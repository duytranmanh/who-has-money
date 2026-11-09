import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTrackerDatabase } from "./tracker-db";
import { createCompany } from "./tracker";

const state = vi.hoisted(() => ({ path: "" }));
vi.mock("./tracker-db", async importOriginal => {
  const actual = await importOriginal<typeof import("./tracker-db")>();
  return { openTrackerDatabase: vi.fn(() => actual.openTrackerDatabase(state.path)) };
});
const trackerGlobal = globalThis as typeof globalThis & { trackerDatabase?: DatabaseSync };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tracker-connection-"));
  state.path = join(directory, "tracker.sqlite");
  vi.mocked(openTrackerDatabase).mockClear();
  vi.resetModules();
});
afterEach(() => {
  if (trackerGlobal.trackerDatabase?.isOpen) trackerGlobal.trackerDatabase.close();
  delete trackerGlobal.trackerDatabase;
  rmSync(directory, { recursive: true, force: true });
});

it("opens lazily and reuses the same connection across requests and module reloads", async () => {
  const { withTrackerStore } = await import("./tracker-storage");
  expect(openTrackerDatabase).not.toHaveBeenCalled();
  withTrackerStore(store => store.insertCompany({ ...createCompany({ name: "Example" }), id: "company" }));
  const connection = trackerGlobal.trackerDatabase!;
  expect(connection.isOpen).toBe(true);
  expect(withTrackerStore(store => store.getCompany("company")!.name)).toBe("Example");
  vi.resetModules();
  const reloaded = await import("./tracker-storage");
  expect(reloaded.withTrackerStore(store => store.getCompany("company")!.name)).toBe("Example");
  expect(trackerGlobal.trackerDatabase).toBe(connection);
  expect(openTrackerDatabase).toHaveBeenCalledTimes(1);
});

it("rolls back failed transactions and keeps the connection usable", async () => {
  const { withTrackerStore } = await import("./tracker-storage");
  expect(() => withTrackerStore(store => store.transaction(() => {
    store.insertCompany({ ...createCompany({ name: "Rollback" }), id: "failed" });
    throw new Error("Failed operation");
  }))).toThrow("Failed operation");
  expect(trackerGlobal.trackerDatabase!.isOpen).toBe(true);
  expect(trackerGlobal.trackerDatabase!.isTransaction).toBe(false);
  expect(withTrackerStore(store => store.listCompanies())).toEqual([]);
  withTrackerStore(store => store.transaction(() => store.insertCompany({ ...createCompany({ name: "Saved" }), id: "saved" })));
  expect(openTrackerDatabase).toHaveBeenCalledTimes(1);
});

it("shares the tracker connection with research storage", async () => {
  const { withTrackerStore } = await import("./tracker-storage");
  const { withCompanyResearchStore } = await import("./company-research-storage");
  expect(openTrackerDatabase).not.toHaveBeenCalled();
  expect(withCompanyResearchStore(store => store.listRuns("example", "2026-11-01"))).toEqual([]);
  const connection = trackerGlobal.trackerDatabase!;
  expect(withTrackerStore(store => store.listCompanies())).toEqual([]);
  expect(trackerGlobal.trackerDatabase).toBe(connection);
  expect(openTrackerDatabase).toHaveBeenCalledTimes(1);
});
