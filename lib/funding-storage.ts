import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { FundingSnapshot, FundingState } from "./funding";
export type { FundingCompany, FundingSnapshot, FundingState } from "./funding";

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateSnapshot(value: FundingSnapshot): void {
  if (!value || !timestamp(value.fetchedAt) || !timestamp(value.windowStart) || !timestamp(value.windowEnd) ||
      Date.parse(value.windowStart) >= Date.parse(value.windowEnd) ||
      !["complete", "partial"].includes(value.coverage) || !Array.isArray(value.companies) ||
      !value.companies.every(company => company && typeof company.slug === "string" && typeof company.name === "string")) {
    throw new Error("Invalid funding snapshot.");
  }
}

function validateState(value: FundingState): void {
  if (!value || typeof value.budgetDate !== "string" || !validDate(value.budgetDate) ||
      !Number.isSafeInteger(value.callsAttempted) || value.callsAttempted < 0 ||
      !(value.transientFailures === undefined || (Number.isSafeInteger(value.transientFailures) && value.transientFailures >= 0)) ||
      !(value.nextAllowedAttemptAt === null || timestamp(value.nextAllowedAttemptAt)) ||
      !(value.latestCompleteSnapshot === null || (typeof value.latestCompleteSnapshot === "string" &&
        /^snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(value.latestCompleteSnapshot) &&
        validDate(value.latestCompleteSnapshot.slice(10, 20))))) {
    throw new Error("Invalid funding state.");
  }
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Same-directory rename keeps readers from seeing a partially written JSON file.
function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Server-only file storage. The collector must serialize mutations with its own lock.
export function createFundingStorage(directory = resolve("data/recent-funding")) {
  const statePath = join(directory, "state.json");

  // Exclusive file creation coordinates collectors across processes. After a crash,
  // remove collector.lock manually only after confirming no collector is running.
  function acquireLock(): (() => void) | null {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "collector.lock");
    let fd: number;
    try { fd = openSync(path, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return () => { closeSync(fd); rmSync(path); };
  }

  function readState(): FundingState | null {
    const state = readJson<FundingState>(statePath);
    if (state !== null) validateState(state);
    return state;
  }

  function saveState(state: FundingState): void {
    validateState(state);
    atomicWrite(statePath, state);
  }

  function readLatestSnapshot(): FundingSnapshot | null {
    const path = readState()?.latestCompleteSnapshot;
    if (!path) return null;
    const snapshot = readJson<FundingSnapshot>(join(directory, path));
    if (!snapshot) throw new Error("Latest funding snapshot is missing.");
    validateSnapshot(snapshot);
    if (snapshot.coverage !== "complete") throw new Error("Latest funding snapshot is incomplete.");
    return snapshot;
  }

  // Complete daily snapshots are immutable. Partial attempts never replace the selected snapshot.
  // A failed state write may leave an unselected archive; the previous pointer stays intact.
  function saveSnapshot(snapshot: FundingSnapshot): string {
    validateSnapshot(snapshot);
    const date = new Date(snapshot.fetchedAt).toISOString().slice(0, 10);
    const path = `snapshots/${date}${snapshot.coverage === "partial" ? ".partial" : ""}.json`;
    const state = readState();
    const existing = readJson<FundingSnapshot>(join(directory, path));
    if (snapshot.coverage === "complete" && existing !== null && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error("A complete funding snapshot already exists for this UTC day.");
    }
    atomicWrite(join(directory, path), snapshot);
    if (snapshot.coverage === "complete") {
      const currentPath = state?.latestCompleteSnapshot;
      if (!currentPath || path > currentPath) {
        saveState({ budgetDate: date, callsAttempted: 0, nextAllowedAttemptAt: null, ...state,
          latestCompleteSnapshot: path });
      }
    }
    return path;
  }

  // Allows recovery when an archive was saved but publishing its pointer failed.
  function readCompleteSnapshot(date: string): FundingSnapshot | null {
    if (!validDate(date)) throw new Error("Invalid funding snapshot date.");
    const snapshot = readJson<FundingSnapshot>(join(directory, `snapshots/${date}.json`));
    if (snapshot) {
      validateSnapshot(snapshot);
      if (snapshot.coverage !== "complete") throw new Error("Funding snapshot is incomplete.");
    }
    return snapshot;
  }

  return { readState, saveState, readLatestSnapshot, saveSnapshot, acquireLock, readCompleteSnapshot };
}
