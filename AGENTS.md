# Project guidance for coding agents

## Scope

- Read `README.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md` before changing product behavior.
- Keep changes within the requested phase. Phase 0 must not grow timeline, comparison, sharing, persistence, accounts, analytics, or bulk crawling features.
- Prefer the smallest implementation that keeps the archive boundary honest and testable.

## Required checks

Run these before proposing a pull request:

```bash
npm run check
npm test
npm run build
```

CI tests must be deterministic and must not require live Internet Archive access.

## Archive and security rules

- Never turn the Worker into an arbitrary URL proxy. It may contact only explicitly coded Internet Archive hosts.
- Validate public hostnames before any upstream request. Reject credentials, ports, IP addresses, localhost, and internal names.
- Keep CDX queries exact and bounded; do not add `/*` or mass-domain crawling by default.
- Treat archive metadata and historical content as untrusted. Do not render it through `innerHTML`.
- Never silently substitute fixture or demo data for a failed live request.
- Surface archive gaps, blocks, rate limits, timeouts, and malformed responses explicitly.
- Do not add secrets, paid services, trackers, a database, or deployment credentials without the owner's explicit request.

## Code conventions

- Use strict TypeScript, web-standard APIs, and vanilla DOM code.
- Keep provider, validation, routing, shared contracts, and client rendering separated.
- Add or update tests first for behavior changes. Mock only the external network boundary.
- Keep documentation consistent with actual commands and verified behavior.
