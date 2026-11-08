/**
 * @fileoverview CLI entry point for researching a fixture company against the local profile.
 * Prints the engine's result and diagnostics without saving them or calling the funding API.
 *
 * Loads company inputs from fixtures/companies.json and preferences from data/profile.json.
 * Delegates research and assessment validation to lib/company-research.ts.
 * See docs/company-research-engine.md for setup and usage.
 */

import { readFile } from "node:fs/promises";
import { researchCompany, type ResearchCompany } from "../lib/company-research.ts";

// Run the reusable engine with fixture company data and the local profile, never the funding API.
async function main() {
  // 1. Resolve the requested fixture company and load the private profile.
  // 2. Run bounded research and print evidence, diagnostics, and the validated result.
  // 3. Report failed research with a nonzero exit code while retaining its trace.
  const slug = process.argv[2];
  if (!slug) throw new Error("Usage: node --env-file=.env.local scripts/research-company.ts <company-slug>");

  const data: { companies: ResearchCompany[] } = JSON.parse(await readFile("fixtures/companies.json", "utf8"));
  const company = data.companies.find(company => company.slug === slug);
  if (!company) throw new Error(`Company not found: ${slug}`);

  const profile = JSON.parse(await readFile("data/profile.json", "utf8"));
  const result = await researchCompany(company, profile);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
