import { closeSequence, editClosure } from "@/lib/tracker";
import { findContact, replaceContact, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function PATCH(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["action", "at"], ["action", "at"], (data, input, now) => {
    const { company, contact } = findContact(data, "sequence", id);
    if (input.action === "edit_closure") return replaceContact(company, editClosure(contact, id, input.at, now));
    return replaceContact(company, closeSequence(contact, id, input.action as "record_response" | "close", input.at, now));
  }, 200);
}
