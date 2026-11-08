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

The CLI prints one JSON run containing `status`, a validated `assessment` on success or `error` on failure, retrieved `sources`, page-tool diagnostics, model-call timing and token usage, timestamps, model, and prompt version. Failed runs exit nonzero. Input/configuration errors also exit nonzero. Results are returned and printed, not saved to disk yet.

## Implementation

- `lib/company-research.ts`: profile validation, bounded tool loop, structured assessment, evidence-reference checks, and run diagnostics. `researchCompany(company, profile)` accepts company data independently of the CLI. Tests inject the model and page reader.
- `lib/research-page.ts`: public-page reading, redirect/DNS checks, bounded HTML extraction, and discovered links.
- `scripts/research-company.ts`: fixture/profile loading and command-line output.

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

Static HTML extraction cannot see JavaScript-rendered content. There is no general web search, browser automation, background queue, persistence, Discovery button, or automatic outreach in this slice.

## Verification

```sh
npx vitest run lib/company-research.test.ts lib/research-page.test.ts
```

Tests use fixture companies, synthetic page responses, and mocked model/HTTP calls. They do not contact Groq, company websites, or the funding API. Existing provisional research in `fixtures/company-fit-benchmark-research.json` remains a manual review aid, not ground-truth labels.

## Experiment background

The original baseline used fixture data and a profile in one model call. It returned `possible_fit` but invented ownership and technology details. Adding page reading and a bounded tool loop made the output useful enough to pursue a feature. The reusable engine adds explicit evidence validation, linked-page discovery, budgets, and diagnostics before persistence and UI work.
