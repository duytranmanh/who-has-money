import { createCompany } from "@/lib/tracker";
import { trackerCompanyList, trackerWrite } from "@/lib/tracker-api";

export const GET = trackerCompanyList;

export async function POST(request: Request) {
  return trackerWrite(request, ["name", "notes"], ["name"], (data, input) => {
    const company = createCompany({ name: input.name, notes: input.notes });
    data.insertCompany(company);
    return company.id;
  }, 201);
}
