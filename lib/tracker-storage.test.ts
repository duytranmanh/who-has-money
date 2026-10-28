import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/companies.json";
import { createCompany, createContact, startSequence } from "./tracker";
import { createTrackerStorage } from "./tracker-storage";
import { rename, writeFile as saveFile } from "node:fs/promises";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tracker-storage-"));
  path = join(directory, "data", "tracker.json");
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function company() {
  return createCompany({ name: fixture.companies[0].name });
}

describe("tracker JSON storage", () => {
  it("returns empty data for a missing file without creating it", async () => {
    expect(await createTrackerStorage(path).readTracker()).toEqual({ companies: [] });
    expect(await readdir(directory)).toEqual([]);
  });

  it("round trips nested history through a fresh store", async () => {
    const savedCompany = company();
    savedCompany.contacts.push(startSequence(createContact({ name: "Alex" }), {
      text: "Hello", sentAt: "2026-10-01T12:00:00Z",
    }, new Date("2026-10-02T12:00:00Z")));
    const data = { companies: [savedCompany] };
    expect(await createTrackerStorage(path).updateTracker(() => data)).toEqual(data);
    expect(await createTrackerStorage(path).readTracker()).toEqual(data);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(data);
    expect(await readdir(join(directory, "data"))).toEqual(["tracker.json"]);
  });

  it("serializes overlapping read-modify-write operations across stores sharing a path", async () => {
    const first = createTrackerStorage(path);
    const second = createTrackerStorage(path);
    const companies = Array.from({ length: 10 }, company);
    await Promise.all(companies.map((entry, index) => (index % 2 ? first : second).updateTracker(async data => {
      await Promise.resolve();
      return { companies: [...data.companies, entry] };
    })));
    expect((await first.readTracker()).companies).toEqual(companies);
  });

  it("leaves saved data intact when a callback mutates its input then fails, and accepts later updates", async () => {
    const store = createTrackerStorage(path);
    const original = { companies: [company()] };
    await store.updateTracker(() => original);
    const failed = store.updateTracker(data => {
      data.companies.length = 0;
      throw new Error("Rejected edit");
    });
    const next = store.updateTracker(data => ({ companies: [...data.companies, company()] }));
    await expect(failed).rejects.toThrow("Rejected edit");
    expect((await next).companies).toHaveLength(2);
  });

  it.each(["{broken", "null", '{"companies":{}}', '{"companies":[{"id":"1","name":"Test","notes":"","contacts":[{}]}]}'])("preserves malformed file %s", async contents => {
    await mkdir(join(directory, "data"));
    await writeFile(path, contents);
    const store = createTrackerStorage(path);
    await expect(store.readTracker()).rejects.toThrow(/invalid/);
    await expect(store.updateTracker(() => ({ companies: [] }))).rejects.toThrow(/invalid/);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("rejects malformed nested messages before saving", async () => {
    const savedCompany = company();
    const contact = startSequence(createContact({ name: "Alex" }), { text: "Hi", sentAt: "2026-10-01T12:00:00Z" });
    contact.sequences[0].messages[0].sentAt = "invalid";
    savedCompany.contacts.push(contact);
    await expect(createTrackerStorage(path).updateTracker(() => ({ companies: [savedCompany] }))).rejects.toThrow("Cannot save invalid tracker data");
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates read errors instead of treating them as missing data", async () => {
    await mkdir(path, { recursive: true });
    await expect(createTrackerStorage(path).readTracker()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it.each(["write", "rename"])("preserves saved data after a failed %s and recovers", async stage => {
    const store = createTrackerStorage(path);
    const original = { companies: [company()] };
    await store.updateTracker(() => original);
    const bytes = await readFile(path, "utf8");
    const failure = new Error("Disk failure");
    if (stage === "write") vi.mocked(saveFile).mockRejectedValueOnce(failure);
    else vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(store.updateTracker(() => ({ companies: [] }))).rejects.toThrow("Disk failure");
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await readdir(join(directory, "data"))).toEqual(["tracker.json"]);
    await store.updateTracker(() => ({ companies: [] }));
    expect(await store.readTracker()).toEqual({ companies: [] });
  });

  it("readers see old saved data until replacement finishes", async () => {
    const store = createTrackerStorage(path);
    const original = { companies: [company()] };
    await store.updateTracker(() => original);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = store.updateTracker(async () => {
      entered();
      await gate;
      return { companies: [] };
    });
    await ready;
    try {
      expect(await store.readTracker()).toEqual(original);
    } finally {
      release();
      await pending;
    }
    expect(await store.readTracker()).toEqual({ companies: [] });
  });
});

describe("legacy outreach compatibility", () => {
  it("loads saved drafts as ordinary messages and reconciles open attempts", async () => {
    const savedCompany = company();
    const contact = startSequence(createContact({ name: "Alex" }), { text: "Hello", sentAt: "2026-10-01T12:00:00Z" }, new Date("2026-10-02T12:00:00Z"));
    const original = contact.sequences[0];
    contact.sequences.push({ ...original, id: "new-attempt", messages: [
      { ...original.messages[0], id: "empty-message", text: "", sentAt: "2026-10-03T12:00:00Z", draft: true } as typeof original.messages[number],
    ] });
    savedCompany.contacts.push(contact);
    await mkdir(join(directory, "data"));
    await writeFile(path, JSON.stringify({ companies: [savedCompany] }));
    const loaded = await createTrackerStorage(path).readTracker();
    const sequences = loaded.companies[0].contacts[0].sequences;
    expect(sequences[0]).toMatchObject({ closeReason: "restarted", closedAt: "2026-10-03T12:00:00Z" });
    expect(sequences[1].messages[0]).toMatchObject({ text: "", sentAt: "2026-10-03T12:00:00Z" });
    expect(sequences[1].messages[0]).not.toHaveProperty("draft");
    await createTrackerStorage(path).updateTracker(() => loaded);
    expect(await createTrackerStorage(path).readTracker()).toEqual(loaded);
  });
});
