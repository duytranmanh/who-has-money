# WHO HAS MONEY?

A local workspace for finding funded startups and tracking job outreach.

Company funding data comes from [RecentFunding](https://recentfunding.com/).

## Prerequisites

- **Docker with Compose v2** — install [Docker Desktop](https://docs.docker.com/desktop/) and keep it running.
- **Make** — macOS: `xcode-select --install`; Ubuntu/Debian: `sudo apt-get install make`.

No local Node.js or npm installation needed. On Windows, use WSL with Docker Desktop integration.

## Setup

1. Clone the repository and enter its directory:

   ```sh
   git clone https://github.com/duytranmanh/who-has-money.git
   cd who-has-money
   ```

2. Create `.env.local`
   ```sh
   cp .env.example .env.local
   ```

   If the file already exists, edit it instead. Replace placeholder values with your keys, or leave unused values empty:

   ```dotenv
   RECENT_FUNDING_API_KEY=
   GROQ_API_KEY=
   ```

   - **Funding discovery:** get a key from [RecentFunding](https://recentfunding.com/docs/).
   - **AI research:** get a key from [GroqCloud](https://console.groq.com/keys) and follow the [profile setup](docs/company-research-engine.md#manual-run).
   - **Manual tracking:** no keys needed. Keep `.env.local` private.

3. Start the app:

   ```sh
   make up
   ```

4. Open **[http://localhost:3000](http://localhost:3000)**.

Discovery starts empty. Click **Refresh data** to fetch companies using your funding API key and quota.
Without a key, use **Applications → + New** to add companies manually.

## Commands

Run from the project directory:

| Command | Purpose |
| --- | --- |
| `make up` | Start or rebuild after code changes |
| `make restart` | Apply changes to `.env.local` |
| `make status` | Check container status |
| `make logs` | Follow logs; Ctrl+C exits |
| `make down` | Stop the app; keep saved data |

If startup fails, confirm Docker is running and port 3000 is free. Check `make logs` for details.

Data stays in `data/`. To back up, stop the app and copy that directory.

More: [Development](docs/development.md) · [Containers](docs/containers.md) · [AI research](docs/company-research-engine.md)
