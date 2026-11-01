# Architecture

## Request path

```text
Browser
  |-- static HTML/CSS/TypeScript --> Cloudflare Workers Static Assets (`dist/`)
  `-- /api/* --------------------> TypeScript Worker
                                        |
                                        `-- bounded HTTPS request --> web.archive.org CDX API
```

Vite compiles `index.html` and `src/client/` to `dist/`. `wrangler.jsonc` configures Cloudflare Static Assets to serve that directory and invokes `src/worker/index.ts` first only for `/api/*`.

The Worker has three small boundaries:

1. `domain-validation.ts` reduces a bare domain or pasted HTTP(S) homepage URL to a public DNS hostname. It rejects input that could broaden the Worker into an internal or arbitrary proxy.
2. `archive-provider.ts` constructs one fixed-host CDX request, selects six metadata fields, filters to HTTP 200 HTML records, caps the response at five rows, and times out after eight seconds.
3. `index.ts` maps HTTP routes and turns provider outcomes into explicit JSON responses.

The client calls the same-origin API and renders returned metadata through DOM properties and text nodes. It never injects archive data as HTML.

## Caching

Successful capture responses use `Cache-Control: public, max-age=300, s-maxage=86400`: browsers may reuse a response briefly and shared infrastructure may reuse it for a day. Validation and upstream errors use `no-store`.

## Testing boundary

Tests inject a fetch implementation at the provider/route boundary. The fixture in `tests/fixtures/cdx-example.json` preserves a real CDX response shape but is test-only. Live Internet Archive status does not decide CI success.

## Deliberate omissions

There is no database, framework, authentication, telemetry, background job, retry loop, or archive-content fetching. Year grouping, de-duplication across hostname variants, and shareable investigations belong to later phases.
