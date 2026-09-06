import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase, Repository } from "../dist/db.js";
import { startSendIpcServer } from "../dist/send-ipc.js";

import { resolveSendSocketPath } from "../dist/ipc-path.js";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-reader-smoke-"));
const databasePath = path.join(temporaryDir, "smoke.sqlite");
const sendSocketPath = resolveSendSocketPath(undefined, temporaryDir);

function parseText(result) {
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content, "La herramienta MCP no devolvió contenido textual");
  return JSON.parse(content.text);
}

const db = openDatabase(databasePath);
const repository = new Repository(db);
repository.upsertChat({ jid: "smoke@g.us", title: "Smoke Test" });
repository.upsertMessage({
  chatJid: "smoke@g.us",
  id: "smoke-1",
  senderJid: "tester@s.whatsapp.net",
  fromMe: false,
  timestampMs: Date.parse("2026-09-02T12:00:00Z"),
  text: "mensaje verificable",
  messageType: "conversation",
  hasAttachment: false,
  pushName: "Tester",
});
db.close();

const sent = [];
const sendServer = await startSendIpcServer(sendSocketPath, async (chatJid, text) => {
  sent.push({ chatJid, text });
  return { messageId: "smoke-outgoing-1" };
});

// Ejercita también la detección del entrypoint con caracteres escapados en file URLs.
const entryPath = path.resolve("dist", `mcp smoke #${randomUUID()}.js`);
fs.copyFileSync(path.resolve("dist/mcp.js"), entryPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entryPath],
  cwd: process.cwd(),
  env: {
    ...process.env,
    WHATSAPP_READER_DB_PATH: databasePath,
    WHATSAPP_READER_SEND_SOCKET: sendSocketPath,
    WHATSAPP_READER_TIME_ZONE: "UTC",
  },
  stderr: "pipe",
});
const client = new Client({ name: "whatsapp-reader-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["get_chats", "get_messages", "search_contacts", "search_messages", "send_message"],
  );

  const chats = parseText(await client.callTool({ name: "get_chats", arguments: { query: "Smoke" } }));
  assert.equal(chats.results.length, 1);
  assert.equal(chats.results[0].jid, "smoke@g.us");

  const messages = parseText(await client.callTool({ name: "search_messages", arguments: { query: "verificable" } }));
  assert.equal(messages.results.length, 1);
  assert.equal(messages.results[0].id, "smoke-1");

  const outgoing = parseText(await client.callTool({
    name: "send_message",
    arguments: { chat: "Smoke Test", message: "respuesta de prueba", confirmed: true },
  }));
  assert.deepEqual(outgoing, {
    status: "accepted",
    chat_jid: "smoke@g.us",
    message_id: "smoke-outgoing-1",
  });
  assert.deepEqual(sent, [{ chatJid: "smoke@g.us", text: "respuesta de prueba" }]);

  process.stdout.write("Smoke MCP correcto: handshake, listado, consultas y envío validados.\n");
} finally {
  await client.close();
  await sendServer.close();
  fs.rmSync(entryPath, { force: true });
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
