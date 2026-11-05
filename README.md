# Internet Archaeology Machine

Internet Archaeology Machine (IAM) is a free, open-source way to explore surviving website captures from the Internet Archive, compare historic snapshots and share what you discover. IAM does not operate its own web archive.

The application uses a Tabler-styled Vite/TypeScript interface and Cloudflare Worker with an indexed-year explorer. Visitors can view cached snapshots, request missing images within strict daily limits, and explore real saved discoveries with Surprise Me.

## What works

- A responsive, keyboard-friendly year explorer that lists only years with matching indexed homepage captures, with explicit empty, loading, success, and upstream-error states.
- A two-capture metadata comparison with safe replay links and replaceable, session-cached year selections.
- Persistent screenshot storage in Cloudflare R2. Public visitors automatically see previously saved PNGs, and may request missing snapshots within strict per-visitor and site-wide limits. All generation re-verifies the archive capture and checks R2 first to avoid repeat Browser Run charges.
- Tabler-based responsive light UI (CSS pinned to @tabler/core 1.7.1 on jsDelivr). Visitors can download a 1600×1100 shareable comparison PNG from two loaded screenshots and copy exact Wayback source links. Export runs entirely in the browser, never calling Browser Run.
- Curator access uses a seven-day, HMAC-signed `Secure`, `HttpOnly`, `SameSite=Strict` session cookie, rather than requiring the owner token for every screenshot. Public visitors never see the generation controls. The original secret remains in Cloudflare and is sent once to log in, not stored in browser-accessible storage.
- `GET /api/health` for a local/deployed health check.
- `GET /api/surprise` to discover one or two actually saved Wayback screenshots from R2; this endpoint does not call the Internet Archive or Browser Run.
- `GET /api/captures?domain=example.com` for a bounded Internet Archive CDX query.
- `GET /api/captures?domain=example.com&year=2002` for at most one capture from one selected year.
- `GET /api/years?domain=example.com` for a bounded CDX-derived list of indexed homepage years (not a complete history guarantee).
- Public-hostname validation that rejects credentials, ports, IP literals, localhost, and internal names before any upstream request.
- Explicit handling for rate limits, timeouts, malformed archive data, and general upstream failures.
- Deterministic Vitest coverage using a clearly labelled real-shape fixture. Fixture records are never returned by the live API.

The year selector lists only years returned by one bounded CDX query using `collapse=timestamp:4`; each chosen year is verified again before comparison. The index can be incomplete, so missing years do not prove the site was offline. The browser never fans out across decades. The comparison covers verified archive metadata and replay entry points for everyone. New screenshots are opt-in, limited public requests with one Browser Run request per uncached image. Cached images and in-tab reuse avoid repeat render work. Wayback may redirect the replay to a different archived year even when CDX verifies a capture in the requested year; user-facing screenshot captions therefore identify the *requested* year rather than claiming the final rendered content is necessarily from it. The original Wayback link remains available for provenance.

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


## Phase 4 — Public screenshots (bounded)

Visitors may request missing images via `POST /api/screenshot/request`, supplying only the validated domain, year and exact 14-digit CDX capture timestamp from the UI. There is no account requirement. Public cached image reads still use `GET /api/screenshot` without touching the coordinator or Browser Run. A public generation request first checks R2, then obtains a lease from a **SQLite-backed Durable Object**. Only one new render can run at once, with a 15-second cooldown. Successful images are saved to R2. The stored PNG remains associated with the CDX timestamp; Wayback may redirect or load later assets, and the screenshot is **not** a guarantee of the rendered date.

The initial hard limits are 6 public attempts per UTC day across the whole site, and 2 per visitor per UTC day. Per-visitor state is keyed to an HMAC fingerprint of Cloudflare's trusted client IP, not a browser-controlled token. The Durable Object serialises admissions and persists counters and leases across restarts. Failed renders also count toward limits. The global coordinator does *not* receive cache hits or ordinary archive browsing; when budget infrastructure is missing, new generation fails closed. Owner generation shares the global lock but bypasses public daily limits.

The binding `SCREENSHOT_BUDGET` and SQLite class `ScreenshotBudget` are declared using Wrangler's `exports` lifecycle configuration. `PUBLIC_SCREENSHOTS_ENABLED` is explicitly set to `true` in `wrangler.jsonc`; change to `false` to pause new public captures without interrupting cached screenshot reads. See [deployment](docs/DEPLOYMENT.md) for rollout and limitations.


## Phase 5 — Surprise Me

Click **Surprise me** beside the search form to discover a random website with screenshots already saved in Cloudflare R2. Only domains on the handpicked (not screenshot-reviewed) editorial shortlist in `src/worker/surprise.ts` are eligible; listing a domain does not assert any capture exists. When the collection contains two distinct cached years for an approved domain, IAM shows a two-image comparison. Otherwise, it shows the single genuine saved image rather than inventing a second year. **Find another** avoids the last domain when an alternative is available, and **Explore this website's history** opens its indexed-year timeline.

The public endpoint `GET /api/surprise` uses only R2 object listing with custom metadata, capped at three pages of 200 items. It makes **no** CDX lookups, does **not** invoke Browser Run, does not write to R2 and consumes **none** of the public screenshot-generation allowance. Entries include exact capture timestamps and Wayback replay links. The listing is a bounded, lexicographically ordered sample; when the cache grows, a separate discovery index or curated catalogue will be preferable to avoid overrepresenting early domains. No extra Cloudflare infrastructure is required.
\n
## Phase 6 — Shareable discovery URLs

Every pair of saved screenshots can be shared as a durable, exact-capture link such as `/discover/yahoo.com/19990102123000/20050102123000`; Surprise Me also supports single-image links. The site offers **Copy comparison link**, **Open shareable page** and **Copy discovery link**. Recipients get the requested cached images, indexed timestamps and original Wayback replay URLs without searching for the domain, signing in, generating screenshots or consuming the shared Browser Run budget.

- `GET /api/discovery?domain=yahoo.com&timestamp=19990102123000&timestamp=20050102123000` resolves exact R2 metadata using **HEAD** lookups (not CDX). Missing or inconsistent image provenance results in 404, not substitute screenshots.
- `GET /discover/<domain>/<capture-timestamp>[/<capture-timestamp>]` serves the existing frontend shell with **server-injected** canonical, Open Graph and Twitter Card tags. Social crawlers receive descriptive titles, archived years and a preview taken from the **first actual cached screenshot**. This preview is one image, not a fabricated composite.
- Wrangler uses `assets.binding="ASSETS"` and `run_worker_first=["/api/*","/discover/*"]`; the ordinary homepage and built frontend assets continue to be served directly.
- Saved screenshots are still modern renderings of archived replays; archive redirects or later resources may change their appearance. Permalinks use exact source timestamps and never claim the final rendered content was independently date-verified.

Deep-link storage currently uses the active `toolbarless-v1-1280x900` R2 variant. If that renderer variant changes later, preserve an old-variant read path or migrate its objects to avoid breaking published links. The existing saved R2 bucket and owner secret are sufficient.
