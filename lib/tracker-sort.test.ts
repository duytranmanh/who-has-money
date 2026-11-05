import { expect, it } from "vitest";
import fixture from "../fixtures/companies.json";
import { sortTrackerCompanies, type CompanySort } from "./tracker-sort";

const companies = [
  { name: fixture.companies[0].name, createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-03T12:00:00.000Z" },
  { name: fixture.companies[1].name, createdAt: "2026-11-02T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z" },
  { name: fixture.companies[2].name, createdAt: "2026-11-03T12:00:00.000Z", updatedAt: "2026-11-02T12:00:00.000Z" },
];

it.each<[CompanySort, number[]]>([
  ["created_oldest", [0, 1, 2]],
  ["created_newest", [2, 1, 0]],
  ["updated_oldest", [1, 2, 0]],
  ["updated_newest", [0, 2, 1]],
])("sorts %s without mutating the source list", (sort, order) => {
  const source = Object.freeze([...companies]);
  const sorted = sortTrackerCompanies(source, sort);
  expect(sorted).toEqual(order.map(index => companies[index]));
  expect(source).toEqual(companies);
  expect(sorted).not.toBe(source);
});

it.each<CompanySort>(["created_oldest", "created_newest", "updated_oldest", "updated_newest"])(
  "keeps ties stable and unknown dates last for %s", sort => {
    const unknown = { name: "Unknown", createdAt: null, updatedAt: null };
    const otherUnknown = { ...unknown, name: "Other unknown" };
    const tied = { ...companies[0], name: "Same time" };
    expect(sortTrackerCompanies([unknown, companies[0], otherUnknown, tied], sort))
      .toEqual([companies[0], tied, unknown, otherUnknown]);
  },
);

it("sorts a filtered subset and moves an edited company by its new update time", () => {
  const subset = companies.filter((_, index) => index !== 1);
  expect(sortTrackerCompanies(subset, "created_newest")).toEqual([companies[2], companies[0]]);
  const saved = { ...companies[2], updatedAt: "2026-11-04T12:00:00.000Z" };
  expect(sortTrackerCompanies([companies[0], saved], "updated_newest")).toEqual([saved, companies[0]]);
  expect(sortTrackerCompanies([companies[0], saved], "created_oldest")).toEqual([companies[0], saved]);
});

it("handles an empty list", () => {
  expect(sortTrackerCompanies([], "created_oldest")).toEqual([]);
});
