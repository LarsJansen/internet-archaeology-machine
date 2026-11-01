# Deployment preparation

Phase 0 does not deploy. The repository contains everything needed for an owner-authorized Cloudflare Workers deployment after this pull request is reviewed.

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
6. Do not add runtime secrets; Phase 0 requires none.
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
