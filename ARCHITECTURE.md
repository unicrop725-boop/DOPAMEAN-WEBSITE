# Architecture

Modular monolith in one Next.js codebase, plus a worker process from the same code. Details and rationale: [docs/SPEC.md](docs/SPEC.md) and [docs/decisions/](docs/decisions/).

## Processes

```
browser ──► web (Next.js, App Router) ──► PostgreSQL ◄── worker (pg-boss + outbox relay)
                 │                                          │
                 └── S3 API (media) ◄───────────────────────┘── SMTP (Mailpit locally)
```

- **web**: server components, route handlers, server actions. Thin: validate (Zod) → authorize → call a module → map errors to stable codes (`src/lib/errors.ts`).
- **worker** (`src/worker`): relays the transactional outbox every 2 s (`FOR UPDATE SKIP LOCKED`, exponential backoff), runs scheduled jobs via pg-boss (housekeeping every 10 min), writes a heartbeat that `/api/health` reads.
- **PostgreSQL** is the only stateful dependency in R1 (no Redis): data, sessions, rate limits, job queue.

## Modules (`src/modules/*`)

Implemented so far: `audit`, `catalog` (create/read), `customers`, `inventory` (stock, movements), `notifications` (mailer, templates, outbox handlers), `staff` (roles, 2FA rule, owner-only creation), `tax` (table only). Empty so far: `pricing`, `cart`, `checkout`, `payments`, `orders`, `fulfillment`, `promotions`.

Rules, enforced by dependency-cruiser in `npm run lint` (violations fail CI; proven with deliberate violations):

1. Another module is reachable only through its `index.ts`.
2. Routes, worker and scripts import modules through `index.ts` only; `src/db` may import each module's `schema.ts` to assemble the Drizzle schema.
3. `domain/` folders are plain TypeScript: no Next, React, Drizzle, pg, Better Auth or provider imports.
4. No cycles.

Cross-module references are plain ids without foreign keys (ADR 0002 item 7).

## Cross-cutting

- **Auth**: Better Auth (`src/lib/auth.ts`), database sessions, email verification, TOTP. Public sign-up creates a customer profile via a database hook. Staff are created only by an Owner (or the one-time bootstrap CLI) in `src/modules/staff`. Admin pages are gated server-side in `src/app/admin/(panel)/layout.tsx`.
- **Outbox** (`src/lib/outbox.ts`): `enqueueOutbox(tx, …)` in the same transaction as the business change; handlers registered by modules (`notificationHandlers`).
- **Audit** (`src/modules/audit`): `recordAudit(tx, …)`; `audit_event` is append-only by trigger.
- **Money, tax, state machines**: not implemented yet; rules in SPEC §4 and §6.
- **Logging**: pino JSON with redaction (`src/lib/logger.ts`).
- **Config**: `src/lib/env.ts` validates every environment variable with Zod.

## Design preservation

The storefront reuses the original CSS unchanged from `public/css` (ADR 0004); the original site stays in `legacy/` as the reference for visual diff tests. Tokens for new screens live in `src/styles/tokens.css`.
