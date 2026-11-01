import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../fixtures/companies.json";
import { createFundingStorage } from "./funding-storage";
import { collectFunding } from "./funding-collector";

let directory: string;
let time: Date;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "funding-collector-"));
  time = new Date("2026-11-01T12:00:00Z");
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const company = (slug: string, date = "2026-10-15T00:00:00Z", country: string | null = "US") =>
  ({ ...fixture.companies[0], slug, announced_at: date, hq_country: country });
const page = (companies: unknown[], next_offset: number | null) => Response.json({ companies, next_offset });
function setup() {
  const store = createFundingStorage(directory);
  const request = vi.fn<typeof fetch>();
  const run = () => collectFunding({ store, fetch: request, now: () => time, apiKey: "test-key" });
  return { store, request, run };
}

it("follows empty pages, filters UTC boundaries and country, deduplicates, then stops at older dates", async () => {
  const { store, request, run } = setup();
  request.mockResolvedValueOnce(page([], 1000)).mockResolvedValueOnce(page([
    company("new", "2026-10-18T00:00:00Z"), company("keep"), company("keep"),
    company("foreign", undefined, "Canada"), company("start", "2026-10-11T00:00:00Z", null),
    company("old", "2026-10-10T00:00:00Z"),
  ], 2000));
  const result = await run();
  expect(result.status).toBe("complete");
  expect(result.snapshot?.companies.map(c => c.slug)).toEqual(["keep", "start"]);
  expect(request.mock.calls[1][0]).toContain("limit=1000&offset=1000");
  expect(store.readState()?.callsAttempted).toBe(2);
  expect((await run()).status).toBe("already_collected");
  expect(request).toHaveBeenCalledTimes(2);
});

it("counts calls before sending and limits empty-page scans to eight calls", async () => {
  const { store, request, run } = setup();
  request.mockImplementation(async url => {
    expect(store.readState()?.callsAttempted).toBe(request.mock.calls.length);
    return page([], Number(new URL(String(url)).searchParams.get("offset")) + 1000);
  });
  expect((await run()).status).toBe("partial");
  expect(request).toHaveBeenCalledTimes(8);
  expect(store.readLatestSnapshot()).toBeNull();
  expect((await run()).status).toBe("budget_exhausted");
});

it("persists cooldown and allows only one delayed transient retry per UTC day", async () => {
  const { store, request, run } = setup();
  request.mockRejectedValue(new Error("network"));
  expect((await run()).status).toBe("failed");
  expect((await run()).status).toBe("cooldown");
  time = new Date("2026-11-01T12:16:00Z");
  expect((await run()).status).toBe("failed");
  time = new Date("2026-11-01T14:00:00Z");
  expect((await run()).status).toBe("cooldown");
  expect(store.readState()?.callsAttempted).toBe(2);
  time = new Date("2026-11-02T12:00:00Z");
  request.mockResolvedValue(page([], null));
  expect((await run()).status).toBe("complete");
  expect(store.readState()?.callsAttempted).toBe(1);
});

it("honors Retry-After without immediately retrying", async () => {
  const { store, request, run } = setup();
  request.mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "3600" } }));
  await run();
  expect(store.readState()?.nextAllowedAttemptAt).toBe("2026-11-01T13:00:00.000Z");
  expect((await run()).status).toBe("cooldown");
  expect(request).toHaveBeenCalledTimes(1);
});

it("blocks overlapping collectors and releases the lock after completion", async () => {
  const { request, run } = setup();
  let respond!: (value: Response) => void;
  request.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  const first = run();
  expect((await run()).status).toBe("busy");
  respond(page([], null));
  await first;
  expect((await run()).status).toBe("already_collected");
});

it.each([401, 400, 403])("stops on HTTP %s without repeated attempts", async status => {
  const { request, run } = setup();
  request.mockResolvedValue(new Response(null, { status }));
  expect((await run()).status).toBe("failed");
  expect((await run()).status).toBe("cooldown");
});

it("rejects bad pagination and keeps previous complete data after partial failure", async () => {
  const { store, request, run } = setup();
  store.saveSnapshot({ fetchedAt: "2026-10-31T12:00:00Z", windowStart: "2026-10-10T00:00:00Z",
    windowEnd: "2026-10-17T00:00:00Z", coverage: "complete", companies: [company("previous")] });
  request.mockResolvedValueOnce(page([company("today")], 1000)).mockResolvedValueOnce(page([], 1000));
  expect((await run()).status).toBe("partial");
  expect(store.readLatestSnapshot()?.companies[0].slug).toBe("previous");
  expect((await run()).status).toBe("cooldown");
});

it("releases its lock without sending when configuration is missing", async () => {
  const { store, request } = setup();
  await expect(collectFunding({ store, fetch: request, apiKey: "" })).rejects.toThrow("not configured");
  const release = store.acquireLock();
  expect(release).not.toBeNull();
  release?.();
  expect(request).not.toHaveBeenCalled();
});

it("never sends an uncounted request when persisting the budget fails", async () => {
  const { store, request, run } = setup();
  vi.spyOn(store, "saveState").mockImplementationOnce(() => { throw new Error("disk full"); });
  await expect(run()).rejects.toThrow("disk full");
  expect(request).not.toHaveBeenCalled();
  const release = store.acquireLock();
  expect(release).not.toBeNull();
  release?.();
});

it("republishes an archived complete snapshot without another API call", async () => {
  const { store, request, run } = setup();
  request.mockResolvedValue(page([], null));
  await run();
  store.saveState({ ...store.readState()!, latestCompleteSnapshot: null });
  expect((await run()).status).toBe("already_collected");
  expect(store.readLatestSnapshot()?.coverage).toBe("complete");
  expect(request).toHaveBeenCalledTimes(1);
});

it("finishes across midnight using the starting day's window and budget", async () => {
  const { store, request, run } = setup();
  time = new Date("2026-11-01T23:59:59Z");
  request.mockImplementationOnce(async () => {
    time = new Date("2026-11-02T00:00:01Z");
    return page([], 1000);
  }).mockResolvedValueOnce(page([company("keep")], null));
  const result = await run();
  expect(result.status).toBe("complete");
  expect(result.snapshot?.windowEnd).toBe("2026-10-18T00:00:00.000Z");
  expect(result.snapshot?.fetchedAt).toBe("2026-11-01T23:59:59.000Z");
  expect(store.readState()?.budgetDate).toBe("2026-11-01");
  expect(store.readState()?.callsAttempted).toBe(2);
  expect(request).toHaveBeenCalledTimes(2);
});
