# Roadmap

## Phase 0 — complete

- Reproducible Vite/TypeScript/Worker scaffold
- Safe `/api/health` and bounded `/api/captures` prototype
- Basic domain search interface
- Deterministic tests, CI, documentation, and local archive feasibility evidence
- Cloudflare configuration without deployment or credentials

The production deployment and authentic CDX access were verified by the project owner.

## Phase 1A — complete

- Show years from 1996 through the current year as explicitly not checked.
- Send one bounded CDX query only when a visitor chooses a year.
- Show one verified capture, no returned capture, timeout, rate limit, or upstream failure without scanning other years.

## Phase 1B — current pull request

- Retain up to two verified captures for an honest side-by-side metadata comparison.
- Reuse checked-year results for the active domain and clear stale state when the domain changes.
- Let visitors replace either compared year without changing the bounded archive API.

## Full Phase 1 timeline — not implemented

Normalize homepage variants, merge/de-duplicate capture metadata, group authentic captures by year, add filters and shareable investigation URLs, and cover all UI states with representative tests.

## Later phases — not implemented

Visual page comparison, citations, exportable discovery cards, curated examples, and optional experiments such as screenshot or source-code archaeology remain separate, reviewable projects.
