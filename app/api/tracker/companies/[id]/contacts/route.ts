import { createContact } from "@/lib/tracker";
import { findCompany, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function POST(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["name", "email", "links"], ["name"], (data, input) => {
    findCompany(data, id);
    data.insertContact(id, createContact({ name: input.name, email: input.email, links: input.links }));
    return id;
  }, 201);
}
