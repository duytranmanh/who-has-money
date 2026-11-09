/**
 * @fileoverview Exercises bounded research and evidence checks with synthetic model/page responses.
 * Checks that research diagnostics identify failures without exposing profiles or model content.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "groq-sdk/resources/chat/completions";
import fixture from "../fixtures/companies.json";
import { parseResearchProfile, researchCompany, researchErrorDetails, RESEARCH_LIMITS, validateAssessment, type CompanyAssessment } from "./company-research";
import { logger } from "./logger";
import { extractPage } from "./research-page";

const company = { ...fixture.companies.find(company => company.slug === "growthware")!, website: "https://growthware.com/" };
const profile = { target: ["SWE"], experience: ["Backend engineering"], hard_nos: ["Space industry"], preferences: ["Small team"] };
const page = extractPage('<body>Operations software.<a href="/careers">Careers</a></body>', company.website);
const assessment: CompanyAssessment = {
  company_slug: company.slug, fit_judgment: "possible_fit", fit_summary: "Worth investigating.",
  supporting_facts: [{ id: "f1", claim: "Builds operations software.", source_id: "page_1", quote: "Operations software." }],
  reasons_connected_to_profile: [{ reason: "Product engineering may fit backend experience.", fact_ids: ["f1"] }],
  mismatches: [], unknowns: ["Team size and current SWE hiring."],
  hiring: { status: "unknown", summary: "No verified openings.", fact_ids: [] },
  role_suitability: { status: "unknown", summary: "No role assessed.", fact_ids: [] },
  recommended_next_step: { action: "further_research", reason: "Verify engineering needs." },
};

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Supply protocol-shaped responses while keeping tests independent of Groq and live websites.
function reply(content: unknown = assessment, urls?: string[]): ChatCompletion {
  return {
    id: "test", object: "chat.completion", created: 0, model: "test",
    choices: [{ index: 0, logprobs: null, finish_reason: urls ? "tool_calls" : "stop", message: {
      role: "assistant", content: urls ? null : JSON.stringify(content),
      ...(urls ? { tool_calls: urls.map((url, index) => ({ id: `tool_${index}`, type: "function" as const, function: { name: "read_page", arguments: JSON.stringify({ url }) } })) } : {}),
    } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

describe("assessment validation", () => {
  it("accepts retrieved excerpts and actual input-field evidence", () => {
    expect(validateAssessment(assessment, company, [{ id: "page_1", page }])).toEqual(assessment);
    const inputOnly = structuredClone(assessment);
    inputOnly.supporting_facts[0] = { id: "f1", claim: "Named Growthware.", source_id: "company.name", quote: company.name };
    expect(validateAssessment(inputOnly, company, [])).toEqual(inputOnly);
  });

  it.each([
    (a: CompanyAssessment) => { a.company_slug = "another-company"; },
    (a: CompanyAssessment) => { a.supporting_facts[0].source_id = "page_99"; },
    (a: CompanyAssessment) => { a.supporting_facts[0].quote = "Uses Kubernetes"; },
    (a: CompanyAssessment) => { a.reasons_connected_to_profile[0].fact_ids = ["invented"]; },
    (a: CompanyAssessment) => { a.supporting_facts.push(a.supporting_facts[0]); },
    (a: CompanyAssessment) => { a.reasons_connected_to_profile = []; },
    (a: CompanyAssessment) => { a.fit_judgment = "reject"; },
    (a: CompanyAssessment) => { a.hiring.status = "verified_openings"; },
    (a: CompanyAssessment) => { a.recommended_next_step.action = "apply"; },
  ])("rejects unsupported or inconsistent assessments", mutate => {
    const invalid = structuredClone(assessment);
    mutate(invalid);
    expect(() => validateAssessment(invalid, company, [{ id: "page_1", page }])).toThrow();
  });

  it.each([{}, { ...assessment, extra: true }, { ...assessment, fit_judgment: "great" }, { ...assessment, unknowns: [3] }])("rejects malformed output", invalid => {
    expect(() => validateAssessment(invalid, company, [])).toThrow("schema");
  });

  it("validates the profile and sends only the four assessment fields", () => {
    expect(parseResearchProfile({ ...profile, privateNotes: "secret" })).toEqual(profile);
    expect(() => parseResearchProfile({ ...profile, hard_nos: "Space" })).toThrow("hard_nos");
  });
});

describe("bounded company research", () => {
  it("correlates lifecycle and token diagnostics without logging research content", async () => {
    await researchCompany(company, { ...profile, experience: ["private-experience"] }, {
      runId: "run-test", complete: vi.fn().mockResolvedValue(reply()), readPage: vi.fn().mockResolvedValue(page),
    });
    expect(logger.info).toHaveBeenCalledWith("research.started", expect.objectContaining({ runId: "run-test", companySlug: company.slug }));
    expect(logger.info).toHaveBeenCalledWith("research.model_completed", expect.objectContaining({ runId: "run-test", promptTokens: 20, completionTokens: 10 }));
    expect(logger.info).toHaveBeenCalledWith("research.completed", expect.objectContaining({ runId: "run-test", modelCalls: 2 }));
    const logs = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logs).not.toContain("private-experience");
    expect(logs).not.toContain(page.text);
    expect(logs).not.toContain(assessment.fit_summary);
  });

  it.each(["page_99", "page_1"])("identifies failed citation references without logging quotes (%s)", async sourceId => {
    const invalid = structuredClone(assessment);
    invalid.supporting_facts[0] = { ...invalid.supporting_facts[0], source_id: sourceId, quote: "private-unmatched-quote" };
    const result = await researchCompany(company, profile, { runId: "validation-run",
      complete: vi.fn().mockResolvedValue(reply(invalid)), readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(logger.error).toHaveBeenCalledWith("research.failed", expect.objectContaining({
      runId: "validation-run", stage: "validation", errorCode: sourceId === "page_99" ? "missing_source" : "quote_mismatch", factId: "f1", sourceId,
    }));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private-unmatched-quote");
  });

  it("logs page failures as evidence gaps with bounded diagnostics", async () => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", supporting_facts: [], reasons_connected_to_profile: [] };
    await researchCompany(company, profile, { runId: "page-run", complete: vi.fn().mockResolvedValue(reply(output)),
      readPage: vi.fn().mockRejectedValue(new Error("Page request failed: HTTP 403; expected uncompressed HTML.")) });
    expect(logger.warn).toHaveBeenCalledWith("research.page_failed", expect.objectContaining({ runId: "page-run", errorCode: "page_http_error", status: 403 }));
    expect(logger.info).toHaveBeenCalledWith("research.completed", expect.objectContaining({ runId: "page-run" }));
  });

  it("logs selected provider diagnostics without its message or generated arguments", async () => {
    const error = Object.assign(new Error("private-profile sk-secret"), { status: 429,
      headers: new Headers({ "retry-after": "15.9", "x-request-id": "provider-1", authorization: "Bearer sk-secret" }),
      error: { error: { code: "rate_limit_exceeded", type: "tokens", message: "private-profile Limit 8000, Used 6150, Requested 3970",
        failed_generation: JSON.stringify({ name: "read_pagecommentary", arguments: { privateProfile: "private-profile" } }) } },
    });
    await researchCompany(company, profile, { runId: "provider-run", complete: vi.fn().mockRejectedValue(error), readPage: vi.fn().mockResolvedValue(page) });
    expect(logger.error).toHaveBeenCalledWith("research.model_failed", expect.objectContaining({ runId: "provider-run", status: 429,
      errorCode: "rate_limit_exceeded", retryAfterSeconds: 16, providerRequestId: "provider-1", attemptedTool: "read_pagecommentary",
      tokenLimit: 8000, tokensUsed: 6150, tokensRequested: 3970 }));
    const logs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logs).not.toContain("private-profile");
    expect(logs).not.toContain("sk-secret");
    expect(logs).not.toContain("arguments");
  });

  it("handles malformed provider diagnostics without obscuring the failure", () => {
    expect(researchErrorDetails({ error: { failed_generation: "not JSON" }, headers: new Headers({ "retry-after": "invalid" }) })).toMatchObject({ errorName: "Error" });
    expect(researchErrorDetails(null)).toEqual({ errorName: "UnknownError" });
  });

  it("reads discovered pages and makes a separate structured final call", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply(null, ["https://growthware.com/careers"]))
      .mockResolvedValueOnce(reply("Ready")).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, { ...profile, privateNotes: "secret" }, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage.mock.calls.map(call => call[0])).toEqual([company.website, "https://growthware.com/careers"]);
    expect(complete.mock.calls.at(-1)![0]).toMatchObject({ response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(complete.mock.calls.at(-1)![0].tools).toBeUndefined();
    expect(JSON.stringify(complete.mock.calls)).not.toContain("secret");
    expect(result.calls).toHaveLength(3);
    expect(result.calls[0].prompt_tokens).toBe(20);
    expect(result.sources).toHaveLength(2);
    expect(result.tools.every(tool => tool.source_id)).toBe(true);
  });

  it("rejects invented URLs and duplicate reads without contacting them", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply(null, ["https://invented.example/", company.website]))
      .mockResolvedValueOnce(reply("Done")).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(result.tools.map(tool => tool.error)).toEqual([undefined, expect.stringContaining("not discovered"), expect.stringContaining("already attempted")]);
  });

  it("caps page reads even when one response requests many tools", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `https://growthware.com/product/${i}`);
    const complete = vi.fn().mockResolvedValueOnce(reply(null, links)).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue({ ...page, links: links.map(url => ({ url, text: "Product" })) });
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage).toHaveBeenCalledTimes(RESEARCH_LIMITS.pageReads);
    expect(result.tools.some(tool => tool.error?.includes("limit"))).toBe(true);
  });

  it("caps research calls and reserves the final assessment call", async () => {
    const complete = vi.fn().mockResolvedValue(reply(null, ["https://invented.example/"]));
    complete.mockResolvedValueOnce(reply(null, ["https://invented.example/"]))
      .mockResolvedValueOnce(reply(null, ["https://invented.example/"]))
      .mockResolvedValueOnce(reply(null, ["https://invented.example/"]))
      .mockResolvedValueOnce(reply());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(RESEARCH_LIMITS.modelCalls);
  });

  it.each([null, "http://127.0.0.1/"])("records missing or unusable websites as unknown", async website => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", supporting_facts: [], reasons_connected_to_profile: [] };
    const complete = vi.fn().mockResolvedValue(reply(output));
    const readPage = vi.fn();
    const result = await researchCompany({ ...company, website }, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("retains page failures without turning them into rejection", async () => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", supporting_facts: [], reasons_connected_to_profile: [] };
    const complete = vi.fn().mockResolvedValueOnce(reply("Unavailable")).mockResolvedValueOnce(reply(output));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockRejectedValue(new Error("HTTP 403")) });
    expect(result.status).toBe("completed");
    expect(result.tools[0].error).toBe("HTTP 403");
  });

  it.each(["invalid JSON", JSON.stringify({ ...assessment, company_slug: "wrong" })])("returns failed validation with evidence intact", async content => {
    const invalid = reply();
    invalid.choices[0].message.content = content;
    const complete = vi.fn().mockResolvedValueOnce(reply("Done")).mockResolvedValueOnce(invalid);
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(result.sources).toHaveLength(1);
  });

  it("records provider failures without automatic retries", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("Rate limited"));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result).toMatchObject({ status: "failed", error: "Rate limited", calls: [{ error: "Rate limited" }] });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(1);
  });

  it("honors cancellation before any network use", async () => {
    const complete = vi.fn();
    const readPage = vi.fn();
    const result = await researchCompany(company, profile, { signal: AbortSignal.abort(), complete, readPage });
    expect(result.status).toBe("failed");
    expect(complete).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it("stops on the shared deadline and retains the interrupted call", async () => {
    vi.useFakeTimers();
    // Node's native AbortSignal.timeout uses internal timers outside Vitest's fake clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("Deadline exceeded")), ms);
      return controller.signal;
    });
    try {
      const complete = vi.fn().mockImplementation((_params, { signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const pending = researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
      await vi.advanceTimersByTimeAsync(RESEARCH_LIMITS.timeoutMs);
      const result = await pending;
      expect(result.status).toBe("failed");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].error).toBeTruthy();
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });

  it("rejects truncated model responses instead of accepting partial assessments", async () => {
    const response = reply();
    response.choices[0].finish_reason = "length";
    const result = await researchCompany({ ...company, website: null }, profile, { complete: vi.fn().mockResolvedValue(response) });
    expect(result).toMatchObject({ status: "failed", error: "Model response did not finish successfully." });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].error).toBeTruthy();
  });
});
