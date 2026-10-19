# Changelog

## Unreleased

### Phase 2: walking skeleton (2026-10-16)

- Added: Docker Compose (Postgres 17, S3 storage, Mailpit, web, worker, migrate), production Dockerfile.
- Added: SQL migrations (22 tables), append-only audit trigger, CHECK constraints on stock and prices.
- Added: Better Auth (email + password, verification, TOTP), owner-only staff creation, admin shell with server-side gating.
- Added: transactional outbox, worker (pg-boss), health endpoint, pino logging with redaction, security headers.
- Added: CI workflow with format, lint + module boundaries, typecheck, unit, integration (real Postgres), E2E + axe, build, audit, secret scan, Docker build.
- Added: fictional seed data.
- Moved: original static site to `legacy/` (kept as design reference), unchanged.
