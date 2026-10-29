import { deleteMessage, editMessage } from "@/lib/tracker";
import { findContact, replaceContact, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function PATCH(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["text", "sentAt", "notes"], [], (data, input, now) => {
    const { company, contact } = findContact(data, "message", id);
    return replaceContact(data, company, contact, editMessage(contact, id, { text: input.text, sentAt: input.sentAt, notes: input.notes }, now));
  }, 200);
}

export async function DELETE(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, [], [], data => {
    const { company, contact } = findContact(data, "message", id);
    return replaceContact(data, company, contact, deleteMessage(contact, id));
  });
}
