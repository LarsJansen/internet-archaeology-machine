# Deployment preparation

Coding-agent work does not deploy. The repository contains everything needed for an owner-authorized Cloudflare Workers deployment after a pull request is reviewed and merged.

## Configuration

`wrangler.jsonc` defines:

- Worker name: `internet-archaeology-machine`
- entry point: `src/worker/index.ts`
- static asset directory: `dist`
- Worker-first handling only for `/api/*`

This follows Cloudflare's [Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/) and [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Connect GitHub to Cloudflare Workers Builds

After merging to `main`:

1. Sign in to the Cloudflare dashboard and create or select a Workers project.
2. In Workers Builds, connect the GitHub repository `LarsJansen/internet-archaeology-machine`.
3. Select production branch `main` and repository root `/`.
4. Set the build command to `npm ci && npm run check && npm test && npm run build`.
5. Keep the deploy command as `npx wrangler deploy` (or use the equivalent `npm run deploy`).
6. For the owner screenshot proof of concept, add one encrypted secret named `SCREENSHOT_ACCESS_TOKEN`. Do not expose it as a plaintext variable.
7. Review the generated API token permissions before enabling builds.

Cloudflare states that Workers Builds defaults the deploy command to `npx wrangler deploy` and uses the Wrangler version from `package.json`.

## Required post-deployment smoke test

Use only a few requests:

```bash
curl -i https://<worker-name>.<account-subdomain>.workers.dev/api/health
curl -i "https://<worker-name>.<account-subdomain>.workers.dev/api/captures?domain=example.com"
curl -i "https://<worker-name>.<account-subdomain>.workers.dev/api/captures?domain=mozilla.org"
```

Record the public URL, response codes, approximate latency, and any redirect, 403, or 429 behavior in `docs/DATA_SOURCES.md`. A healthy endpoint alone does not prove archive access; at least one authentic CDX response must be observed before Phase 1 begins.

If the archive request fails from Cloudflare, do not route around restrictions through unapproved proxies. Preserve the visible error and evaluate documented alternatives.

## One-time screenshot setup

`wrangler.jsonc` defines the native `BROWSER` binding used by Cloudflare Browser Run Quick Actions. The configured compatibility date is newer than the documented `2026-03-24` minimum, and remote binding mode allows `wrangler dev` to reach the real service when explicitly exercised. Browser Run is not called by builds or automated tests.

Set a strong owner token once, using either the Cloudflare dashboard's encrypted Variables and Secrets control or Wrangler's interactive prompt:

```bash
npx wrangler secret put SCREENSHOT_ACCESS_TOKEN
```

Do not commit the value to this repository or place it in a URL. The UI sends it only in `X-Screenshot-Token` and clears the field after each attempt. Cloudflare Workers Free currently allows 10 browser minutes per day and one Quick Action every 10 seconds, so keep smoke testing to one known capture.

After an owner-authorized deployment, verify the endpoint without putting the token in the URL:

```bash
read -s SCREENSHOT_TOKEN
curl -D screenshot.headers -o screenshot.png \
  -X POST "https://<worker-name>.<account-subdomain>.workers.dev/api/screenshot" \
  -H "Content-Type: application/json" \
  -H "X-Screenshot-Token: ${SCREENSHOT_TOKEN}" \
  --data '{"domain":"yahoo.com","year":1999}'
unset SCREENSHOT_TOKEN
```

Expect an image response for a verified capture, `401` for a wrong token, `503 SCREENSHOT_DISABLED` when the secret or binding is unavailable, and explicit archive or Browser Run errors otherwise. The official references are [Browser Run setup](https://developers.cloudflare.com/browser-run/get-started/), [screenshot options](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/), and [limits](https://developers.cloudflare.com/browser-run/limits/).

## Phase 3A — screenshot persistence (owner setup required)

1. Enable **R2** for the Cloudflare account, checking any required billing/activation steps in the dashboard first. R2 Standard has a free monthly allowance; beyond it usage may incur charges. See [current R2 pricing](https://developers.cloudflare.com/r2/pricing/).
2. Using the same logged-in Wrangler account that owns IAM, create the bucket **before merging/deploying the code that binds it**:

   ```powershell
   npx wrangler@4 r2 bucket create internet-archaeology-machine-screenshots
   npx wrangler@4 r2 bucket list
   ```

3. `wrangler.jsonc` contains `r2_buckets: [{ binding: "SCREENSHOTS", bucket_name: "internet-archaeology-machine-screenshots" }]`. When the PR merges, Cloudflare Workers Builds deploys the Worker from `main` and attaches this binding. Do not put R2 access keys or owner tokens in GitHub. The Worker uses the bound bucket directly, not R2 S3 credentials.
4. Verify the Worker has **both** `BROWSER` and `SCREENSHOTS` bindings and the existing encrypted `SCREENSHOT_ACCESS_TOKEN` secret. Don't replace or share the existing owner token.
5. Select a verified year whose image has never been saved. A public GET should return **404** for its exact timestamp, not generate anything. With the owner token, generate **one** screenshot. The screenshot should save to R2 and the response header should say `X-IAM-Screenshot-Source: generated`. Refresh the page without a token; the saved image should appear automatically, with no Browser Run usage. Repeating an owner request should say `cached`.
6. Check the bucket's **Objects** view to verify a new key under `screenshots/toolbarless-v1-1280x900/<domain>/<timestamp>.png`. Do not make R2 bucket public: all reads go through the validated Worker API.

### Privacy, costs and failure behaviour

- Public `GET /api/screenshot?domain=<domain>&year=<yyyy>&timestamp=<14-digit CDX timestamp>` is read-only and bounded to a validated hostname/year/timestamp. It does not call CDX or Browser Run. A cache miss is 404. If R2 isn't connected, it returns 503.
- Only authenticated owner `POST /api/screenshot` can create objects, after verifying the CDX capture and checking for an R2 hit. Requests without the configured bucket fail *before* browser generation, preventing throwaway images.
- Each object stores the verified *CDX capture* timestamp, requested year, replay URL and rendering-version metadata. This does **not** assert the screenshot's rendered content is from that date; Wayback redirects/late assets remain possible.
- An image generated **before Phase 3A** is not imported automatically. Regenerate it once if you want public reuse.
- R2 operations and storage count towards the account's usage; owner-only generation, exact-key reads and no bulk crawling keep the workload bounded. The current approach uses R2 object metadata, not a separate D1 database.


## Phase 4 — Self-service screenshots

The repo now adds a SQLite-backed Durable Object named `ScreenshotBudget`, bound as `SCREENSHOT_BUDGET`. Wrangler automatically provisions it via the `exports` block on the first deployment; no separate R2 bucket or new secret is required. Durable Objects are supported on Workers Free plans, but on paid plans usage beyond included allowances can cost money. Review [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) before enabling public traffic.

The new production main entry point is `src/worker/entry.ts` so the handler and Durable Object RPC class are exported together. The existing `BROWSER`, `SCREENSHOTS` and encrypted `SCREENSHOT_ACCESS_TOKEN` bindings are all still needed.

**Initial limits:** six public screenshot attempts site-wide per UTC day, two attempts per trusted Cloudflare visitor IP per UTC day, one active render, and a 15-second spacing between attempted renders. Attempts count even when Browser Run or the Wayback replay fails. A 90-second durable lease survives Worker process changes and prevents repeated captures. The owner may still generate missing screenshots, using the existing curator session, but those requests share the global active lease and cooldown.

**Public smoke test** (after CI and deployment):
1. Open an archived year with no screenshot while signed out. The action should offer **Show this snapshot**, not request a secret.
2. Click it once. Confirm the returned PNG is saved under `screenshots/toolbarless-v1-1280x900/` in R2.
3. Refresh and select the same year. It should load automatically from R2, with no new Browser Run request or quota usage.
4. Select a different uncached year and try generating again. After two attempts from the same visitor in one UTC day, further missing captures should produce `429 VISITOR_BUDGET_EXHAUSTED`. A temporarily active screenshot should produce `429 SCREENSHOT_BUSY` with `Retry-After`.
5. Check that wrong/mismatched timestamps produce `409 SCREENSHOT_CAPTURE_CHANGED` and **do not** generate an image. This verifies a current CDX match, but cannot detect Wayback navigation to another archive date inside the browser.
6. Confirm owner authentication remains functional and public GET cached images work if `PUBLIC_SCREENSHOTS_ENABLED` is disabled.

**Important limitations:** IP-based throttling is a cost guard, not bot-proof authentication. Proxies can share or change IPs. The daily cap is also not a strict browser-minutes cap — an individual request's duration may vary. Keep an eye on Browser Run usage and optionally add Cloudflare Turnstile, WAF rules or stricter limits before promoting the app heavily. Never accept a screenshot URL from visitors; only the CDX-verified replay is rendered.

**Emergency stop:** set `PUBLIC_SCREENSHOTS_ENABLED` to `false` in Wrangler config and redeploy. Cached screenshots and curator actions remain available. Do not remove the Durable Object binding without considering the budget state and in-progress requests.


## Phase 5 — Surprise Me smoke test

No new bindings or secrets. `GET /api/surprise` reads the existing `SCREENSHOTS` R2 bucket with `list({ prefix, include: ['customMetadata'] })` and returns one or two **already stored** screenshots from a single domain. The list scan is capped at three pages of 200 objects, with an explicit `inventoryPartial` flag when more objects are available. Screenshots without valid provenance metadata are skipped. The endpoint never calls CDX, Browser Run or the Durable Object quota coordinator.

After deployment, click **Surprise me** on the public homepage. Confirm it shows real saved images and exact archive timestamps, source links open Wayback, **Find another** changes the domain when alternatives are available, and **Explore this website's history** starts a regular site search. A collection with only one cached year should show just one panel. Empty collection returns a helpful `404 SURPRISE_EMPTY` rather than fabricated history. Check browser Network: `/api/surprise` and cached image GETs are allowed; there should be no `/api/screenshot/request` or Browser Run requests.

R2 object listing consumes Class A operations, so this version is intended for a modest-sized cache. If the collection becomes large or popular, add a curated indexed discovery manifest or a separate metadata index before increasing the pagination bound.
