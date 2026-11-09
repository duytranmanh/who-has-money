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
  reasons_connected_to_profile: [{ reason: "Product engineering may fit backend experience.", source_ids: ["page_1"] }],
  mismatches: [], unknowns: ["Team size and current SWE hiring."],
  hiring: { status: "unknown", summary: "No verified openings.", source_ids: [] },
  role_suitability: { status: "unknown", summary: "No role assessed.", source_ids: [] },
  recommended_next_step: { action: "further_research", reason: "Verify engineering needs." },
};

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Supply protocol-shaped responses while keeping tests independent of Groq and live websites.
function reply(content: unknown = assessment): ChatCompletion {
  return {
    id: "test", object: "chat.completion", created: 0, model: "test",
    choices: [{ index: 0, logprobs: null, finish_reason: "stop", message: {
      role: "assistant", content: JSON.stringify(content),
    } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

function providerError(status: number, retryAfter = "0", message = "Provider unavailable") {
  return Object.assign(new Error(message), { status, headers: new Headers({ "retry-after": retryAfter }),
    error: { error: { code: "rate_limit_exceeded", message } } });
}

function jsonGenerationError() {
  return Object.assign(new Error("Failed to generate JSON."), { status: 400,
    error: { error: { code: "json_validate_failed", failed_generation: "untrusted-provider-content" } } });
}

describe("assessment validation", () => {
  it("accepts retrieved excerpts and actual input-field evidence", () => {
    expect(validateAssessment(assessment, company, [{ id: "page_1", page }])).toEqual(assessment);
    const inputOnly = structuredClone(assessment);
    inputOnly.reasons_connected_to_profile[0].source_ids = ["company.name"];
    expect(validateAssessment(inputOnly, company, [])).toEqual(inputOnly);
  });

  it.each([
    (a: CompanyAssessment) => { a.company_slug = "another-company"; },
    (a: CompanyAssessment) => { a.hiring.source_ids = ["page_99"]; },
    (a: CompanyAssessment) => { a.reasons_connected_to_profile[0].source_ids = ["invented"]; },
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

  it("accepts direct source references without intermediate fact IDs or generated quotes", () => {
    const source = { ...page, text: "inve now works with your AI assistantConnect your guests" };
    expect(validateAssessment(assessment, company, [{ id: "page_1", page: source }])).toEqual(assessment);
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

  it("logs unknown source references without dumping quotes, source text, or the profile", async () => {
    const sourceId = "page_99";
    const invalid = structuredClone(assessment);
    invalid.reasons_connected_to_profile[0].source_ids = [sourceId];
    const result = await researchCompany(company, { ...profile, experience: ["private-profile-content"] }, { runId: "validation-run",
      complete: vi.fn().mockResolvedValue(reply(invalid)), readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(logger.error).toHaveBeenCalledWith("research.failed", expect.objectContaining({
      runId: "validation-run", stage: "validation", errorCode: "missing_source", sourceId,
      availableSourceIds: expect.arrayContaining(["page_1", "company.name"]),
    }));
    const logs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logs).not.toContain("private-profile-content");
    expect(logs).not.toContain(assessment.fit_summary);
    expect(logs).not.toContain(assessment.reasons_connected_to_profile[0].reason);
    expect(logs).not.toContain(page.text);
    expect(JSON.stringify(result)).not.toContain('"sourceText"');
  });

  it("logs page failures as evidence gaps with bounded diagnostics", async () => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", reasons_connected_to_profile: [] };
    await researchCompany(company, profile, { runId: "page-run", complete: vi.fn().mockResolvedValue(reply(output)),
      readPage: vi.fn().mockRejectedValue(new Error("Page request failed: HTTP 403; expected uncompressed HTML.")) });
    expect(logger.warn).toHaveBeenCalledWith("research.page_failed", expect.objectContaining({ runId: "page-run", errorCode: "page_http_error", status: 403 }));
    expect(logger.info).toHaveBeenCalledWith("research.completed", expect.objectContaining({ runId: "page-run" }));
  });

  it("logs selected provider diagnostics without its message or generated arguments", async () => {
    const error = Object.assign(new Error("private-profile sk-secret"), { status: 429,
      headers: new Headers({ "retry-after": "60", "x-request-id": "provider-1", authorization: "Bearer sk-secret" }),
      error: { error: { code: "rate_limit_exceeded", type: "tokens", message: "private-profile Limit 8000, Used 6150, Requested 3970",
        failed_generation: JSON.stringify({ name: "read_pagecommentary", arguments: { privateProfile: "private-profile" } }) } },
    });
    await researchCompany(company, profile, { runId: "provider-run", complete: vi.fn().mockRejectedValue(error), readPage: vi.fn().mockResolvedValue(page) });
    expect(logger.error).toHaveBeenCalledWith("research.model_failed", expect.objectContaining({ runId: "provider-run", status: 429,
      errorCode: "rate_limit_exceeded", retryAfterSeconds: 60, providerRequestId: "provider-1", attemptedTool: "read_pagecommentary",
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

  it("selects discovered pages once and assesses fresh evidence without drafts or tool history", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: ["link_1"] })).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, { ...profile, privateNotes: "secret" }, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage.mock.calls.map(call => call[0])).toEqual([company.website, "https://growthware.com/careers"]);
    expect(complete.mock.calls.at(-1)![0]).toMatchObject({ response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(complete.mock.calls.at(-1)![0].tools).toBeUndefined();
    expect(JSON.stringify(complete.mock.calls)).not.toContain("secret");
    expect(result.calls).toHaveLength(2);
    const selectionRequest = complete.mock.calls[0][0];
    expect(selectionRequest.response_format.json_schema.name).toBe("page_selection");
    expect(selectionRequest.max_completion_tokens).toBe(RESEARCH_LIMITS.selectionCompletionTokens);
    expect(selectionRequest.reasoning_effort).toBe("low");
    const finalRequest = complete.mock.calls[1][0];
    expect(finalRequest.messages).toHaveLength(2);
    expect(finalRequest.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(finalRequest.max_completion_tokens).toBe(RESEARCH_LIMITS.completionTokens);
    expect(finalRequest.reasoning_effort).toBe("medium");
    expect(JSON.stringify(finalRequest)).not.toContain("page_ids");
    expect(JSON.stringify(finalRequest)).not.toContain("candidates");
    expect(JSON.parse(finalRequest.messages[1].content).sources).toHaveLength(2);
    expect(JSON.parse(finalRequest.messages[1].content).available_source_ids).toEqual(expect.arrayContaining(["page_1", "page_2", "company.description"]));
    expect(finalRequest.messages[0].content).toContain('"source_ids":["page_1"]');
    const schema = finalRequest.response_format.json_schema.schema;
    expect(schema.properties).not.toHaveProperty("supporting_facts");
    expect(schema.properties.reasons_connected_to_profile.items.properties.source_ids.items.enum).toContain("page_1");
    expect(JSON.stringify(schema)).not.toContain("fact_ids");
    expect(finalRequest.messages[0].content).not.toContain("company.FIELD");
    expect(JSON.stringify(complete.mock.calls)).not.toContain("source_links");
    expect(result.calls[0].prompt_tokens).toBe(20);
    expect(result.sources).toHaveLength(2);
    expect(result.tools.every(tool => tool.source_id)).toBe(true);
  });

  it("ignores invented page IDs and deduplicates selections without another browsing call", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: ["https://invented.example/", "link_99", "link_1", "link_1"] }))
      .mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage.mock.calls.map(call => call[0])).toEqual([company.website, "https://growthware.com/careers"]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("research.selection_rejected", expect.anything());
  });

  it("caps candidates and reads at most two selected pages, without following their links", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `https://growthware.com/product/${i}`);
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: links.map((_, i) => `link_${i + 1}`) })).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue({ ...page, links: links.map(url => ({ url, text: "Product" })) });
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage).toHaveBeenCalledTimes(RESEARCH_LIMITS.pageReads);
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).candidates).toHaveLength(RESEARCH_LIMITS.candidateLinks);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("supports selecting no additional pages while still assessing once", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] })).mockResolvedValueOnce(reply());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(RESEARCH_LIMITS.modelCalls);
    expect(result.sources).toHaveLength(1);
  });

  it("skips selection when the homepage has no usable discovered links", async () => {
    const complete = vi.fn().mockResolvedValue(reply());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue({ ...page, links: [] }) });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.calls[0].stage).toBe("assessment");
  });

  it("falls back to homepage evidence for malformed selection without adding model calls", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply("not a selection")).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(complete.mock.calls[1][0].messages[1].content).gaps).toContain("Additional page selection was invalid. Assess only the supplied evidence.");
  });

  it("bounds all evidence and excludes link lists and unrelated company metadata from assessment", async () => {
    const largePage = { ...page, text: `Operations software. ${"evidence ".repeat(2000)}`,
      links: ["careers", "about", "third"].map(path => ({ url: `https://growthware.com/${path}`, text: path })) };
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: ["link_1", "link_2"] })).mockResolvedValueOnce(reply());
    const result = await researchCompany({ ...company, unrelated_metadata: "private-unused-metadata" }, profile, { complete, readPage: vi.fn().mockResolvedValue(largePage) });
    expect(result.status).toBe("completed");
    expect(result.sources).toHaveLength(3);
    expect(result.sources.reduce((total, source) => total + source.page.text.length, 0)).toBeLessThanOrEqual(RESEARCH_LIMITS.evidenceChars);
    expect(result.sources.every(source => source.page.truncated)).toBe(true);
    const selection = JSON.parse(complete.mock.calls[0][0].messages[1].content);
    expect(selection.homepage.length).toBeLessThanOrEqual(RESEARCH_LIMITS.selectionTextChars);
    const final = JSON.parse(complete.mock.calls[1][0].messages[1].content);
    expect(final.sources.every((source: object) => !Object.hasOwn(source, "links"))).toBe(true);
    expect(JSON.stringify(complete.mock.calls)).not.toContain("private-unused-metadata");
    expect(complete.mock.calls.every(([request]) => JSON.stringify(request).length <= RESEARCH_LIMITS.requestChars)).toBe(true);
  });

  it("fails oversized profiles before network use without silently dropping requirements", async () => {
    const complete = vi.fn();
    const readPage = vi.fn();
    const result = await researchCompany(company, { ...profile, hard_nos: ["x".repeat(RESEARCH_LIMITS.inputChars)] }, { complete, readPage });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("Shorten the profile") });
    expect(complete).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it("honors Retry-After and retries only the failed assessment using already fetched evidence", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: ["link_1"] }))
      .mockRejectedValueOnce(providerError(429, "1")).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const started = Date.now();
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[1][0]).toEqual(complete.mock.calls[2][0]);
    expect(result.calls.map(call => call.stage)).toEqual(["research", "assessment", "assessment"]);
    expect(result.calls[1].error).toBeTruthy();
    expect(result.calls[2].error).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("research.retrying", expect.objectContaining({ reason: "rate_limit", waitMs: 1000 }));
  });

  it("can retry selection without rereading the homepage or creating another selection stage", async () => {
    const complete = vi.fn().mockRejectedValueOnce(providerError(429)).mockResolvedValueOnce(reply({ page_ids: [] })).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(result.calls.map(call => call.stage)).toEqual(["research", "research", "assessment"]);
  });

  it("bounds retries even if every provider attempt is rate limited", async () => {
    const complete = vi.fn().mockRejectedValue(providerError(429));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.calls).toHaveLength(2);
  });

  it("retries a rejected JSON assessment once with correction guidance and the same fetched evidence", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: ["link_1"] }))
      .mockRejectedValueOnce(jsonGenerationError()).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(readPage).toHaveBeenCalledTimes(2);
    const original = complete.mock.calls[1][0];
    const retry = complete.mock.calls[2][0];
    expect(retry.messages.slice(0, 2)).toEqual(original.messages);
    expect(retry.messages[2].content).toContain("previous generation was rejected as invalid JSON");
    expect(retry.messages[2].content).toContain('"source_ids":["page_1"]');
    expect(retry.response_format).toEqual(original.response_format);
    expect(JSON.stringify(retry)).not.toContain("untrusted-provider-content");
    expect(result.calls[1].error).toBeTruthy();
    expect(logger.warn).toHaveBeenCalledWith("research.retrying", expect.objectContaining({ reason: "json_validate_failed", waitMs: 0 }));
  });

  it("keeps the same one-retry budget when JSON generation repeatedly fails", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] })).mockRejectedValue(jsonGenerationError());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("shares the retry budget across rate limits and invalid JSON", async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] }))
      .mockRejectedValueOnce(providerError(429)).mockRejectedValueOnce(jsonGenerationError());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalledWith("research.retrying", expect.objectContaining({ reason: "json_validate_failed" }));
  });

  it("can retry page-selection JSON without repeating homepage fetching", async () => {
    const complete = vi.fn().mockRejectedValueOnce(jsonGenerationError()).mockResolvedValueOnce(reply({ page_ids: [] })).mockResolvedValueOnce(reply());
    const readPage = vi.fn().mockResolvedValue(page);
    const result = await researchCompany(company, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1][0].messages[2].content).toContain('"page_ids":[]');
    expect(complete.mock.calls[1][0].messages[2].content).not.toContain("company.amount_usd");
  });

  it("does not retry unrelated provider 400 errors", async () => {
    const complete = vi.fn().mockRejectedValue(Object.assign(new Error("Bad request"), { status: 400, error: { code: "invalid_request_error" } }));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(["31", "120"])("does not wait beyond the retry budget (%s seconds)", async retryAfter => {
    const complete = vi.fn().mockRejectedValue(providerError(429, retryAfter));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalledWith("research.retrying", expect.anything());
  });

  it("does not wait when the run deadline leaves insufficient time for a retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const complete = vi.fn().mockImplementation(() => {
      vi.setSystemTime(Date.now() + RESEARCH_LIMITS.timeoutMs - 500);
      throw providerError(429, "1");
    });
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue(page) });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("cancels a rate-limit wait without making another provider attempt", async () => {
    const controller = new AbortController();
    const complete = vi.fn().mockRejectedValue(providerError(429, "1"));
    const pending = researchCompany(company, profile, { signal: controller.signal, complete, readPage: vi.fn().mockResolvedValue(page) });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith("research.retrying", expect.anything()));
    controller.abort();
    expect((await pending).status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([413, 429])("shrinks a request exceeding the full allowance instead of waiting (%s)", async status => {
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] }))
      .mockRejectedValueOnce(providerError(status, "60", "Limit 8000, Requested 9000"))
      .mockResolvedValueOnce(reply());
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockResolvedValue({ ...page, text: page.text + " evidence".repeat(200) }) });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(complete.mock.calls[2][0]).length).toBeLessThan(JSON.stringify(complete.mock.calls[1][0]).length);
    expect(logger.warn).toHaveBeenCalledWith("research.retrying", expect.objectContaining({ reason: "request_too_large", waitMs: 0 }));
    expect(result.sources[0].page.truncated).toBe(true);
  });

  it("retains reduced source excerpts after a retry", async () => {
    const output = structuredClone(assessment);
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] }))
      .mockRejectedValueOnce(providerError(413)).mockResolvedValueOnce(reply(output));
    const result = await researchCompany(company, profile, { complete,
      readPage: vi.fn().mockResolvedValue({ ...page, text: "x".repeat(1200) + "hidden-after-reduction" }) });
    expect(result.status).toBe("completed");
    expect(result.sources[0].page.text).not.toContain("hidden-after-reduction");
  });

  it("does not retry an oversized request when there is no page evidence left to shrink", async () => {
    const complete = vi.fn().mockRejectedValue(providerError(413));
    const result = await researchCompany({ ...company, website: null }, profile, { complete });
    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([null, "http://127.0.0.1/"])("records missing or unusable websites as unknown", async website => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", reasons_connected_to_profile: [] };
    const complete = vi.fn().mockResolvedValue(reply(output));
    const readPage = vi.fn();
    const result = await researchCompany({ ...company, website }, profile, { complete, readPage });
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("retains page failures without turning them into rejection", async () => {
    const output = { ...assessment, fit_judgment: "insufficient_evidence", reasons_connected_to_profile: [] };
    const complete = vi.fn().mockResolvedValue(reply(output));
    const result = await researchCompany(company, profile, { complete, readPage: vi.fn().mockRejectedValue(new Error("HTTP 403")) });
    expect(result.status).toBe("completed");
    expect(result.tools[0].error).toBe("HTTP 403");
  });

  it.each(["invalid JSON", JSON.stringify({ ...assessment, company_slug: "wrong" })])("returns failed validation with evidence intact", async content => {
    const invalid = reply();
    invalid.choices[0].message.content = content;
    const complete = vi.fn().mockResolvedValueOnce(reply({ page_ids: [] })).mockResolvedValueOnce(invalid);
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
