import { recordFollowUp } from "@/lib/tracker";
import { findContact, replaceContact, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function POST(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["text", "sentAt", "notes"], ["sentAt"], (data, input, now) => {
    const { company, contact } = findContact(data, "sequence", id);
    return replaceContact(company, recordFollowUp(contact, id, { text: input.text, sentAt: input.sentAt, notes: input.notes }, now));
  }, 201);
}
