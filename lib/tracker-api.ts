import { deriveContactProgress, deriveOutreachProgress, TrackerError } from "./tracker";
import type { TrackerCompany, TrackerContact } from "./tracker";
import { withTrackerStore, type TrackerStore } from "./tracker-storage";
import { isDeepStrictEqual } from "node:util";

export type IdContext = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };

// Attach transient state using one clock for the whole response.
function companyView(company: TrackerCompany, now: Date) {
  return { ...company, contacts: company.contacts.map(contact => ({ ...contact, ...deriveContactProgress(contact, now) })) };
}

// Domain failures have stable public codes; unexpected failures never expose stored data or paths.
function errorResponse(error: unknown): Response {
  if (error instanceof TrackerError) {
    const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
    return Response.json({ error: { code: error.code, message: error.message } }, { status, headers });
  }
  console.error("Tracker operation failed", { kind: "storage-or-internal-error" });
  return Response.json({ error: { code: "internal_error", message: "Could not load or save tracker data." } }, { status: 500, headers });
}

// Parse only client-editable fields; domain functions enforce their semantic constraints.
async function body(request: Request, allowed: string[], required: string[]): Promise<Record<string, string> & { links?: string[] }> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new TrackerError("invalid_input", "Body must be valid JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TrackerError("invalid_input", "Body must be an object.");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).length || Object.keys(record).some(key => !allowed.includes(key))) {
    throw new TrackerError("invalid_input", "Supply supported editable fields.");
  }
  for (const key of required) {
    if (!(key in record)) throw new TrackerError("invalid_input", `${key} is required.`);
  }
  for (const [key, field] of Object.entries(record)) {
    if (key === "links" ? !Array.isArray(field) || field.some(link => typeof link !== "string") : typeof field !== "string") {
      throw new TrackerError("invalid_input", `${key} has an invalid type.`);
    }
  }
  return record as Record<string, string> & { links?: string[] };
}

// Logic owns the transaction: read, apply domain rules, persist resource changes, and build the response together.
export async function trackerWrite(
  request: Request,
  allowed: string[],
  required: string[],
  change: (data: TrackerStore, input: Record<string, string> & { links?: string[] }, now: Date) => string,
  status = 200,
): Promise<Response> {
  try {
    const input = allowed.length ? await body(request, allowed, required) : {} as Record<string, string>;
    return withTrackerStore(store => store.transaction(() => {
      const now = new Date();
      const companyId = change(store, input, now);
      return Response.json({ companyId, company: companyView(findCompany(store, companyId), now), computedAt: now.toISOString() }, { status, headers });
    }));
  } catch (error) { return errorResponse(error); }
}

// GET recalculates due dates rather than persisting or caching derived values.
export async function trackerRead(): Promise<Response> {
  try {
    return withTrackerStore(store => {
      const now = new Date();
      return Response.json({ companies: store.listCompanies().map(company => companyView(company, now)), computedAt: now.toISOString() }, { headers });
    });
  } catch (error) { return errorResponse(error); }
}

// Sidebar summaries retain search and badges without sending outreach history or contact details.
export async function trackerCompanyList(): Promise<Response> {
  try {
    return withTrackerStore(store => {
      const now = new Date();
      const companies = store.listCompanySummaries().map(company => ({ ...company,
        contacts: company.contacts.map(({ lastSentAt, messageCount, closeReason, ...contact }) => {
          const { status, isOverdue } = deriveOutreachProgress({ closeReason, messageCount, lastSentAt }, now);
          return { ...contact, status, isOverdue };
        }) }));
      return Response.json({ companies, computedAt: now.toISOString() }, { headers });
    });
  } catch (error) { return errorResponse(error); }
}

// Only the selected company's full history is sent to the workspace.
export async function trackerCompanyRead(id: string): Promise<Response> {
  try {
    return withTrackerStore(store => {
      const now = new Date();
      return Response.json({ company: companyView(findCompany(store, id), now), computedAt: now.toISOString() }, { headers });
    });
  } catch (error) { return errorResponse(error); }
}

// Delete the whole company tree atomically; no company remains to return.
export async function trackerCompanyDelete(id: string): Promise<Response> {
  try {
    return withTrackerStore(store => store.transaction(() => {
      findCompany(store, id);
      store.deleteCompany(id);
      return Response.json({ companyId: id, company: null, computedAt: new Date().toISOString() }, { headers });
    }));
  } catch (error) { return errorResponse(error); }
}

export function findCompany(store: TrackerStore, id: string): TrackerCompany {
  const company = store.getCompany(id);
  if (!company) throw new TrackerError("not_found", "Company not found.");
  return company;
}

// Resolve ownership with SQL rather than scanning every company's history.
export function findContact(store: TrackerStore, kind: "contact" | "sequence" | "message", id: string) {
  const owner = store.findContactOwner(kind, id);
  if (!owner) throw new TrackerError("not_found", `${kind} not found.`);
  const contact = store.getContact(owner.contactId)!;
  return { company: { id: owner.companyId }, contact };
}

// Persist only changed resources from a domain operation; the API caller owns the transaction.
export function replaceContact(store: TrackerStore, company: { id: string }, before: TrackerContact, updated: TrackerContact): string {
  if (before.name !== updated.name || before.email !== updated.email || !isDeepStrictEqual(before.links, updated.links)) store.updateContact(updated);
  for (const old of before.sequences) {
    if (!updated.sequences.some(sequence => sequence.id === old.id)) store.deleteSequence(old.id);
  }
  for (const sequence of updated.sequences) {
    const old = before.sequences.find(existing => existing.id === sequence.id);
    if (!old) store.insertSequence(updated.id, sequence);
    else if (old.closedAt !== sequence.closedAt || old.closeReason !== sequence.closeReason || old.respondedAt !== sequence.respondedAt) store.updateSequence(sequence);
    for (const message of old?.messages ?? []) {
      if (!sequence.messages.some(existing => existing.id === message.id)) store.deleteMessage(message.id);
    }
    for (const message of sequence.messages) {
      const previous = old?.messages.find(existing => existing.id === message.id);
      if (!previous) store.insertMessage(sequence.id, message);
      else if (!isDeepStrictEqual(previous, message)) store.updateMessage(message);
    }
  }
  return company.id;
}
