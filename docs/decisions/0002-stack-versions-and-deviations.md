# ADR 0002: Stack versions, approvals and deviations from the brief

Status: Accepted
Date: 2026-10-16

## Context

The brief says to use the current stable version of each locked tool and record the versions. The owner approved the Phase 1 spec ("all approve") on 2026-10-16, which accepts the proposed defaults in SPEC §13.

## Versions installed (from `npm view` on 2026-10-16, locked by `package-lock.json`)

next 16.4.2 · react / react-dom 19.3.1 · typescript **6.0.3** · tailwindcss 4.x (+ @tailwindcss/postcss) · drizzle-orm 0.45.4 · drizzle-kit 0.31.11 · better-auth 1.7.10 · pg-boss 12.38.0 · zod 4.6.7 · vitest 5.0.5 · @playwright/test 1.64.1 · pino 10.4.0 · testcontainers / @testcontainers/postgresql 12.2.1 · dependency-cruiser 18.6.0 · eslint 10.12.0 · prettier 3.9.10 · sharp 0.35.x · node 22.19 (runtime image node:22-alpine) · PostgreSQL 17 (postgres:17-alpine).

## Deviations (each needs the owner's awareness)

1. **TypeScript 6.0.3, not 7.0.2.** `npm view typescript version` reports 7.0.2 but npm resolved 6.0.3 because typescript-eslint's peer range excludes 7. Strict mode is on (plus `noUncheckedIndexedAccess`). Revisit when typescript-eslint supports 7.
2. **RustFS instead of MinIO** for local S3-compatible storage: see ADR 0003.
3. **Better Auth CLI not used.** `@better-auth/cli` crashed in this npm environment (arborist error) and its latest version (1.4.x) predates better-auth 1.7. The auth tables in `src/db/auth-schema.ts` are hand-written from the library's own `getAuthTables()` output (`scripts/dump-auth-tables.ts` re-dumps it for comparison on upgrades). Sign-up, sign-in, verification, TOTP and rate-limit tables are exercised by the E2E tests.
4. **Staff passwords are hashed with Better Auth's `hashPassword` (scrypt)**, the same as customer passwords, which satisfies "argon2id or scrypt".
5. **Dependency audit gate covers production dependencies only** (`npm audit --omit=dev --audit-level=high`). Dev-only advisories (`braces` via `eslint-config-next`, `esbuild` via `drizzle-kit`) are tracked in PROGRESS.md as open risks. Four moderate advisories remain in `drizzle-kit` even with `--omit=dev` because better-auth depends on it; they concern the esbuild dev server and are not reachable at runtime. The gate fails on high/critical.
6. **CSP uses `'unsafe-inline'`** for scripts and styles until nonce-based CSP is implemented (Phase 5).
7. **Cross-module references are weak** (plain uuid columns, no FK) so that modules never import each other's tables (brief §5). Referential integrity across modules is enforced by the owning module's API and tested.
8. **No `tax`/`pricing`/`checkout` code yet.** Only the `tax_rule` table exists. These land in Phase 3.

## Approvals recorded

Owner replied "all approve" to SPEC §13 (Q1–Q19) and ADR 0001. Items that have **no default** and still need concrete values are tracked in PROGRESS.md "Needs owner input": Q2 GSTIN/state, Q3 GST slab rules (accountant), Q5 Razorpay test keys, Q7 shipping rule, Q12 font/image licences, Q14 per-control decisions where a default was ambiguous.
