## Project scope and decision rules

This is personal software for one user, running locally.
Shared hosting, multiple users, and production deployment are outside scope
unless explicitly requested.

- Solve the current requirement with the smallest complete change.
- Prefer straightforward code, existing dependencies, and built-in features.
- Optimize for easy local use, debugging, and maintenance by one person.
- Assume one trusted user. Do not add accounts, roles, multi-tenancy,
  or collaboration features unless requested.
- Prefer local files or an embedded database when persistence is needed.
  Follow existing storage choices unless the task requires a change.
- Do not add cloud services, distributed systems, deployment infrastructure,
  or scaling mechanisms unless requested.
- Add abstractions and dependencies only when they reduce current complexity.
  Small duplication is acceptable.
- Handle realistic failures clearly. Protect saved data and secrets.
- Keep checks proportional to the change, with particular care for persistence
  and data transformations.
- Keep unrelated refactors and hypothetical future requirements out of scope.

When several approaches work, choose the one with fewer moving parts
and less ongoing maintenance.

## Development data

Use `fixtures/companies.json` as the reference data shape and sample dataset when developing and testing. Do not call the live RecentFunding API unless explicitly requested. Do not change the application's runtime data source unless explicitly requested.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
