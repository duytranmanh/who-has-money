/**
 * @fileoverview Exposes saved research and explicit research requests for a Discovery company round.
 * Delegates lifecycle and persistence coordination to lib/company-research-api.ts.
 */

import { companyResearchRead, companyResearchStart, type ResearchContext } from "@/lib/company-research-api";

export async function GET(request: Request, context: ResearchContext) {
  const { slug } = await context.params;
  return companyResearchRead(request, slug);
}

export async function POST(request: Request, context: ResearchContext) {
  const { slug } = await context.params;
  return companyResearchStart(request, slug);
}
