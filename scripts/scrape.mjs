#!/usr/bin/env node
/**
 * Two-phase OpenReview synchronization.
 *
 * Phase 1 is intentionally fast and authoritative: read the homepage's
 * "Open for Submissions" section and persist every listed call immediately.
 * Phase 2 enriches those cards with official CFP links/deadlines. If phase 2
 * fails or times out, phase 1 remains safely persisted so the UI never falls
 * back to the old curated-only count.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchOpenReviewHomepageSnapshot,
  fetchOpenReviewDirectoryLive,
  mergeOpenReviewIntoStore,
} from "../lib/openreviewLive.js";
import { groupOpenReviewEntries } from "../lib/openreviewDirectory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "data", "cfps.json");
const SNAPSHOT_PATH = path.join(ROOT, "data", "openreview-last-good.json");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function persist(store, live, phase) {
  const merged = mergeOpenReviewIntoStore(store.items || [], live);
  const next = {
    ...store,
    updatedAt: live.checkedAt,
    source: `${store.source || "curated"} + OpenReview ${phase}`,
    openreviewSync: {
      ...merged.sync,
      phase,
      checkedAt: live.checkedAt,
      warning: live.warning || null,
    },
    items: merged.items,
  };
  writeJSON(DATA_PATH, next);
  return next;
}

async function main() {
  let store = readJSON(DATA_PATH, { updatedAt: null, source: "seed", items: [] });

  // Phase 1: persist all homepage calls before any expensive enrichment.
  let snapshot;
  try {
    snapshot = await fetchOpenReviewHomepageSnapshot({ force: true });
    if (snapshot.entries.length) writeJSON(SNAPSHOT_PATH, snapshot);
  } catch (error) {
    const previous = readJSON(SNAPSHOT_PATH, null);
    const entries = (previous?.entries || []).filter((entry) =>
      entry.deadline && new Date(entry.deadline).getTime() > Date.now()
    );
    if (!entries.length) throw error;
    snapshot = {
      ...previous,
      entries,
      groups: groupOpenReviewEntries(entries),
      complete: false,
      checkedAt: new Date().toISOString(),
      source: "openreview-last-good-current-fallback",
      warning: `Live OpenReview fetch failed; retained ${entries.length} still-open calls from the last-good snapshot.`,
    };
  }
  store = persist(store, snapshot, "homepage snapshot");
  console.log(`OpenReview phase 1 persisted: ${snapshot.entries.length} calls, ${snapshot.groups.length} grouped cards, ${store.items.length} total venues.`);

  // Phase 2: best-effort official CFP enrichment. Never erase phase 1 on error.
  if (process.env.OPENREVIEW_SKIP_ENRICHMENT === "1") return;
  try {
    const enriched = await fetchOpenReviewDirectoryLive({ force: true, snapshot });
    store = persist(store, enriched, "official CFP enriched");
    console.log(`OpenReview phase 2 enriched: ${enriched.entries.length} calls, ${enriched.groups.length} grouped cards, ${store.items.length} total venues.`);
  } catch (error) {
    console.warn(`OpenReview enrichment deferred: ${error.message}. Homepage snapshot remains persisted.`);
  }
}

main().catch((error) => {
  console.error(`OpenReview homepage sync failed: ${error.message}`);
  process.exit(1);
});
