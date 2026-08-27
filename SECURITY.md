# Security notes

## Current protections

- User-supplied paper and reference URLs accept only HTTP(S), standard web ports,
  public DNS/IP destinations, and a limited number of validated redirects.
- Uploads and remote responses have hard byte limits. Uploaded and downloaded PDFs
  must have a PDF signature and are limited to 250 pages.
- Expensive AI and deep-verification routes use per-IP, per-instance rate limits
  and reject browser requests originating from another site.
- The bulk deadline-verification API is disabled unless `PIPELINE_ADMIN_TOKEN` is
  configured and supplied as `Authorization: Bearer <token>` or
  `x-cfp-admin-token`.
- Security headers deny framing, sniffing, plugins, and unnecessary browser
  permissions. The production build does not expose the `X-Powered-By` header.
- Custom LLM endpoints are ignored unless `ALLOW_CUSTOM_LLM_BASE_URL=1`; when
  enabled, only credential-free HTTPS URLs are accepted.
- Remote-fetch validation rejects private IPv4 ranges, IPv4-mapped IPv6,
  IPv4-compatible IPv6, NAT64, 6to4, Teredo, local/link-local ranges, and unsafe
  redirect targets. Connections are pinned to the public DNS answers that were
  checked, preventing DNS-rebinding between validation and the request.
- GitHub Actions dependencies use immutable commit SHAs. Workflows that install
  dependencies run `npm audit` before receiving any repository secret, and all
  jobs that write shared data use one concurrency lock. Checkout does not persist
  a write credential; the short-lived GitHub token exists only in the final commit
  step.
- Venue-history tables have Row Level Security enabled with no public policy and
  public table privileges revoked. Only the backend database owner/service role
  should receive `DATABASE_URL`.

## Deployment limitation

The built-in rate limiter is intentionally dependency-free and stores counters in
each running server instance. This is appropriate for the current small deployment,
but it is not a global quota across multiple Render/Vercel instances. Before opening
the AI tools to a large public audience, replace it with a shared limiter such as
Redis/Upstash and consider per-user quotas. No login is currently required, by
product choice, so determined distributed abuse cannot be fully prevented.

## Secrets

Keep `.env.local` and deployment secrets out of source control. Rotate any API key
that is accidentally pasted into a ticket, screenshot, commit, or public log. Set a
long random `PIPELINE_ADMIN_TOKEN` only if the administrative HTTP endpoint is
needed; scheduled scripts do not require it. Repository secrets are scoped only to
the workflow steps that call their provider and are not available to `npm ci`.

## Verification commands

```bash
npm audit
npm run lint
npm run test:security
npm run build
```
