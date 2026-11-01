# Roadmap

## Phase 0 — complete

- Reproducible Vite/TypeScript/Worker scaffold
- Safe `/api/health` and bounded `/api/captures` prototype
- Basic domain search interface
- Deterministic tests, CI, documentation, and local archive feasibility evidence
- Cloudflare configuration without deployment or credentials

The production deployment and authentic CDX access were verified by the project owner.

## Phase 1A — current pull request

- Show years from 1996 through the current year as explicitly not checked.
- Send one bounded CDX query only when a visitor chooses a year.
- Show one verified capture, no returned capture, timeout, rate limit, or upstream failure without scanning other years.

## Full Phase 1 timeline — not implemented

Normalize homepage variants, merge/de-duplicate capture metadata, group authentic captures by year, add filters and shareable investigation URLs, and cover all UI states with representative tests.

## Later phases — not implemented

Capture comparison, citations, exportable discovery cards, curated examples, and optional experiments such as screenshot or source-code archaeology remain separate, reviewable projects.
