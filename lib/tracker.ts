export type MessageKind = "initial" | "follow_up_1" | "follow_up_2";
export type CloseReason = "responded" | "completed" | "manual" | "restarted";
export type TrackerMessage = { id: string; kind: MessageKind; text: string; sentAt: string; notes: string };
export type TrackerSequence = {
  id: string;
  closedAt: string | null;
  closeReason: CloseReason | null;
  respondedAt: string | null;
  messages: TrackerMessage[];
};
// Sequences are appended in creation order, independent of backdated sent timestamps.
export type TrackerContact = { id: string; name: string; email: string; links: string[]; sequences: TrackerSequence[] };
export type TrackerCompany = { id: string; name: string; notes: string; contacts: TrackerContact[] };
export type TrackerData = { companies: TrackerCompany[] };
export type MessageInput = { text: string; sentAt: string; notes?: string };
export type ContactInput = { name: string; email?: string; links?: string[] };
export type CompanyInput = { name: string; notes?: string };
export type ContactProgress = {
  status: "uncontacted" | "awaiting_follow_up_1" | "awaiting_follow_up_2" | CloseReason;
  nextFollowUpAt: string | null;
  isOverdue: boolean;
};

export class TrackerError extends Error {
  constructor(public code: "invalid_input" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TrackerError("invalid_input", `${field} must not be empty.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new TrackerError("invalid_input", `${field} must be a string.`);
  return value;
}

// Require explicit offsets and reject calendar dates that Date.parse would silently normalize.
function timestamp(value: unknown, now: Date): string {
  if (typeof value !== "string") throw new TrackerError("invalid_input", "Timestamp must include a timezone offset.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  const time = Date.parse(value);
  if (!match || !Number.isFinite(time)) throw new TrackerError("invalid_input", "Invalid timestamp or missing timezone offset.");
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59 || time > now.getTime()) {
    throw new TrackerError("invalid_input", "Timestamp must be valid and cannot be in the future.");
  }
  return new Date(time).toISOString();
}

// Create an empty tracker company with an independent stable ID.
export function createCompany(input: CompanyInput): TrackerCompany {
  return { id: crypto.randomUUID(), name: requiredText(input.name, "Name"), notes: optionalText(input.notes, "Notes"), contacts: [] };
}

// Validate supplied company fields while preserving contacts and identity.
export function updateCompany(company: TrackerCompany, patch: Partial<CompanyInput>): TrackerCompany {
  return { ...company, ...(patch.name !== undefined ? { name: requiredText(patch.name, "Name") } : {}),
    ...(patch.notes !== undefined ? { notes: optionalText(patch.notes, "Notes") } : {}) };
}

// Create an uncontacted person with independent links and a stable ID.
export function createContact(input: ContactInput): TrackerContact {
  return updateContact({ id: crypto.randomUUID(), name: "", email: "", links: [], sequences: [] }, input);
}

// Validate supplied details while preserving outreach history.
export function updateContact(contact: TrackerContact, patch: Partial<ContactInput>): TrackerContact {
  if (patch.links !== undefined && (!Array.isArray(patch.links) || patch.links.some(link => typeof link !== "string"))) {
    throw new TrackerError("invalid_input", "Links must be an array of strings.");
  }
  return { ...contact, name: requiredText(patch.name ?? contact.name, "Name"),
    email: patch.email === undefined ? contact.email : optionalText(patch.email, "Email"),
    links: patch.links === undefined ? [...contact.links] : [...patch.links] };
}

function message(input: MessageInput, kind: MessageKind, now: Date): TrackerMessage {
  return { id: crypto.randomUUID(), kind, text: requiredText(input.text, "Message text"),
    sentAt: timestamp(input.sentAt, now), notes: optionalText(input.notes, "Notes") };
}

function sequenceIndex(contact: TrackerContact, id: string): number {
  const index = contact.sequences.findIndex(sequence => sequence.id === id);
  if (index < 0) throw new TrackerError("not_found", "Sequence not found.");
  return index;
}

function replaceSequence(contact: TrackerContact, index: number, sequence: TrackerSequence): TrackerContact {
  return { ...contact, sequences: contact.sequences.map((existing, i) => i === index ? sequence : existing) };
}

function assertOrder(messages: TrackerMessage[]): void {
  if (messages.some((entry, index) => index > 0 && Date.parse(entry.sentAt) <= Date.parse(messages[index - 1].sentAt))) {
    throw new TrackerError("conflict", "Sent timestamps must follow message order.");
  }
}

// Starting outreach closes any open attempt in the same returned contact.
export function startSequence(contact: TrackerContact, input: MessageInput, now = new Date()): TrackerContact {
  const initial = message(input, "initial", now);
  const sequences = contact.sequences.map(sequence => sequence.closedAt === null
    ? { ...sequence, closedAt: now.toISOString(), closeReason: "restarted" as const } : sequence);
  return { ...contact, sequences: [...sequences, { id: crypto.randomUUID(), closedAt: null,
    closeReason: null, respondedAt: null, messages: [initial] }] };
}

// Due dates guide the user; early follow-ups remain valid bookkeeping.
export function recordFollowUp(contact: TrackerContact, id: string, input: MessageInput, now = new Date()): TrackerContact {
  const index = sequenceIndex(contact, id);
  const sequence = contact.sequences[index];
  if (sequence.closedAt !== null || sequence.messages.length >= 3) throw new TrackerError("conflict", "Sequence is closed.");
  const next = message(input, sequence.messages.length === 1 ? "follow_up_1" : "follow_up_2", now);
  const messages = [...sequence.messages, next];
  assertOrder(messages);
  return replaceSequence(contact, index, { ...sequence, messages,
    ...(messages.length === 3 ? { closedAt: next.sentAt, closeReason: "completed" as const } : {}) });
}

// Close an open attempt explicitly; closure cannot precede its last sent message.
export function closeSequence(contact: TrackerContact, id: string, action: "record_response" | "close", at: string, now = new Date()): TrackerContact {
  const index = sequenceIndex(contact, id);
  const sequence = contact.sequences[index];
  if (action !== "record_response" && action !== "close") throw new TrackerError("invalid_input", "Unknown closure action.");
  if (sequence.closedAt !== null) throw new TrackerError("conflict", "Sequence is already closed.");
  const closedAt = timestamp(at, now);
  if (Date.parse(closedAt) < Date.parse(sequence.messages.at(-1)!.sentAt)) throw new TrackerError("conflict", "Closure cannot precede the last message.");
  return replaceSequence(contact, index, { ...sequence, closedAt,
    closeReason: action === "close" ? "manual" : "responded", respondedAt: action === "record_response" ? closedAt : null });
}

function findMessage(contact: TrackerContact, id: string): [number, number] {
  for (let i = 0; i < contact.sequences.length; i++) {
    const index = contact.sequences[i].messages.findIndex(entry => entry.id === id);
    if (index >= 0) return [i, index];
  }
  throw new TrackerError("not_found", "Message not found.");
}

// Corrections preserve message kind and all explicit closure decisions.
export function editMessage(contact: TrackerContact, id: string, patch: Partial<MessageInput>, now = new Date()): TrackerContact {
  const [index, messageIndex] = findMessage(contact, id);
  const sequence = contact.sequences[index];
  const existing = sequence.messages[messageIndex];
  const updated = { ...existing,
    ...(patch.text !== undefined ? { text: requiredText(patch.text, "Message text") } : {}),
    ...(patch.sentAt !== undefined ? { sentAt: timestamp(patch.sentAt, now) } : {}),
    ...(patch.notes !== undefined ? { notes: optionalText(patch.notes, "Notes") } : {}) };
  const messages = sequence.messages.map((entry, i) => i === messageIndex ? updated : entry);
  assertOrder(messages);
  return replaceSequence(contact, index, { ...sequence, messages,
    ...(sequence.closeReason === "completed" ? { closedAt: messages.at(-1)!.sentAt } : {}) });
}

// Only deleting the latest completed attempt can reopen outreach.
export function deleteMessage(contact: TrackerContact, id: string): TrackerContact {
  const [index, messageIndex] = findMessage(contact, id);
  const sequence = contact.sequences[index];
  if (messageIndex !== sequence.messages.length - 1) throw new TrackerError("conflict", "Delete later messages first.");
  if (messageIndex === 0) return { ...contact, sequences: contact.sequences.filter((_, i) => i !== index) };
  const reopen = sequence.closeReason === "completed" && index === contact.sequences.length - 1;
  return replaceSequence(contact, index, { ...sequence, messages: sequence.messages.slice(0, -1),
    ...(reopen ? { closedAt: null, closeReason: null } : {}) });
}

// Compute from the newest attempt and a supplied clock; never persist these values.
export function deriveContactProgress(contact: TrackerContact, now = new Date()): ContactProgress {
  const sequence = contact.sequences.at(-1);
  if (!sequence) return { status: "uncontacted", nextFollowUpAt: null, isOverdue: false };
  if (sequence.closedAt !== null) return { status: sequence.closeReason!, nextFollowUpAt: null, isOverdue: false };
  const due = Date.parse(sequence.messages.at(-1)!.sentAt) + 72 * 60 * 60 * 1000;
  return { status: sequence.messages.length === 1 ? "awaiting_follow_up_1" : "awaiting_follow_up_2",
    nextFollowUpAt: new Date(due).toISOString(), isOverdue: due < now.getTime() };
}
