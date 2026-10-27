import { createCompany } from "@/lib/tracker";
import { trackerWrite } from "@/lib/tracker-api";

export async function POST(request: Request) {
  return trackerWrite(request, ["name", "notes"], ["name"], (data, input) => {
    const company = createCompany({ name: input.name, notes: input.notes });
    data.companies.push(company);
    return company.id;
  }, 201);
}
