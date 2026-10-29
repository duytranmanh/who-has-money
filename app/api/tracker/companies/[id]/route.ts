import { updateCompany } from "@/lib/tracker";
import { findCompany, trackerCompanyDelete, trackerCompanyRead, trackerWrite } from "@/lib/tracker-api";
import type { IdContext } from "@/lib/tracker-api";

export async function GET(_request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerCompanyRead(id);
}

export async function DELETE(_request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerCompanyDelete(id);
}

export async function PATCH(request: Request, context: IdContext) {
  const { id } = await context.params;
  return trackerWrite(request, ["name", "notes"], [], (data, input) => {
    const company = updateCompany(findCompany(data, id), { name: input.name, notes: input.notes });
    data.updateCompany(company);
    return id;
  });
}
