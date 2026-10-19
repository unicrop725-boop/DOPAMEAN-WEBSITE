# DOPAMEAN commerce platform

Single-vendor commerce platform (storefront, admin, backend) built behind the existing DOPAMEAN storefront design.

> **Status: Phase 2 (walking skeleton) complete.** Auth, database, worker, outbox, CI gates, seed and an admin shell work. The storefront pages are **not ported yet** (home shows a placeholder); cart, checkout, payments and orders are not built. See [docs/PROGRESS.md](docs/PROGRESS.md) for the truth about what works.

## Quick start (about 10 minutes)

Prerequisites: Node 22+, npm 10+, Docker Desktop (running).

```bash
git clone <this repo> && cd cloth
cp .env.example .env
# Fill the two secrets (any shell with openssl; or use any 32+ char random strings):
#   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
#   PRICING_TOKEN_SECRET=$(openssl rand -base64 32)
# For local development also set S3_ACCESS_KEY=minioadmin and S3_SECRET_KEY=minioadmin.

npm ci
docker compose up -d postgres storage mailpit   # Postgres, S3 storage, Mailpit (mail UI on :8025)
npm run db:migrate                               # apply SQL migrations
npm run db:seed                                  # fictional products, variants and stock
OWNER_EMAIL=you@example.com OWNER_NAME="You" OWNER_PASSWORD='choose-a-long-password' npm run staff:create-owner

npm run dev        # web on http://localhost:3000
npm run worker     # in a second terminal: outbox relay, housekeeping, heartbeat
```

Sign in at <http://localhost:3000/admin/login>. Owner and Manager accounts must enrol an authenticator app (TOTP) on first sign-in.

Everything in containers instead: `docker compose --profile app up --build` (runs migrations, web and worker). Health: <http://localhost:3000/api/health>.

## Commands

| Command                             | What it does                                                               |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `npm run lint`                      | ESLint and dependency-cruiser module-boundary rules                        |
| `npm run typecheck`                 | `tsc --noEmit` (strict)                                                    |
| `npm test`                          | Unit tests                                                                 |
| `npm run test:integration`          | Integration tests against a real PostgreSQL (Testcontainers; needs Docker) |
| `npm run build && npm run test:e2e` | Playwright E2E (needs `docker compose up -d postgres mailpit`)             |
| `npm run audit`                     | Production dependency audit (fails on high/critical)                       |
| `npm run db:generate`               | Generate a new SQL migration from schema changes                           |

## Layout

- `src/modules/*`: domain modules; each exposes only `index.ts` (enforced in CI).
- `src/app`: Next.js routes (`admin/` uses Tailwind; the storefront route group uses the original CSS).
- `src/worker`: background worker (pg-boss + outbox relay).
- `drizzle/`: committed SQL migrations. `scripts/`: migrate, seed, create-owner.
- `legacy/`: the original static site, kept as the design reference.
- `docs/`: spec, progress, invariants, decisions (ADRs).

Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md). Environment variables: [docs/ENV.md](docs/ENV.md).

## Licence

MIT for the source code. Brand fonts, photos and video are not covered (rights unconfirmed), see [LICENSE](LICENSE).
