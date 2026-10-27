import { updateCompany } from "@/lib/tracker";
import { findCompany, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function PATCH(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["name", "notes"], [], (data, input) => {
    const company = updateCompany(findCompany(data, id), { name: input.name, notes: input.notes });
    data.companies = data.companies.map(existing => existing.id === id ? company : existing);
    return id;
  });
}
