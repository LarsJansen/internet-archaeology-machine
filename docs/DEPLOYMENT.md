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
