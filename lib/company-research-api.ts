/**
 * @fileoverview Coordinates saved company research without holding SQLite locks during network work.
 * Accepts round identity from clients; company data and profiles come from local server storage.
 *
 * Runs lib/company-research.ts and persists attempts through lib/company-research-storage.ts.
 * Reads Discovery inputs through lib/funding-storage.ts without refreshing the funding feed.
 * See docs/company-research-engine.md for endpoints and run lifecycle.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createFundingStorage } from "./funding-storage";
import { parseResearchProfile, researchCompany, researchErrorDetails, RESEARCH_LIMITS, RESEARCH_MODEL, RESEARCH_PROMPT_VERSION,
  type ResearchCompany, type ResearchProfile, type ResearchResult } from "./company-research";
import { withCompanyResearchStore, type ResearchRunSummary, type SavedResearchRun } from "./company-research-storage";
import { logger, type LogFields } from "./logger";

const headers = { "Cache-Control": "no-store" };
// Allow result validation/persistence time beyond the engine's 90-second network deadline.
export const RESEARCH_CLAIM_MS = RESEARCH_LIMITS.timeoutMs + 30_000;
export type ResearchContext = { params: Promise<{ slug: string }> };

class ResearchApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function errorResponse(error: unknown, context: LogFields): Response {
  const status = error instanceof ResearchApiError ? error.status : 500;
  const details = researchErrorDetails(error);
  const fields = { ...context, ...details, status,
    errorCode: error instanceof ResearchApiError ? error.code : details.errorCode ?? "internal_error" };
  if (status < 500) logger.warn("research.request_failed", fields);
  else logger.error("research.request_failed", fields);
  if (error instanceof ResearchApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
  return Response.json({ error: { code: "internal_error", message: "Could not load or save company research." } }, { status: 500, headers });
}

// Compare JSON content rather than insertion order, retaining the exact input snapshots separately.
export function researchInputHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function announcedDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ResearchApiError(400, "invalid_input", "announcedDate must be a valid UTC date (YYYY-MM-DD).");
  }
  return value;
}

// The funding feed remains read-only; an absent round can still have saved research history.
function findDiscoveryCompany(slug: string, date: string): ResearchCompany | undefined {
  const snapshot = createFundingStorage().readLatestSnapshot();
  return snapshot?.companies.find(company => company.slug === slug && typeof company.announced_at === "string" &&
    Number.isFinite(Date.parse(company.announced_at)) && new Date(company.announced_at).toISOString().slice(0, 10) === date);
}

async function loadProfile(): Promise<ResearchProfile> {
  try { return parseResearchProfile(JSON.parse(await readFile("data/profile.json", "utf8"))); }
  catch { throw new ResearchApiError(503, "profile_unavailable", "Create a valid data/profile.json before starting research."); }
}

// Missing current inputs make freshness unknown, not a reason to hide saved assessments.
function freshness(run: ResearchRunSummary, companyHash: string | null, profileHash: string | null) {
  const staleReasons: string[] = [];
  if (companyHash !== null && run.companyInputHash !== companyHash) staleReasons.push("company_input_changed");
  if (profileHash !== null && run.profileHash !== profileHash) staleReasons.push("profile_changed");
  if (run.model !== RESEARCH_MODEL) staleReasons.push("model_changed");
  if (run.promptVersion !== RESEARCH_PROMPT_VERSION) staleReasons.push("prompt_changed");
  return { stale: staleReasons.length ? true : companyHash !== null && profileHash !== null ? false : null, staleReasons };
}

// Stored profile snapshots are for reproducibility, not part of the browser response.
function runView(run: SavedResearchRun, companyHash: string | null, profileHash: string | null) {
  const { profile: _profile, ...view } = run;
  void _profile;
  return { ...view, ...freshness(run, companyHash, profileHash) };
}

export async function companyResearchRead(request: Request, slug: string): Promise<Response> {
  // 1. Validate the round and read available current inputs without requiring a model API key.
  // 2. Expire abandoned claims and read the round's history in one local transaction.
  // 3. Return selected evidence plus freshness, keeping old successes visible after failed reruns.
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !["announcedDate", "runId"].includes(key)) ||
        query.getAll("announcedDate").length !== 1 || query.getAll("runId").length > 1) {
      throw new ResearchApiError(400, "invalid_input", "Supply announcedDate and an optional runId.");
    }
    const date = announcedDate(query.get("announcedDate"));
    const company = findDiscoveryCompany(slug, date);
    let profile: ResearchProfile | null = null;
    try { profile = await loadProfile(); } catch { /* Saved research remains readable without a valid current profile. */ }
    const companyHash = company ? researchInputHash(company) : null;
    const profileHash = profile ? researchInputHash(profile) : null;
    return withCompanyResearchStore(store => store.transaction(() => {
      store.expireRuns(slug, date, new Date().toISOString());
      const runId = query.get("runId");
      if (runId !== null) {
        const run = store.getRun(runId);
        if (!run || run.companySlug !== slug || run.announcedDate !== date) throw new ResearchApiError(404, "not_found", "Research run not found for this round.");
        return Response.json({ run: runView(run, companyHash, profileHash) }, { headers });
      }
      const history = store.listRuns(slug, date);
      const successful = history.find(run => run.status === "completed" && run.promptVersion === RESEARCH_PROMPT_VERSION);
      return Response.json({ companySlug: slug, announcedDate: date,
        currentInputsAvailable: { company: !!company, profile: !!profile },
        latestAttempt: history[0] ? runView(store.getRun(history[0].id)!, companyHash, profileHash) : null,
        latestSuccessful: successful ? runView(store.getRun(successful.id)!, companyHash, profileHash) : null,
        history: history.map(run => ({ ...run, ...freshness(run, companyHash, profileHash) })),
      }, { headers });
    }));
  } catch (error) { return errorResponse(error, { companySlug: slug, stage: "read", requestId: randomUUID() }); }
}

export async function companyResearchStart(request: Request, slug: string): Promise<Response> {
  // 1. Resolve trusted local inputs and commit an exclusive, expiring round claim.
  // 2. Run bounded research outside any database callback or transaction.
  // 3. Commit the result only if the claim remains active, then report the saved state.
  const id = randomUUID();
  let stage = "input";
  try {
    let input: unknown;
    try { input = await request.json(); } catch { throw new ResearchApiError(400, "invalid_input", "Body must be valid JSON."); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("announcedDate" in input)) {
      throw new ResearchApiError(400, "invalid_input", "Supply only announcedDate; company and profile inputs are loaded locally.");
    }
    const date = announcedDate(input.announcedDate);
    const company = findDiscoveryCompany(slug, date);
    if (!company) throw new ResearchApiError(404, "not_found", "Company round not found in the current Discovery snapshot.");
    const profile = await loadProfile();
    if (!process.env.GROQ_API_KEY?.trim()) throw new ResearchApiError(503, "model_unavailable", "Configure GROQ_API_KEY before starting research.");
    request.signal.throwIfAborted();
    const now = new Date();
    const companyHash = researchInputHash(company);
    const profileHash = researchInputHash(profile);
    stage = "claim";
    const claim = withCompanyResearchStore(store => store.transaction(() => {
      store.expireRuns(slug, date, now.toISOString());
      const active = store.listRuns(slug, date).find(run => run.status === "running");
      if (active) return { activeId: active.id };
      store.insertRun({ id, companySlug: slug, announcedDate: date, companyInput: company, companyInputHash: companyHash,
        profile, profileHash, model: RESEARCH_MODEL, promptVersion: RESEARCH_PROMPT_VERSION,
        startedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + RESEARCH_CLAIM_MS).toISOString() });
      return { activeId: null };
    }));
    if (claim.activeId) {
      logger.warn("research.claim_conflict", { runId: claim.activeId, companySlug: slug, announcedDate: date });
      return Response.json({ error: { code: "conflict", message: "Research is already running for this round." }, runId: claim.activeId }, { status: 409, headers });
    }
    logger.info("research.claimed", { runId: id, companySlug: slug, announcedDate: date });

    let result: ResearchResult;
    stage = "engine";
    try { result = await researchCompany(company, profile, { signal: request.signal, runId: id }); }
    catch (error) {
      logger.error("research.engine_failed", { runId: id, companySlug: slug, ...researchErrorDetails(error) });
      result = { company_slug: slug, model: RESEARCH_MODEL, prompt_version: RESEARCH_PROMPT_VERSION,
        started_at: now.toISOString(), finished_at: new Date().toISOString(), status: "failed",
        error: "Research stopped unexpectedly before producing a result.", sources: [], tools: [], calls: [] };
    }
    stage = "save";
    const saved = withCompanyResearchStore(store => store.transaction(() => {
      const finishedAt = new Date().toISOString();
      store.expireRuns(slug, date, finishedAt);
      if (!store.finishRun(id, result, finishedAt)) return null;
      return store.getRun(id)!;
    }));
    if (!saved) throw new ResearchApiError(409, "conflict", "Research claim expired or was already closed. Reload saved research before retrying.");
    logger.info("research.saved", { runId: id, companySlug: slug, status: saved.status });
    return Response.json({ run: runView(saved, companyHash, profileHash) }, { status: saved.status === "completed" ? 201 : 502, headers });
  } catch (error) { return errorResponse(error, { runId: id, companySlug: slug, stage }); }
}
