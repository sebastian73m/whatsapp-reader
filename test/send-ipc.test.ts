import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SendIpcClientError,
  SendServiceError,
  sendTextViaIpc,
  startSendIpcServer,
  type SendIpcServer,
} from "../src/send-ipc.js";

import { resolveSendSocketPath } from "../src/ipc-path.js";

const temporaryDirs: string[] = [];
const servers: SendIpcServer[] = [];

function temporarySocket(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-send-ipc-"));
  temporaryDirs.push(directory);
  return resolveSendSocketPath(undefined, directory);
}

function observeIncomingChunk(expected: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const originalEmit = net.Socket.prototype.emit;
    net.Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      const emitted = Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      if (event === "data" && Buffer.isBuffer(args[0]) && args[0].equals(expected)) {
        net.Socket.prototype.emit = originalEmit;
        resolve();
      }
      return emitted;
    };
  });
}

function decodeWithPreviousChunkBehavior(chunks: Buffer[]): string {
  return chunks.map((chunk) => chunk.toString("utf8")).join("");
}

async function receiveFragmentedLine(socketPath: string, firstChunk: Buffer, secondChunk: Buffer): Promise<unknown> {
  const firstChunkDelivered = observeIncomingChunk(firstChunk);
  let client!: net.Socket;
  const response = new Promise<unknown>((resolve, reject) => {
    client = net.createConnection(socketPath);
    let response = "";
    client.on("connect", () => {
      client.write(firstChunk);
    });
    client.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\n")) client.end();
    });
    client.on("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    client.on("error", reject);
  });
  await firstChunkDelivered;
  // El servidor ya procesó el fragmento incompleto en un evento data separado.
  // Con el decodificador anterior, los bytes parciales ya se habrían sustituido.
  client.end(secondChunk);
  return response;
}

async function startFragmentedResponseServer(socketPath: string): Promise<SendIpcServer> {
  const server = net.createServer((client) => {
    let request = "";
    client.on("data", (chunk: Buffer) => {
      request += chunk.toString("utf8");
      if (!request.includes("\n")) return;
      const { requestId } = JSON.parse(request) as { requestId: string };
      const response = Buffer.from(`${JSON.stringify({ version: 1, requestId, ok: true, messageId: "confirmación-🚀" })}\n`);
      const emoji = Buffer.from("🚀");
      const splitAt = response.indexOf(emoji) + 2;
      const firstChunk = response.subarray(0, splitAt);
      const firstChunkDelivered = observeIncomingChunk(firstChunk);
      client.write(firstChunk);
      void firstChunkDelivered.then(() => client.end(response.subarray(splitAt)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("IPC de envío", () => {
  it("entrega el destinatario y el texto al ingestor", async () => {
    const socketPath = temporarySocket();
    const received: Array<{ chatJid: string; text: string }> = [];
    const server = await startSendIpcServer(socketPath, async (chatJid, text) => {
      received.push({ chatJid, text });
      return { messageId: "outgoing-1" };
    });
    servers.push(server);

    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Nos vemos a las 18", 1_000))
      .resolves.toEqual({ messageId: "outgoing-1" });
    expect(received).toEqual([{ chatJid: "familia@g.us", text: "Nos vemos a las 18" }]);
    if (process.platform !== "win32") expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("rechaza un segundo servidor sin interrumpir al primero", async () => {
    const socketPath = temporarySocket();
    servers.push(await startSendIpcServer(socketPath, async () => ({ messageId: "original" })));
    await expect(startSendIpcServer(socketPath, async () => ({ messageId: "duplicate" }))).rejects.toThrow();
    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000))
      .resolves.toEqual({ messageId: "original" });
  });

  it("permite reiniciar el servidor con la misma dirección", async () => {
    const socketPath = temporarySocket();
    const first = await startSendIpcServer(socketPath, async () => ({ messageId: "first" }));
    await first.close();
    servers.push(await startSendIpcServer(socketPath, async () => ({ messageId: "second" })));
    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000))
      .resolves.toEqual({ messageId: "second" });
  });

  it("propaga errores operativos sin exponer excepciones internas", async () => {
    const socketPath = temporarySocket();
    const server = await startSendIpcServer(socketPath, async () => {
      throw new SendServiceError("whatsapp_unavailable", "WhatsApp no está conectado");
    });
    servers.push(server);

    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000)).rejects.toMatchObject({
      code: "whatsapp_unavailable",
      message: "WhatsApp no está conectado",
    });
  });

  it("preserva UTF-8 cuando la solicitud se fragmenta dentro de un carácter", async () => {
    const socketPath = temporarySocket();
    const received: Array<{ chatJid: string; text: string }> = [];
    const server = await startSendIpcServer(socketPath, async (chatJid, text) => {
      received.push({ chatJid, text });
      return { messageId: "outgoing-ñ" };
    });
    servers.push(server);
    const request = Buffer.from(`${JSON.stringify({
      version: 1,
      requestId: "fragmented-request",
      action: "send_text",
      chatJid: "familia@g.us",
      text: "Llegué 🚀",
    })}\n`);
    const splitAt = request.indexOf(Buffer.from("🚀")) + 2;

    // Fixture del comportamiento anterior: cada chunk se convertía por separado.
    // Demuestra que esta partición corrompe la secuencia UTF-8 antes de probar el servidor real.
    expect(decodeWithPreviousChunkBehavior([request.subarray(0, splitAt), request.subarray(splitAt)])).not.toBe(request.toString("utf8"));

    await expect(receiveFragmentedLine(socketPath, request.subarray(0, splitAt), request.subarray(splitAt))).resolves.toMatchObject({
      ok: true,
      messageId: "outgoing-ñ",
    });
    expect(received).toEqual([{ chatJid: "familia@g.us", text: "Llegué 🚀" }]);
  });

  it("preserva UTF-8 cuando la respuesta se fragmenta dentro de un carácter", async () => {
    const socketPath = temporarySocket();
    servers.push(await startFragmentedResponseServer(socketPath));

    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000))
      .resolves.toEqual({ messageId: "confirmación-🚀" });
  });

  it("informa cuando el ingestor no está disponible", async () => {
    const socketPath = temporarySocket();
    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000)).rejects.toBeInstanceOf(SendIpcClientError);
    await expect(sendTextViaIpc(socketPath, "familia@g.us", "Hola", 1_000)).rejects.toMatchObject({
      code: "ingestor_unavailable",
    });
  });
});
