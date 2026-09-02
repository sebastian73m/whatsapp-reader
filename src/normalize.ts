import { getContentType, type WAMessage } from "baileys";
import type { ChatInput, ContactInput, MessageInput } from "./db.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  const object = record(value);
  if (object && typeof object.toNumber === "function") {
    const converted = (object.toNumber as () => number)();
    return Number.isFinite(converted) ? converted : undefined;
  }
  if (object && typeof object.low === "number") return object.low;
  return undefined;
}

function unwrapMessage(value: unknown): UnknownRecord | undefined {
  let current = record(value);
  for (let i = 0; i < 5 && current; i += 1) {
    const wrapperKey = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage"]
      .find((key) => record(current?.[key]));
    if (!wrapperKey) return current;
    current = record(record(current[wrapperKey])?.message);
  }
  return current;
}

function extractText(content: UnknownRecord): string {
  const conversation = stringValue(content.conversation);
  if (conversation) return conversation;

  const candidates: Array<[string, string]> = [
    ["extendedTextMessage", "text"],
    ["imageMessage", "caption"],
    ["videoMessage", "caption"],
    ["documentMessage", "caption"],
    ["buttonsResponseMessage", "selectedDisplayText"],
    ["listResponseMessage", "title"],
    ["templateButtonReplyMessage", "selectedDisplayText"],
    ["interactiveResponseMessage", "body"],
  ];
  for (const [kind, field] of candidates) {
    const value = record(content[kind])?.[field];
    const text = stringValue(value) ?? stringValue(record(value)?.text);
    if (text) return text;
  }
  return "";
}

const ATTACHMENT_TYPES = new Set([
  "audioMessage",
  "documentMessage",
  "imageMessage",
  "stickerMessage",
  "videoMessage",
]);

export function normalizeMessage(message: WAMessage): MessageInput | undefined {
  const chatJid = stringValue(message.key.remoteJid);
  const id = stringValue(message.key.id);
  const content = unwrapMessage(message.message);
  const seconds = numberValue(message.messageTimestamp);
  if (!chatJid || !id || !content || seconds === undefined) return undefined;
  const type = getContentType(content as NonNullable<WAMessage["message"]>) ?? "unknown";
  const participant = stringValue(message.key.participant);
  const pushName = stringValue(message.pushName);
  return {
    chatJid,
    id,
    ...(participant ? { senderJid: participant } : message.key.fromMe ? {} : { senderJid: chatJid }),
    fromMe: Boolean(message.key.fromMe),
    timestampMs: Math.trunc(seconds * 1000),
    text: extractText(content),
    messageType: type,
    hasAttachment: ATTACHMENT_TYPES.has(type),
    ...(pushName ? { pushName } : {}),
  };
}

export function normalizeChat(value: unknown): ChatInput | undefined {
  const chat = record(value);
  const jid = stringValue(chat?.id);
  if (!chat || !jid) return undefined;
  const conversationTimestamp = numberValue(chat.conversationTimestamp);
  const title = stringValue(chat.name) ?? stringValue(chat.subject);
  const unreadCount = numberValue(chat.unreadCount);
  return {
    jid,
    ...(title ? { title } : {}),
    ...(unreadCount === undefined ? {} : { unreadCount }),
    ...(conversationTimestamp === undefined ? {} : { lastMessageAt: Math.trunc(conversationTimestamp * 1000) }),
  };
}

export function normalizeContact(value: unknown): ContactInput | undefined {
  const contact = record(value);
  const jid = stringValue(contact?.id);
  if (!contact || !jid) return undefined;
  const phoneFromJid = jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : undefined;
  const displayName = stringValue(contact.name);
  const notifyName = stringValue(contact.notify) ?? stringValue(contact.verifiedName);
  const phone = stringValue(contact.phoneNumber) ?? phoneFromJid;
  return {
    jid,
    ...(displayName ? { displayName } : {}),
    ...(notifyName ? { notifyName } : {}),
    ...(phone ? { phone } : {}),
  };
}
