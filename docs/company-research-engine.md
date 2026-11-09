# Company research engine

The reusable engine assesses whether a company is worth investigating for software engineering work. It keeps company fit, verified hiring evidence, and suitability for a specific role separate. The CLI still uses `fixtures/companies.json`; it never calls the RecentFunding API or changes Discovery's runtime data source.

## Manual run

Set `GROQ_API_KEY` in `.env.local`. Create `data/profile.json` with these four fields:

```json
{
  "target": ["Software engineering roles at early-stage startups"],
  "experience": ["Describe your skills, projects, and work experience"],
  "hard_nos": ["List confirmed dealbreakers"],
  "preferences": ["List positive signals that are not requirements"]
}
```

Each field must be an array of nonempty strings; empty arrays are allowed. Other profile fields are excluded from model requests. The profile is sent to Groq, but never to company websites. `data/` and `.env.local` remain ignored by Git.

Run with Node.js 22.18+ or 24+ for native TypeScript support:

```sh
node --env-file=.env.local scripts/research-company.ts growthware
```

The CLI prints one JSON run containing `status`, a validated `assessment` on success or `error` on failure, retrieved `sources`, page-tool diagnostics, model-call timing and token usage, timestamps, model, and prompt version. Failed runs exit nonzero. Input/configuration errors also exit nonzero. CLI results are printed without persistence; the HTTP API saves runs in SQLite.

## Implementation

- `lib/company-research.ts`: profile validation, bounded tool loop, structured assessment, evidence-reference checks, and run diagnostics. `researchCompany(company, profile)` accepts company data independently of the CLI. Tests inject the model and page reader.
- `lib/research-page.ts`: public-page reading, redirect/DNS checks, bounded HTML extraction, and discovered links.
- `scripts/research-company.ts`: fixture/profile loading and command-line output.
- `lib/company-research-api.ts`: trusted input loading, exclusive run claims, engine execution, and HTTP responses.
- `lib/company-research-storage.ts`: round-scoped attempt history, exact input snapshots, and terminal results.

## Saved research API

The API reads company inputs from the current complete saved funding snapshot, using the same data as Discovery. It never refreshes the feed or accepts company data, model names, or profile content from clients. Preferences come from `data/profile.json`.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| POST | `/api/companies/:slug/research` | Accept exactly `{"announcedDate":"YYYY-MM-DD"}`. Claim the round, run research synchronously, and save the terminal result before responding. |
| GET | `/api/companies/:slug/research?announcedDate=YYYY-MM-DD` | Return `latestAttempt`, `latestSuccessful`, history summaries, and current input availability. |
| GET | `/api/companies/:slug/research?announcedDate=YYYY-MM-DD&runId=ID` | Return one run's saved input and full engine result, only if it belongs to that company and round. |

All responses use `Cache-Control: no-store`. POST returns `201` for a saved successful assessment, `502` for a saved failed attempt, `409` for an active/expired claim conflict, `400` for invalid requests, `404` when the round is absent from current Discovery, or `503` for unavailable profile/model configuration. Storage errors return a generic `500` and never claim an unsaved result succeeded. An active-run conflict includes `runId`.

GET requires neither a model key nor a valid current profile. Saved history remains readable after its company leaves the current funding snapshot. A successful rerun appends history; a failed rerun never replaces the last successful assessment. GET expires abandoned claims locally but never runs the agent or contacts upstream services.

### Identity, schema, and freshness

Migration 4 in `lib/tracker-db.ts` adds `research_runs` to `data/tracker.sqlite`, sharing the existing lazy connection. Research is independent of Applications' `companies` records and does not change their timestamps. The migration preserves all existing tracker records.

Each attempt stores its UUID, `company_slug`, `announced_date`, exact company/profile JSON snapshots and SHA-256 hashes, model, prompt version, lifecycle status, start/finish/deadline timestamps, full engine result JSON, and failure summary. A partial unique index permits only one `running` attempt per slug/date pair. History summaries omit evidence and profile snapshots; full browser responses also omit the stored profile snapshot.

Round identity uses the UTC calendar date of `announced_at`, not snapshot or research time. It is provisional: same-company rounds on the same day collide, and an upstream announcement-date correction appears as a different round. Funding stages and amounts do not participate in matching.

Freshness compares the saved hashes against the complete current company input and parsed four-field profile. Object key order is ignored; array order and all input field changes count, including upstream metadata. Model and prompt-version changes also mark results stale. Responses include `staleReasons`; `stale` is `null` when an input is unavailable and no known difference establishes staleness. POST compares against its captured inputs; subsequent GET requests compare against current inputs.

### Claims and recovery

Orchestration commits expiration and claim insertion together, releases the database transaction, then awaits the engine. It commits the terminal result separately. No SQLite transaction spans network work. Explicit POST requests rerun even a fresh successful assessment.

The engine has a 90-second deadline. Persisted claims expire after 120 seconds, allowing time to validate and save a result. A later GET or POST for that round marks overdue claims failed. Results arriving after expiration cannot overwrite expired records or newer attempts. No background worker or automatic retry runs after a process crash, request interruption, or save failure; old successful results remain available, and another explicit POST can claim the round after expiration. Request cancellation is passed to the engine.

The engine reads the homepage first. The model can then request links actually returned by retrieved pages, including linked external job boards. Relevant careers, product, about, and team links take priority in the returned link list. URLs invented by the model and duplicate attempts are rejected.

Research uses Groq `openai/gpt-oss-20b`. A separate final call requests strict JSON-schema output without tools. Local validation checks the shape, company identity, unique fact IDs, known evidence references, and exact excerpts from retrieved text or company input fields. Fit reasons and mismatches require fact references. Positive/negative hiring and role judgments require evidence. An `apply` recommendation requires a verified opening and a possible role match.

Sources use IDs such as `page_1`. Input evidence uses `company.FIELD`, such as `company.description`. Each fact contains a claim, source ID, and verbatim quote. These checks establish evidence provenance; they cannot establish that a model's interpretation logically follows from a quote. Review remains necessary.

## Limits and failures

- At most four model calls, reserving one for the final assessment; no automatic SDK retries.
- At most five page attempts. Invalid or duplicate page requests consume the attempt budget. Excess requests return tool errors without network reads.
- At most 4,096 completion tokens per model call; one 90-second deadline for the run.
- Each page has a 15-second deadline covering DNS, redirects, and body reading; at most three redirects.
- Each HTTP response is capped at 512,000 bytes. Only uncompressed HTML is accepted.
- Extracted page text is capped at 12,000 characters; at most 40 deduplicated links are returned.
- Only HTTP/HTTPS on default ports is accepted, without URL credentials. Private/local addresses are blocked, including resolved DNS addresses and redirect destinations. Each connection is pinned to its checked DNS result.
- Missing websites and page failures become evidence gaps. Provider failures, deadline/cancellation, truncated completions, malformed assessments, and invalid citations return failed runs with available evidence and diagnostics.

Static HTML extraction cannot see JavaScript-rendered content. There is no general web search, browser automation, background queue, Discovery button, or automatic outreach in this slice.

## Verification

```sh
npx vitest run lib/company-research.test.ts lib/research-page.test.ts lib/company-research-storage.test.ts 'app/api/companies/[slug]/research/route.test.ts'
```

Tests use fixture companies, synthetic page responses, and mocked model/HTTP calls. They do not contact Groq, company websites, or the funding API. Existing provisional research in `fixtures/company-fit-benchmark-research.json` remains a manual review aid, not ground-truth labels.

## Experiment background

The original baseline used fixture data and a profile in one model call. It returned `possible_fit` but invented ownership and technology details. Adding page reading and a bounded tool loop made the output useful enough to pursue a feature. The reusable engine adds explicit evidence validation, linked-page discovery, budgets, and diagnostics. The saved research API adds local history before Discovery UI work.
