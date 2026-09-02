import fs from "node:fs";
import process from "node:process";
import makeWASocket, {
  Browsers,
  DisconnectReason,
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
import { config } from "./config.js";
import { openDatabase, Repository } from "./db.js";
import { normalizeChat, normalizeContact, normalizeMessage } from "./normalize.js";

process.umask(0o077);
fs.mkdirSync(config.authDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: ["msg", "message", "messages", "qr", "auth", "creds", "keys", "*.message", "*.messages"],
      censor: "[REDACTADO]",
    },
  },
  pino.destination(2),
);
const baileysLogger = logger.child({ component: "baileys" });
const db = openDatabase(config.dbPath);
const repository = new Repository(db);

let socket: WASocket | undefined;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopping = false;

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

function scheduleReconnect(): void {
  if (stopping || reconnectTimer) return;
  if (reconnectAttempts >= config.maxReconnectAttempts) {
    logger.error({ attempts: reconnectAttempts }, "Se agotaron los reintentos; reinicie el ingestor manualmente");
    shutdown(1);
    return;
  }
  const delay = Math.min(config.reconnectBaseMs * 2 ** reconnectAttempts, 30_000);
  reconnectAttempts += 1;
  logger.warn({ attempt: reconnectAttempts, delayMs: delay }, "Conexión cerrada; se reintentará");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    browser: Browsers.macOS("Desktop"),
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

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", (update) => {
    if (update.qr) {
      process.stderr.write("Escanee este QR desde WhatsApp > Dispositivos vinculados:\n");
      qrcode.generate(update.qr, { small: true }, (code) => process.stderr.write(`${code}\n`));
    }
    if (update.connection === "open") {
      reconnectAttempts = 0;
      logger.info("Dispositivo vinculado y escuchando eventos");
    }
    if (update.connection === "close") {
      const code = statusCode(update.lastDisconnect?.error);
      if (code === DisconnectReason.loggedOut) {
        logger.error("WhatsApp cerró la sesión. No se reintentará; vuelva a vincular manualmente");
        shutdown(2);
      } else {
        scheduleReconnect();
      }
    }
  });

  socket.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
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

  socket.ev.on("messages.upsert", ({ messages }) => {
    const save = db.transaction(() => messages.forEach(persistMessage));
    save();
    logger.info({ count: messages.length }, "Mensajes nuevos normalizados");
  });

  socket.ev.on("chats.upsert", (chats) => {
    const save = db.transaction(() => chats.forEach((chat) => {
      const normalized = normalizeChat(chat);
      if (normalized) repository.upsertChat(normalized);
    }));
    save();
  });

  socket.ev.on("chats.update", (chats) => {
    const save = db.transaction(() => chats.forEach((chat) => {
      const normalized = normalizeChat(chat);
      if (normalized) repository.upsertChat(normalized);
    }));
    save();
  });

  socket.ev.on("contacts.upsert", (contacts) => {
    const save = db.transaction(() => contacts.forEach((contact) => {
      const normalized = normalizeContact(contact);
      if (normalized) repository.upsertContact(normalized);
    }));
    save();
  });

  socket.ev.on("contacts.update", (contacts) => {
    const save = db.transaction(() => contacts.forEach((contact) => {
      const normalized = normalizeContact(contact);
      if (normalized) repository.upsertContact(normalized);
    }));
    save();
  });
}

function shutdown(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    socket?.ws.close();
  } catch {
    // La conexión ya puede estar cerrada.
  }
  db.close();
  process.exitCode = exitCode;
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

void connect().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : "error desconocido" }, "No se pudo iniciar la conexión");
  scheduleReconnect();
});
