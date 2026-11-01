import { collectFunding, type FundingCollectionResult } from "./funding-collector";
import { createFundingStorage } from "./funding-storage";

const headers = { "Cache-Control": "no-store" };
const messages: Record<FundingCollectionResult["status"], string> = {
  complete: "Funding data refreshed. Coverage complete.",
  partial: "Refresh incomplete. Keeping the previous complete snapshot.",
  failed: "Refresh failed. Keeping any previously saved data.",
  already_collected: "Today's funding data has already been collected.",
  busy: "A refresh is already running. Reload saved data shortly.",
  cooldown: "Refresh is paused. Try again after the saved cooldown.",
  budget_exhausted: "Today's refresh budget is exhausted. Try again tomorrow (UTC).",
};

function failure(message: string): Response {
  return Response.json({ error: message }, { status: 500, headers });
}

// Page loads only read local data; they never initiate collection or require an API key.
export function fundingRead(): Response {
  try {
    const snapshot = createFundingStorage().readLatestSnapshot();
    return Response.json({ companies: snapshot?.companies ?? [], snapshot: snapshot ? {
      fetchedAt: snapshot.fetchedAt, windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd, coverage: snapshot.coverage,
    } : null }, { headers });
  } catch {
    return failure("Could not read saved funding data.");
  }
}

// Only explicit POST requests spend quota. Collector outcomes remain distinct from storage failures.
export async function fundingRefresh(): Promise<Response> {
  try {
    const result = await collectFunding();
    const state = createFundingStorage().readState();
    return Response.json({ status: result.status, message: messages[result.status],
      attemptCoverage: result.snapshot?.coverage ?? null,
      nextAllowedAttemptAt: state?.nextAllowedAttemptAt ?? null,
    }, { status: result.status === "failed" ? 502 : 200, headers });
  } catch {
    return failure("Could not refresh funding data. Check API key configuration and local storage.");
  }
}
