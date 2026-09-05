import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { ChatResolutionError, openDatabase } from "./db.js";
import { parseRange } from "./dates.js";
import { Queries } from "./queries.js";
import { SendIpcClientError, sendTextViaIpc, type SendReceipt } from "./send-ipc.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const sendAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(value ?? fallback, maximum);
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  if (error instanceof ChatResolutionError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: error.message, candidates: error.candidates }, null, 2) }],
      isError: true,
    };
  }
  if (error instanceof SendIpcClientError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: error.message }, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: "invalid_request", message: error instanceof Error ? error.message : "Error desconocido" }) }],
    isError: true,
  };
}

const dateField = z.string().max(40).optional().describe("ISO-8601. YYYY-MM-DD usa la zona configurada; fecha-hora exige Z u offset.");

type SendText = (chatJid: string, message: string) => Promise<SendReceipt>;

export function createMcpServer(
  queries: Queries,
  sendText: SendText = (chatJid, message) => sendTextViaIpc(config.sendSocketPath, chatJid, message, config.sendTimeoutMs),
): McpServer {
  const server = new McpServer({ name: "whatsapp-mcp", version: "0.1.0" });

  server.registerTool("search_messages", {
    title: "Buscar mensajes de WhatsApp",
    description: "Busca términos textuales en el índice FTS5 local. Devuelve sólo coincidencias concretas y nunca el historial completo.",
    inputSchema: {
      query: z.string().min(1).max(500),
      chat: z.string().min(1).max(300).optional(),
      from_date: dateField,
      to_date: dateField,
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ query, chat, from_date, to_date, limit }) => {
    try {
      const range = parseRange(from_date, to_date, config.timeZone);
      return response({ results: queries.searchMessages(query, { ...range, ...(chat ? { chat } : {}), limit: boundedLimit(limit, config.defaultLimit, 100) }) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_messages", {
    title: "Leer mensajes de un chat",
    description: "Devuelve mensajes normalizados en orden cronológico. Si el nombre es ambiguo, falla y devuelve candidatos.",
    inputSchema: {
      chat: z.string().min(1).max(300),
      from_date: dateField,
      to_date: dateField,
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ chat, from_date, to_date, limit }) => {
    try {
      const range = parseRange(from_date, to_date, config.timeZone);
      return response({ results: queries.getMessages(chat, { ...range, limit: boundedLimit(limit, 50, 200) }) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_chats", {
    title: "Listar chats",
    description: "Lista metadatos mínimos de chats locales, opcionalmente filtrados por texto.",
    inputSchema: {
      query: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ query, limit }) => {
    try {
      return response({ results: queries.getChats(query, boundedLimit(limit, config.defaultLimit, 100)) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("search_contacts", {
    title: "Buscar contactos",
    description: "Busca contactos locales por nombre, alias, teléfono o JID.",
    inputSchema: {
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ query, limit }) => {
    try {
      return response({ results: queries.searchContacts(query, boundedLimit(limit, config.defaultLimit, 100)) });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("send_message", {
    title: "Enviar mensaje de WhatsApp",
    description: "Envía un mensaje de texto a un chat conocido mediante la sesión activa del ingestor. Produce un efecto externo real y no es idempotente.",
    inputSchema: {
      chat: z.string().min(1).max(300).describe("Nombre inequívoco o JID exacto de un chat ya conocido."),
      message: z.string().min(1).max(4096).refine((value) => value.trim().length > 0, "El mensaje no puede contener sólo espacios"),
      confirmed: z.literal(true).describe("Debe ser true únicamente después de que el usuario haya autorizado el destinatario y el texto."),
    },
    annotations: sendAnnotations,
  }, async ({ chat, message }) => {
    try {
      const chatJid = queries.resolveChat(chat);
      const receipt = await sendText(chatJid, message);
      return response({ status: "accepted", chat_jid: chatJid, message_id: receipt.messageId });
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const db = openDatabase(config.dbPath, true);
  const server = createMcpServer(new Queries(db));
  const transport = new StdioServerTransport();
  const close = async () => {
    await server.close();
    db.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`No se pudo iniciar whatsapp-mcp: ${error instanceof Error ? error.message : "error desconocido"}\n`);
    process.exitCode = 1;
  });
}
