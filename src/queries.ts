import type Database from "better-sqlite3";
import type { ChatCandidate, MessageResult } from "./db.js";
import { Repository } from "./db.js";

type Range = { fromMs?: number; toExclusiveMs?: number };

export type SearchOptions = Range & { chat?: string; limit: number };
export type GetMessageOptions = Range & { limit: number };

function ftsLiteralQuery(input: string): string {
  const tokens = (input.normalize("NFKC").match(/[\p{L}\p{N}_@.+-]+/gu) ?? [])
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (tokens.length === 0) throw new Error("La búsqueda debe contener letras o números");
  if (tokens.length > 20) throw new Error("La búsqueda admite como máximo 20 términos");
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function messageFilters(range: Range, chatJid?: string): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (chatJid) {
    clauses.push("m.chat_jid = @chatJid");
    params.chatJid = chatJid;
  }
  if (range.fromMs !== undefined) {
    clauses.push("m.timestamp_ms >= @fromMs");
    params.fromMs = range.fromMs;
  }
  if (range.toExclusiveMs !== undefined) {
    clauses.push("m.timestamp_ms < @toExclusiveMs");
    params.toExclusiveMs = range.toExclusiveMs;
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

const MESSAGE_SELECT = `
  m.chat_jid,
  c.title AS chat_title,
  m.id,
  m.sender_jid,
  COALESCE(m.push_name, sender.display_name, sender.notify_name) AS sender_name,
  m.from_me,
  strftime('%Y-%m-%dT%H:%M:%fZ', m.timestamp_ms / 1000.0, 'unixepoch') AS timestamp,
  m.text,
  m.message_type,
  m.has_attachment
`;

export class Queries {
  private readonly repository: Repository;

  constructor(private readonly db: Database.Database) {
    this.repository = new Repository(db);
  }

  searchMessages(query: string, options: SearchOptions): MessageResult[] {
    const chatJid = options.chat ? this.repository.resolveChat(options.chat) : undefined;
    const filter = messageFilters(options, chatJid);
    return this.db.prepare(`
      SELECT ${MESSAGE_SELECT}, bm25(messages_fts) AS relevance
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN chats c ON c.jid = m.chat_jid
      LEFT JOIN contacts sender ON sender.jid = m.sender_jid
      WHERE messages_fts MATCH @ftsQuery${filter.sql}
      ORDER BY relevance ASC, m.timestamp_ms DESC
      LIMIT @limit
    `).all({ ftsQuery: ftsLiteralQuery(query), ...filter.params, limit: options.limit }) as MessageResult[];
  }

  getMessages(chat: string, options: GetMessageOptions): MessageResult[] {
    const chatJid = this.repository.resolveChat(chat);
    const filter = messageFilters(options, chatJid);
    return this.db.prepare(`
      SELECT * FROM (
        SELECT ${MESSAGE_SELECT}
        FROM messages m
        JOIN chats c ON c.jid = m.chat_jid
        LEFT JOIN contacts sender ON sender.jid = m.sender_jid
        WHERE 1 = 1${filter.sql}
        ORDER BY m.timestamp_ms DESC, m.id DESC
        LIMIT @limit
      ) recent
      ORDER BY timestamp ASC, id ASC
    `).all({ ...filter.params, limit: options.limit }) as MessageResult[];
  }

  getChats(query: string | undefined, limit: number): ChatCandidate[] {
    const params: Record<string, unknown> = { limit };
    let filter = "";
    if (query?.trim()) {
      const escaped = query.trim().replace(/[\\%_]/g, "\\$&");
      params.pattern = `%${escaped}%`;
      filter = `WHERE COALESCE(c.title, '') LIKE @pattern ESCAPE '\\'
                   OR COALESCE(ct.display_name, '') LIKE @pattern ESCAPE '\\'
                   OR COALESCE(ct.notify_name, '') LIKE @pattern ESCAPE '\\'
                   OR c.jid LIKE @pattern ESCAPE '\\'`;
    }
    return this.db.prepare(`
      SELECT c.jid, COALESCE(c.title, ct.display_name, ct.notify_name) AS title, c.kind,
             CASE WHEN c.last_message_at IS NULL THEN NULL
                  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', c.last_message_at / 1000.0, 'unixepoch') END AS last_message_at
      FROM chats c
      LEFT JOIN contacts ct ON ct.jid = c.jid
      ${filter}
      ORDER BY c.last_message_at DESC, title COLLATE NOCASE
      LIMIT @limit
    `).all(params) as ChatCandidate[];
  }

  searchContacts(query: string, limit: number): Array<Record<string, unknown>> {
    const value = query.trim();
    if (!value) throw new Error("La búsqueda de contactos no puede estar vacía");
    const escaped = value.replace(/[\\%_]/g, "\\$&");
    return this.db.prepare(`
      SELECT jid, display_name, notify_name, phone
      FROM contacts
      WHERE COALESCE(display_name, '') LIKE @pattern ESCAPE '\\'
         OR COALESCE(notify_name, '') LIKE @pattern ESCAPE '\\'
         OR COALESCE(phone, '') LIKE @pattern ESCAPE '\\'
         OR jid LIKE @pattern ESCAPE '\\'
      ORDER BY (lower(COALESCE(display_name, notify_name, '')) = lower(@value)) DESC,
               COALESCE(display_name, notify_name, jid) COLLATE NOCASE
      LIMIT @limit
    `).all({ pattern: `%${escaped}%`, value, limit }) as Array<Record<string, unknown>>;
  }
}
