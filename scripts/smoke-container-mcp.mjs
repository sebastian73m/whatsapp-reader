import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "docker",
  args: ["exec", "-i", "whatsapp-reader", "node", "dist/mcp.js"],
  stderr: "pipe",
});
const client = new Client({ name: "whatsapp-reader-container-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["get_chats", "get_messages", "search_contacts", "search_messages", "send_message"],
  );

  const result = await client.callTool({ name: "get_chats", arguments: { limit: 1 } });
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content, "El MCP del contenedor no devolvió contenido textual");
  const payload = JSON.parse(content.text);
  assert.ok(Array.isArray(payload.results), "get_chats no devolvió una lista");
  process.stdout.write("Smoke del contenedor MCP correcto.\n");
} finally {
  await client.close();
}
