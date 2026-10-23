import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/companies.json";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("filters the API response while preserving upstream pagination and metadata", async () => {
  vi.stubEnv("RECENT_FUNDING_API_KEY", "fixture-test-key");
  const upstream = { ...fixture, access: { notice: "Sample access notice" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(upstream)));

  const response = await GET();
  const data = await response.json();
  const eligible = fixture.companies.filter((company) =>
    company.hq_country === "United States" || company.hq_country === null);

  expect(response.status).toBe(200);
  expect(data.companies).toEqual(eligible);
  expect(data.count).toBe(eligible.length);
  expect(data.filtering).toEqual({
    fetched: fixture.companies.length,
    excluded: fixture.companies.length - eligible.length,
  });
  expect(data.next_offset).toBe(fixture.next_offset);
  expect(data.access).toEqual(upstream.access);
});
