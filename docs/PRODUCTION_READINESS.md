# Production readiness review

Review date: 2026-08-27

## Outcome

CFP Radar is suitable for an always-on Render web service. The request path reads vetted local snapshots; broad discovery, deadline verification, and historical-paper ingestion remain scheduled GitHub Actions jobs. The review intentionally did not change ranking, admission, deadline, deduplication, or discovery semantics.

## Security review

- Outbound user-controlled URLs are restricted to HTTP(S), standard ports, public resolved addresses, and revalidated redirects. Connections are pinned to the checked DNS answers to reduce DNS-rebinding risk.
- PDF uploads and remote responses have byte limits; PDFs also have signature and page-count limits.
- Untrusted paper and web text is delimited before being included in prompts.
- Expensive browser endpoints enforce same-site/origin checks and rate limits. The administrative batch endpoint requires a configured bearer token.
- External links are sanitized before they reach API output, framing is denied, MIME sniffing is disabled, and production responses use HSTS and a restrictive CSP.
- GitHub Actions dependencies are commit-SHA pinned. Install/audit steps run before secrets are exposed, and write workflows share a concurrency lock.
- Dependency overrides pin patched `postcss`, `nanoid`, and `js-yaml` releases.

## Deployment and architecture review

- Render uses a paid Starter instance, an explicit Node 20 runtime, a health check, graceful shutdown time, and immutable lockfile installation.
- `/api/health` checks that the packaged CFP snapshot can be read without calling any third-party service.
- The app binds to `0.0.0.0`; Render provides `PORT` to Next.js automatically.
- Scheduled discovery remains in GitHub Actions every two days. A failed provider cannot force a broad scrape during a page request or erase the last-good OpenReview snapshot.
- Optional PostgreSQL support is available for venue history. The packaged JSON snapshot remains the safe single-instance default.

## Capacity and residual risks

The initial paid single-instance deployment avoids free-tier cold starts and is appropriate for the current static-snapshot-heavy workload. Horizontal scaling is not yet safe for global AI quotas because the rate limiter is held in each process. Before materially increasing instance count or opening AI tools to heavy anonymous use:

1. move rate-limit counters to a shared Redis-compatible store;
2. add authenticated per-user quotas and provider spend alerts;
3. move large catalog/history responses behind a CDN or split them into paginated endpoints;
4. use managed PostgreSQL for mutable shared data; and
5. add external uptime, latency, error-rate, and LLM-cost monitoring.

The CSP permits inline scripts/styles because the current Next.js theme bootstrap and component styling require them. Removing those allowances requires a nonce-based rendering change and should be treated as a separate, regression-tested hardening project.

## Verification

Run before each production release:

```bash
npm ci
npm audit
npm test
npm run lint
npm run build
```
