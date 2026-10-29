import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../fixtures/companies.json";
import { closeSequence, createCompany, createContact, recordFollowUp, startSequence } from "./tracker";
import { openTrackerDatabase } from "./tracker-db";
import { createTrackerStorage } from "./tracker-storage";

let directory: string;
let path: string;
let db: DatabaseSync;
let store: ReturnType<typeof createTrackerStorage>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tracker-storage-"));
  path = join(directory, "tracker.sqlite");
  db = openTrackerDatabase(path);
  store = createTrackerStorage(db);
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function history() {
  const company = createCompany({ name: fixture.companies[0].name, notes: "Notes\nwith unicode: café" });
  let contact = startSequence(createContact({ name: "Alex", email: "alex@example.com", links: ["https://example.com", ""] }),
    { text: "Hello", notes: "Initial notes", sentAt: "2026-10-01T12:00:00Z" });
  contact = recordFollowUp(contact, contact.sequences[0].id,
    { text: "Follow up", notes: "Follow-up notes", sentAt: "2026-10-02T12:00:00Z" });
  contact = closeSequence(contact, contact.sequences[0].id, "record_response", "2026-10-03T12:00:00Z");
  // Creation order must survive even when a newer attempt has an earlier sent timestamp.
  contact = startSequence(contact, { text: "", sentAt: "2026-09-01T12:00:00Z" });
  company.contacts.push(contact, createContact({ name: "Uncontacted" }));
  return { companies: [company, createCompany({ name: fixture.companies[1].name })] };
}

function seed(data = history()) {
  store.transaction(() => {
    for (const company of data.companies) {
      store.insertCompany(company);
      for (const contact of company.contacts) {
        store.insertContact(company.id, contact);
        for (const sequence of contact.sequences) {
          store.insertSequence(contact.id, sequence);
          for (const message of sequence.messages) store.insertMessage(sequence.id, message);
        }
      }
    }
  });
  return data;
}

it("reads empty and missing resources", () => {
  expect(store.listCompanies()).toEqual([]);
  expect(store.listContacts("missing")).toEqual([]);
  expect(store.listSequences("missing")).toEqual([]);
  expect(store.listMessages("missing")).toEqual([]);
  expect(store.getCompany("missing")).toBeUndefined();
  expect(store.getContact("missing")).toBeUndefined();
  expect(store.getSequence("missing")).toBeUndefined();
  expect(store.getMessage("missing")).toBeUndefined();
});

it("round trips all resources, fields, and creation ordering after reopening", () => {
  const data = seed();
  db.close();
  db = openTrackerDatabase(path);
  store = createTrackerStorage(db);
  expect(store.listCompanies()).toEqual(data.companies);
  const company = data.companies[0];
  const contact = company.contacts[0];
  const sequence = contact.sequences[0];
  expect(store.getCompany(company.id)).toEqual(company);
  expect(store.listContacts(company.id)).toEqual(company.contacts);
  expect(store.getContact(contact.id)).toEqual(contact);
  expect(store.listSequences(contact.id)).toEqual(contact.sequences);
  expect(store.getSequence(sequence.id)).toEqual(sequence);
  expect(store.listMessages(sequence.id)).toEqual(sequence.messages);
  expect(store.getMessage(sequence.messages[0].id)).toEqual(sequence.messages[0]);
});

it("lists sequences without messages and excludes other contacts' history", () => {
  const data = seed();
  const [contact, other] = data.companies[0].contacts;
  const empty = { id: "empty-sequence", closedAt: null, closeReason: null, respondedAt: null, messages: [] };
  store.insertSequence(contact.id, empty);
  store.insertSequence(other.id, { ...empty, id: "other-sequence" });
  expect(store.listSequences(contact.id)).toEqual([...contact.sequences, empty]);
  expect(store.listSequences(other.id)).toEqual([{ ...empty, id: "other-sequence" }]);
});

it("uses one query per resource read regardless of nested resource count", () => {
  const data = seed();
  const company = data.companies[0];
  const contact = company.contacts[0];
  const sequence = contact.sequences[0];
  const prepare = vi.spyOn(db, "prepare");
  try {
    const reads = [
      () => store.listCompanies(), () => store.getCompany(company.id),
      () => store.listContacts(company.id), () => store.getContact(contact.id),
      () => store.listSequences(contact.id), () => store.getSequence(sequence.id),
      () => store.listMessages(sequence.id), () => store.getMessage(sequence.messages[0].id),
    ];
    for (const read of reads) {
      prepare.mockClear();
      read();
      expect(prepare).toHaveBeenCalledTimes(1);
    }
  } finally {
    prepare.mockRestore();
  }
});

it("preserves empty parents and isolates lookups across multiple populated companies", () => {
  const data = history();
  const second = history().companies[0];
  data.companies.push(second);
  seed(data);
  expect(store.listCompanies()).toEqual(data.companies);
  for (const company of data.companies) {
    expect(store.getCompany(company.id)).toEqual(company);
    expect(store.listContacts(company.id)).toEqual(company.contacts);
    for (const contact of company.contacts) {
      expect(store.getContact(contact.id)).toEqual(contact);
      expect(store.listSequences(contact.id)).toEqual(contact.sequences);
      for (const sequence of contact.sequences) expect(store.getSequence(sequence.id)).toEqual(sequence);
    }
  }
});

it("updates individual resources without rewriting unrelated rows or changing ownership", () => {
  const data = seed();
  const company = data.companies[0];
  const contact = company.contacts[0];
  const sequence = contact.sequences[1];
  const message = sequence.messages[0];
  db.exec("CREATE TRIGGER no_company_delete BEFORE DELETE ON companies BEGIN SELECT RAISE(ABORT, 'unexpected delete'); END;");
  store.transaction(() => {
    expect(store.updateCompany({ ...company, notes: "Changed" })).toBe(true);
    expect(store.updateContact({ ...contact, email: "new@example.com", links: [] })).toBe(true);
    expect(store.updateSequence({ ...sequence, closeReason: "manual", closedAt: "2026-10-04T12:00:00Z" })).toBe(true);
    expect(store.updateMessage({ ...message, text: "Edited", notes: "Correction" })).toBe(true);
    expect(store.updateCompany({ id: "missing", name: "Missing", notes: "" })).toBe(false);
  });
  expect(store.getCompany(company.id)!.notes).toBe("Changed");
  expect(store.getContact(contact.id)).toMatchObject({ email: "new@example.com", links: [] });
  expect(store.getSequence(sequence.id)).toMatchObject({ closeReason: "manual", closedAt: "2026-10-04T12:00:00Z" });
  expect(store.getMessage(message.id)).toMatchObject({ text: "Edited", notes: "Correction", kind: message.kind });
  expect(store.getCompany(data.companies[1].id)).toEqual(data.companies[1]);
  expect(store.getSequence(contact.sequences[0].id)).toEqual(contact.sequences[0]);
});

it.each(["company", "contact", "sequence", "message"] as const)("deletes a %s and only its owned descendants", kind => {
  const data = seed();
  const company = data.companies[0];
  const contact = company.contacts[0];
  const sequence = contact.sequences[0];
  store.transaction(() => {
    if (kind === "company") expect(store.deleteCompany(company.id)).toBe(true);
    if (kind === "contact") expect(store.deleteContact(contact.id)).toBe(true);
    if (kind === "sequence") expect(store.deleteSequence(sequence.id)).toBe(true);
    if (kind === "message") expect(store.deleteMessage(sequence.messages[1].id)).toBe(true);
    expect(store.deleteCompany("missing")).toBe(false);
    expect(store.deleteContact("missing")).toBe(false);
    expect(store.deleteSequence("missing")).toBe(false);
    expect(store.deleteMessage("missing")).toBe(false);
  });
  expect(store.getCompany(data.companies[1].id)).toEqual(data.companies[1]);
  if (kind !== "message") expect(store.getMessage(sequence.messages[0].id)).toBeUndefined();
  if (kind === "message") expect(store.listMessages(sequence.id)).toEqual([sequence.messages[0]]);
  if (kind === "sequence") expect(store.listSequences(contact.id)).toEqual([contact.sequences[1]]);
  if (kind === "contact") expect(store.listContacts(company.id)).toEqual([company.contacts[1]]);
  if (kind === "company") expect(store.getCompany(company.id)).toBeUndefined();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("groups sequence closure and new outreach atomically, rolling back on failure", () => {
  const data = seed();
  const contact = data.companies[0].contacts[0];
  const sequence = contact.sequences[1];
  expect(() => store.transaction(() => {
    store.updateSequence({ ...sequence, closeReason: "restarted", closedAt: "2026-10-04T12:00:00Z" });
    store.insertSequence(contact.id, { ...sequence, id: "new-sequence" });
    store.insertMessage("new-sequence", sequence.messages[0]);
  })).toThrow(/UNIQUE/);
  expect(store.listCompanies()).toEqual(data.companies);
  store.transaction(() => store.updateContact({ ...contact, name: "Recovered" }));
  expect(store.getContact(contact.id)!.name).toBe("Recovered");
});

it("rolls back deletions and domain failures", () => {
  const data = seed();
  expect(() => store.transaction(() => {
    store.deleteCompany(data.companies[0].id);
    throw new Error("Rejected operation");
  })).toThrow("Rejected operation");
  expect(store.listCompanies()).toEqual(data.companies);
});

it("enforces foreign keys without leaving partial changes", () => {
  expect(() => store.transaction(() => store.insertContact("missing", createContact({ name: "Alex" }))))
    .toThrow(/FOREIGN KEY/);
  expect(store.listCompanies()).toEqual([]);
  expect(db.isTransaction).toBe(false);
});

it("commits single-statement resource writes without an explicit transaction", () => {
  const company = createCompany({ name: fixture.companies[0].name });
  const contact = startSequence(createContact({ name: "Alex" }), { text: "Hello", sentAt: "2026-10-01T12:00:00Z" });
  const sequence = contact.sequences[0];
  const message = sequence.messages[0];
  store.insertCompany(company);
  store.insertContact(company.id, contact);
  store.insertSequence(contact.id, sequence);
  store.insertMessage(sequence.id, message);
  expect(store.updateCompany({ ...company, notes: "Changed" })).toBe(true);
  expect(store.updateContact({ ...contact, name: "Edited" })).toBe(true);
  expect(store.updateSequence({ ...sequence, closeReason: "manual", closedAt: message.sentAt })).toBe(true);
  expect(store.updateMessage({ ...message, text: "Edited message" })).toBe(true);
  expect(db.isTransaction).toBe(false);
  db.close();
  db = openTrackerDatabase(path);
  store = createTrackerStorage(db);
  expect(store.getCompany(company.id)!.notes).toBe("Changed");
  expect(store.getContact(contact.id)!.name).toBe("Edited");
  expect(store.getSequence(sequence.id)!.closeReason).toBe("manual");
  expect(store.getMessage(message.id)!.text).toBe("Edited message");
  expect(store.deleteMessage(message.id)).toBe(true);
  expect(store.getMessage(message.id)).toBeUndefined();
  expect(db.isTransaction).toBe(false);
});

it("rejects nested transactions and asynchronous callbacks", () => {
  expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(/Nested/);
  expect(() => store.transaction(() => {
    store.insertCompany(createCompany({ name: "Rollback" }));
    return Promise.resolve();
  })).toThrow(/synchronous/);
  expect(store.listCompanies()).toEqual([]);
  expect(db.isTransaction).toBe(false);
});

it("keeps uncommitted edits invisible to another connection", () => {
  const data = seed();
  const otherDb = openTrackerDatabase(path);
  try {
    const other = createTrackerStorage(otherDb);
    store.transaction(() => {
      store.updateCompany({ ...data.companies[0], notes: "Changed" });
      expect(other.listCompanies()).toEqual(data.companies);
    });
    expect(other.getCompany(data.companies[0].id)!.notes).toBe("Changed");
  } finally {
    otherDb.close();
  }
});
