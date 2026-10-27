import { deriveContactProgress, TrackerError } from "./tracker";
import type { TrackerCompany, TrackerContact, TrackerData } from "./tracker";
import { readTracker, updateTracker } from "./tracker-storage";

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

// Persist inside the queue, then derive the affected company's response from the saved snapshot.
export async function trackerWrite(
  request: Request,
  allowed: string[],
  required: string[],
  change: (data: TrackerData, input: Record<string, string> & { links?: string[] }, now: Date) => string,
  status = 200,
): Promise<Response> {
  try {
    const input = allowed.length ? await body(request, allowed, required) : {} as Record<string, string>;
    let companyId = "";
    const saved = await updateTracker(data => {
      companyId = change(data, input, new Date());
      return data;
    });
    const now = new Date();
    return Response.json({ companyId, company: companyView(findCompany(saved, companyId), now), computedAt: now.toISOString() }, { status, headers });
  } catch (error) { return errorResponse(error); }
}

// GET recalculates due dates rather than persisting or caching derived values.
export async function trackerRead(): Promise<Response> {
  try {
    const data = await readTracker();
    const now = new Date();
    return Response.json({ companies: data.companies.map(company => companyView(company, now)), computedAt: now.toISOString() }, { headers });
  } catch (error) { return errorResponse(error); }
}

export function findCompany(data: TrackerData, id: string): TrackerCompany {
  const company = data.companies.find(company => company.id === id);
  if (!company) throw new TrackerError("not_found", "Company not found.");
  return company;
}

// Locate nested history by its stable ID while retaining the owning company for write responses.
export function findContact(data: TrackerData, kind: "contact" | "sequence" | "message", id: string): { company: TrackerCompany; contact: TrackerContact } {
  for (const company of data.companies) {
    for (const contact of company.contacts) {
      const matches = kind === "contact" ? contact.id === id : contact.sequences.some(sequence =>
        kind === "sequence" ? sequence.id === id : sequence.messages.some(message => message.id === id));
      if (matches) return { company, contact };
    }
  }
  throw new TrackerError("not_found", `${kind} not found.`);
}

// Replace only the matching contact in the loaded snapshot; storage owns committing that snapshot.
export function replaceContact(company: TrackerCompany, updated: TrackerContact): string {
  company.contacts = company.contacts.map(contact => contact.id === updated.id ? updated : contact);
  return company.id;
}
