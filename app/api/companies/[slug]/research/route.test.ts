/**
 * @fileoverview Exercises research HTTP lifecycle against temporary SQLite storage and fixture companies.
 * Mocks only external research and local input loading, keeping persistence and routes real.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "@/fixtures/companies.json";
import { openTrackerDatabase } from "@/lib/tracker-db";
import { createCompanyResearchStorage } from "@/lib/company-research-storage";
import { researchCompany, RESEARCH_MODEL, RESEARCH_PROMPT_VERSION, type ResearchResult } from "@/lib/company-research";
import { researchInputHash } from "@/lib/company-research-api";
import { logger } from "@/lib/logger";
import { GET, POST } from "./route";

const state = vi.hoisted(() => ({
  store: null as unknown as ReturnType<typeof createCompanyResearchStorage>,
  snapshot: null as { companies: typeof fixture.companies } | null,
  profile: {} as unknown, profileMissing: false, storageFailure: false,
}));
vi.mock("@/lib/company-research-storage", async original => ({
  ...await original<typeof import("@/lib/company-research-storage")>(),
  withCompanyResearchStore: (operation: (store: typeof state.store) => unknown) => {
    if (state.storageFailure) throw new Error("Private database path");
    return operation(state.store);
  },
}));
vi.mock("@/lib/company-research", async original => ({
  ...await original<typeof import("@/lib/company-research")>(), researchCompany: vi.fn(),
}));
vi.mock("@/lib/funding-storage", () => ({ createFundingStorage: () => ({ readLatestSnapshot: () => state.snapshot }) }));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  readFile: vi.fn(async (path: string) => {
    if (path !== "data/profile.json") throw new Error("Unexpected file access");
    if (state.profileMissing) throw new Error("Private profile path");
    return JSON.stringify(state.profile);
  }),
}));

const company = fixture.companies.find(company => company.slug === "growthware")!;
const date = new Date(company.announced_at!).toISOString().slice(0, 10);
const startTime = "2026-11-08T12:00:00.000Z";
const profile = { target: ["SWE"], experience: ["Backend work"], hard_nos: [], preferences: ["Small teams"] };
const context = (slug = company.slug) => ({ params: Promise.resolve({ slug }) });
const url = `http://localhost/api/companies/${company.slug}/research`;
const post = (input: unknown = { announcedDate: date }, slug = company.slug) => POST(new Request(url, { method: "POST", body: JSON.stringify(input) }), context(slug));
const get = (announcedDate = date, runId?: string, slug = company.slug) => GET(new Request(`${url}?announcedDate=${announcedDate}${runId ? `&runId=${runId}` : ""}`), context(slug));

function result(failed = false): ResearchResult {
  const base = { company_slug: company.slug, model: RESEARCH_MODEL, prompt_version: RESEARCH_PROMPT_VERSION,
    started_at: startTime, finished_at: new Date().toISOString(), sources: [], tools: [], calls: [] };
  if (failed) return { ...base, status: "failed", error: "No validated assessment" };
  return { ...base, status: "completed", assessment: {
    company_slug: company.slug, fit_judgment: "insufficient_evidence", fit_summary: "Needs more research.",
    reasons_connected_to_profile: [], mismatches: [], unknowns: ["Engineering needs"],
    hiring: { status: "unknown", summary: "No verified opening.", source_ids: [] },
    role_suitability: { status: "unknown", summary: "No role assessed.", source_ids: [] },
    recommended_next_step: { action: "further_research", reason: "Verify engineering needs." },
  } };
}

let directory: string;
let db: DatabaseSync;
beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  directory = mkdtempSync(join(tmpdir(), "research-api-"));
  db = openTrackerDatabase(join(directory, "tracker.sqlite"));
  state.store = createCompanyResearchStorage(db);
  state.snapshot = { companies: structuredClone(fixture.companies) };
  state.profile = { ...profile, privateNotes: "profile-private-secret" };
  state.profileMissing = false;
  state.storageFailure = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(startTime));
  vi.mocked(researchCompany).mockReset().mockImplementation(async () => {
    expect(db.isTransaction).toBe(false);
    return result();
  });
  vi.stubEnv("GROQ_API_KEY", "test-model-key");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  db.close(); rmSync(directory, { recursive: true, force: true });
});

it("reads an empty round without research or an API key", async () => {
  vi.stubEnv("GROQ_API_KEY", "");
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ companySlug: company.slug, announcedDate: date, latestAttempt: null, latestSuccessful: null, history: [] });
  expect(researchCompany).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("saves trusted inputs and a completed result before reporting success", async () => {
  const response = await post();
  expect(response.status).toBe(201);
  const data = await response.json();
  expect(researchCompany).toHaveBeenCalledWith(company, profile, { signal: expect.any(AbortSignal), runId: data.run.id });
  expect(logger.info).toHaveBeenCalledWith("research.claimed", { runId: data.run.id, companySlug: company.slug, announcedDate: date });
  expect(logger.info).toHaveBeenCalledWith("research.saved", { runId: data.run.id, companySlug: company.slug, status: "completed" });
  expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("profile-private-secret");
  expect(state.store.getRun(data.run.id)).toMatchObject({ companyInput: company, profile, status: "completed", result: result() });
  expect(data.run).toMatchObject({ stale: false, staleReasons: [] });
  expect(data.run.profile).toBeUndefined();
  expect(JSON.stringify(data)).not.toContain("profile-private-secret");
  const saved = await (await get()).json();
  expect(saved.latestSuccessful.id).toBe(data.run.id);
  expect(saved.history).toHaveLength(1);
  expect(saved.history[0].result).toBeUndefined();
  expect((await (await get(date, data.run.id)).json()).run.result).toEqual(result());
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves the last success when a newer attempt fails", async () => {
  const successful = await (await post()).json();
  vi.mocked(researchCompany).mockResolvedValue(result(true));
  const failure = await post();
  expect(failure.status).toBe(502);
  const failed = await failure.json();
  const data = await (await get()).json();
  expect(data.latestSuccessful.id).toBe(successful.run.id);
  expect(data.latestAttempt.id).toBe(failed.run.id);
  expect(data.latestAttempt.status).toBe("failed");
  expect(data.history.map((run: { status: string }) => run.status)).toEqual(["failed", "completed"]);
});

it("requires a rerun for results from an older prompt version", async () => {
  const initial = await (await post()).json();
  // An unsupported assessment shape must never reach the browser.
  db.prepare("UPDATE research_runs SET prompt_version = ?, result_json = ? WHERE id = ?")
    .run("old-version", JSON.stringify({ assessment: "unsupported format" }), initial.run.id);
  const saved = await (await get()).json();
  expect(saved.latestSuccessful).toBeNull();
  expect(saved.latestAttempt).toMatchObject({ id: initial.run.id, result: null, stale: true });
  expect(saved.history).toHaveLength(1);
  expect((await (await get(date, initial.run.id)).json()).run.result).toBeNull();
  expect(researchCompany).toHaveBeenCalledTimes(1);
  const rerun = await (await post()).json();
  expect((await (await get()).json()).latestSuccessful.id).toBe(rerun.run.id);
});

it("exposes active progress and rejects concurrent requests without another engine call", async () => {
  let finish!: (value: ResearchResult) => void;
  vi.mocked(researchCompany).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = post();
  await vi.waitFor(() => expect(researchCompany).toHaveBeenCalledTimes(1));
  expect(db.isTransaction).toBe(false);
  const active = await (await get()).json();
  expect(active.latestAttempt.status).toBe("running");
  const duplicate = await post();
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).runId).toBe(active.latestAttempt.id);
  expect(researchCompany).toHaveBeenCalledTimes(1);
  finish(result());
  expect((await pending).status).toBe(201);
});

it("recovers abandoned claims and prevents an old worker overwriting newer research", async () => {
  let finish!: (value: ResearchResult) => void;
  vi.mocked(researchCompany).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = post();
  await vi.waitFor(() => expect(researchCompany).toHaveBeenCalledTimes(1));
  const oldId = state.store.listRuns(company.slug, date)[0].id;
  vi.setSystemTime(new Date(state.store.getRun(oldId)!.deadlineAt));
  const newResponse = await post();
  expect(newResponse.status).toBe(201);
  expect(state.store.getRun(oldId)).toMatchObject({ status: "failed", result: null, error: expect.stringContaining("deadline expired") });
  finish(result());
  expect((await pending).status).toBe(409);
  const current = await (await get()).json();
  expect(current.latestSuccessful.id).not.toBe(oldId);
  expect(state.store.getRun(oldId)!.result).toBeNull();
});

it("marks expired claims failed on GET without starting research", async () => {
  let finish!: (value: ResearchResult) => void;
  vi.mocked(researchCompany).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = post();
  await vi.waitFor(() => expect(researchCompany).toHaveBeenCalledTimes(1));
  vi.setSystemTime(new Date(state.store.listRuns(company.slug, date)[0].deadlineAt));
  expect((await (await get()).json()).latestAttempt.status).toBe("failed");
  expect(researchCompany).toHaveBeenCalledTimes(1);
  finish(result());
  expect((await pending).status).toBe(409);
});

it("matches by slug and UTC announcement date across snapshots, isolating other rounds", async () => {
  const initial = await (await post()).json();
  state.snapshot = { companies: [{ ...company, announced_at: `${date}T08:00:00Z` }] };
  expect((await (await get()).json()).latestSuccessful.id).toBe(initial.run.id);
  const otherDate = "2026-11-01";
  state.snapshot = { companies: [{ ...company, announced_at: `${otherDate}T00:00:00Z` }] };
  expect((await (await get(otherDate)).json()).history).toEqual([]);
  expect((await get(otherDate, initial.run.id)).status).toBe(404);
  expect((await get(date, initial.run.id, "other-company")).status).toBe(404);
  expect((await post({ announcedDate: otherDate })).status).toBe(201);
  expect(state.store.listRuns(company.slug, date)).toHaveLength(1);
  expect(state.store.listRuns(company.slug, otherDate)).toHaveLength(1);
});

it("detects profile and input changes without changing saved snapshots", async () => {
  const data = await (await post()).json();
  state.profile = { ...profile, preferences: ["Large teams"] };
  state.snapshot = { companies: [{ ...company, description: "Changed description" }] };
  const current = await (await get()).json();
  expect(current.latestSuccessful).toMatchObject({ stale: true, staleReasons: ["company_input_changed", "profile_changed"] });
  expect(state.store.getRun(data.run.id)!.companyInput).toEqual(company);
  expect(state.store.getRun(data.run.id)!.profile).toEqual(profile);
});

it("returns saved evidence when the company or valid profile is no longer available", async () => {
  const initial = await (await post()).json();
  state.snapshot = null;
  state.profileMissing = true;
  vi.stubEnv("GROQ_API_KEY", "");
  const current = await (await get()).json();
  expect(current).toMatchObject({ currentInputsAvailable: { company: false, profile: false }, latestSuccessful: { id: initial.run.id, stale: null } });
  expect((await post()).status).toBe(404);
});

it.each([{}, [], { announcedDate: "2026-02-30" }, { announcedDate: date, profile }, { announcedDate: 123 }])("rejects invalid or client-supplied research inputs", async input => {
  expect((await post(input)).status).toBe(400);
  expect(researchCompany).not.toHaveBeenCalled();
  expect(state.store.listRuns(company.slug, date)).toEqual([]);
});

it("rejects malformed JSON and ambiguous read queries", async () => {
  expect((await POST(new Request(url, { method: "POST", body: "broken" }), context())).status).toBe(400);
  for (const query of ["", "announcedDate=invalid", `announcedDate=${date}&announcedDate=${date}`, `announcedDate=${date}&profile=override`]) {
    expect((await GET(new Request(`${url}?${query}`), context())).status).toBe(400);
  }
});

it("requires a valid local profile and model key before claiming or running", async () => {
  state.profile = { ...profile, preferences: "invalid" };
  expect((await post()).status).toBe(503);
  state.profile = profile;
  vi.stubEnv("GROQ_API_KEY", "");
  expect((await post()).status).toBe(503);
  expect(researchCompany).not.toHaveBeenCalled();
  expect(state.store.listRuns(company.slug, date)).toEqual([]);
});

it("saves unexpected engine failures with a safe message", async () => {
  vi.mocked(researchCompany).mockRejectedValue(new Error("Private path or secret"));
  const response = await post();
  expect(response.status).toBe(502);
  expect((await response.json()).run.error).toBe("Research stopped unexpectedly before producing a result.");
  expect(state.store.listRuns(company.slug, date)[0].status).toBe("failed");
});

it("reports persistence failure without claiming a successful save", async () => {
  vi.spyOn(state.store, "finishRun").mockImplementation(() => { throw Object.assign(new Error("Private disk path"), { code: "SQLITE_FULL" }); });
  const response = await post();
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("Private disk path");
  expect(state.store.listRuns(company.slug, date)[0].status).toBe("running");
  expect(db.isTransaction).toBe(false);
  expect(logger.error).toHaveBeenCalledWith("research.request_failed", expect.objectContaining({
    runId: state.store.listRuns(company.slug, date)[0].id, stage: "save", status: 500, errorCode: "SQLITE_FULL",
  }));
  expect(logger.info).not.toHaveBeenCalledWith("research.saved", expect.anything());
  expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("Private disk path");
});

it("returns safe errors when storage is unavailable", async () => {
  state.storageFailure = true;
  const response = await get();
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("Private database path");
});

it("hashes nested JSON content consistently regardless of object key order", () => {
  expect(researchInputHash({ a: { c: 1, b: 2 }, d: ["x", "y"] }))
    .toBe(researchInputHash({ d: ["x", "y"], a: { b: 2, c: 1 } }));
  expect(researchInputHash(profile)).not.toBe(researchInputHash({ ...profile, preferences: [] }));
});
