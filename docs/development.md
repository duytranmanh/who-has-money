# Local development

For Docker setup, see the [README](../README.md#quick-start). This guide runs
Next.js directly on your computer with live reload.

## Requirements

- [Node.js 24](https://nodejs.org/en/download), matching the Docker image, and npm.
  The app uses Node's built-in `node:sqlite`; use Node 24 for this workflow.
- A project checkout and a terminal in its root directory.
- API keys only for features that contact external providers. See the
  [configuration table](../README.md#api-keys-and-first-use).

Docker and Make are not required for this workflow.

## Start the development server

1. Run `node --version` and `npm --version` to confirm installation.
2. Run `npm ci` to install the locked dependencies.
3. Run `cp .env.example .env.local` if `.env.local` does not already exist.
   Replace placeholder keys with real values or leave unused values empty.
4. Run `npm run dev`.
5. Open **[http://localhost:3001](http://localhost:3001)**.

The development port is set to **3001** in `package.json`. Docker Compose uses
**3000**. Stop the development server with Ctrl+C. After editing `.env.local`,
restart the development server to ensure the new values are loaded.

Both workflows use the checkout's `data/` directory. Stop the Docker app before
running the development server against the same saved data.

## Checks

```sh
npm run lint
npm run test:run
npm run build
```

`npm test` starts Vitest in watch mode. `npm run start` serves a completed build
on port 3000 by default; it is separate from `npm run dev`.

## Development data

Use `fixtures/companies.json` as the reference company shape and sample dataset.
The running app reads saved funding snapshots; there is no automatic fixture
mode. Do not click **Refresh data** or call the live RecentFunding API during
development unless explicitly requested. Keep the runtime data source unchanged.

The [research guide](company-research-engine.md#manual-run) describes a CLI that
uses fixture companies. That CLI still contacts Groq and public company websites;
it is not an offline test.
