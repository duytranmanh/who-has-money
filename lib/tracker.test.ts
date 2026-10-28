import { describe, expect, it } from "vitest";
import fixture from "../fixtures/companies.json";
import {
  closeSequence, createCompany, createContact, deleteMessage, deriveContactProgress,
  editClosure, editMessage, recordFollowUp, startSequence, TrackerError, updateCompany, updateContact,
} from "./tracker";

const now = new Date("2026-11-10T12:00:00Z");
const initialAt = "2026-10-30T10:00:00-05:00";
const input = (sentAt = initialAt) => ({ text: "Hello", sentAt });
function started() {
  return startSequence(createContact({ name: "Alex" }), input(), now);
}
function followed() {
  const contact = started();
  return recordFollowUp(contact, contact.sequences[0].id, input("2026-11-03T15:00:00Z"), now);
}
function completed() {
  const contact = followed();
  return recordFollowUp(contact, contact.sequences[0].id, input("2026-11-06T15:00:00Z"), now);
}

function expectError(run: () => unknown, code: TrackerError["code"]) {
  expect(run).toThrow(TrackerError);
  try { run(); } catch (error) { expect((error as TrackerError).code).toBe(code); }
}

describe("tracker records", () => {
  it("creates independent records using a Discovery company name", () => {
    const company = createCompany({ name: fixture.companies[0].name });
    expect(company.contacts).toEqual([]);
    expect(company.id).not.toBe(createCompany({ name: company.name }).id);
    expect(updateCompany(company, { notes: "Research" })).toEqual({ ...company, notes: "Research" });
    expect(company.notes).toBe("");
  });

  it("validates details and copies contact links", () => {
    const links = ["https://example.com/alex"];
    const contact = createContact({ name: " Alex ", links });
    links.push("https://example.com/other");
    expect(contact.name).toBe("Alex");
    expect(contact.links).toHaveLength(1);
    expect(updateContact(contact, { email: "alex@example.com" }).id).toBe(contact.id);
    expectError(() => createCompany({ name: " " }), "invalid_input");
    expectError(() => updateContact(contact, { name: "" }), "invalid_input");
    expectError(() => createContact({ name: "Alex", links: [42] as unknown as string[] }), "invalid_input");
  });
});

describe("sequence timing and transitions", () => {
  it("keeps uncontacted contacts accessible", () => {
    expect(deriveContactProgress(createContact({ name: "Alex" }), now)).toEqual({
      status: "uncontacted", nextFollowUpAt: null, isOverdue: false,
    });
  });

  it("uses 72 elapsed hours across DST and derives overdue from the supplied clock", () => {
    const contact = started();
    const due = "2026-11-02T15:00:00.000Z";
    expect(deriveContactProgress(contact, new Date(due))).toEqual({
      status: "awaiting_follow_up_1", nextFollowUpAt: due, isOverdue: false,
    });
    expect(deriveContactProgress(contact, now).isOverdue).toBe(true);
  });

  it("shifts the second due date after late sending", () => {
    expect(deriveContactProgress(followed(), now)).toEqual({
      status: "awaiting_follow_up_2", nextFollowUpAt: "2026-11-06T15:00:00.000Z", isOverdue: true,
    });
  });

  it("allows early follow-ups and closes after the second", () => {
    const contact = started();
    const first = recordFollowUp(contact, contact.sequences[0].id, input("2026-10-30T16:00:00Z"), now);
    expect(first.sequences[0].messages[1].kind).toBe("follow_up_1");
    const done = completed();
    expect(done.sequences[0].messages[2].kind).toBe("follow_up_2");
    expect(done.sequences[0].closedAt).toBe("2026-11-06T15:00:00.000Z");
    expect(deriveContactProgress(done, now)).toEqual({ status: "completed", nextFollowUpAt: null, isOverdue: false });
    expectError(() => recordFollowUp(done, done.sequences[0].id, input(), now), "conflict");
  });

  it.each(["record_response", "close"] as const)("stops pending follow-ups for %s", action => {
    const contact = followed();
    const closed = closeSequence(contact, contact.sequences[0].id, action, "2026-11-04T00:00:00Z", now);
    expect(closed.sequences[0].closeReason).toBe(action === "close" ? "manual" : "responded");
    expect(closed.sequences[0].respondedAt).toBe(action === "close" ? null : "2026-11-04T00:00:00.000Z");
    expect(deriveContactProgress(closed, now).nextFollowUpAt).toBeNull();
    expectError(() => recordFollowUp(closed, closed.sequences[0].id, input(), now), "conflict");
  });

  it("restarts atomically and uses creation order for backdated outreach", () => {
    const contact = started();
    const original = structuredClone(contact);
    const restarted = startSequence(contact, input("2026-10-01T00:00:00Z"), now);
    expect(contact).toEqual(original);
    expect(restarted.sequences[0].closeReason).toBe("restarted");
    expect(restarted.sequences[1].closedAt).toBeNull();
    expect(deriveContactProgress(restarted, now).nextFollowUpAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it.each(["2026-10-30T10:00:00", "2026-02-30T00:00:00Z", "2026-11-11T00:00:00Z", "garbage", "2026-10-30T24:00:00Z"])("rejects invalid timestamp %s", sentAt => {
    expectError(() => startSequence(createContact({ name: "Alex" }), input(sentAt), now), "invalid_input");
  });

  it("requires explicit timestamps, ordered sends, and valid closure times", () => {
    const contact = followed();
    const id = contact.sequences[0].id;
    expectError(() => startSequence(contact, { text: "Hi" } as never, now), "invalid_input");
    expectError(() => recordFollowUp(contact, id, input("2026-11-03T15:00:00Z"), now), "conflict");
    expectError(() => closeSequence(contact, id, "close", initialAt, now), "conflict");
    expectError(() => recordFollowUp(contact, "missing", input(), now), "not_found");
  });
});

describe("message corrections", () => {
  it("recalculates due dates without changing IDs or kind", () => {
    const contact = followed();
    const original = structuredClone(contact);
    const entry = contact.sequences[0].messages[1];
    const edited = editMessage(contact, entry.id, { text: "Correction", sentAt: "2026-11-04T15:00:00Z", notes: "Backdated" }, now);
    expect(edited.sequences[0].messages[1]).toMatchObject({ id: entry.id, kind: entry.kind, text: "Correction", notes: "Backdated" });
    expect(deriveContactProgress(edited, now).nextFollowUpAt).toBe("2026-11-07T15:00:00.000Z");
    expect(contact).toEqual(original);
    expectError(() => editMessage(contact, entry.id, { sentAt: initialAt }, now), "conflict");
    expectError(() => editMessage(contact, contact.sequences[0].messages[0].id, { sentAt: "2026-11-04T00:00:00Z" }, now), "conflict");
  });

  it("updates automatic completion time and reopens after deleting second follow-up", () => {
    const contact = completed();
    const id = contact.sequences[0].messages[2].id;
    const edited = editMessage(contact, id, { sentAt: "2026-11-07T15:00:00Z" }, now);
    expect(edited.sequences[0].closedAt).toBe("2026-11-07T15:00:00.000Z");
    const reopened = deleteMessage(edited, id);
    expect(reopened.sequences[0].closeReason).toBeNull();
    expect(deriveContactProgress(reopened, now).status).toBe("awaiting_follow_up_2");
  });

  it("never reopens historical completed attempts, even after newer attempts are removed", () => {
    const done = completed();
    const restarted = startSequence(done, input(), now);
    const corrected = deleteMessage(restarted, done.sequences[0].messages[2].id);
    expect(corrected.sequences[0].closeReason).toBe("completed");
    const removed = deleteMessage(corrected, corrected.sequences[1].messages[0].id);
    expect(deriveContactProgress(removed, now).status).toBe("completed");
  });

  it.each(["record_response", "close"] as const)("preserves %s closure during corrections", action => {
    const contact = followed();
    const closed = closeSequence(contact, contact.sequences[0].id, action, "2026-11-05T00:00:00Z", now);
    const edited = editMessage(closed, closed.sequences[0].messages[1].id, { notes: "Correction" }, now);
    const corrected = deleteMessage(edited, edited.sequences[0].messages[1].id);
    expect(corrected.sequences[0].closedAt).toBe(closed.sequences[0].closedAt);
    expect(corrected.sequences[0].closeReason).toBe(closed.sequences[0].closeReason);
  });

  it("preserves restarted closure and requires deletion from the end", () => {
    const contact = startSequence(followed(), input(), now);
    expectError(() => deleteMessage(contact, contact.sequences[0].messages[0].id), "conflict");
    const corrected = deleteMessage(contact, contact.sequences[0].messages[1].id);
    expect(corrected.sequences[0].closeReason).toBe("restarted");
  });

  it("removes an empty sequence and reports missing messages", () => {
    const contact = started();
    expect(deleteMessage(contact, contact.sequences[0].messages[0].id).sequences).toEqual([]);
    expectError(() => deleteMessage(contact, "missing"), "not_found");
    expectError(() => editMessage(contact, "missing", {}, now), "not_found");
  });
});

describe("empty outreach", () => {
  it("tracks empty messages and follow-ups by date and lets text be cleared", () => {
    let contact = startSequence(createContact({ name: "Alex" }), { text: "", sentAt: initialAt }, now);
    const id = contact.sequences[0].id;
    expect(deriveContactProgress(contact, now).status).toBe("awaiting_follow_up_1");
    contact = recordFollowUp(contact, id, { text: "", sentAt: "2026-11-03T15:00:00Z" }, now);
    expect(deriveContactProgress(contact, now).nextFollowUpAt).toBe("2026-11-06T15:00:00.000Z");
    contact = editMessage(contact, contact.sequences[0].messages[1].id, { text: "", notes: "" }, now);
    contact = recordFollowUp(contact, id, { text: "", sentAt: "2026-11-06T15:00:00Z" }, now);
    expect(deriveContactProgress(contact, now).status).toBe("completed");
    expect(contact.sequences[0].messages.every(message => message.text === "")).toBe(true);
  });

  it("corrects response times without changing the closure reason", () => {
    const original = started();
    const id = original.sequences[0].id;
    const closed = closeSequence(original, id, "record_response", "2026-11-02T12:00:00Z", now);
    const edited = editClosure(closed, id, "2026-11-03T12:00:00Z", now);
    expect(edited.sequences[0]).toMatchObject({ closeReason: "responded", closedAt: "2026-11-03T12:00:00.000Z", respondedAt: "2026-11-03T12:00:00.000Z" });
    expectError(() => editClosure(edited, id, "2026-01-01T00:00:00Z", now), "conflict");
  });
});
