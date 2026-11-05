# Company research experiment

Goal: learn tool calling by assessing company fit against my SWE profile.

Script: `scripts/research-company.ts`. Inputs: `fixtures/companies.json` and `data/profile.json`. Model: Groq `openai/gpt-oss-20b`.

## What we tried

- **Baseline:** one model call using fixture data and profile. Returned `possible_fit`, but invented details about ownership and technology.
- **Page reading:** added fetch + Cheerio; tested Growthware’s homepage. Returns URL, timestamp, title, and text; 15-second timeout, 12,000-character text cap.
- **Tool loop:** model requests `read_page`; local code validates arguments, fetches the page, and sends results with matching `tool_call_id`. Repeats until an assessment or four model calls.

## What happened

- upon intial skimming, I think it works decently, we should persue and make this a feature of our application

## Current limits

No saved tool trace or JSON validation. Four model calls can include multiple page reads. Keep company fit separate from verified hiring and role suitability.

## Manual run

```sh
node --env-file=.env.local scripts/research-company.ts growthware
```

Uses fixtures for company inputs; does not call the live RecentFunding API.
