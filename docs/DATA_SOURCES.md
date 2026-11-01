# Data sources and Phase 0 observations

## Internet Archive CDX API

The prototype uses the official Wayback CDX endpoint at `https://web.archive.org/cdx/search/cdx`. The query is an exact homepage hostname, not a prefix or entire-domain crawl. It requests:

- `timestamp`, `original`, `statuscode`, `mimetype`, `digest`, and `length`
- JSON output
- successful (`200`) HTML captures
- a hard limit of five rows

Reference: [Wayback CDX Server documentation](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md).

These fields are metadata. A digest is not proof of a visual change, the first record is not a website launch date, and a missing record is not evidence that a site was offline.

## Availability API

Phase 0 also probed `https://archive.org/wayback/available?url=...` as a legitimate fallback candidate. It returns a closest-snapshot shape rather than a timeline, so the application does not merge it into the CDX response.

## Observations on 1 November 2026

The following bounded probes were made from the local development environment with a descriptive user agent and a 15-second client timeout:

| Domain | CDX, limit 3 | Observed latency | Availability API |
| --- | --- | ---: | --- |
| `example.com` | HTTP 200, expected JSON header/rows | 1.49s | HTTP 200 |
| `mozilla.org` | HTTP 200, expected JSON header/rows | 4.95s | HTTP 200 |
| `yahoo.com` | HTTP 200, expected JSON header/rows | 0.86s | HTTP 429 |

The sample CDX rows included the documented header followed by string-valued metadata. A sanitized direct copy of the three-row `example.com` shape is stored at `tests/fixtures/cdx-example.json` and labelled as test data.

The completed local Wrangler path was then exercised on port 8799. The built homepage returned HTTP 200 in 113ms, `/api/health` returned HTTP 200 in 201ms, and `/api/captures?domain=example.com` returned HTTP 200 with authentic CDX metadata in 4.45s. These timings are single observations, not performance guarantees.

## What remains unverified

No Cloudflare deployment or credentialed remote development session was authorized. Therefore:

- CDX access from deployed Cloudflare infrastructure is not yet proven.
- Production latency, redirects, Cloudflare egress behavior, and production 403/429 frequency remain unknown.
- Phase 1 must not claim the production-path gate is complete until the deployed `/api/captures` endpoint is smoke-tested with a few domains.

If CDX is blocked in production, do not use random proxies or bypass access controls. Keep the error visible, test the documented Availability API as a reduced legitimate experience, and reassess the data source before building the timeline.
