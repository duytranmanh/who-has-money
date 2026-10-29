import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "@/fixtures/companies.json";
import { createTrackerStorage } from "@/lib/tracker-storage";
import { GET } from "./route";
import { POST as createCompany, GET as listCompanies } from "./companies/route";
import { PATCH as editCompany, GET as getCompany } from "./companies/[id]/route";
import { POST as createContact } from "./companies/[id]/contacts/route";
import { PATCH as editContact } from "./contacts/[id]/route";
import { POST as start } from "./contacts/[id]/sequences/route";
import { POST as follow } from "./sequences/[id]/follow-ups/route";
import { PATCH as close } from "./sequences/[id]/route";
import { PATCH as edit, DELETE as remove } from "./messages/[id]/route";
import type { TrackerCompany, ContactProgress } from "@/lib/tracker";

const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createTrackerStorage>, fail: false }));
vi.mock("@/lib/tracker-storage", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/tracker-storage")>();
  return { ...actual,
    readTracker: () => state.fail ? Promise.reject(new Error("Private path")) : state.store.readTracker(),
    updateTracker: (...args: Parameters<typeof actual.updateTracker>) => state.fail ? Promise.reject(new Error("Private path")) : state.store.updateTracker(...args),
  };
});
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tracker-api-"));
  state.store = createTrackerStorage(join(directory, "tracker.json"));
  state.fail = false;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown, method = "POST") => new Request("http://localhost/api/tracker", { method, body: JSON.stringify(body) });
const message = (day: number) => ({ text: "Hello", sentAt: `2026-01-${String(day).padStart(2, "0")}T12:00:00Z` });
type Result = { companyId: string; company: Omit<TrackerCompany, "contacts"> & { contacts: (TrackerCompany["contacts"][number] & ContactProgress)[] }; computedAt: string };
async function result(response: Response, status = 200): Promise<Result> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body.companyId).toBe(body.company.id);
  expect(Number.isFinite(Date.parse(body.computedAt))).toBe(true);
  return body;
}
async function setup() {
  const created = await result(await createCompany(req({ name: fixture.companies[0].name })), 201);
  const added = await result(await createContact(req({ name: "Alex" }), ctx(created.companyId)), 201);
  return { companyId: added.companyId, contactId: added.company.contacts[0].id };
}

describe("tracker API", () => {
  it("lists sidebar summaries without full histories, email, or links", async () => {
    const { companyId, contactId } = await setup();
    await start(req(message(1)), ctx(contactId));
    const response = await listCompanies();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.companies).toEqual([{ id: companyId, name: fixture.companies[0].name, notes: "",
      contacts: [{ id: contactId, name: "Alex", status: "awaiting_follow_up_1", isOverdue: true }] }]);
  });

  it("returns only the requested company's details and rejects missing IDs", async () => {
    const { companyId, contactId } = await setup();
    await createCompany(req({ name: "Other company" }));
    await start(req(message(1)), ctx(contactId));
    const response = await getCompany(new Request("http://localhost"), ctx(companyId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.companies).toBeUndefined();
    expect(body.company.id).toBe(companyId);
    expect(body.company.contacts[0].sequences[0].messages[0].text).toBe("Hello");
    expect(body.company.contacts[0].status).toBe("awaiting_follow_up_1");
    expect((await getCompany(new Request("http://localhost"), ctx("missing"))).status).toBe(404);
  });

  it("returns empty tracker data with a computation timestamp", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ companies: [], computedAt: expect.any(String) });
  });

  it("persists company/contact changes and the full outreach/correction workflow", async () => {
    const { companyId, contactId } = await setup();
    expect((await result(await editCompany(req({ notes: "Research" }, "PATCH"), ctx(companyId)))).company.notes).toBe("Research");
    expect((await result(await editContact(req({ email: "alex@example.com", links: ["https://example.com"] }, "PATCH"), ctx(contactId)))).company.contacts[0].email).toBe("alex@example.com");
    let current = await result(await start(req(message(1)), ctx(contactId)), 201);
    const sequenceId = current.company.contacts[0].sequences[0].id;
    expect(current.company.contacts[0]).toMatchObject({ status: "awaiting_follow_up_1", nextFollowUpAt: "2026-01-04T12:00:00.000Z", isOverdue: true });
    current = await result(await follow(req(message(5)), ctx(sequenceId)), 201);
    const firstFollowUp = current.company.contacts[0].sequences[0].messages[1].id;
    current = await result(await edit(req({ sentAt: message(6).sentAt }, "PATCH"), ctx(firstFollowUp)));
    expect(current.company.contacts[0].nextFollowUpAt).toBe("2026-01-09T12:00:00.000Z");
    current = await result(await follow(req(message(9)), ctx(sequenceId)), 201);
    expect(current.company.contacts[0].status).toBe("completed");
    const secondFollowUp = current.company.contacts[0].sequences[0].messages[2].id;
    current = await result(await remove(new Request("http://localhost", { method: "DELETE" }), ctx(secondFollowUp)));
    expect(current.company.contacts[0].status).toBe("awaiting_follow_up_2");
    current = await result(await close(req({ action: "record_response", at: message(10).sentAt }, "PATCH"), ctx(sequenceId)));
    expect(current.company.contacts[0]).toMatchObject({ status: "responded", nextFollowUpAt: null, isOverdue: false });
    const fetched = await (await GET()).json();
    expect(fetched.companies[0]).toEqual(current.company);
    const stored = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
    expect(stored.companies[0].contacts[0].status).toBeUndefined();
    expect(stored.computedAt).toBeUndefined();
  });

  it("restarts open outreach and supports manual closure", async () => {
    const { contactId } = await setup();
    await result(await start(req(message(1)), ctx(contactId)), 201);
    const restarted = await result(await start(req(message(2)), ctx(contactId)), 201);
    const sequences = restarted.company.contacts[0].sequences;
    expect(sequences[0].closeReason).toBe("restarted");
    const closed = await result(await close(req({ action: "close", at: message(3).sentAt }, "PATCH"), ctx(sequences[1].id)));
    expect(closed.company.contacts[0].status).toBe("manual");
  });

  it.each([null, [], {}, { name: "" }, { name: 42 }, { name: "Alex", id: "client-id" }])("rejects invalid creation body %j", async body => {
    const response = await createCompany(req(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: expect.any(String) } });
  });

  it("rejects malformed JSON, wrong field types, missing timestamps, and attempts to edit message kind", async () => {
    expect((await createCompany(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
    const { companyId, contactId } = await setup();
    expect((await createContact(req({ name: "Alex", links: [42] }), ctx(companyId))).status).toBe(400);
    expect((await editContact(req({ name: null }, "PATCH"), ctx(contactId))).status).toBe(400);
    expect((await start(req({ text: "Hi" }), ctx(contactId))).status).toBe(400);
    const current = await result(await start(req(message(1)), ctx(contactId)), 201);
    const sequence = current.company.contacts[0].sequences[0];
    expect((await edit(req({ kind: "follow_up_2" }, "PATCH"), ctx(sequence.messages[0].id))).status).toBe(400);
    expect((await close(req({ action: "unknown", at: message(2).sentAt }, "PATCH"), ctx(sequence.id))).status).toBe(400);
  });

  it("returns 404 for missing records at every nesting level", async () => {
    for (const response of [
      await editCompany(req({ name: "New" }, "PATCH"), ctx("missing")),
      await createContact(req({ name: "Alex" }), ctx("missing")),
      await editContact(req({ name: "New" }, "PATCH"), ctx("missing")),
      await start(req(message(1)), ctx("missing")),
      await follow(req(message(2)), ctx("missing")),
      await close(req({ action: "close", at: message(3).sentAt }, "PATCH"), ctx("missing")),
      await edit(req({ text: "Correction" }, "PATCH"), ctx("missing")),
      await remove(new Request("http://localhost", { method: "DELETE" }), ctx("missing")),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("returns conflicts without changing saved history", async () => {
    const { contactId } = await setup();
    const initial = await result(await start(req(message(1)), ctx(contactId)), 201);
    const sequence = initial.company.contacts[0].sequences[0];
    await result(await follow(req(message(4)), ctx(sequence.id)), 201);
    const before = await state.store.readTracker();
    expect((await follow(req(message(3)), ctx(sequence.id))).status).toBe(409);
    expect((await remove(new Request("http://localhost", { method: "DELETE" }), ctx(sequence.messages[0].id))).status).toBe(409);
    expect(await state.store.readTracker()).toEqual(before);
    await result(await close(req({ action: "close", at: message(5).sentAt }, "PATCH"), ctx(sequence.id)));
    expect((await follow(req(message(6)), ctx(sequence.id))).status).toBe(409);
  });

  it("returns generic 500 responses on storage failures without claiming saved changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.fail = true;
    for (const response of [await GET(), await createCompany(req({ name: "Example" }))]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Could not load or save tracker data." } });
    }
    expect(await state.store.readTracker()).toEqual({ companies: [] });
  });
});

describe("empty inline outreach API", () => {
  it("persists empty outreach and follow-ups without a sent-state transition", async () => {
    const { contactId } = await setup();
    let current = await result(await start(req({ text: "", sentAt: message(1).sentAt }), ctx(contactId)), 201);
    const sequenceId = current.company.contacts[0].sequences[0].id;
    expect(current.company.contacts[0].status).toBe("awaiting_follow_up_1");
    current = await result(await follow(req({ text: "", sentAt: message(2).sentAt }), ctx(sequenceId)), 201);
    expect(current.company.contacts[0].nextFollowUpAt).toBe("2026-01-05T12:00:00.000Z");
    const id = current.company.contacts[0].sequences[0].messages[1].id;
    current = await result(await edit(req({ text: "", notes: "" }, "PATCH"), ctx(id)));
    expect(current.company.contacts[0].sequences[0].messages[1].text).toBe("");
    await result(await close(req({ action: "record_response", at: message(3).sentAt }, "PATCH"), ctx(sequenceId)));
    current = await result(await close(req({ action: "edit_closure", at: message(4).sentAt }, "PATCH"), ctx(sequenceId)));
    expect(current.company.contacts[0].sequences[0].respondedAt).toBe("2026-01-04T12:00:00.000Z");
    expect((await state.store.readTracker()).companies[0].contacts[0].sequences[0].messages[0].text).toBe("");
  });
});
