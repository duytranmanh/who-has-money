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

## Delete saved research

Stop the app, then run from the project root:

```sh
node scripts/delete-research.ts
```

This permanently deletes every research attempt, including running, completed, and failed runs, from `data/tracker.sqlite`. It prints the deleted count. Applications, contacts, messages, funding snapshots, and `data/profile.json` remain intact. An absent database produces an error without creating a database file.

## Implementation

- `lib/company-research.ts`: profile validation, one page-selection call, one fresh structured assessment, bounded retries, evidence-reference checks, and run diagnostics. `researchCompany(company, profile)` accepts company data independently of the CLI. Tests inject the model and page reader.
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

The engine reads the homepage first. One structured selection call chooses up to two additional pages from eight discovered candidates, including linked external job boards. Careers, product, about, and team links take priority. The model returns link IDs rather than tool calls or executable URLs; unknown IDs are ignored and duplicates are removed. An empty selection is valid. Invalid selection JSON falls back to homepage evidence. Selection is skipped when no usable links are available. Links found on the selected pages do not trigger further browsing.

Research uses Groq `openai/gpt-oss-20b`. One final call requests strict JSON-schema output without tools. Its two-message request contains compact company fields, the profile, evidence gaps, and retrieved excerpts. It contains no selection output, earlier draft assessment, tool history, or page link lists. Reasons, mismatches, hiring, and role suitability each carry direct `source_ids`. Local validation checks the shape, company identity, and source references. An `apply` recommendation requires a verified opening and a possible role match.

Prompt version 4 identifies the simplified assessment shape. Results from other prompt versions are excluded from assessment display and require an explicit rerun. Saved company/profile snapshots remain exact; model input excludes unrelated company feed metadata. Description text is limited to 1,500 characters and investors to eight entries. The combined company/profile input must fit 6,000 characters. Oversized input fails before network use with instructions to shorten the profile; profile requirements are never silently truncated.

The assessment receives an explicit `available_source_ids` list, with concrete references such as `page_1`, `company.description`, and `company.amount_usd` when available. These IDs also constrain the response schema. A reason looks like `{"reason":"Potential product engineering fit","source_ids":["page_1"]}`. There is no `supporting_facts` collection, generated fact ID, or model-generated quote. The UI links each reason directly to fetched page excerpts or the cited saved funding field. Reference checks establish that sources exist, not that an interpretation follows from their content.

There is no compatibility conversion for older assessment formats. Their history summaries and input snapshots remain available, but result payloads are returned as `null` and cannot become `latestSuccessful`. Rerun research to generate a current assessment.

## Server diagnostics

Research uses the dependency-free `lib/logger.ts` logger. Each event is one JSON line on stderr, visible in the terminal running Next.js. All three levels (`info`, `warn`, `error`) use stderr to preserve the CLI's result-only stdout. Logs are not saved to a separate file automatically.

API claims, engine runs, page attempts, model calls, and saves share the persisted `runId`. Standalone CLI runs generate a correlation ID without creating a database record. Normal GET polling is not logged; request failures include their stage and a run ID or read request ID.

Events include timings, token usage, request character counts, page/source counts, provider status/code, request ID, retry delay, and attempted tool name when available. Rate-limit errors also expose numeric token limits and usage when present in provider diagnostics. Retry events distinguish rate-limit waits from oversized-request reductions. Each provider attempt gets its own trace; its timing excludes retry waits.

Unknown source references log `missing_source`, the source ID, and `availableSourceIds`. Quote matching and the intermediate fact-reference graph are removed. Provider messages, generated arguments, prompts, direct profile data, page text, URLs, credentials, and full assessments/errors are not dumped. Browser error-message translation remains separate from diagnostics.

## Limits and failures

- At most two logical model calls: page selection and final assessment. Each allows one explicit retry, so a run makes at most four provider attempts. Automatic SDK retries remain disabled.
- Rate-limit retries honor `Retry-After` when present, defaulting to five seconds otherwise. Waits must fit within 30 seconds and the remaining run deadline. Cancellation interrupts the wait. Retries reuse fetched pages and retry only the failed stage.
- HTTP 413, or a provider-reported token request exceeding the full allowance, halves page evidence for one retry instead of waiting. If no evidence can be reduced, the attempt fails. A second failure is retained without restarting research.
- Provider HTTP 400 with `json_validate_failed` retries the failed stage once with static, stage-specific JSON correction guidance and the same fetched evidence. Failed generations are not fed back into the prompt. This shares the existing one-retry-per-stage budget with rate limits and oversized requests; unrelated 400 errors are not retried.
- At most three page attempts: homepage and two selected pages. Invalid or duplicate reads cannot exceed that budget.
- At most 256 completion tokens with low reasoning effort for selection, and 3,072 with medium effort for assessment; one 90-second deadline for the run. These effort levels are supported by GPT-OSS on [Groq](https://console.groq.com/docs/reasoning).
- At most 1,600 text characters per retained page and 4,800 across all evidence. Selection sees at most 1,000 homepage text characters. Assessment excludes page link lists.
- Each serialized model request, including its schema, is limited to 14,000 characters. Page excerpts are reduced locally when necessary. Character budgets are conservative size controls, not exact token counts or a guarantee against the shared organization TPM limit. Actual token usage remains logged for tuning; no model-tokenizer dependency is added.
- Each page has a 15-second deadline covering DNS, redirects, and body reading; at most three redirects.
- Each HTTP response is capped at 512,000 bytes. Only uncompressed HTML is accepted.
- The page reader extracts up to 12,000 text characters and 40 deduplicated links; the engine applies the smaller evidence and candidate budgets before model use.
- Only HTTP/HTTPS on default ports is accepted, without URL credentials. Private/local addresses are blocked, including resolved DNS addresses and redirect destinations. Each connection is pinned to its checked DNS result.
- Missing websites and page failures become evidence gaps. Provider failures, deadline/cancellation, truncated completions, malformed assessments, and invalid citations return failed runs with available evidence and diagnostics.

Static HTML extraction cannot see JavaScript-rendered content. There is no general web search, browser automation, background queue, or automatic outreach in this slice.

## Verification

```sh
npx vitest run lib/company-research.test.ts lib/research-page.test.ts lib/company-research-storage.test.ts 'app/api/companies/[slug]/research/route.test.ts'
```

Tests use fixture companies, synthetic page responses, and mocked model/HTTP calls. They do not contact Groq, company websites, or the funding API. Existing provisional research in `fixtures/company-fit-benchmark-research.json` remains a manual review aid, not ground-truth labels.

## Experiment background

The original baseline used fixture data and a profile in one model call. It returned `possible_fit` but invented ownership and technology details. Adding page reading and a bounded tool loop made the output useful enough to pursue a feature. The reusable engine adds explicit evidence validation, linked-page discovery, budgets, and diagnostics. The saved research API adds local history before Discovery UI work.
