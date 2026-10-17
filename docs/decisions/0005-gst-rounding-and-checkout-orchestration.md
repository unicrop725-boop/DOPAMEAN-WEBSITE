# ADR 0005: GST rounding, payment state rules and checkout as the orchestration layer

Status: Accepted
Date: 2026-10-17

## Context

The commerce core needed four decisions the brief leaves open. Each affects money or stock, so they are recorded here instead of being buried in code.

## Decisions

### 1. GST is extracted from the tax-inclusive price, per line, rounded half up

Shelf prices include GST (the storefront shows one price). For each line the tax is `gross * rate / (100 + rate)`, computed in integer paise with BigInt and rounded **half up** (`(2n*num + den) / (2n*den)`). Net = gross - tax, so net + tax always equals the price the customer saw, to the paisa.

- Intra-state orders split the tax into CGST and SGST; when the tax is an odd number of paise the extra paisa goes to **SGST**. Inter-state orders use IGST.
- The apparel slab is chosen by **unit price** (5% up to Rs 2,500, 18% above), which is the rule for readymade garments. The rule is data (`tax_rule`), not code, and defaults come from the seed.
- Shipping, when charged, is taxed at the highest rate among the order's lines. Shipping defaults to free (owner question still open).
- Rounding is per line, not per order, so the invoice lines add up to the invoice total.

**Open:** the owner/accountant must confirm the slab and rounding. Nothing here is tax advice.

### 2. One function prices a cart

`priceCart` is the only place totals are computed. Cart page, checkout summary, order placement and the worker all call it (INV-01). The checkout form carries an HMAC-signed snapshot of what the customer was shown; placement re-prices and compares (INV-12). Any difference in price, stock or tax stops the order and shows what changed. Nothing is created.

### 3. Payment and order states are separate machines, and a payment can still succeed after a failure notice

Order, payment and fulfilment each have their own state machine, and an order can never move backwards. Payment providers send events out of order and retry them, so:

- A `captured` event is accepted for a payment currently `failed` (a customer retries and pays on the same provider order), but a `failed` event never undoes a `captured` payment.
- A capture that arrives after the order was cancelled or its stock hold expired tries to re-reserve; if that is not possible the payment is refunded automatically. The refund request row is written in the same transaction as the decision; the provider call happens after commit and is retried by a worker job.
- A webhook is: verify the HMAC over the raw body, store the event, de-duplicate on the provider's event id and apply the change, all in **one transaction**. Replays change nothing (INV-04, INV-05).
- A browser return to the shop never marks anything paid. It checks the return signature and then asks the provider's API for the captured payment (INV-02).

### 4. `checkout` is the top orchestration module; there is no `checkout_session` table

`checkout` coordinates cart, pricing, tax, inventory, orders, payments and notifications. Nothing imports it except the app layer and the worker, which keeps the dependency graph acyclic (enforced by dependency-cruiser). It owns no table: a checkout is a form submission with an idempotency key, and the key is stored on the order. This avoids a second source of truth for "what is being bought" next to the cart.

## Consequences

- Money correctness is covered by unit tests on the pure domain code and integration tests on a real Postgres; the browser flows are covered by `tests/e2e/shopping.spec.ts` against a fake Razorpay server.
- The Razorpay adapter has **not** been run against Razorpay's real API (no test keys yet). It is implemented but unverified; PROGRESS.md says so.
- Changing a rate or slab is a data change; changing the rounding rule is a code change and needs a new ADR and updated tests.
