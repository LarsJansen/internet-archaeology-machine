# Phase 0 Design

## Intent

Establish a reproducible, deliberately small Internet Archaeology Machine application and prove that its Cloudflare Worker-shaped backend can make bounded requests to the Internet Archive. The result is a foundation for Phase 1, not a timeline product.

## Goals

- Serve a Vite-built vanilla TypeScript frontend and `/api/*` routes from one Cloudflare Worker project.
- Provide a basic domain search form backed by `GET /api/captures?domain=...`.
- Validate input, contact only the fixed Internet Archive CDX host, cap results, time out requests, and expose upstream failures honestly.
- Include deterministic tests and a real-shape fixture without substituting fixture data into live responses.
- Document local evidence, architecture, deployment setup, and the still-unverified production-path gate.

## Non-goals

- Timeline grouping, year filters, comparison, sharing, screenshots, accounts, persistence, analytics, or deployment.
- Bulk/domain-wide crawling, arbitrary proxying, retries, or workarounds for Internet Archive access controls.
- Claiming Cloudflare-production connectivity without an authorized deployment.

## Constraints

- Vite, vanilla TypeScript, accessible CSS, a TypeScript Cloudflare Worker, Vitest, and Wrangler.
- No database, credentials, paid services, or unnecessary runtime dependencies.
- CI must not depend on live Internet Archive availability.

## Approaches considered

1. **Plain Vite build plus Wrangler Static Assets (selected).** Vite builds `dist`; Wrangler serves those assets and runs the Worker first only for `/api/*`. This follows the project brief and keeps dependencies and configuration small. A pre-dev build is acceptable for this Phase 0 scaffold.
2. **Cloudflare Vite plugin.** This provides tighter local HMR/runtime integration, but adds integration-specific configuration that Phase 0 does not need.
3. **Separate frontend and API dev servers.** This avoids a plugin but requires proxy/process orchestration and makes the same-origin path harder to reproduce.

## Design

The frontend is a single accessible form that submits a domain to the same-origin API and renders a small list of capture metadata using DOM text APIs. Shared TypeScript types define the response contract.

The Worker routes health and capture requests. Input is normalized to a public DNS hostname and rejects IP addresses, credentials, ports, localhost, and internal/single-label names. The provider constructs one fixed-host CDX request for exact homepage matches, requests a small field set, limits results to five, and applies an eight-second timeout. It parses the CDX header row defensively. Successful responses are cacheable for 24 hours; errors are explicit and not replaced by fixture data.

Vitest exercises domain validation, CDX parsing/provider behavior, and Worker route contracts with injected fetch functions. The real-shape CDX fixture is test-only. CI runs type checking, tests, and the production build on Node 24.

## Evidence gate

On 1 November 2026, bounded local-network probes returned CDX HTTP 200 responses for `example.com`, `mozilla.org`, and `yahoo.com`. Availability API probes returned 200 for the first two and 429 for the third. These observations justify explicit rate-limit handling but do not satisfy the plan's deployed-Cloudflare verification gate. That check remains a manual post-PR step requiring the owner's Cloudflare account.
