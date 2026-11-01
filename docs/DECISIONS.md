# Decisions

## 2026-11-01: one repository and one Cloudflare Worker project

Vite builds the client and Wrangler deploys both Worker code and static assets. Same-origin `/api/*` calls avoid a separate API host and browser CORS configuration.

## 2026-11-01: plain Vite plus Wrangler

Phase 0 uses Vite directly rather than the Cloudflare Vite plugin or parallel development servers. `npm run dev` performs a production client build before starting Wrangler. This is slower than hot module replacement but keeps the first scaffold and dependency surface small.

## 2026-11-01: exact, bounded CDX query

The provider queries one validated hostname, filters to successful HTML captures, selects only needed fields, and requests at most five rows. It does not use `/*`, wildcard subdomains, pagination, or retries.

## 2026-11-01: fixture data is test-only

The UI never falls back to fixture captures. Upstream problems stay visible so a visitor cannot mistake demo history for archive evidence.

## 2026-11-01: no deployment in the first PR

The project is configured for Cloudflare Workers Builds, but deployment requires the owner's Cloudflare authorization. Phase 0 records local feasibility evidence without claiming the production-path gate.
