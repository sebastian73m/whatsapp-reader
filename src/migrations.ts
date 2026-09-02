import type Database from "better-sqlite3";

type Migration = { version: number; sql: string };

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE contacts (
        jid TEXT PRIMARY KEY,
        display_name TEXT,
        notify_name TEXT,
        phone TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        title TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'other')),
        unread_count INTEGER,
        last_message_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        chat_jid TEXT NOT NULL,
        id TEXT NOT NULL,
        sender_jid TEXT,
        from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
        timestamp_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        message_type TEXT NOT NULL,
        has_attachment INTEGER NOT NULL CHECK (has_attachment IN (0, 1)),
        push_name TEXT,
        PRIMARY KEY (chat_jid, id),
        FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
      );

      CREATE INDEX idx_messages_chat_time ON messages(chat_jid, timestamp_ms, id);
      CREATE INDEX idx_messages_time ON messages(timestamp_ms);
      CREATE INDEX idx_chats_last_message ON chats(last_message_at DESC);

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        chat_jid UNINDEXED,
        message_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, chat_jid, message_id)
        VALUES (new.rowid, new.text, new.chat_jid, new.id);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, text, chat_jid, message_id)
        VALUES (new.rowid, new.text, new.chat_jid, new.id);
      END;
    `,
  },
];

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
      migration.version,
      new Date().toISOString(),
    );
  });
  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
