import type { TrackerCompany } from "./tracker";

export type CompanySort = "created_oldest" | "created_newest" | "updated_oldest" | "updated_newest";

// Preserve source order for ties, keep unknown dates last, and never reorder the caller's array.
export function sortTrackerCompanies<T extends Pick<TrackerCompany, "createdAt" | "updatedAt">>(companies: readonly T[], sort: CompanySort): T[] {
  const field = sort.startsWith("created_") ? "createdAt" : "updatedAt";
  const direction = sort.endsWith("oldest") ? 1 : -1;
  return [...companies].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (Date.parse(left) - Date.parse(right)) * direction;
  });
}
