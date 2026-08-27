# Official workshop discovery architecture

OpenReview is not used as a runtime or discovery dependency.

## Sources

1. `data/watchlist.json` — established conferences and journals.
2. `data/workshop-sources.json` — parent conference families whose official workshop/satellite pages are monitored.
3. WikiCFP and general web discovery remain lead-only sources and still pass the existing legitimacy gate.

## Workshop agent

Run `npm run sync:workshops`.

The agent:

1. Resolves the official parent conference site or configured official workshop index.
2. Finds official workshop, challenge, shared-task, satellite-event and special-session links.
3. Opens each official workshop page.
4. Extracts track-specific submission deadlines.
5. Keeps only future submission calls.
6. Writes the official workshop page into `cfpUrl` and a submission portal into `submissionUrl` when available.
7. Refreshes matching curated cards instead of duplicating them.
8. Removes expired cards created by this agent only.

## Automation

`.github/workflows/pipeline.yml` runs every two days and executes:

- official workshop discovery,
- watchlist monitoring,
- CMT/EasyChair/HotCRP/custom CFP discovery,
- WikiCFP lead verification,
- deadline verification,
- legitimacy refresh.
