/**
 * @fileoverview Persists company research attempts by slug and UTC funding announcement date.
 * Keeps input snapshots and engine results independent of Applications companies.
 * Only exposes result payloads from the current research prompt version.
 *
 * Uses the connection and transaction mechanics in lib/tracker-storage.ts.
 * Called by lib/company-research-api.ts, which owns business transaction boundaries.
 * See docs/company-research-engine.md for lifecycle and API contracts.
 */

import type { DatabaseSync } from "node:sqlite";
import { RESEARCH_PROMPT_VERSION, type ResearchCompany, type ResearchProfile, type ResearchResult } from "./company-research";
import { createTrackerStorage, withTrackerDatabase } from "./tracker-storage";

export type ResearchRunSummary = {
  id: string; companySlug: string; announcedDate: string; companyInputHash: string; profileHash: string;
  model: string; promptVersion: string; status: "running" | "completed" | "failed";
  startedAt: string; finishedAt: string | null; deadlineAt: string; error: string | null;
};
export type SavedResearchRun = ResearchRunSummary & {
  companyInput: ResearchCompany; profile: ResearchProfile; result: ResearchResult | null;
};
export type NewResearchRun = Omit<SavedResearchRun, "status" | "finishedAt" | "error" | "result">;

const summaryColumns = `id, company_slug AS companySlug, announced_date AS announcedDate,
  company_input_hash AS companyInputHash, profile_hash AS profileHash, model, prompt_version AS promptVersion,
  status, started_at AS startedAt, finished_at AS finishedAt, deadline_at AS deadlineAt, error`;

// Callers supply and own the connection; asynchronous research must run outside transactions.
export function createCompanyResearchStorage(db: DatabaseSync) {
  const { transaction } = createTrackerStorage(db);

  // Summaries avoid loading profile snapshots and evidence for every historical attempt.
  function listRuns(companySlug: string, announcedDate: string): ResearchRunSummary[] {
    return db.prepare(`SELECT ${summaryColumns} FROM research_runs
      WHERE company_slug = ? AND announced_date = ? ORDER BY started_at DESC, rowid DESC`)
      .all(companySlug, announcedDate) as ResearchRunSummary[];
  }

  function getRun(id: string): SavedResearchRun | undefined {
    const row = db.prepare(`SELECT ${summaryColumns}, company_input_json, profile_json, result_json
      FROM research_runs WHERE id = ?`).get(id);
    if (!row) return undefined;
    const { company_input_json, profile_json, result_json, ...summary } = row;
    return { ...summary as ResearchRunSummary, companyInput: JSON.parse(company_input_json as string),
      profile: JSON.parse(profile_json as string),
      // Older result formats require an explicit rerun, not conversion on read.
      result: result_json === null || summary.promptVersion !== RESEARCH_PROMPT_VERSION ? null : JSON.parse(result_json as string) };
  }

  // Expiration and a new claim belong in one caller-owned transaction.
  // Terminal rows stay immutable so a late worker cannot overwrite a replacement attempt.
  function expireRuns(companySlug: string, announcedDate: string, now: string): void {
    db.prepare(`UPDATE research_runs SET status = 'failed', finished_at = ?,
      error = 'Research deadline expired before a result was saved.'
      WHERE company_slug = ? AND announced_date = ? AND status = 'running' AND deadline_at <= ?`)
      .run(now, companySlug, announcedDate, now);
  }

  function insertRun(run: NewResearchRun): void {
    db.prepare(`INSERT INTO research_runs (id, company_slug, announced_date, company_input_json,
      company_input_hash, profile_json, profile_hash, model, prompt_version, status, started_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(run.id, run.companySlug, run.announcedDate, JSON.stringify(run.companyInput), run.companyInputHash,
        JSON.stringify(run.profile), run.profileHash, run.model, run.promptVersion, run.startedAt, run.deadlineAt);
  }

  // Persist one terminal result only while the claim is live. The API owns failure reporting.
  function finishRun(id: string, result: ResearchResult, now: string): boolean {
    return db.prepare(`UPDATE research_runs SET status = ?, result_json = ?, error = ?, finished_at = ?
      WHERE id = ? AND status = 'running' AND deadline_at > ? AND company_slug = ? AND model = ? AND prompt_version = ?`)
      .run(result.status, JSON.stringify(result), result.status === "failed" ? result.error : null, now,
        id, now, result.company_slug, result.model, result.prompt_version).changes > 0;
  }

  return { transaction, listRuns, getRun, expireRuns, insertRun, finishRun };
}

export type CompanyResearchStore = ReturnType<typeof createCompanyResearchStorage>;

export function withCompanyResearchStore<T>(operation: (store: CompanyResearchStore) => T): T {
  return withTrackerDatabase(db => operation(createCompanyResearchStorage(db)));
}
