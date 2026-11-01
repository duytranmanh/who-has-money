import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/companies.json";
import { createFundingStorage } from "../../../lib/funding-storage";
import { GET } from "./route";
import { POST } from "./refresh/route";

vi.mock("../../../lib/funding-storage", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/funding-storage")>();
  return { ...actual, createFundingStorage: vi.fn(actual.createFundingStorage) };
});

let directory: string;
let store: ReturnType<typeof createFundingStorage>;
const snapshot = { fetchedAt: "2026-11-01T12:00:00.000Z", windowStart: "2026-10-11T00:00:00.000Z",
  windowEnd: "2026-10-18T00:00:00.000Z", coverage: "complete" as const, companies: fixture.companies };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "funding-api-"));
  const actual = await vi.importActual<typeof import("../../../lib/funding-storage")>("../../../lib/funding-storage");
  store = actual.createFundingStorage(directory);
  vi.mocked(createFundingStorage).mockReturnValue(store);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  vi.stubEnv("RECENT_FUNDING_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network call")));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads saved companies and metadata without upstream requests or an API key", async () => {
  store.saveSnapshot(snapshot);
  vi.stubEnv("RECENT_FUNDING_API_KEY", "");
  const response = await GET();
  const data = await response.json();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(data.companies).toEqual(fixture.companies);
  expect(data.snapshot.fetchedAt).toBe(snapshot.fetchedAt);
  expect(data.snapshot.coverage).toBe("complete");
  expect(fetch).not.toHaveBeenCalled();
});

it("returns an empty saved-data state", async () => {
  expect(await (await GET()).json()).toEqual({ companies: [], snapshot: null });
  expect(fetch).not.toHaveBeenCalled();
});

it("refreshes on POST and exposes the new snapshot on GET", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ companies: [
    { ...fixture.companies[0], hq_country: "US", announced_at: "2026-10-15T00:00:00Z" },
  ], next_offset: null }));
  const response = await POST();
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("complete");
  expect((await (await GET()).json()).companies).toHaveLength(1);
  expect((await (await POST()).json()).status).toBe("already_collected");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports failed collection, preserves old data, and exposes persisted cooldown", async () => {
  store.saveSnapshot({ ...snapshot, fetchedAt: "2026-10-31T12:00:00Z" });
  const response = await POST();
  expect(response.status).toBe(502);
  expect((await response.json()).status).toBe("failed");
  const retry = await (await POST()).json();
  expect(retry.status).toBe("cooldown");
  expect(retry.nextAllowedAttemptAt).toBe("2026-11-01T12:15:00.000Z");
  expect((await (await GET()).json()).companies).toEqual(fixture.companies);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports partial coverage without selecting it for display", async () => {
  vi.mocked(fetch).mockImplementation(async url => Response.json({ companies: [],
    next_offset: Number(new URL(String(url)).searchParams.get("offset")) + 1000 }));
  const data = await (await POST()).json();
  expect(data.status).toBe("partial");
  expect(data.attemptCoverage).toBe("partial");
  expect((await (await GET()).json()).snapshot).toBeNull();
});

it("returns safe errors for corrupt storage and missing configuration", async () => {
  writeFileSync(join(directory, "state.json"), "broken");
  expect((await GET()).status).toBe(500);
  expect((await POST()).status).toBe(500);
  expect(fetch).not.toHaveBeenCalled();
});
