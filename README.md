# Internet Archaeology Machine

Internet Archaeology Machine (IAM) is a free, open-source experiment for exploring surviving homepage captures in the Internet Archive. It is a curiosity tool, not a SaaS product and not an archive of its own.

The application uses a Tabler-styled Vite/TypeScript interface and Cloudflare Worker with an on-demand historical year explorer. It checks only the year a visitor selects, compares up to two verified archive entry points, and can show two owner-gated screenshots side by side.

## What works

- A responsive, keyboard-friendly year explorer with not-checked, loading, empty, success, and upstream-error states.
- A two-capture metadata comparison with safe replay links and replaceable, session-cached year selections.
- Persistent screenshot storage in Cloudflare R2. Public visitors automatically see previously saved PNGs; only owners may generate new images. Owner generation re-verifies the capture and checks R2 first to avoid repeat Browser Run charges. The screenshot action hides Wayback's own toolbar using a scoped CSS rule.
- Tabler-based responsive light UI (CSS pinned to @tabler/core 1.7.1 on jsDelivr). The visitor's preview object URLs stay only in tab memory and are cleared on domain change; the source PNGs live persistently in R2.
- `GET /api/health` for a local/deployed health check.
- `GET /api/captures?domain=example.com` for a bounded Internet Archive CDX query.
- `GET /api/captures?domain=example.com&year=2002` for at most one capture from one selected year.
- Public-hostname validation that rejects credentials, ports, IP literals, localhost, and internal names before any upstream request.
- Explicit handling for rate limits, timeouts, malformed archive data, and general upstream failures.
- Deterministic Vitest coverage using a clearly labelled real-shape fixture. Fixture records are never returned by the live API.

The year selector does not claim that every displayed year is archived. Years remain labelled “Not checked” until selected, and the browser never scans or fans out across decades. The comparison covers verified archive metadata and replay entry points for everyone. The screenshot comparison is an optional owner-only action, with one Browser Run request per image and in-tab reuse to conserve the free-tier quota. Wayback may redirect the replay to a different archived year even when CDX verifies a capture in the requested year; user-facing screenshot captions therefore identify the *requested* year rather than claiming the final rendered content is necessarily from it. The original Wayback link remains available for provenance.

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

Public `GET /api/screenshot?domain=example.com&year=2002&timestamp=20020120142510` fetches only an exact, previously saved image from R2, without contacting the archive or running a browser. Owner `POST /api/screenshot` accepts a validated domain and year, checks the same R2 key after live CDX verification, and only launches Browser Run on a miss. The endpoint never accepts a destination URL or HTML. Storage writes require both the `SCREENSHOTS` R2 binding and `SCREENSHOT_ACCESS_TOKEN` secret. See [deployment preparation](docs/DEPLOYMENT.md) for setup and testing.

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

## Phase 3A: persistent screenshot cache

A single Cloudflare R2 Standard bucket, `internet-archaeology-machine-screenshots`, stores the PNG and attached provenance metadata. No D1 database is needed until browsing/searching the stored catalogue is required. Object keys include the capture timestamp and rendering version, not just the requested year. Previously generated **in-browser** screenshots are not retroactively present in R2 and must be generated once after storage is configured.

See [deployment preparation](docs/DEPLOYMENT.md) for the one-time owner R2 setup. The Worker fails closed rather than running Browser Run when its storage binding is missing. Public cache misses return 404 and do not consume archive or screenshot quota.
