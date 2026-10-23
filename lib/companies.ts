const US_COUNTRIES = new Set(["us", "usa", "united states", "united states of america"]);
const UNKNOWN_COUNTRIES = new Set(["", "unknown", "n/a", "unspecified"]);

// Keeps US and unspecified headquarters; malformed country values remain unknown.
export function keepCompany(country: unknown): boolean {
  if (typeof country !== "string") return true;
  const normalized = country.trim().toLowerCase().replaceAll(".", "");
  return US_COUNTRIES.has(normalized) || UNKNOWN_COUNTRIES.has(normalized);
}
