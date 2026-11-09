/**
 * @fileoverview Verifies research persistence, round isolation, and claim recovery in temporary SQLite databases.
 * Exercises lib/company-research-storage.ts without model or network requests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import fixture from "../fixtures/companies.json";
import { openTrackerDatabase } from "./tracker-db";
import { createCompanyResearchStorage, type NewResearchRun } from "./company-research-storage";
import { RESEARCH_MODEL, RESEARCH_PROMPT_VERSION, type ResearchResult } from "./company-research";

let directory: string;
let db: DatabaseSync;
let store: ReturnType<typeof createCompanyResearchStorage>;
const company = fixture.companies[0];
const now = "2026-11-08T12:00:00.000Z";
const deadline = "2026-11-08T12:02:00.000Z";
const profile = { target: ["SWE"], experience: [], hard_nos: [], preferences: [] };

function attempt(id = "run", date = "2026-10-20"): NewResearchRun {
  return { id, companySlug: company.slug, announcedDate: date, companyInput: company, companyInputHash: "company-hash",
    profile, profileHash: "profile-hash", model: RESEARCH_MODEL, promptVersion: RESEARCH_PROMPT_VERSION,
    startedAt: now, deadlineAt: deadline };
}

function failure(message = "Page unavailable"): Extract<ResearchResult, { status: "failed" }> {
  return { company_slug: company.slug, model: RESEARCH_MODEL, prompt_version: RESEARCH_PROMPT_VERSION,
    started_at: now, finished_at: now, status: "failed", error: message, sources: [], tools: [], calls: [] };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "research-storage-"));
  db = openTrackerDatabase(join(directory, "tracker.sqlite"));
  store = createCompanyResearchStorage(db);
});
afterEach(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });

it("persists exact inputs, evidence, and diagnostics across connection reopen", () => {
  store.transaction(() => store.insertRun(attempt()));
  const result = { ...failure(), tools: [{ url: company.website, error: "HTTP 403", duration_ms: 10 }] };
  expect(store.finishRun("run", result, now)).toBe(true);
  db.close();
  db = openTrackerDatabase(join(directory, "tracker.sqlite"));
  store = createCompanyResearchStorage(db);
  expect(store.getRun("run")).toEqual({ ...attempt(), status: "failed", finishedAt: now, error: result.error, result });
  expect(store.listRuns(company.slug, "2026-10-20")[0]).not.toHaveProperty("profile");
  expect(store.listRuns(company.slug, "2026-10-20")[0]).not.toHaveProperty("result");
});

it("enforces one active run per round across database connections", () => {
  store.insertRun(attempt());
  const other = openTrackerDatabase(join(directory, "tracker.sqlite"));
  try {
    expect(() => createCompanyResearchStorage(other).insertRun(attempt("duplicate"))).toThrow(/UNIQUE/);
    createCompanyResearchStorage(other).insertRun(attempt("different-round", "2026-11-01"));
    expect(store.listRuns(company.slug, "2026-11-01")).toHaveLength(1);
    expect(store.listRuns("unrelated", "2026-10-20")).toEqual([]);
  } finally { other.close(); }
});

it("expires abandoned runs and rejects late results after a replacement claim", () => {
  store.insertRun(attempt());
  store.expireRuns(company.slug, "2026-10-20", now);
  expect(store.getRun("run")!.status).toBe("running");
  store.transaction(() => {
    store.expireRuns(company.slug, "2026-10-20", deadline);
    store.insertRun({ ...attempt("replacement"), startedAt: deadline, deadlineAt: "2026-11-08T12:04:00.000Z" });
  });
  expect(store.getRun("run")).toMatchObject({ status: "failed", result: null, finishedAt: deadline });
  expect(store.finishRun("run", failure("Late response"), deadline)).toBe(false);
  expect(store.getRun("replacement")!.status).toBe("running");
  expect(store.getRun("run")!.error).toContain("deadline expired");
});

it("rolls back expiration when replacement insertion fails", () => {
  store.insertRun(attempt());
  db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON research_runs BEGIN SELECT RAISE(ABORT, 'Insert failed'); END;");
  expect(() => store.transaction(() => {
    store.expireRuns(company.slug, "2026-10-20", deadline);
    store.insertRun(attempt("replacement"));
  })).toThrow("Insert failed");
  expect(store.getRun("run")!.status).toBe("running");
  expect(store.getRun("replacement")).toBeUndefined();
  expect(db.isTransaction).toBe(false);
});

it("keeps terminal runs immutable and orders equal-time attempts by insertion", () => {
  store.insertRun(attempt());
  expect(store.finishRun("run", failure("First error"), now)).toBe(true);
  expect(store.finishRun("run", failure("Changed error"), now)).toBe(false);
  store.insertRun(attempt("retry"));
  expect(store.listRuns(company.slug, "2026-10-20").map(run => run.id)).toEqual(["retry", "run"]);
  expect(store.getRun("run")!.error).toBe("First error");
});

it("rejects finishing with another company's result or after the deadline", () => {
  store.insertRun(attempt());
  expect(store.finishRun("run", { ...failure(), company_slug: "other" }, now)).toBe(false);
  expect(store.finishRun("run", failure(), deadline)).toBe(false);
  expect(store.getRun("run")!.status).toBe("running");
});

it("enforces lifecycle constraints in SQLite", () => {
  store.insertRun(attempt());
  expect(() => db.exec("UPDATE research_runs SET status = 'completed'")).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE research_runs SET profile_json = 'broken'")).toThrow();
  expect(() => db.exec("UPDATE research_runs SET result_json = '[]', status = 'completed', finished_at = 'now'")).toThrow(/CHECK/);
  expect(store.getRun("run")!.status).toBe("running");
});
