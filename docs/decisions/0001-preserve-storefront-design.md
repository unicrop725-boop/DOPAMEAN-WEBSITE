# ADR 0001: Preserve the existing storefront design exactly

Status: Accepted (owner approved 2026-10-16). Refined by ADR 0004: the CSS is served from `public/`, not imported.
Date: 2026-10-16

## Context

The repo contains a finished static front end for DOPAMEAN: `index.html`, `collection_page.html`, `products.html`, 7 CSS files (~125 KB), `script/script.js`, fonts (Apercu, Apercu Mono, Satoshi) and image assets. The owner's instruction: **do not change the design**; make it a working commerce platform behind this exact design.

The locked stack (brief §4) says Tailwind + shadcn/ui. The existing CSS is hand-written, global, class-based, with separate desktop (`.desktop-view`) and mobile (`.mobile`) DOM trees toggled by media queries (768/1023/1024 px).

## Options

1. Rewrite the storefront in Tailwind/shadcn to "match" the design. Risk: visual drift; high effort; contradicts "exact design".
2. Port markup and CSS **verbatim** into Next.js: the legacy CSS files are copied unchanged and imported globally by the storefront route group; HTML is translated 1:1 into React components keeping every class name, element order and asset. Only text/price/image/link values become data-driven.
3. Keep static HTML and bolt an API on with `fetch`. Rejected: no SSR, no SEO (brief requires metadata, structured data, sitemap), no server-rendered order confirmation.

## Decision

Option 2.

- Storefront route group `(storefront)` imports the legacy CSS unchanged (CSS files are not edited; any additive fixes go in a new `storefront-additions.css` loaded after them and are listed in the spec).
- Tailwind + shadcn/ui is used for the **admin** and for any **new** screen that has no existing design (see SPEC §9 for the list), styled with tokens extracted from the existing CSS so the new screens look native.
- Legacy CSS is scoped to the storefront route group only; Tailwind preflight is not loaded there so it cannot alter the legacy rendering.
- Visual regression: Playwright screenshot baselines of the three existing pages at 375/768/1280/1920 px are taken from the **current static files** before any port, and the ported pages must match within a pixel-diff threshold. This is the proof that the design is unchanged.

## Consequences

- Two styling systems coexist (legacy CSS for storefront, Tailwind for admin/new screens). Acceptable and isolated by route group.
- Markup that is currently duplicated for desktop/mobile stays duplicated (needed for identical rendering). It is rendered from the same data.
- Existing JS behaviours (accordions, size selector, bag drawer, size-chart modal, clock) are re-implemented as small client components with identical behaviour; the legacy `script.js` is not shipped (it throws on pages missing elements and has cross-page selector collisions, see SPEC §1.3).
- Changing any visible design element (including removing a non-functional button) requires owner approval, see SPEC §13.
