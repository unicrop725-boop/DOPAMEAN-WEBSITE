# ADR 0004: Original storefront CSS is served from `public/`, not bundled

Status: Accepted (refines ADR 0001)
Date: 2026-10-16

## Context

ADR 0001 said the legacy CSS would be imported by the storefront route group. Inspecting the files showed that bundling would **change what users see**:

- `legacy/css/style.css` and `legacy/css/collection_page.css` declare `@font-face` with `url('./apercu_regular_pro.woff2')` etc., **relative to `css/`**, but the font files live in `fonts/`. In the current static site the browser requests `/css/ApercuMonoProRegular.woff2` and gets 404, so the home and collection pages render with **fallback fonts**, not Apercu / Apercu Mono. (`products.html` resolves its fonts correctly.) Verified by rendering the pages: 404s for `/css/ApercuMonoProRegular.woff(2)` and `/css/apercu_medium_pro.woff` on home and collection.
- A bundler (Next/webpack/Turbopack) resolves `url()` at build time and **fails the build** on missing files. Making it pass would mean editing the CSS or adding the fonts, either of which changes the rendered design.

## Decision

Copy `css/`, `fonts/`, `assets/` unchanged to `public/` (same relative layout as the static site) and link the page-specific stylesheets from the ported pages with `<link rel="stylesheet" href="/css/...">`. Next does not process `public/`, so URLs resolve exactly as they do today, 404s included. The original files stay in `legacy/` as the **design reference**; E2E visual tests render `legacy/` and the ported page side by side and diff them.

Pages navigate with plain `<a>` (full page loads) exactly like the static site, because each page loads a different stylesheet set whose global rules conflict with each other.

## Consequences

- The ported pages are byte-for-byte the same CSS. Any visual change must be a deliberate, listed decision.
- **Owner decision needed (PROGRESS.md):** do you want the intended brand fonts to start loading on home/collection? That is a one-line fix (point the `url()`s at `../fonts/`) but it **will change the look** of those two pages, so I have not done it.
- The admin and new screens use Tailwind and load the fonts correctly via their own `@font-face` pointing at `/fonts/`. Font licences are unconfirmed (SPEC Q12).
