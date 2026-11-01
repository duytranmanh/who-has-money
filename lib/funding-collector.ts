import { createFundingStorage } from "./funding-storage";
import { DAILY_CALL_LIMIT, fundingCompanyInWindow, fundingStateForDay, fundingWindow,
  nextFundingDay, parseFundingPage, type FundingCompany, type FundingSnapshot } from "./funding";

type Store = ReturnType<typeof createFundingStorage>;
type Options = { store?: Store; fetch?: typeof fetch; now?: () => Date; apiKey?: string };
export type FundingCollectionResult = { status: "complete" | "partial" | "failed" | "already_collected" |
  "busy" | "cooldown" | "budget_exhausted"; snapshot?: FundingSnapshot };

function retryAfter(response: Response, now: Date): string {
  const header = response.headers.get("Retry-After");
  const reset = Number(response.headers.get("X-RateLimit-Reset"));
  const until = header ? (/^\d+$/.test(header) ? now.getTime() + Number(header) * 1000 : Date.parse(header)) : NaN;
  return new Date(Math.max(now.getTime() + 60_000,
    Number.isFinite(until) ? until : reset > 0 ? reset * 1000 : Date.parse(nextFundingDay(now)))).toISOString();
}

// Orchestration owns the refresh boundary; storage supplies locking and atomic files.
// Retries require a later invocation, never a sleeping loop or background timer.
export async function collectFunding(options: Options = {}): Promise<FundingCollectionResult> {
  // 1. Acquire the collection lock and check saved progress, cooldown, and budget.
  // 2. Fetch and filter pages, persisting each attempted call before sending it.
  // 3. Save coverage and collected companies, then release the lock on every exit.
  const store = options.store ?? createFundingStorage();
  const request = options.fetch ?? fetch;
  const clock = options.now ?? (() => new Date());
  const release = store.acquireLock();
  if (!release) return { status: "busy" };
  try {
    const started = clock();
    let state = fundingStateForDay(store.readState(), started);
    const existing = store.readCompleteSnapshot(state.budgetDate);
    if (existing) {
      store.saveSnapshot(existing);
      return { status: "already_collected", snapshot: existing };
    }
    if (state.nextAllowedAttemptAt && Date.parse(state.nextAllowedAttemptAt) > started.getTime()) return { status: "cooldown" };
    if (state.callsAttempted >= DAILY_CALL_LIMIT) return { status: "budget_exhausted" };
    const apiKey = options.apiKey ?? process.env.RECENT_FUNDING_API_KEY;
    if (!apiKey) throw new Error("RecentFunding API key is not configured.");

    const window = fundingWindow(started);
    const companies = new Map<string, FundingCompany>();
    let offset = 0;
    let complete = false;
    let failed = false;
    let pages = 0;
    while (state.callsAttempted < DAILY_CALL_LIMIT) {
      state = { ...state, callsAttempted: state.callsAttempted + 1 };
      store.saveState(state);
      let response: Response;
      try {
        response = await request(`https://recentfunding.com/api/v1/companies?sort=announced&limit=1000&offset=${offset}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "who-has-money/0.1" },
          cache: "no-store", signal: AbortSignal.timeout(10_000),
        });
      } catch {
        response = new Response(null, { status: 503 });
      }
      if (!response.ok) {
        const transient = response.status >= 500;
        const failures = (state.transientFailures ?? 0) + (transient ? 1 : 0);
        state = { ...state, transientFailures: failures, nextAllowedAttemptAt:
          response.status === 429 ? retryAfter(response, clock()) : transient && failures === 1
            ? new Date(clock().getTime() + 15 * 60_000).toISOString() : nextFundingDay(clock()) };
        store.saveState(state);
        failed = true;
        break;
      }
      let page;
      try { page = parseFundingPage(await response.json(), offset); }
      catch {
        store.saveState({ ...state, nextAllowedAttemptAt: nextFundingDay(clock()) });
        failed = true;
        break;
      }
      pages++;
      for (const company of page.companies) {
        if (fundingCompanyInWindow(company, window) && !companies.has(company.slug)) companies.set(company.slug, company);
      }
      // The upstream announced sort places unknown dates last. Any older known date
      // proves the lower boundary was reached, even when that company is non-US.
      complete = page.next_offset === null || page.companies.some(company =>
        typeof company.announced_at === "string" && Date.parse(company.announced_at) < Date.parse(window.windowStart));
      if (complete) break;
      offset = page.next_offset!;
    }
    if (!pages) return { status: failed ? "failed" : "partial" };
    const snapshot: FundingSnapshot = { fetchedAt: started.toISOString(), ...window,
      coverage: complete ? "complete" : "partial", companies: [...companies.values()] };
    store.saveSnapshot(snapshot);
    return { status: snapshot.coverage, snapshot };
  } finally { release(); }
}
