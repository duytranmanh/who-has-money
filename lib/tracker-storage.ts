import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TrackerData } from "./tracker";

const queues = new Map<string, Promise<unknown>>();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function date(value: unknown): boolean {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

// Check the stored shape without replaying transitions or applying today's clock to history.
function validData(value: unknown): value is TrackerData {
  const strings = (record: Record<string, unknown>, fields: string[]) => fields.every(field => typeof record[field] === "string");
  return object(value) && Array.isArray(value.companies) && value.companies.every(company =>
    object(company) && strings(company, ["id", "name", "notes"]) && Array.isArray(company.contacts) && company.contacts.every(contact =>
      object(contact) && strings(contact, ["id", "name", "email"]) &&
      Array.isArray(contact.links) && contact.links.every(link => typeof link === "string") &&
      Array.isArray(contact.sequences) && contact.sequences.every(sequence =>
        object(sequence) && strings(sequence, ["id"]) &&
        (sequence.closedAt === null || date(sequence.closedAt)) &&
        [null, "responded", "completed", "manual", "restarted"].includes(sequence.closeReason as string | null) &&
        (sequence.respondedAt === null || date(sequence.respondedAt)) &&
        Array.isArray(sequence.messages) && sequence.messages.length > 0 && sequence.messages.length <= 3 &&
        sequence.messages.every((message, index) =>
          object(message) && strings(message, ["id", "text", "notes"]) && date(message.sentAt) &&
          message.kind === ["initial", "follow_up_1", "follow_up_2"][index])
      )
    )
  );
}

// Only an absent file means an empty tracker; all other read failures reach the caller.
async function load(filePath: string): Promise<TrackerData> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { companies: [] };
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch (cause) {
    throw new Error("Tracker file contains invalid JSON; saved data was not changed.", { cause });
  }
  if (!validData(data)) throw new Error("Tracker file has an invalid structure; saved data was not changed.");
  return data;
}

// Stores sharing a path share a queue within this process. Separate processes are unsupported.
export function createTrackerStorage(filePath = resolve("data/tracker.json")) {
  const path = resolve(filePath);

  // Reads see a complete committed file, either before or after an overlapping update.
  async function readTracker(): Promise<TrackerData> {
    return load(path);
  }

  // The callback returns replacement data. Success means the complete replacement was saved.
  function updateTracker(change: (data: TrackerData) => TrackerData | Promise<TrackerData>): Promise<TrackerData> {
    const operation = (queues.get(path) ?? Promise.resolve()).then(async () => {
      // 1. Load current data and apply the domain operation inside the queue.
      // 2. Validate and write a complete temporary file beside the destination.
      // 3. Atomically replace the saved file before returning success.
      const updated = await change(await load(path));
      if (!validData(updated)) throw new Error("Cannot save invalid tracker data.");
      const contents = `${JSON.stringify(updated, null, 2)}\n`;
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, path);
      } finally {
        // Cleanup must not mask a write or rename failure.
        await unlink(temporaryPath).catch(() => undefined);
      }
      return updated;
    });
    // A rejected operation must not prevent subsequent edits from running.
    const settled = operation.then(() => undefined, () => undefined);
    queues.set(path, settled);
    void settled.then(() => {
      if (queues.get(path) === settled) queues.delete(path);
    });
    return operation;
  }

  return { readTracker, updateTracker };
}

export const { readTracker, updateTracker } = createTrackerStorage();
