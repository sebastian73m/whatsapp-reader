import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

type SendRequest = {
  version: 1;
  requestId: string;
  action: "send_text";
  chatJid: string;
  text: string;
};

type SendSuccess = {
  version: 1;
  requestId: string;
  ok: true;
  messageId: string;
};

type SendFailure = {
  version: 1;
  requestId: string;
  ok: false;
  error: string;
  message: string;
};

type SendResponse = SendSuccess | SendFailure;

export type SendReceipt = { messageId: string };

export class SendServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class SendIpcClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function validRequest(value: unknown): value is SendRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<SendRequest>;
  return request.version === PROTOCOL_VERSION
    && request.action === "send_text"
    && typeof request.requestId === "string"
    && request.requestId.length > 0
    && request.requestId.length <= 100
    && typeof request.chatJid === "string"
    && request.chatJid.length > 0
    && request.chatJid.length <= 300
    && typeof request.text === "string"
    && request.text.trim().length > 0
    && request.text.length <= 4096;
}

function parseJsonLine<T>(data: string): T {
  const newline = data.indexOf("\n");
  if (newline < 0) throw new Error("Mensaje IPC incompleto");
  return JSON.parse(data.slice(0, newline)) as T;
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", (error) => {
      client.destroy();
      if (isErrno(error, "ECONNREFUSED") || isErrno(error, "ENOENT")) resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`La ruta IPC existe y no es un socket: ${socketPath}`);
  }
  if (await socketIsActive(socketPath)) {
    throw new Error(`Ya hay un ingestor escuchando en ${socketPath}`);
  }
  await fs.promises.unlink(socketPath);
}

export type SendIpcServer = { close: () => Promise<void> };

export async function startSendIpcServer(
  socketPath: string,
  sendText: (chatJid: string, text: string) => Promise<SendReceipt>,
): Promise<SendIpcServer> {
  const windows = process.platform === "win32";
  if (!windows) {
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await prepareSocketPath(socketPath);
  }
  const clients = new Set<net.Socket>();

  const server = net.createServer((client) => {
    clients.add(client);
    client.setTimeout(60_000);
    let data = "";
    let receivedBytes = 0;
    const decoder = new StringDecoder("utf8");
    let handled = false;

    const reply = (response: SendResponse) => client.end(`${JSON.stringify(response)}\n`);
    const fail = (requestId: string, error: string, message: string) => {
      reply({ version: PROTOCOL_VERSION, requestId, ok: false, error, message });
    };

    client.on("data", (chunk: Buffer) => {
      if (handled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BYTES) {
        handled = true;
        fail("unknown", "invalid_request", "La solicitud IPC excede el límite permitido");
        return;
      }
      data += decoder.write(chunk);
      if (!data.includes("\n")) return;
      handled = true;
      let request: unknown;
      try {
        request = parseJsonLine(data);
      } catch {
        fail("unknown", "invalid_request", "La solicitud IPC no contiene JSON válido");
        return;
      }
      if (!validRequest(request)) {
        fail("unknown", "invalid_request", "La solicitud de envío no es válida");
        return;
      }
      void sendText(request.chatJid, request.text)
        .then(({ messageId }) => reply({ version: PROTOCOL_VERSION, requestId: request.requestId, ok: true, messageId }))
        .catch((error: unknown) => {
          if (error instanceof SendServiceError) fail(request.requestId, error.code, error.message);
          else fail(request.requestId, "send_failed", "WhatsApp no pudo aceptar el mensaje");
        });
    });
    client.on("timeout", () => client.destroy());
    client.on("error", () => undefined);
    client.on("close", () => clients.delete(client));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  if (!windows) {
    try {
      await fs.promises.chmod(socketPath, 0o600);
    } catch (error) {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  return {
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // Windows elimina la pipe al cerrar el último handle; no es un archivo.
      if (windows) return;
      try {
        const stat = await fs.promises.lstat(socketPath);
        if (stat.isSocket()) await fs.promises.unlink(socketPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    },
  };
}

export async function sendTextViaIpc(
  socketPath: string,
  chatJid: string,
  message: string,
  timeoutMs: number,
): Promise<SendReceipt> {
  const requestId = randomUUID();
  const request: SendRequest = {
    version: PROTOCOL_VERSION,
    requestId,
    action: "send_text",
    chatJid,
    text: message,
  };

  return await new Promise<SendReceipt>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let settled = false;
    let data = "";
    let receivedBytes = 0;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error, receipt?: SendReceipt) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolve(receipt!);
    };

    client.setTimeout(timeoutMs);
    client.once("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        finish(new SendIpcClientError("invalid_response", "La respuesta del ingestor excede el límite permitido"));
        return;
      }
      data += decoder.write(chunk);
      if (!data.includes("\n")) return;
      let response: SendResponse;
      try {
        response = parseJsonLine<SendResponse>(data);
      } catch {
        finish(new SendIpcClientError("invalid_response", "El ingestor devolvió una respuesta inválida"));
        return;
      }
      if (!response || typeof response !== "object"
        || response.version !== PROTOCOL_VERSION
        || response.requestId !== requestId
        || typeof response.ok !== "boolean") {
        finish(new SendIpcClientError("invalid_response", "El ingestor devolvió una respuesta incompatible"));
      } else if (!response.ok) {
        if (typeof response.error !== "string" || typeof response.message !== "string") {
          finish(new SendIpcClientError("invalid_response", "El ingestor devolvió un error incompatible"));
        } else {
          finish(new SendIpcClientError(response.error, response.message));
        }
      } else if (typeof response.messageId !== "string" || !response.messageId) {
        finish(new SendIpcClientError("invalid_response", "El ingestor no devolvió el identificador del mensaje"));
      } else {
        finish(undefined, { messageId: response.messageId });
      }
    });
    client.once("timeout", () => finish(new SendIpcClientError("send_timeout", "El ingestor no respondió a tiempo; el estado del envío es incierto")));
    client.once("error", (error) => {
      const unavailable = isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED");
      finish(new SendIpcClientError(
        unavailable ? "ingestor_unavailable" : "ipc_error",
        unavailable ? "El ingestor no está disponible para enviar mensajes" : "No se pudo contactar al ingestor",
      ));
    });
    client.once("end", () => {
      if (!settled && !data.includes("\n")) {
        finish(new SendIpcClientError("invalid_response", "El ingestor cerró la conexión sin responder"));
      }
    });
  });
}
