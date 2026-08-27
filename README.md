# CFP Radar

CFP Radar is an auto-updating research venue discovery platform for conferences, workshops, journals, special issues, book calls, workshop proposals, and reviewer opportunities. It combines verified deadline data with venue-history intelligence, paper-to-venue recommendations, and reference checking.

The production architecture keeps discovery work out of the page-request path: scheduled agents build vetted snapshots, while the Next.js application serves those snapshots quickly and predictably.

## What it does

- Tracks active calls with exact deadline and timezone-aware lifecycle handling.
- Separates paper CFPs, workshop-hosting calls, book/chapter proposals, and reviewer recruitment.
- Discovers calls through OpenReview, official venue sites, configured watchlists, publisher sources, and carefully gated external leads.
- Displays provenance, ranking, legitimacy, and verification evidence.
- Maps venues to verified prior editions and accepted papers.
- Recommends live venues for an uploaded paper and checks references using an optional LLM provider.
- Preserves last-good snapshots when an upstream provider is incomplete or unavailable.

## Architecture

```text
GitHub Actions (every 2 days)          Next.js web service (always on)
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ discover → verify → vet     │        │ pages + bounded API routes   │
│ dedupe → prune → snapshot   │───────▶│ read vetted JSON snapshots  │
│ venue-history sync          │ commit │ optional PostgreSQL history │
└─────────────────────────────┘        └──────────────────────────────┘
```

Broad network discovery never runs in response to a user opening the site. The scheduled pipeline is the data source of truth and commits refreshed artifacts only after its integrity tests pass.

## Local development

Requirements: Node.js 20 and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. The discovery dashboard works without an API key. AI-assisted recommendations and verification require a configured provider key.

The default model is Groq's `qwen/qwen3.8-27b`:

```env
LLM_PROVIDER=groq
LLM_MODEL=qwen/qwen3.8-27b
GROQ_API_KEY=
```

Never commit `.env.local` or real credentials.

## Quality checks

```bash
npm ci
npm audit
npm test
npm run lint
npm run build
```

The test suite covers ranking, discovery, OpenReview ingestion, workshop/book/reviewer calls, lifecycle rules, admission, deduplication, search, venue history, pipeline cadence, and security controls.

## Data pipeline

The primary workflow, [`.github/workflows/pipeline.yml`](.github/workflows/pipeline.yml), runs every two days and can also be triggered manually. It:

1. archives calls whose exact deadline passed;
2. synchronizes OpenReview and configured rankings;
3. discovers workshops, workshop proposals, book calls, reviewer calls, watchlist entries, and vetted web leads;
4. verifies deadlines and refreshes legitimacy evidence;
5. checks that every call family was refreshed;
6. resolves venue-history identities and fills missing history; and
7. commits changed data in one serialized write.

Useful local commands:

```bash
npm run scrape
npm run watchlist
npm run discover:web
npm run verify
npm run legitimacy
npm run sync:venue-history
```

Configuration lives under `data/`; discovery logic should not need edits when a source or monitored venue changes. Generated stores include `data/cfps.json`, `data/workshop-proposals.json`, `data/book-calls.json`, and `data/reviewer-calls.json`.

## Render deployment

The included [`render.yaml`](render.yaml) defines a paid Starter web service, a Node 20 runtime, immutable dependency installation, graceful shutdown, and `/api/health` monitoring.

1. Push the repository to GitHub.
2. In Render, create a Blueprint from the repository.
3. Supply `GROQ_API_KEY` as a secret when prompted. Do not put the key in `render.yaml`.
4. Apply the Blueprint and confirm `/api/health` returns `status: ok`.

The paid instance is intentional: Render free web services spin down when idle, whereas this service is designed to remain responsive. Autoscaling and multiple instances should be enabled only after moving the in-memory AI rate limiter to a shared store.

## Security model

- Outbound URLs are restricted to public HTTP(S) destinations and revalidated through redirects.
- DNS answers are checked and pinned to reduce server-side request forgery and DNS-rebinding risk.
- Uploads, remote responses, PDFs, and LLM outputs have hard limits.
- Expensive routes enforce origin checks and rate limits; administrative bulk verification requires a token.
- API output sanitizes external links, and production responses set CSP, HSTS, anti-framing, MIME-sniffing, and permissions headers.
- GitHub Actions dependencies are SHA-pinned and secrets are withheld until after dependency installation and audit.

See [`SECURITY.md`](SECURITY.md) for reporting and operational limitations and [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) for the audit outcome and scale-up checklist.

## Repository map

```text
app/                 Next.js pages and API routes
components/          UI components
lib/                 domain, ingestion, security, and LLM modules
scripts/             scheduled discovery and maintenance jobs
data/                source configuration and vetted snapshots
tests/               regression and security tests
migrations/          optional PostgreSQL schema
.github/workflows/    scheduled automation
docs/                architecture and operational notes
```

## Operational principles

- Official venue and publisher pages outrank aggregator data.
- A guessed future deadline is never presented as an open call.
- Partial provider failures preserve the last verified snapshot.
- External forms and social posts are leads, not legitimacy evidence.
- Scheduled jobs mutate data; user-facing requests do not launch broad discovery.

## License

No open-source license has been granted. All rights are reserved unless the repository owner adds a license file.
