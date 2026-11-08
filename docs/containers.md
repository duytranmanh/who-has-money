# Local container setup

Docker builds a standalone Next.js app and runs it as a non-root Node.js process.
Compose exposes it at http://localhost:3000, injects `.env.local` at startup,
and mounts host `./data` at `/app/data` to preserve SQLite records and funding
snapshots. Secrets and saved data are excluded from the image. Funding reads
run at request time so they see mounted snapshots.

Run these from the project directory with Docker running. Create `.env.local`
with `RECENT_FUNDING_API_KEY=your_key_here` for funding refresh.

| Command | Purpose |
| --- | --- |
| `make help` (or `make`) | Show commands |
| `make up` | Build and recreate after code changes, or start for the first time |
| `make restart` | Recreate with updated environment values, without rebuilding |
| `make down` | Stop and remove containers; preserve host data |
| `make logs` | Follow logs; Ctrl+C exits without stopping the app |
| `make status` | Show container status |

Before updates, run `make down` and back up the entire `data/` directory.
Then run `make up`. Reverting an image does not undo SQLite migrations;
rollback may also require restoring the matching data backup.
