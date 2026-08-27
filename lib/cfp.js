import fs from "node:fs";
import path from "node:path";
import { readCatalogConfig } from "./catalogConfig.js";
import { primaryCfpUrl, safeExternalUrl, sanitizeExternalUrlFields } from "./cfpLinks.js";
import { isCallActive } from "./callLifecycle.js";
import { dedupeCalls } from "./dedupeCalls.js";
import { groupOpenReviewEntries } from "./openreviewDirectory.js";
import { mergeOpenReviewIntoStore } from "./openreviewLive.js";
import {
  applyConferenceRanking,
  createConferenceRankIndex,
  findConferenceRanking,
} from "./conferenceRankings.js";
import { venueHistoryEnabled } from "./venue-history/config.js";
import { resolveVenueIdentity } from "./venue-history/identity.js";
import { historyCoverageMap } from "./venue-history/jsonRepository.js";

const DATA_PATH = path.join(process.cwd(), "data", "cfps.json");
const OPENREVIEW_SNAPSHOT_PATH = path.join(process.cwd(), "data", "openreview-last-good.json");
const RANKING_SNAPSHOT_PATH = path.join(process.cwd(), "data", "icore-2026-conferences.json");
const RANKING_CONFIG_PATH = path.join(process.cwd(), "data", "ranking-sources.json");
const CACHE_TTL_MS = 5_000;
let storeCache = null;
let snapshotCache = null;
let rankingSnapshotCache = null;
let rankingConfigCache = null;

function readJsonCached(filePath, previous, fallback) {
  const now = Date.now();
  if (previous && now - previous.checkedAt < CACHE_TTL_MS) return previous;
  try {
    const modifiedAt = fs.statSync(filePath).mtimeMs;
    if (previous && previous.modifiedAt === modifiedAt) return { ...previous, checkedAt: now };
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), modifiedAt, checkedAt: now };
  } catch {
    return { value: fallback, modifiedAt: null, checkedAt: now };
  }
}

function sanitizeCfpLinks(item) {
  const safe = sanitizeExternalUrlFields(item, [
    "url",
    "cfpUrl",
    "officialCfpUrl",
    "submissionUrl",
    "templateUrl",
    "openreviewUrl",
    "conferenceRankingUrl",
  ]);
  if (item.links && typeof item.links === "object") {
    const call = safeExternalUrl(item.links.call);
    safe.links = { ...item.links };
    if (call) safe.links.call = call;
    else delete safe.links.call;
  }
  safe.openreviewLinks = (item.openreviewLinks || [])
    .map((link) => ({ ...link, url: safeExternalUrl(link?.url) }))
    .filter((link) => link.url);
  safe.openreviewDeadlines = (item.openreviewDeadlines || []).map((row) => ({
    ...row,
    links: (row.links || [])
      .map((link) => ({ ...link, url: safeExternalUrl(link?.url) }))
      .filter((link) => link.url),
  }));
  return safe;
}

/** Read the raw CFP store from disk. */
export function readStore() {
  storeCache = readJsonCached(DATA_PATH, storeCache, { updatedAt: null, source: "empty", items: [] });
  return storeCache.value;
}

/**
 * Return only CFPs whose deadline has NOT passed.
 * Expiration uses the exact instant, including timezone. The scheduled pruning
 * job also removes closed calls from the live store and archives them.
 */
export function getActiveCFPs(now = new Date()) {
  const store = readStore();
  const catalog = readCatalogConfig();
  let sourceItems = store.items || [];
  let openreviewSync = store.openreviewSync || null;

  // The snapshot is an independent recovery layer. If a later pipeline stage
  // accidentally rewrites cfps.json without its OpenReview mirror, the API can
  // still reconstruct those cards without making slow network calls in a page
  // request. Exact-time lifecycle filtering below removes expired snapshot rows.
  try {
    snapshotCache = readJsonCached(OPENREVIEW_SNAPSHOT_PATH, snapshotCache, { entries: [] });
    const snapshot = snapshotCache.value;
    const entries = (snapshot.entries || []).filter((entry) =>
      entry.deadline && new Date(entry.deadline).getTime() > now.getTime()
    );
    if (entries.length) {
      const recovered = mergeOpenReviewIntoStore(sourceItems, {
        ...snapshot,
        entries,
        groups: groupOpenReviewEntries(entries),
        complete: false,
        checkedAt: snapshot.checkedAt || store.updatedAt || now.toISOString(),
        source: `${snapshot.source || "openreview-snapshot"}-api-recovery`,
        cache: "disk-snapshot",
      });
      sourceItems = recovered.items;
      const storedTime = new Date(openreviewSync?.checkedAt || 0).getTime();
      const snapshotTime = new Date(snapshot.checkedAt || 0).getTime();
      if (!openreviewSync || snapshotTime >= storedTime) openreviewSync = { ...recovered.sync, phase: "API snapshot recovery" };
    }
  } catch { /* The persisted CFP store remains available without a snapshot. */ }

  // Rank recovery is also applied at read time so OpenReview cards reconstructed
  // from the last-good snapshot receive the same ranking as persisted cards.
  try {
    rankingSnapshotCache = readJsonCached(RANKING_SNAPSHOT_PATH, rankingSnapshotCache, { conferences: [] });
    rankingConfigCache = readJsonCached(RANKING_CONFIG_PATH, rankingConfigCache, { sources: [] });
    const rankGroups = rankingConfigCache.value.sources?.find((source) => source.key === "ICORE2026")?.rankGroups || {};
    const rankIndex = createConferenceRankIndex(rankingSnapshotCache.value.conferences || [], rankGroups);
    sourceItems = sourceItems.map((item) =>
      applyConferenceRanking(item, findConferenceRanking(item, rankIndex))
    );
  } catch { /* Ranking is an enhancement; CFP lifecycle remains available without it. */ }

  const includeVenueHistory = venueHistoryEnabled();
  const coverage = includeVenueHistory ? historyCoverageMap() : new Map();
  const activeItems = dedupeCalls(sourceItems.filter((item) => isCallActive(item, now))).items
    .map(sanitizeCfpLinks)
    .map((item) => {
      if (!includeVenueHistory) return item;
      const venueId = resolveVenueIdentity(item);
      return venueId ? { ...item, venueId, historyCoverage: coverage.get(venueId) || null } : item;
    });
  const workshopLinkCounts = new Map();
  for (const item of activeItems) {
    if (item.type !== "workshop") continue;
    const url = primaryCfpUrl(item, catalog.linkPolicy);
    if (url) workshopLinkCounts.set(url, (workshopLinkCounts.get(url) || 0) + 1);
  }
  const items = activeItems.map((item) => {
    const resolvedCfpUrl = primaryCfpUrl(item, catalog.linkPolicy);
    const cfpLinkKind = item.type === "workshop" && workshopLinkCounts.get(resolvedCfpUrl) > 2
      ? "workshop-directory"
      : item.type;
    return { ...item, resolvedCfpUrl, cfpLinkKind };
  });

  // Soonest deadline first; rolling (no deadline) sinks to the bottom.
  items.sort((a, b) => {
    const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return ad - bd;
  });

  if (!openreviewSync) {
    const mirroredEntries = items.filter((item) => item.source === "openreview" || item.openreviewMirror).length;
    openreviewSync = {
      checkedAt: null,
      mirroredEntries,
      groupedCards: mirroredEntries,
      source: "stored-items-only",
      warning: "No successful OpenReview homepage snapshot has been persisted yet.",
    };
  }
  return { updatedAt: store.updatedAt, source: store.source, count: items.length, openreviewSync, catalog, items };
}

/** Compact one-line summary of a venue, used as LLM context. */
export function venueContextLine(c) {
  const topics = (c.topics || []).join(", ");
  const fmt = c.format || {};
  const fmtStr = [
    fmt.style ? `style=${fmt.style}` : null,
    fmt.pageLimit ? `pageLimit=${fmt.pageLimit}` : null,
    typeof fmt.anonymized === "boolean" ? `anonymized=${fmt.anonymized}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  // Journal metrics so the model can weigh fit vs. impact, speed and cost.
  const m = c.metrics || {};
  const metricStr = [
    m.impactFactor ? `IF=${m.impactFactor}` : null,
    m.citeScore ? `CiteScore=${m.citeScore}` : null,
    m.subToFirstDecision ? `first-decision=${m.subToFirstDecision}` : null,
    m.acceptanceToPub ? `accept-to-pub=${m.acceptanceToPub}` : null,
    m.acceptanceRate ? `acceptance=${m.acceptanceRate}` : null,
    m.apc ? `APC=${m.apc}` : null,
    m.openAccess ? `OA=${m.openAccess}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const metrics = metricStr ? ` | metrics: ${metricStr}` : "";
  const pub = c.publisher ? ` | publisher=${c.publisher}` : "";
  const legit = c.legitimacy || {};
  const legitimacy = ` | legitimacy=${legit.level || "unverified"}` +
    (legit.proceedings?.corroboratedSources ? `; proceedingsSources=${legit.proceedings.corroboratedSources}; priorYears=${legit.proceedings.editionsFound || 0}` : "") +
    (legit.parentConference?.confirmed ? "; officialParentListing=true" : "") +
    (legit.publisherEvidence?.currentEditionConfirmed ? "; currentPublisherConfirmed=true" : "") +
    (legit.ranking?.scimago?.confirmed ? `; scimago=${legit.ranking.scimago.quartile || "listed"}` : "");
  return `[${c.id}] ${c.acronym} — ${c.name} | type=${c.type} | domain=${c.domain} | tier=${c.tier || "n/a"}${pub} | topics: ${topics} | deadline=${c.deadline || "rolling"} | format: ${fmtStr}${metrics}${legitimacy} | template=${c.templateUrl || "n/a"}`;
}
