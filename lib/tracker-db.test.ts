import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openTrackerDatabase } from "./tracker-db";

let directory: string;
let path: string;
const connections: DatabaseSync[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tracker-db-"));
  path = join(directory, "nested", "tracker.sqlite");
});
afterEach(() => {
  for (const db of connections.splice(0)) if (db.isOpen) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function open() {
  const db = openTrackerDatabase(path);
  connections.push(db);
  return db;
}

it("creates the directory and schema, then preserves records on reopen", () => {
  const db = open();
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name))
    .toEqual(["companies", "contacts", "messages", "sequences"]);
  db.prepare("INSERT INTO companies VALUES (?, ?, ?, ?)").run("c", "Sample", "Notes", 0);
  db.close();
  const reopened = open();
  expect(reopened.prepare("SELECT * FROM companies").get()).toMatchObject({ id: "c", name: "Sample", notes: "Notes", position: 0 });
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

it("rolls back a failed multi-record transaction", () => {
  const db = open();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("INSERT INTO companies VALUES ('c', 'Sample', '', 0)");
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
  db.exec("PRAGMA user_version = 2");
  db.close();
  expect(() => open()).toThrow("Unsupported tracker database schema version: 2");
  const raw = new DatabaseSync(path);
  connections.push(raw);
  raw.exec("BEGIN IMMEDIATE");
  expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
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
