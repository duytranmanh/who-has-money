import { describe, expect, it } from "vitest";
import fixture from "../fixtures/companies.json";
import { keepCompany } from "./companies";

describe("headquarters country filter", () => {
  it.each(["United States", "US", "USA", "U.S.", "U.S.A.", "United States of America", "  united STATES  "])("keeps %s", (country) => {
    expect(keepCompany(country)).toBe(true);
  });

  it.each([null, undefined, "", "  ", "unknown", " Unknown ", "N/A", "unspecified", 42, {}])("keeps unknown country %j", (country) => {
    expect(keepCompany(country)).toBe(true);
  });

  it.each(["Canada", "China", " united kingdom ", "Australia"])("excludes %s", (country) => {
    expect(keepCompany(country)).toBe(false);
  });

  it("keeps US and missing headquarters from the saved response without mutating it", () => {
    const original = structuredClone(fixture);
    const companies = fixture.companies.filter((company) => keepCompany(company.hq_country));
    expect(companies).toEqual(fixture.companies.filter((company) =>
      company.hq_country === "United States" || company.hq_country === null));
    expect(companies.length).toBeGreaterThan(0);
    expect(companies.length).toBeLessThan(fixture.companies.length);
    expect(fixture).toEqual(original);
  });
});
