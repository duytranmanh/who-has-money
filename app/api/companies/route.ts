const RECENT_FUNDING_URL =
  "https://recentfunding.com/api/v1/companies?limit=50";

// Checks the minimum company identity fields; other upstream fields remain unvalidated.
function isCompanyList(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const companies = (value as Record<string, unknown>).companies;
  return (
    Array.isArray(companies) &&
    companies.every(
      (company: unknown) =>
        typeof company === "object" &&
        company !== null &&
        "slug" in company &&
        typeof company.slug === "string" &&
        "name" in company &&
        typeof company.name === "string",
    )
  );
}

// Serves up to 50 companies without exposing the upstream API key.
// Success preserves upstream metadata; failures return an error message and HTTP status.
export async function GET() {
  // 1. Check server configuration.
  // 2. Request companies and translate upstream failures.
  // 3. Validate the payload and return it to the caller.
  const apiKey = process.env.RECENT_FUNDING_API_KEY;
  const headers = { "Cache-Control": "no-store" };

  if (!apiKey) {
    return Response.json(
      { error: "RecentFunding API key is not configured." },
      { status: 500, headers },
    );
  }

  // Each call uses upstream quota; no local rate limiting or automatic retries yet.
  try {
    const response = await fetch(RECENT_FUNDING_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "who-has-money/0.1",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    // HTTP errors do not cause fetch to throw.
    if (!response.ok) {
      if (response.status === 429) {
        // Let callers respect the provider's retry window without retrying here.
        const retryAfter = response.headers.get("Retry-After");
        return Response.json(
          { error: "RecentFunding request limit reached. Try again later." },
          {
            status: 429,
            headers: {
              ...headers,
              ...(retryAfter ? { "Retry-After": retryAfter } : {}),
            },
          },
        );
      }
      return Response.json(
        { error: "Could not load companies from RecentFunding." },
        { status: 502, headers },
      );
    }

    // Parsed JSON is untrusted until its minimum structure has been checked.
    const data: unknown = await response.json();
    if (!isCompanyList(data)) {
      return Response.json(
        { error: "RecentFunding returned an unexpected response." },
        { status: 502, headers },
      );
    }

    // Preserve pagination and access metadata alongside the company list.
    return Response.json(data, { headers });
  } catch (error) {
    // Log only the failure category so credentials and upstream payloads stay private.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("RecentFunding request failed", {
      kind: timedOut ? "timeout" : "network-or-response-error",
    });
    return Response.json(
      {
        error: timedOut
          ? "RecentFunding took too long to respond. Try again."
          : "Could not load companies. Try again.",
      },
      { status: timedOut ? 504 : 502, headers },
    );
  }
}
