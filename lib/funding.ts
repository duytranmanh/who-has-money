import { keepCompany } from "./companies";

export type FundingCompany = Record<string, unknown> & { slug: string; name: string };
export type FundingSnapshot = {
  fetchedAt: string;
  windowStart: string;
  windowEnd: string;
  coverage: "complete" | "partial";
  companies: FundingCompany[];
};
export type FundingState = {
  budgetDate: string;
  callsAttempted: number;
  nextAllowedAttemptAt: string | null;
  latestCompleteSnapshot: string | null;
  transientFailures?: number;
};

const DAY = 86_400_000;
export const DAILY_CALL_LIMIT = 8;

// Use whole UTC days: include the older boundary and exclude the 14-day cutoff.
export function fundingWindow(now: Date) {
  const midnight = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return { windowStart: new Date(midnight - 21 * DAY).toISOString(),
    windowEnd: new Date(midnight - 14 * DAY).toISOString() };
}

export function fundingStateForDay(state: FundingState | null, now: Date): FundingState {
  const budgetDate = now.toISOString().slice(0, 10);
  return state?.budgetDate === budgetDate ? state : { budgetDate, callsAttempted: 0,
    nextAllowedAttemptAt: state?.nextAllowedAttemptAt ?? null,
    latestCompleteSnapshot: state?.latestCompleteSnapshot ?? null, transientFailures: 0 };
}

export function nextFundingDay(now: Date): string {
  return new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + DAY).toISOString();
}

export function fundingCompanyInWindow(company: FundingCompany, window: ReturnType<typeof fundingWindow>): boolean {
  const date = typeof company.announced_at === "string" ? Date.parse(company.announced_at) : NaN;
  return keepCompany(company.hq_country) && date >= Date.parse(window.windowStart) && date < Date.parse(window.windowEnd);
}

// Reject non-advancing cursors so malformed pages cannot drain the quota in a loop.
export function parseFundingPage(value: unknown, offset: number): { companies: FundingCompany[]; next_offset: number | null } {
  const page = value as { companies?: FundingCompany[]; next_offset?: number | null } | null;
  if (!page || !Array.isArray(page.companies) || !page.companies.every(company =>
    company && typeof company.slug === "string" && typeof company.name === "string") ||
    !(page.next_offset === null || (Number.isSafeInteger(page.next_offset) &&
      page.next_offset! > offset && page.next_offset! <= 1_000_000))) {
    throw new Error("Invalid RecentFunding page.");
  }
  return { companies: page.companies, next_offset: page.next_offset! };
}
