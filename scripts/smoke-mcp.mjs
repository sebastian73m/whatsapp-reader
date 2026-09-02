import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase, Repository } from "../dist/db.js";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-reader-smoke-"));
const databasePath = path.join(temporaryDir, "smoke.sqlite");

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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/mcp.js")],
  cwd: process.cwd(),
  env: {
    ...process.env,
    WHATSAPP_READER_DB_PATH: databasePath,
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
    ["get_chats", "get_messages", "search_contacts", "search_messages"],
  );

  const chats = parseText(await client.callTool({ name: "get_chats", arguments: { query: "Smoke" } }));
  assert.equal(chats.results.length, 1);
  assert.equal(chats.results[0].jid, "smoke@g.us");

  const messages = parseText(await client.callTool({ name: "search_messages", arguments: { query: "verificable" } }));
  assert.equal(messages.results.length, 1);
  assert.equal(messages.results[0].id, "smoke-1");

  process.stdout.write("Smoke MCP correcto: handshake, listado y consultas validados.\n");
} finally {
  await client.close();
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
