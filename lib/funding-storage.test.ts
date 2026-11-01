import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../fixtures/companies.json";
import { createFundingStorage, type FundingSnapshot } from "./funding-storage";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), "funding-storage-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function snapshot(day = "01", coverage: FundingSnapshot["coverage"] = "complete"): FundingSnapshot {
  return { fetchedAt: `2026-11-${day}T12:00:00Z`, windowStart: "2026-10-11T00:00:00Z",
    windowEnd: "2026-10-18T00:00:00Z", coverage, companies: fixture.companies };
}

it("starts empty and preserves fixture company fields across storage instances", () => {
  const store = createFundingStorage(directory);
  expect(store.readState()).toBeNull();
  expect(store.readLatestSnapshot()).toBeNull();
  store.saveSnapshot(snapshot());
  expect(createFundingStorage(directory).readLatestSnapshot()).toEqual(snapshot());
});

it("archives days and selects the newest complete snapshot without resetting request state", () => {
  const store = createFundingStorage(directory);
  const state = { budgetDate: "2026-11-02", callsAttempted: 3,
    nextAllowedAttemptAt: "2026-11-02T13:00:00Z", latestCompleteSnapshot: null };
  store.saveState(state);
  store.saveSnapshot(snapshot());
  store.saveSnapshot(snapshot("02"));
  store.saveSnapshot(snapshot("03", "partial"));
  expect(store.readState()).toEqual({ ...state, latestCompleteSnapshot: "snapshots/2026-11-02.json" });
  expect(store.readLatestSnapshot()).toEqual(snapshot("02"));
  expect(fs.readdirSync(join(directory, "snapshots"))).toHaveLength(3);
  expect(() => store.saveSnapshot({ ...snapshot("02"), companies: [] })).toThrow("already exists");
});

it("does not move the pointer backward when archiving an older day", () => {
  const store = createFundingStorage(directory);
  store.saveSnapshot(snapshot("02"));
  store.saveSnapshot(snapshot());
  expect(store.readLatestSnapshot()).toEqual(snapshot("02"));
});

it("keeps the previous snapshot and cleans temporary files when snapshot rename fails", () => {
  const store = createFundingStorage(directory);
  store.saveSnapshot(snapshot());
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk failure"); });
  expect(() => store.saveSnapshot(snapshot("02"))).toThrow("disk failure");
  expect(store.readLatestSnapshot()).toEqual(snapshot());
  expect(fs.readdirSync(join(directory, "snapshots"))).toEqual(["2026-11-01.json"]);
});

it("keeps the old pointer if publishing state fails after the archive is saved", () => {
  const store = createFundingStorage(directory);
  store.saveSnapshot(snapshot());
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (target === join(directory, "state.json")) throw new Error("state failure");
    rename(source, target);
  });
  expect(() => store.saveSnapshot(snapshot("02"))).toThrow("state failure");
  expect(store.readLatestSnapshot()).toEqual(snapshot());
  expect(fs.readdirSync(directory)).toEqual(["snapshots", "state.json"]);
});

it("rejects corrupt state and unsafe snapshot paths instead of treating them as empty", () => {
  const store = createFundingStorage(directory);
  fs.writeFileSync(join(directory, "state.json"), "broken");
  expect(() => store.readState()).toThrow();
  expect(() => store.saveState({ budgetDate: "2026-11-01", callsAttempted: 0,
    nextAllowedAttemptAt: null, latestCompleteSnapshot: "../other.json" })).toThrow("Invalid funding state");
});

it("reports missing or corrupt selected snapshots", () => {
  const store = createFundingStorage(directory);
  store.saveSnapshot(snapshot());
  const path = join(directory, "snapshots/2026-11-01.json");
  fs.writeFileSync(path, "{}");
  expect(() => store.readLatestSnapshot()).toThrow("Invalid funding snapshot");
  fs.unlinkSync(path);
  expect(() => store.readLatestSnapshot()).toThrow("missing");
});
