# Internet Archaeology Machine

Internet Archaeology Machine (IAM) is a free, open-source experiment for exploring surviving homepage captures in the Internet Archive. It is a curiosity tool, not a SaaS product and not an archive of its own.

Phase 0 is a feasibility scaffold: a small Vite/TypeScript interface and a Cloudflare Worker endpoint that requests at most five successful HTML capture records for one validated public hostname.

## What works

- A responsive, keyboard-friendly domain search form with loading, empty, success, and upstream-error states.
- `GET /api/health` for a local/deployed health check.
- `GET /api/captures?domain=example.com` for a bounded Internet Archive CDX query.
- Public-hostname validation that rejects credentials, ports, IP literals, localhost, and internal names before any upstream request.
- Explicit handling for rate limits, timeouts, malformed archive data, and general upstream failures.
- Deterministic Vitest coverage using a clearly labelled real-shape fixture. Fixture records are never returned by the live API.

This is not yet the Phase 1 timeline. Results are only a small sample of surviving indexed homepage captures.

## Local setup

Requirements: Node.js 24 or newer and npm.

```bash
npm ci
npm test
npm run check
npm run build
npm run dev
```

`npm run dev` builds the frontend and starts Wrangler's local Worker runtime. Open the URL Wrangler prints, normally `http://localhost:8787`.

For frontend-only styling work, `npm run dev:client` starts Vite without the Worker API.

## API examples

```bash
curl http://localhost:8787/api/health
curl "http://localhost:8787/api/captures?domain=example.com"
```

Successful capture responses identify `internet-archive-cdx` as their source and include an archive-coverage limitation. HTTP 429 from the upstream archive becomes an explicit `ARCHIVE_RATE_LIMITED` response; the application never swaps in demo data.

## Project map

- `src/client/` — vanilla TypeScript and CSS frontend
- `src/worker/` — Worker routing, validation, and Internet Archive provider
- `src/shared/` — JSON contract types shared by client and Worker
- `tests/` — deterministic unit and interface tests plus the labelled CDX fixture
- `docs/` — architecture, data-source, decision, roadmap, and deployment notes
- `wrangler.jsonc` — Worker and Static Assets configuration

See [Architecture](docs/ARCHITECTURE.md), [data-source evidence](docs/DATA_SOURCES.md), and [deployment preparation](docs/DEPLOYMENT.md) for details.

## Evidence and limits

On 1 November 2026, bounded requests from the development environment returned CDX HTTP 200 responses for `example.com`, `mozilla.org`, and `yahoo.com`. Availability API requests returned HTTP 200 for the first two and HTTP 429 for the third. The exact observations are recorded in `docs/DATA_SOURCES.md`.

No Cloudflare deployment was made in Phase 0, so connectivity from deployed Cloudflare infrastructure is still an explicit gate before Phase 1.

## License

[MIT](LICENSE)
