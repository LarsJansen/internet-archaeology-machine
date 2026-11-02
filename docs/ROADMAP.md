# Roadmap

## Phase 0 — complete

- Reproducible Vite/TypeScript/Worker scaffold
- Safe `/api/health` and bounded `/api/captures` prototype
- Basic domain search interface
- Deterministic tests, CI, documentation, and local archive feasibility evidence
- Cloudflare configuration without deployment or credentials

The production deployment and authentic CDX access were verified by the project owner.

## Phase 1A — complete

- Initial on-demand year grid (replaced with real indexed-year discovery in Issue #12).
- Send one bounded CDX query only when a visitor chooses a year.
- Show one verified capture, no returned capture, timeout, rate limit, or upstream failure without scanning other years.

## Phase 1B — complete

- Retain up to two verified captures for an honest side-by-side metadata comparison.
- Reuse checked-year results for the active domain and clear stale state when the domain changes.
- Let visitors replace either compared year without changing the bounded archive API.

## Phase 2A — complete

- One owner-gated screenshot action per verified capture, backed by Cloudflare Browser Run.
- Re-verify domain and year server-side before one Browser Run Quick Action.
- Keep owner credentials out of links and storage.

## Phase 2B — complete

- Tabler-based responsive redesign, with an archive-oriented light theme.
- Two independent screenshot panels mapped to the selected verified years.
- Cache screenshot object URLs only in the current tab, reuse on year replacement, and revoke on domain change.
- Preserve explicit owner action per screenshot; no batch requests or quota-using background work.

## Phase 3A — complete

- Add R2 Standard screenshot storage and per-image provenance metadata.
- Show cached PNGs publicly by exact verified capture timestamp; no owner token or Browser Run required for reads.
- Preserve owner-only generation and avoid duplicate browser renders on cache hits.
- Cloudflare R2 bucket provisioned and shared screenshot cache smoke-tested in production.

## Indexed-year discovery (Issue #12) — complete

- Discover only matching homepage years using a single bounded CDX `collapse=timestamp:4` request.
- Display no invented 1996–present year grid and only show comparison panels after individual capture verification.
- Explain partial coverage, index errors and empty results honestly.

## Shareable discovery cards and curator access — complete

- Export a two-image, source-labelled comparison PNG entirely in the browser using already saved screenshots.
- Keep both exact Wayback URLs available with a copy-sources action so shared graphics have a verifiable trail.
- Replace the repeated screenshot token form with a discreet curator login and seven-day HttpOnly signed session.
- Present production-ready copy without public-facing admin/proof-of-concept labels.

## Full Phase 1 timeline — not implemented

Normalize homepage variants, merge/de-duplicate capture metadata, group authentic captures by year, add filters and shareable investigation URLs, and cover all UI states with representative tests.

## Later phases — not implemented

Curated examples, discovery collections, richer shareable investigation URLs and source-code archaeology remain separate, reviewable projects.


## Phase 4 — public screenshot requests

- Public users can request a missing screenshot without login after a fresh CDX timestamp check.
- R2 cache-first; generation uses a single SQLite Durable Object with global/per-visitor budgets, cooldowns and leases.
- Public attempts are capped at six/day site-wide and two/day per visitor, with owner generation continuing to function.
- Preserve a clear disclaimer that replay content may differ from the requested archive date.
- No automatic crawling or mass screenshot generation.
