# Roadmap

## Phase 0 — current pull request

- Reproducible Vite/TypeScript/Worker scaffold
- Safe `/api/health` and bounded `/api/captures` prototype
- Basic domain search interface
- Deterministic tests, CI, documentation, and local archive feasibility evidence
- Cloudflare configuration without deployment or credentials

## Gate before Phase 1

Deploy the reviewed Worker through the owner's Cloudflare account, then make a few respectful smoke requests to `/api/health` and `/api/captures`. Record response status, latency, redirects, and any 403/429 behavior. Do not start the full timeline if a legitimate production data path is unavailable.

## Phase 1 — not implemented

Normalize homepage variants, merge/de-duplicate capture metadata, group authentic captures by year, add filters and shareable investigation URLs, and cover all UI states with representative tests.

## Later phases — not implemented

Capture comparison, citations, exportable discovery cards, curated examples, and optional experiments such as screenshot or source-code archaeology remain separate, reviewable projects.
