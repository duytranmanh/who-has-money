/**
 * @fileoverview Checks assessment rendering at the boundary between saved research and Discovery UI.
 * Uses static rendering to verify uncertainty, citations, and safe source links without live research.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompanyAssessment, ResearchResult } from "@/lib/company-research";
import { ResearchAssessment } from "./company-research-panel";

const assessment: CompanyAssessment = {
  company_slug: "growthware", fit_judgment: "insufficient_evidence", fit_summary: "More evidence is needed to assess fit.",
  reasons_connected_to_profile: [],
  mismatches: [], unknowns: ["Remote work policy"],
  hiring: { status: "no_openings_found", summary: "No job listings appeared on reviewed pages.", source_ids: ["s1"] },
  role_suitability: { status: "unknown", summary: "No role requirements found.", source_ids: [] },
  recommended_next_step: { action: "further_research", reason: "Check hiring requirements." },
};
const sources: ResearchResult["sources"] = [{ id: "s1", page: {
  url: "https://example.com/careers", title: "Company careers", checked_at: "2026-11-08T12:00:00Z",
  text: "Tools for growing teams.", truncated: false, links: [],
} }];

function render(value = assessment, pages = sources) {
  return renderToStaticMarkup(createElement(ResearchAssessment, { assessment: value, sources: pages }));
}

describe("research assessment", () => {
  it("preserves uncertainty and distinguishes missing listings from a hiring claim", () => {
    const html = render();
    expect(html).toContain("Insufficient evidence");
    expect(html).toContain("No openings found");
    expect(html).toContain("Remote work policy");
    expect(html).not.toContain("Not hiring");
    expect(html).not.toContain("Confidence:");
    expect(html).not.toContain("% Match");
  });

  it("connects direct citations to fetched source excerpts and safe source destinations", () => {
    const html = render();
    const target = html.match(/href="#([^"]+-s1)"/)?.[1];
    expect(target).toBeTruthy();
    expect(html).toContain(`id="${target}" tabindex="-1"`);
    expect(html).toContain("Tools for growing teams.");
    expect(html).toContain('href="https://example.com/careers"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not turn stored non-web URLs into executable links", () => {
    const html = render(assessment, [{ ...sources[0], page: { ...sources[0].page, url: "javascript:alert(1)" } }]);
    expect(html).not.toContain('href="javascript:');
  });

  it("links input-field citations to saved funding values without showing unrelated metadata", () => {
    const value = { ...assessment, reasons_connected_to_profile: [{ reason: "Early funding stage", source_ids: ["company.stage"] }] };
    const html = renderToStaticMarkup(createElement(ResearchAssessment, { assessment: value, sources,
      companyInput: { slug: "growthware", name: "Growthware", stage: "seed", unrelated_metadata: "hidden-metadata" } }));
    const target = html.match(/href="#([^"]+-company\.stage)"/)?.[1];
    expect(target).toBeTruthy();
    expect(html).toContain(`id="${target}" tabindex="-1"`);
    expect(html).toContain("seed");
    expect(html).not.toContain("hidden-metadata");
  });

  it("renders negative recommendations and empty evidence without inventing matches", () => {
    const html = render({ ...assessment, fit_judgment: "reject",
      mismatches: [{ reason: "Requires on-site work", source_ids: [] }],
      recommended_next_step: { action: "skip", reason: "Conflicts with location preference." } }, []);
    expect(html).toContain("Reject");
    expect(html).toContain("Requires on-site work");
    expect(html).toContain("Skip");
    expect(html).toContain("No webpage excerpts available.");
    expect(html).toContain("No supported profile matches identified.");
  });
});
