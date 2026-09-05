import fs from "node:fs";
import process from "node:process";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  isJidBroadcast,
  isJidNewsletter,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { backupCredentials, isSessionLinked, restoreCredentialBackup } from "./auth-state.js";
import { config } from "./config.js";
import { openDatabase, Repository } from "./db.js";
import { normalizeChat, normalizeContact, normalizeMessage } from "./normalize.js";
import { SendServiceError, startSendIpcServer, type SendIpcServer } from "./send-ipc.js";

process.umask(0o077);
fs.mkdirSync(config.authDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: ["message", "messages", "qr", "auth", "creds", "keys", "*.message", "*.messages"],
      censor: "[REDACTADO]",
    },
  },
  pino.destination(2),
);
// Baileys registra estructuras de handshake y emparejamiento que pueden contener
// material criptográfico efímero. Los eventos operativos se registran abajo de
// forma explícita; el logger interno permanece silenciado por diseño.
const baileysLogger = pino({ level: "silent" });
const db = openDatabase(config.dbPath);
const repository = new Repository(db);

let socket: WASocket | undefined;
let reconnectAttempts = 0;
let connectionReplacedAttempts = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let stableConnectionTimer: NodeJS.Timeout | undefined;
let stopping = false;
let reconnectsSuspendedMessage: string | undefined;
let shutdownPromise: Promise<void> | undefined;
let credentialWrites: Promise<void> = Promise.resolve();
let sendIpcServer: SendIpcServer | undefined;
let whatsappConnected = false;

function persistCredentials(saveCreds: () => Promise<void>): void {
  credentialWrites = credentialWrites
    .then(async () => {
      await saveCreds();
      await backupCredentials(config.authDir);
    })
    .catch((error: unknown) => {
      logger.error(
        { error: error instanceof Error ? error.message : "error desconocido" },
        "No se pudieron persistir las credenciales de WhatsApp",
      );
    });
}

function persistMessage(message: WAMessage): void {
  const normalized = normalizeMessage(message);
  if (normalized) repository.upsertMessage(normalized);
}

function statusCode(error: unknown): number | undefined {
  if (error instanceof Boom) return error.output.statusCode;
  if (error && typeof error === "object" && "output" in error) {
    const output = (error as { output?: { statusCode?: unknown } }).output;
    return typeof output?.statusCode === "number" ? output.statusCode : undefined;
  }
  return undefined;
}

function scheduleReconnect(disconnectCode?: number): void {
  if (stopping || reconnectsSuspendedMessage || reconnectTimer) return;
  if (reconnectAttempts >= config.maxReconnectAttempts) {
    suspendReconnects("Se agotaron los reintentos; reinicie el ingestor manualmente", { attempts: reconnectAttempts });
    return;
  }
  const delay = Math.min(config.reconnectBaseMs * 2 ** reconnectAttempts, 30_000);
  reconnectAttempts += 1;
  logger.warn({ attempt: reconnectAttempts, delayMs: delay, disconnectCode }, "Conexión cerrada; se reintentará");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect().catch((error: unknown) => {
      logger.warn(
        { error: error instanceof Error ? error.message : "error desconocido" },
        "Falló el intento de conexión",
      );
      scheduleReconnect();
    });
  }, delay);
}

function suspendReconnects(message: string, details: Record<string, unknown> = {}): void {
  if (reconnectsSuspendedMessage) return;
  reconnectsSuspendedMessage = message;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  logger.error(details, message);
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  if (isSessionLinked(state.creds)) {
    logger.info("Sesión persistida encontrada; se intentará reconectar sin solicitar un QR");
  }
  const latestVersion = await fetchLatestWaWebVersion();
  if (!latestVersion.isLatest) {
    logger.warn("No se pudo resolver la última revisión de WhatsApp Web; se usará la incluida en Baileys");
  }
  const nextSocket = makeWASocket({
    version: latestVersion.version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    // WhatsApp rechaza actualmente el subprotocolo de los clientes Desktop
    // no oficiales antes de emitir el QR. Ubuntu/Chrome anuncia WEB_BROWSER.
    browser: Browsers.ubuntu("Chrome"),
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    emitOwnEvents: true,
    generateHighQualityLinkPreview: false,
    maxMsgRetryCount: 3,
    shouldIgnoreJid: (jid) => !jid || isJidBroadcast(jid) || isJidNewsletter(jid),
    getMessage: async () => undefined,
  });
  socket = nextSocket;

  nextSocket.ev.on("creds.update", () => persistCredentials(saveCreds));
  nextSocket.ev.on("connection.update", (update) => {
    if (socket !== nextSocket || stopping || reconnectsSuspendedMessage) return;
    if (update.qr) {
      process.stderr.write("Escanee este QR desde WhatsApp > Dispositivos vinculados:\n");
      qrcode.generate(update.qr, { small: true }, (code) => process.stderr.write(`${code}\n`));
    }
    if (update.connection === "open") {
      whatsappConnected = true;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = setTimeout(() => {
        if (socket === nextSocket && whatsappConnected) {
          reconnectAttempts = 0;
          connectionReplacedAttempts = 0;
        }
      }, 30_000);
      persistCredentials(saveCreds);
      logger.info("Dispositivo vinculado y escuchando eventos");
    }
    if (update.connection === "close") {
      whatsappConnected = false;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = undefined;
      const code = statusCode(update.lastDisconnect?.error);
      if (code === DisconnectReason.loggedOut) {
        suspendReconnects("WhatsApp cerró la sesión. No se reintentará; vuelva a vincular manualmente");
      } else if (code === DisconnectReason.connectionReplaced) {
        connectionReplacedAttempts += 1;
        if (connectionReplacedAttempts >= 3) {
          suspendReconnects(
            "Otra instancia reemplaza esta conexión; se suspenden los reintentos hasta reiniciar el servicio",
            { attempts: connectionReplacedAttempts, disconnectCode: code },
          );
        } else {
          scheduleReconnect(code);
        }
      } else {
        connectionReplacedAttempts = 0;
        scheduleReconnect(code);
      }
    }
  });

  nextSocket.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    const save = db.transaction(() => {
      for (const contact of contacts) {
        const normalized = normalizeContact(contact);
        if (normalized) repository.upsertContact(normalized);
      }
      for (const chat of chats) {
        const normalized = normalizeChat(chat);
        if (normalized) repository.upsertChat(normalized);
      }
      for (const message of messages) persistMessage(message);
    });
    save();
    logger.info({ chats: chats.length, contacts: contacts.length, messages: messages.length }, "Bloque de historial normalizado");
  });

  nextSocket.ev.on("messages.upsert", ({ messages }) => {
    const save = db.transaction(() => messages.forEach(persistMessage));
    save();
    logger.info({ count: messages.length }, "Mensajes nuevos normalizados");
  });

  nextSocket.ev.on("chats.upsert", (chats) => {
    const save = db.transaction(() => chats.forEach((chat) => {
      const normalized = normalizeChat(chat);
      if (normalized) repository.upsertChat(normalized);
    }));
    save();
  });

  nextSocket.ev.on("chats.update", (chats) => {
    const save = db.transaction(() => chats.forEach((chat) => {
      const normalized = normalizeChat(chat);
      if (normalized) repository.upsertChat(normalized);
    }));
    save();
  });

  nextSocket.ev.on("contacts.upsert", (contacts) => {
    const save = db.transaction(() => contacts.forEach((contact) => {
      const normalized = normalizeContact(contact);
      if (normalized) repository.upsertContact(normalized);
    }));
    save();
  });

  nextSocket.ev.on("contacts.update", (contacts) => {
    const save = db.transaction(() => contacts.forEach((contact) => {
      const normalized = normalizeContact(contact);
      if (normalized) repository.upsertContact(normalized);
    }));
    save();
  });
}

function shutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
  whatsappConnected = false;
  const activeSocket = socket;
  socket = undefined;
  shutdownPromise = (async () => {
    try {
      await activeSocket?.end(undefined);
    } catch {
      try {
        activeSocket?.ws.close();
      } catch {
        // La conexión ya puede estar cerrada.
      }
    }
    await sendIpcServer?.close();
    await credentialWrites;
    db.close();
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

async function start(): Promise<void> {
  const recovery = await restoreCredentialBackup(config.authDir);
  if (recovery === "restored") {
    logger.warn("Se restauraron credenciales desde el backup atómico después de detectar una escritura incompleta");
  }
  sendIpcServer = await startSendIpcServer(config.sendSocketPath, async (chatJid, text) => {
    if (reconnectsSuspendedMessage) {
      throw new SendServiceError("whatsapp_unavailable", `${reconnectsSuspendedMessage} Los envíos permanecerán deshabilitados hasta la intervención manual.`);
    }
    if (!socket || !whatsappConnected) {
      throw new SendServiceError("whatsapp_unavailable", "WhatsApp no está conectado; intente nuevamente cuando el ingestor se reconecte");
    }
    const knownChatJid = repository.resolveChat(chatJid);
    if (knownChatJid !== chatJid) throw new SendServiceError("unknown_chat", "El destinatario no es un chat conocido");
    const sent = await socket.sendMessage(chatJid, { text });
    const messageId = sent?.key.id;
    if (!messageId) throw new SendServiceError("send_failed", "WhatsApp no confirmó la aceptación del mensaje");
    return { messageId };
  });
  await connect();
}

void start().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : "error desconocido" }, "No se pudo iniciar la conexión");
  void shutdown(1);
});
