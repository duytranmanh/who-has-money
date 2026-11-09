/**
 * @fileoverview Opens and atomically upgrades the shared local tracker and research database.
 * Owns schema migrations; business transactions belong to the feature orchestration layers.
 *
 * Used by lib/tracker-storage.ts for the lazy connection shared with company research storage.
 */

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

type Migration = { version: number; name: string; up: (db: DatabaseSync) => void };

// Append consecutive versions; applied migrations must stay unchanged for older databases.
// The opener owns the transaction and version updates, so migrations only perform schema/data changes.
const migrations: Migration[] = [
  { version: 1, name: "Create tracker tables", up: db => { db.exec(schema); } },
  { version: 2, name: "Add tracker metadata", up: db => {
    db.exec(`CREATE TABLE tracker_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;`);
  } },
  { version: 3, name: "Add company timestamps", up: db => {
    // 1. Add timestamp columns without defaults for future inserts.
    // 2. Backfill synthetic dates in existing company order within the opener's transaction.
    // Historical creation and edit times cannot be reconstructed from outreach timestamps.
    db.exec(`ALTER TABLE companies ADD COLUMN created_at TEXT;
      ALTER TABLE companies ADD COLUMN updated_at TEXT;`);
    const baseline = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const companies = db.prepare("SELECT id FROM companies ORDER BY position, rowid").all();
    const update = db.prepare("UPDATE companies SET created_at = ?, updated_at = ? WHERE id = ?");
    companies.forEach((company, index) => {
      const at = new Date(baseline + index * 60 * 1000).toISOString();
      update.run(at, at, company.id);
    });
  } },
  { version: 4, name: "Add company research runs", up: db => {
    db.exec(`CREATE TABLE research_runs (
      id TEXT PRIMARY KEY NOT NULL,
      company_slug TEXT NOT NULL,
      announced_date TEXT NOT NULL,
      company_input_json TEXT NOT NULL CHECK (json_valid(company_input_json) AND json_type(company_input_json) = 'object'),
      company_input_hash TEXT NOT NULL,
      profile_json TEXT NOT NULL CHECK (json_valid(profile_json) AND json_type(profile_json) = 'object'),
      profile_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      deadline_at TEXT NOT NULL,
      result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
      error TEXT,
      CHECK ((status = 'running' AND finished_at IS NULL AND result_json IS NULL AND error IS NULL)
        OR (status = 'completed' AND finished_at IS NOT NULL AND result_json IS NOT NULL AND error IS NULL)
        OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL))
    ) STRICT;
    CREATE INDEX research_runs_round ON research_runs(company_slug, announced_date, started_at DESC);
    CREATE UNIQUE INDEX research_runs_active ON research_runs(company_slug, announced_date) WHERE status = 'running';`);
  } },
];

// Open and upgrade the database atomically; reject newer schemas and close on failure.
// Callers own closing a successfully returned connection.
export function openTrackerDatabase(filePath: string): DatabaseSync {
  // 1. Open the connection and configure SQLite.
  // 2. Lock the database and check schema compatibility.
  // 3. Apply pending migrations and commit; roll back and close on failure.
  if (filePath !== ":memory:") mkdirSync(dirname(resolve(filePath)), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Acquire the write lock before checking the version so concurrent openers cannot both migrate.
    db.exec("BEGIN IMMEDIATE;");
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version < 0 || version > migrations.at(-1)!.version) {
      throw new Error(`Unsupported tracker database schema version: ${version}.`);
    }
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version};`);
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
