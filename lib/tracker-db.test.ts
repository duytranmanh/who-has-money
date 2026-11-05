import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTrackerDatabase } from "./tracker-db";

let directory: string;
let path: string;
const connections: DatabaseSync[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tracker-db-"));
  path = join(directory, "nested", "tracker.sqlite");
});
afterEach(() => {
  vi.useRealTimers();
  for (const db of connections.splice(0)) if (db.isOpen) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function open() {
  const db = openTrackerDatabase(path);
  connections.push(db);
  return db;
}

// Reconstruct the pre-timestamp schema so upgrade tests start with genuine legacy columns.
function openLegacy(version: 1 | 2) {
  const db = open();
  db.exec(`ALTER TABLE companies DROP COLUMN updated_at;
    ALTER TABLE companies DROP COLUMN created_at;
    PRAGMA user_version = ${version};`);
  if (version === 1) db.exec("DROP TABLE tracker_metadata");
  return db;
}

it("creates the directory and schema, then preserves records on reopen", () => {
  const db = open();
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name))
    .toEqual(["companies", "contacts", "messages", "sequences", "tracker_metadata"]);
  db.prepare("INSERT INTO companies (id, name, notes, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("c", "Sample", "Notes", 0, "2026-11-01T12:00:00.000Z", "2026-11-02T12:00:00.000Z");
  db.close();
  const reopened = open();
  expect(reopened.prepare("SELECT * FROM companies").get()).toMatchObject({ id: "c", name: "Sample", notes: "Notes", position: 0,
    created_at: "2026-11-01T12:00:00.000Z", updated_at: "2026-11-02T12:00:00.000Z" });
  expect(reopened.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
  expect(reopened.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
});

it("rejects orphan contacts, sequences, and messages", () => {
  const db = open();
  expect(() => db.exec("INSERT INTO contacts VALUES ('p', 'missing', 'Person', '', '[]', 0)"))
    .toThrow(/FOREIGN KEY/);
  expect(() => db.exec("INSERT INTO sequences VALUES ('s', 'missing', NULL, NULL, NULL, 0)"))
    .toThrow(/FOREIGN KEY/);
  expect(() => db.exec("INSERT INTO messages VALUES ('m', 'missing', 'initial', '', '2026-10-01T00:00:00Z', '', 0)"))
    .toThrow(/FOREIGN KEY/);
});

it("upgrades a version one database without changing tracker rows", () => {
  const db = openLegacy(1);
  db.exec("INSERT INTO companies VALUES ('old', 'Existing', 'Keep notes', 0);");
  db.close();
  const upgraded = open();
  expect(upgraded.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  expect(upgraded.prepare("SELECT * FROM tracker_metadata").all()).toEqual([]);
  expect(upgraded.prepare("SELECT * FROM companies").get())
    .toMatchObject({ id: "old", name: "Existing", notes: "Keep notes", position: 0,
      created_at: expect.any(String), updated_at: expect.any(String) });
});

it("upgrades version two data with synthetic timestamps without changing outreach", () => {
  const db = openLegacy(2);
  db.exec(`INSERT INTO companies VALUES ('old', 'Existing', 'Keep notes', 0);
    INSERT INTO contacts VALUES ('p', 'old', 'Alex', 'alex@example.com', '["https://example.com"]', 0);
    INSERT INTO sequences VALUES ('s', 'p', NULL, NULL, NULL, 0);
    INSERT INTO messages VALUES ('m', 's', 'initial', 'Hello', '2026-10-01T12:00:00Z', 'Notes', 0);
    INSERT INTO tracker_metadata VALUES ('json_import', '2026-10-29T03:34:14.965Z');`);
  const tables = ["contacts", "sequences", "messages", "tracker_metadata"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  db.close();
  const reopened = open();
  expect(reopened.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  expect(reopened.prepare("SELECT * FROM companies").get())
    .toMatchObject({ id: "old", name: "Existing", notes: "Keep notes", position: 0,
      created_at: expect.any(String), updated_at: expect.any(String) });
  expect(tables.map(table => reopened.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const schema = reopened.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
  reopened.close();
  expect(open().prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
});

it.each([1, 2] as const)("backfills version %i companies one minute apart in existing order, only once", version => {
  const db = openLegacy(version);
  db.exec(`INSERT INTO companies VALUES ('last', 'Last', '', 12);
    INSERT INTO companies VALUES ('first', 'First', '', 2);
    INSERT INTO companies VALUES ('middle', 'Middle', '', 7);`);
  db.close();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
  const upgraded = open();
  const expected = [
    { id: "first", created_at: "2026-10-25T12:00:00.000Z", updated_at: "2026-10-25T12:00:00.000Z" },
    { id: "middle", created_at: "2026-10-25T12:01:00.000Z", updated_at: "2026-10-25T12:01:00.000Z" },
    { id: "last", created_at: "2026-10-25T12:02:00.000Z", updated_at: "2026-10-25T12:02:00.000Z" },
  ];
  expect(upgraded.prepare("SELECT id, created_at, updated_at FROM companies ORDER BY created_at").all()).toEqual(expected);
  expect(upgraded.prepare("SELECT id FROM companies ORDER BY updated_at DESC").all().map(row => row.id))
    .toEqual(["last", "middle", "first"]);
  expect(upgraded.prepare("PRAGMA table_info(companies)").all().filter(row => ["created_at", "updated_at"].includes(row.name as string))
    .every(row => row.dflt_value === null)).toBe(true);
  upgraded.close();
  vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
  expect(open().prepare("SELECT id, created_at, updated_at FROM companies ORDER BY created_at").all()).toEqual(expected);
});

it("rolls back a failed multi-record transaction", () => {
  const db = open();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("INSERT INTO companies (id, name, notes, position) VALUES ('c', 'Sample', '', 0)");
    db.exec("INSERT INTO contacts VALUES ('p', 'missing', 'Person', '', '[]', 0)");
    throw new Error("Expected foreign key failure");
  } catch (error) {
    db.exec("ROLLBACK");
    expect(String(error)).toMatch(/FOREIGN KEY/);
  }
  expect(db.prepare("SELECT count(*) AS count FROM companies").get()).toMatchObject({ count: 0 });
});

it("leaves newer schemas untouched and releases the migration lock on failure", () => {
  const db = open();
  db.exec("PRAGMA user_version = 4");
  db.close();
  expect(() => open()).toThrow("Unsupported tracker database schema version: 4");
  const raw = new DatabaseSync(path);
  connections.push(raw);
  raw.exec("BEGIN IMMEDIATE");
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
  raw.exec("ROLLBACK");
});

it("rolls back partially applied schema initialization", () => {
  const rawPath = join(directory, "broken.sqlite");
  const raw = new DatabaseSync(rawPath);
  connections.push(raw);
  raw.exec("CREATE TABLE contacts (id TEXT)");
  expect(() => openTrackerDatabase(rawPath)).toThrow(/already exists/);
  expect(raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name)).toEqual(["contacts"]);
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 });
});

it("rolls back earlier migrations and their version updates when a later migration fails", () => {
  const rawPath = join(directory, "migration-failure.sqlite");
  const raw = new DatabaseSync(rawPath);
  connections.push(raw);
  raw.exec("CREATE TABLE tracker_metadata (key TEXT PRIMARY KEY, value TEXT)");
  expect(() => openTrackerDatabase(rawPath)).toThrow(/already exists/);
  expect(raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
    .toEqual(["tracker_metadata"]);
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 });
  raw.exec("BEGIN IMMEDIATE; ROLLBACK;");
});

it("rolls back a partially applied timestamp migration and leaves version two intact", () => {
  const db = openLegacy(2);
  db.exec(`INSERT INTO companies VALUES ('old', 'Existing', 'Keep notes', 0);
    ALTER TABLE companies ADD COLUMN updated_at TEXT;`);
  const before = db.prepare("SELECT * FROM companies").all();
  db.close();
  expect(() => open()).toThrow(/duplicate column/);
  const raw = new DatabaseSync(path);
  connections.push(raw);
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
  expect(raw.prepare("PRAGMA table_info(companies)").all().map(row => row.name))
    .toEqual(["id", "name", "notes", "position", "updated_at"]);
  expect(raw.prepare("SELECT * FROM companies").all()).toEqual(before);
  raw.exec("BEGIN IMMEDIATE; ROLLBACK;");
});

it("rolls back the schema and earlier backfilled rows when a later company update fails", () => {
  const db = openLegacy(2);
  db.exec(`INSERT INTO companies VALUES ('first', 'First', '', 0);
    INSERT INTO companies VALUES ('second', 'Second', '', 1);
    CREATE TRIGGER reject_backfill BEFORE UPDATE ON companies WHEN NEW.id = 'second'
      BEGIN SELECT RAISE(ABORT, 'Backfill failure'); END;`);
  const before = db.prepare("SELECT * FROM companies ORDER BY position").all();
  db.close();
  expect(() => open()).toThrow(/Backfill failure/);
  const raw = new DatabaseSync(path);
  connections.push(raw);
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
  expect(raw.prepare("PRAGMA table_info(companies)").all().map(row => row.name))
    .toEqual(["id", "name", "notes", "position"]);
  expect(raw.prepare("SELECT * FROM companies ORDER BY position").all()).toEqual(before);
  raw.exec("DROP TRIGGER reject_backfill");
  raw.close();
  const retried = open();
  expect(retried.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  expect(retried.prepare("SELECT created_at, updated_at FROM companies").all())
    .toEqual(Array(2).fill({ created_at: expect.any(String), updated_at: expect.any(String) }));
});
