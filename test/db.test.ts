import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatResolutionError, Repository } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { Queries } from "../src/queries.js";

let db: Database.Database;
let repository: Repository;
let queries: Queries;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  repository = new Repository(db);
  queries = new Queries(db);
});

afterEach(() => db.close());

function seed(): void {
  repository.upsertChat({ jid: "familia@g.us", title: "Familia" });
  repository.upsertMessage({
    chatJid: "familia@g.us",
    id: "m1",
    senderJid: "ana@s.whatsapp.net",
    fromMe: false,
    timestampMs: Date.parse("2026-09-02T12:00:00Z"),
    text: "Almuerzo familiar mañana",
    messageType: "conversation",
    hasAttachment: false,
    pushName: "Ana",
  });
  repository.upsertMessage({
    chatJid: "familia@g.us",
    id: "m2",
    fromMe: true,
    timestampMs: Date.parse("2026-09-02T12:01:00Z"),
    text: "Confirmado",
    messageType: "conversation",
    hasAttachment: false,
  });
}

describe("migraciones y escritura idempotente", () => {
  it("aplica la migración una sola vez", () => {
    migrate(db);
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      expect.objectContaining({ version: 1 }),
    ]);
  });

  it("actualiza un mensaje repetido sin duplicarlo ni romper FTS", () => {
    seed();
    repository.upsertMessage({
      chatJid: "familia@g.us",
      id: "m1",
      senderJid: "ana@s.whatsapp.net",
      fromMe: false,
      timestampMs: Date.parse("2026-09-02T12:00:00Z"),
      text: "Cena familiar mañana",
      messageType: "conversation",
      hasAttachment: false,
    });

    expect(db.prepare("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 2 });
    expect(queries.searchMessages("almuerzo", { limit: 10 })).toEqual([]);
    expect(queries.searchMessages("cena", { limit: 10 })).toHaveLength(1);
  });
});

describe("consultas", () => {
  it("busca texto y filtra por chat y fecha", () => {
    seed();
    const results = queries.searchMessages("almuerzo familiar", {
      chat: "Familia",
      fromMs: Date.parse("2026-09-02T00:00:00Z"),
      toExclusiveMs: Date.parse("2026-09-03T00:00:00Z"),
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "m1", sender_name: "Ana", chat_title: "Familia" });
  });

  it("devuelve los mensajes recientes en orden cronológico", () => {
    seed();
    expect(queries.getMessages("familia@g.us", { limit: 2 }).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("escapa comodines al resolver nombres y reporta ambigüedad", () => {
    repository.upsertChat({ jid: "uno@g.us", title: "EquipoX" });
    expect(() => repository.resolveChat("Equipo_")).toThrow(ChatResolutionError);
    try {
      repository.resolveChat("Equipo_");
    } catch (error) {
      expect(error).toMatchObject({ code: "chat_not_found", candidates: [] });
    }

    repository.upsertChat({ jid: "dos@g.us", title: "Familia trabajo" });
    repository.upsertChat({ jid: "tres@g.us", title: "Familia amigos" });
    expect(() => repository.resolveChat("Familia")).toThrowError(/más de un chat/);
  });

  it("rechaza búsquedas sin términos útiles", () => {
    expect(() => queries.searchMessages("---", { limit: 10 })).toThrow(/letras o números/);
  });
});
