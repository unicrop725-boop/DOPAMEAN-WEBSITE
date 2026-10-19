# Environment variables

All variables are validated at startup by `src/lib/env.ts` (Zod). `.env.example` has no real values.

| Variable                         | Required | Default                 | Purpose                                                            |
| -------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------ |
| `APP_URL`                        | no       | `http://localhost:3000` | Public base URL (auth links, cookies)                              |
| `LOG_LEVEL`                      | no       | `info`                  | pino level                                                         |
| `DATABASE_URL`                   | yes      |                         | PostgreSQL connection string                                       |
| `BETTER_AUTH_SECRET`             | yes      |                         | Auth signing secret, 32+ chars                                     |
| `PRICING_TOKEN_SECRET`           | yes      |                         | HMAC key for pricing tokens, 32+ chars (used from Phase 3)         |
| `S3_ENDPOINT`                    | yes      |                         | S3-compatible endpoint                                             |
| `S3_REGION`                      | no       | `us-east-1`             |                                                                    |
| `S3_BUCKET`                      | yes      |                         | Media bucket                                                       |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | yes      |                         | Storage credentials (dev defaults `minioadmin` only for local use) |
| `SMTP_HOST`, `SMTP_PORT`         | yes      |                         | Mail server (Mailpit locally)                                      |
| `SMTP_USER`, `SMTP_PASS`         | no       |                         | SMTP auth                                                          |
| `SMTP_SECURE`                    | no       | `false`                 | `true` for implicit TLS                                            |
| `MAIL_FROM`                      | yes      |                         | From header                                                        |
| `RAZORPAY_KEY_ID`, `_KEY_SECRET` | no       |                         | Razorpay **test** keys (not used until Phase 3; none supplied yet) |
| `RAZORPAY_WEBHOOK_SECRET`        | no       |                         | Webhook signature secret                                           |
| `RESERVATION_TTL_MINUTES`        | no       | `15`                    | Stock reservation lifetime (INV-10)                                |
| `ORDER_PAYMENT_DEADLINE_MINUTES` | no       | `60`                    | When an unpaid order is cancelled (SPEC §4.5)                      |
| `CONTACT_INBOX`                  | no       |                         | Email address that receives contact-form messages                  |
| `S3_PUBLIC_URL`                  | no       |                         | Public base URL for uploaded media                                 |
| `SENTRY_DSN`                     | no       |                         | Optional error tracking                                            |
| `DB_POOL_MAX`                    | no       | `10`                    | pg pool size                                                       |

Do not set `NODE_ENV` in `.env`: Next sets it, and a non-standard value breaks `next build`.
