# Internet Archaeology Machine

Internet Archaeology Machine (IAM) is a free, open-source experiment for exploring surviving homepage captures in the Internet Archive. It is a curiosity tool, not a SaaS product and not an archive of its own.

The current application is a small Vite/TypeScript interface and Cloudflare Worker with an on-demand historical year explorer. It checks only the year a visitor selects.

## What works

- A responsive, keyboard-friendly year explorer with not-checked, loading, empty, success, and upstream-error states.
- `GET /api/health` for a local/deployed health check.
- `GET /api/captures?domain=example.com` for a bounded Internet Archive CDX query.
- `GET /api/captures?domain=example.com&year=2002` for at most one capture from one selected year.
- Public-hostname validation that rejects credentials, ports, IP literals, localhost, and internal names before any upstream request.
- Explicit handling for rate limits, timeouts, malformed archive data, and general upstream failures.
- Deterministic Vitest coverage using a clearly labelled real-shape fixture. Fixture records are never returned by the live API.

The year selector does not claim that every displayed year is archived. Years remain labelled “Not checked” until selected, and the browser never scans or fans out across decades.

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
curl "http://localhost:8787/api/captures?domain=example.com&year=2002"
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

The Phase 0 deployment and authentic CDX access were verified before the on-demand year explorer was started. Targeted year-query observations are recorded in `docs/DATA_SOURCES.md`.

## License

[MIT](LICENSE)
