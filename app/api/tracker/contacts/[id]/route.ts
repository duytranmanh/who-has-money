import { updateContact } from "@/lib/tracker";
import { findContact, replaceContact, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function PATCH(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["name", "email", "links"], [], (data, input) => {
    const { company, contact } = findContact(data, "contact", id);
    return replaceContact(company, updateContact(contact, input));
  }, 200);
}
