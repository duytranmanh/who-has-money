import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const schema = `
  CREATE TABLE companies (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    notes TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0)
  ) STRICT;
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    links_json TEXT NOT NULL CHECK (json_valid(links_json) AND json_type(links_json) = 'array'),
    position INTEGER NOT NULL CHECK (position >= 0)
  ) STRICT;
  CREATE INDEX contacts_company ON contacts(company_id, position);
  CREATE TABLE sequences (
    id TEXT PRIMARY KEY NOT NULL,
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    closed_at TEXT,
    close_reason TEXT CHECK (close_reason IN ('responded', 'completed', 'manual', 'restarted')),
    responded_at TEXT,
    position INTEGER NOT NULL CHECK (position >= 0)
  ) STRICT;
  CREATE INDEX sequences_contact ON sequences(contact_id, position);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    sequence_id TEXT NOT NULL REFERENCES sequences(id),
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'follow_up_1', 'follow_up_2')),
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    notes TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    UNIQUE (sequence_id, position),
    UNIQUE (sequence_id, kind)
  ) STRICT;
`;

// Initialize schema atomically. Callers own closing the returned server-side connection.
export function openTrackerDatabase(filePath: string): DatabaseSync {
  if (filePath !== ":memory:") mkdirSync(dirname(resolve(filePath)), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Acquire the write lock before checking the version so concurrent openers cannot both migrate.
    db.exec("BEGIN IMMEDIATE;");
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    if (version === 0) {
      db.exec(schema);
      db.exec("PRAGMA user_version = 1;");
    } else if (version !== 1) {
      throw new Error(`Unsupported tracker database schema version: ${version}.`);
    }
    db.exec("COMMIT;");
    return db;
  } catch (error) {
    // Preserve the original failure even if rollback or connection cleanup also fails.
    if (db.isTransaction) { try { db.exec("ROLLBACK;"); } catch {} }
    try { db.close(); } catch {}
    throw error;
  }
}
