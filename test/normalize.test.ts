import { describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import { normalizeChat, normalizeContact, normalizeMessage } from "../src/normalize.js";

function message(value: Partial<WAMessage>): WAMessage {
  return value as WAMessage;
}

describe("normalizeMessage", () => {
  it("normaliza texto recibido y deriva el remitente del chat directo", () => {
    expect(normalizeMessage(message({
      key: { remoteJid: "5491111111111@s.whatsapp.net", id: "m1", fromMe: false },
      messageTimestamp: 1_725_290_400,
      pushName: "Ana",
      message: { conversation: "  hola  " },
    }))).toEqual({
      chatJid: "5491111111111@s.whatsapp.net",
      id: "m1",
      senderJid: "5491111111111@s.whatsapp.net",
      fromMe: false,
      timestampMs: 1_725_290_400_000,
      text: "hola",
      messageType: "conversation",
      hasAttachment: false,
      pushName: "Ana",
    });
  });

  it("desenvuelve mensajes efímeros y conserva el caption del adjunto", () => {
    expect(normalizeMessage(message({
      key: { remoteJid: "120363000000000000@g.us", id: "m2", fromMe: false, participant: "5491222222222@s.whatsapp.net" },
      messageTimestamp: 1_725_290_401,
      message: {
        ephemeralMessage: {
          message: { imageMessage: { caption: "comprobante" } },
        },
      },
    }))).toMatchObject({
      senderJid: "5491222222222@s.whatsapp.net",
      text: "comprobante",
      messageType: "imageMessage",
      hasAttachment: true,
    });
  });

  it("omite mensajes incompletos", () => {
    expect(normalizeMessage(message({ key: { id: "sin-chat" }, message: { conversation: "hola" } }))).toBeUndefined();
  });
});

describe("normalización de metadatos", () => {
  it("normaliza chats sin materializar propiedades ausentes", () => {
    expect(normalizeChat({ id: "chat@g.us", subject: "Equipo", conversationTimestamp: 123, unreadCount: 0 })).toEqual({
      jid: "chat@g.us",
      title: "Equipo",
      unreadCount: 0,
      lastMessageAt: 123_000,
    });
    expect(normalizeChat({ id: "vacío@g.us" })).toEqual({ jid: "vacío@g.us" });
  });

  it("deriva el teléfono de contactos directos", () => {
    expect(normalizeContact({ id: "5491333333333@s.whatsapp.net", notify: "Luis" })).toEqual({
      jid: "5491333333333@s.whatsapp.net",
      notifyName: "Luis",
      phone: "5491333333333",
    });
  });
});
