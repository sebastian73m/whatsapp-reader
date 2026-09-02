import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export type ContactInput = {
  jid: string;
  displayName?: string | null;
  notifyName?: string | null;
  phone?: string | null;
};

export type ChatInput = {
  jid: string;
  title?: string | null;
  unreadCount?: number | null;
  lastMessageAt?: number | null;
};

export type MessageInput = {
  chatJid: string;
  id: string;
  senderJid?: string | null;
  fromMe: boolean;
  timestampMs: number;
  text: string;
  messageType: string;
  hasAttachment: boolean;
  pushName?: string | null;
};

export type MessageResult = {
  chat_jid: string;
  chat_title: string | null;
  id: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  timestamp: string;
  text: string;
  message_type: string;
  has_attachment: number;
};

export type ChatCandidate = { jid: string; title: string | null; kind: string; last_message_at: string | null };

export class ChatResolutionError extends Error {
  constructor(
    message: string,
    readonly code: "chat_not_found" | "ambiguous_chat",
    readonly candidates: ChatCandidate[],
  ) {
    super(message);
  }
}

export function openDatabase(filename: string, readonly = false): Database.Database {
  if (!readonly) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new Database(filename, { readonly, fileMustExist: readonly });
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    migrate(db);
    try {
      fs.chmodSync(filename, 0o600);
    } catch {
      // Algunos sistemas de archivos no admiten chmod; la advertencia está en el README.
    }
  }
  return db;
}

function chatKind(jid: string): "direct" | "group" | "other" {
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) return "direct";
  return "other";
}

export class Repository {
  constructor(readonly db: Database.Database) {}

  upsertContact(contact: ContactInput): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO contacts(jid, display_name, notify_name, phone, updated_at)
      VALUES (@jid, @displayName, @notifyName, @phone, @now)
      ON CONFLICT(jid) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, contacts.display_name),
        notify_name = COALESCE(excluded.notify_name, contacts.notify_name),
        phone = COALESCE(excluded.phone, contacts.phone),
        updated_at = excluded.updated_at
    `).run({ ...contact, displayName: contact.displayName ?? null, notifyName: contact.notifyName ?? null, phone: contact.phone ?? null, now });
  }

  upsertChat(chat: ChatInput): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO chats(jid, title, kind, unread_count, last_message_at, updated_at)
      VALUES (@jid, @title, @kind, @unreadCount, @lastMessageAt, @now)
      ON CONFLICT(jid) DO UPDATE SET
        title = COALESCE(excluded.title, chats.title),
        unread_count = COALESCE(excluded.unread_count, chats.unread_count),
        last_message_at = CASE
          WHEN excluded.last_message_at IS NULL THEN chats.last_message_at
          WHEN chats.last_message_at IS NULL THEN excluded.last_message_at
          ELSE MAX(chats.last_message_at, excluded.last_message_at)
        END,
        updated_at = excluded.updated_at
    `).run({
      jid: chat.jid,
      title: chat.title ?? null,
      kind: chatKind(chat.jid),
      unreadCount: chat.unreadCount ?? null,
      lastMessageAt: chat.lastMessageAt ?? null,
      now,
    });
  }

  upsertMessage(message: MessageInput): void {
    const save = this.db.transaction(() => {
      this.upsertChat({ jid: message.chatJid, lastMessageAt: message.timestampMs });
      if (message.senderJid || message.pushName) {
        this.upsertContact({
          jid: message.senderJid ?? message.chatJid,
          ...(message.pushName === undefined ? {} : { notifyName: message.pushName }),
        });
      }
      this.db.prepare(`
        INSERT INTO messages(chat_jid, id, sender_jid, from_me, timestamp_ms, text, message_type, has_attachment, push_name)
        VALUES (@chatJid, @id, @senderJid, @fromMe, @timestampMs, @text, @messageType, @hasAttachment, @pushName)
        ON CONFLICT(chat_jid, id) DO UPDATE SET
          sender_jid = excluded.sender_jid,
          from_me = excluded.from_me,
          timestamp_ms = excluded.timestamp_ms,
          text = excluded.text,
          message_type = excluded.message_type,
          has_attachment = excluded.has_attachment,
          push_name = COALESCE(excluded.push_name, messages.push_name)
      `).run({
        ...message,
        senderJid: message.senderJid ?? null,
        fromMe: message.fromMe ? 1 : 0,
        hasAttachment: message.hasAttachment ? 1 : 0,
        pushName: message.pushName ?? null,
      });
    });
    save();
  }

  resolveChat(input: string): string {
    const value = input.trim();
    if (!value) throw new ChatResolutionError("El chat no puede estar vacío", "chat_not_found", []);
    const exactJid = this.db.prepare("SELECT jid FROM chats WHERE jid = ?").get(value) as { jid: string } | undefined;
    if (exactJid) return exactJid.jid;

    const escaped = value.replace(/[\\%_]/g, "\\$&");
    const rows = this.db.prepare(`
      SELECT c.jid, COALESCE(c.title, ct.display_name, ct.notify_name) AS title, c.kind,
             CASE WHEN c.last_message_at IS NULL THEN NULL ELSE datetime(c.last_message_at / 1000, 'unixepoch') END AS last_message_at
      FROM chats c
      LEFT JOIN contacts ct ON ct.jid = c.jid
      WHERE COALESCE(c.title, '') LIKE @pattern ESCAPE '\\'
         OR COALESCE(ct.display_name, '') LIKE @pattern ESCAPE '\\'
         OR COALESCE(ct.notify_name, '') LIKE @pattern ESCAPE '\\'
         OR c.jid LIKE @pattern ESCAPE '\\'
      ORDER BY (lower(COALESCE(c.title, ct.display_name, ct.notify_name, '')) = lower(@value)) DESC,
               c.last_message_at DESC
      LIMIT 11
    `).all({ pattern: `%${escaped}%`, value }) as ChatCandidate[];
    if (rows.length === 1) return rows[0]!.jid;
    if (rows.length === 0) throw new ChatResolutionError(`No se encontró el chat “${value}”`, "chat_not_found", []);
    throw new ChatResolutionError(`“${value}” coincide con más de un chat; use el JID exacto`, "ambiguous_chat", rows.slice(0, 10));
  }
}
