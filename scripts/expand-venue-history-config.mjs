#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getActiveCFPs } from "../lib/cfp.js";
import { fetchRemote, readResponseText } from "../lib/safeFetch.js";

const POLICY_PATH = path.join(process.cwd(), "data", "venue-history-expansion-policy.json");
const MANUAL_CONFIG_PATH = path.join(process.cwd(), "data", "venue-history-config.json");
const WATCHLIST_PATH = path.join(process.cwd(), "data", "watchlist.json");
const OUTPUT_PATH = path.join(process.cwd(), "data", "venue-history-catalog.json");
const CROSSREF_BASE = "https://api.crossref.org";
let lastRequestAt = 0;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalJournalQuery(call) {
  return String(call.name || "")
    // Dashboard names sometimes add a publisher or common acronym in a final
    // parenthetical. Crossref stores the canonical journal title without it.
    .replace(/\s*\([^)]{1,40}\)\s*$/i, "")
    .trim();
}

function publisherMatches(callPublisher, registryPublisher, patterns) {
  const registry = normalize(registryPublisher);
  const allowed = patterns[callPublisher] || [];
  return allowed.some((pattern) => registry.includes(normalize(pattern)));
}

function validIssn(value) {
  return /^\d{4}-\d{3}[\dX]$/i.test(String(value || ""));
}

function nameTokens(value) {
  const ignored = new Set(["acm", "ieee", "international", "conference", "annual", "symposium", "workshop", "on", "of", "the", "and", "for"]);
  return new Set(normalize(value).split(" ").filter((token) => token.length > 1 && !ignored.has(token)));
}

function tokenScore(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.min(a.size, b.size);
}

function dblpStream(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/db\/(conf\/[^/]+)\/?$/i);
    return match?.[1].toLowerCase() || null;
  } catch {
    return null;
  }
}

function discoverConferences(active, watchlist, policy, excludedCallIds) {
  const venues = [];
  const rejections = [];
  for (const call of active.filter((entry) => entry.type === "conference" && policy.enabled && policy.ranks.includes(entry.conferenceRank || entry.tier))) {
    if (excludedCallIds.has(call.id)) continue;
    const acronym = normalize(call.acronym);
    const candidates = (watchlist.conferences || [])
      .filter((entry) => normalize(entry.acronym) === acronym && dblpStream(entry.dblpUrl))
      .map((entry) => ({ entry, score: tokenScore(call.name, entry.name) }))
      .filter(({ score }) => score >= Number(policy.minimumNameTokenScore || 0.6))
      .sort((a, b) => b.score - a.score);
    if (candidates.length !== 1 || (candidates[1] && candidates[0].score === candidates[1].score)) {
      rejections.push({ callId: call.id, name: call.name, reason: "no-unique-exact-ranked-dblp-match" });
      continue;
    }
    const match = candidates[0].entry;
    venues.push({
      id: call.id.replace(/-(?:19|20)\d{2}(?:-.*)?$/, "") || call.id,
      canonicalName: match.name,
      acronym: match.acronym,
      venueType: "conference",
      status: "active",
      officialUrl: call.url || call.cfpUrl,
      match: { callIds: [call.id], names: [call.name, match.name] },
      externalIds: { dblpStream: dblpStream(match.dblpUrl), rankingId: match.rankingId || null },
      historyStartYear: Number(policy.historyStartYear),
      historyEndYear: Number(policy.historyEndYear),
      registryVerification: {
        source: "Exact ranked name plus configured DBLP stream",
        rankingUrl: match.rankingUrl || null,
        dblpUrl: match.dblpUrl,
        nameTokenScore: candidates[0].score,
      },
    });
  }
  return { venues, rejections };
}

async function crossrefJson(url) {
  const mailto = process.env.CROSSREF_MAILTO;
  if (mailto) url.searchParams.set("mailto", mailto);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waitMs = Math.max(0, 400 - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
    const { response } = await fetchRemote(url, {
      timeoutMs: 45_000,
      headers: {
        Accept: "application/json",
        "User-Agent": `CFP-Radar-HistoryCatalog/1.0${mailto ? ` (mailto:${mailto})` : ""}`,
      },
    });
    if (response.ok) return JSON.parse(await readResponseText(response, 4 * 1024 * 1024));
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    if (status !== 429 && status < 500) throw new Error(`Crossref journal search failed (HTTP ${status}).`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 1_000 * 2 ** attempt)));
  }
  throw new Error("Crossref journal search did not recover after retries.");
}

async function resolveJournal(call, policy) {
  const query = canonicalJournalQuery(call);
  const url = new URL(`${CROSSREF_BASE}/journals`);
  url.searchParams.set("query", query);
  url.searchParams.set("rows", "8");
  const data = await crossrefJson(url);
  const exactTitle = normalize(query);
  const matches = (data?.message?.items || []).filter((record) =>
    normalize(record.title) === exactTitle
    && publisherMatches(call.publisher, record.publisher, policy.publisherPatterns)
    && (record.ISSN || []).some(validIssn)
    && Number(record.counts?.["total-dois"] || 0) >= Number(policy.minimumRegisteredDois || 1)
  );
  if (matches.length !== 1) {
    return {
      rejection: {
        callId: call.id,
        name: call.name,
        publisher: call.publisher || null,
        reason: matches.length ? "ambiguous-exact-registry-match" : "no-exact-title-publisher-issn-match",
        registryCandidates: (data?.message?.items || []).slice(0, 3).map((record) => ({
          title: record.title,
          publisher: record.publisher,
          issns: record.ISSN || [],
        })),
      },
    };
  }
  const record = matches[0];
  const issns = [...new Set((record.ISSN || []).filter(validIssn))].sort();
  return {
    venue: {
      id: call.id,
      canonicalName: record.title,
      acronym: call.acronym || record.title,
      venueType: "journal",
      historyProvider: "crossref-journal",
      status: "active",
      publisher: call.publisher || record.publisher,
      officialUrl: call.url || call.cfpUrl,
      match: {
        callIds: [call.id],
        names: [call.name, record.title].filter(Boolean),
      },
      externalIds: { issns },
      historyStartYear: Number(policy.historyStartYear),
      historyEndYear: Number(policy.historyEndYear),
      maxPapersPerYear: Number(policy.maxPapersPerYear),
      coverageMode: "representative",
      registryVerification: {
        source: "Crossref exact title, publisher, and ISSN",
        registryPublisher: record.publisher,
        registeredDois: Number(record.counts?.["total-dois"] || 0),
        url: `${CROSSREF_BASE}/journals/${encodeURIComponent(issns[0])}`,
      },
    },
  };
}

function writeAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function mergeExactVenue(existing, next) {
  if (!existing) return next;
  const match = { ...(existing.match || {}), ...(next.match || {}) };
  for (const key of ["callIds", "names", "acronyms", "openreviewSeries"]) {
    const values = [...new Set([...(existing.match?.[key] || []), ...(next.match?.[key] || [])].filter(Boolean))];
    if (values.length) match[key] = values;
  }
  return { ...existing, ...next, match };
}

function mergeCatalogVenues(...groups) {
  const venues = new Map();
  for (const venue of groups.flat()) {
    if (!venue?.id) continue;
    venues.set(venue.id, mergeExactVenue(venues.get(venue.id), venue));
  }
  return [...venues.values()].sort((a, b) => a.venueType.localeCompare(b.venueType) || a.id.localeCompare(b.id));
}

async function main() {
  const policy = readJson(POLICY_PATH);
  const manual = readJson(MANUAL_CONFIG_PATH);
  const watchlist = readJson(WATCHLIST_PATH);
  const manualCallIds = new Set((manual.venues || []).flatMap((venue) => venue.match?.callIds || []));
  const curatedCallIds = new Set((policy.curatedVenues || []).flatMap((venue) => venue.match?.callIds || []));
  const active = getActiveCFPs(new Date()).items || [];
  const conferenceResult = discoverConferences(active, watchlist, policy.conferences || {}, new Set([...manualCallIds, ...curatedCallIds]));
  const previous = fs.existsSync(OUTPUT_PATH) ? readJson(OUTPUT_PATH) : { venues: [], rejections: [] };
  const retainedConferences = (previous.venues || []).filter((venue) =>
    venue.venueType === "conference"
    && venue.registryVerification?.source === "Exact ranked name plus configured DBLP stream"
  );
  const journalPolicy = policy.journals || {};
  const candidates = active.filter((call) =>
    journalPolicy.enabled
    && call.type === "journal"
    && journalPolicy.tiers.includes(call.tier)
    && !manualCallIds.has(call.id)
    && !curatedCallIds.has(call.id)
    && journalPolicy.publisherPatterns[call.publisher]
  );
  let discovered = [];
  let rejections = [];
  if (process.argv.includes("--reuse-journals") && fs.existsSync(OUTPUT_PATH)) {
    discovered = (previous.venues || []).filter((venue) => venue.venueType === "journal");
    rejections = (previous.rejections || []).filter((entry) => candidates.some((call) => call.id === entry.callId));
    console.log(`Reused ${discovered.length} already verified journal identities.`);
  } else {
    for (const [index, call] of candidates.entries()) {
      try {
        const result = await resolveJournal(call, journalPolicy);
        if (result.venue) discovered.push(result.venue);
        else rejections.push(result.rejection);
      } catch (error) {
        rejections.push({ callId: call.id, name: call.name, publisher: call.publisher || null, reason: error.message });
      }
      console.log(`[${index + 1}/${candidates.length}] ${call.id}: ${discovered.at(-1)?.id === call.id ? "verified" : "not admitted"}`);
    }
  }
  // Venue history survives the current CFP card. Keep previously proven ranked
  // conference identities and merge later call IDs into the same stable venue.
  const venues = mergeCatalogVenues(
    retainedConferences,
    conferenceResult.venues,
    discovered,
    // Explicit curated identities win if an automatically generated ID ever
    // collides, while mergeExactVenue still retains exact historical aliases.
    policy.curatedVenues || [],
  );
  writeAtomic(OUTPUT_PATH, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "exact-authority-history-catalog",
    policy: {
      journalTiers: journalPolicy.tiers,
      exactJournalIdentity: "normalized title + configured publisher family + Crossref ISSN",
      curatedIdentity: "exact DBLP stream or ACL Anthology event",
    },
    counts: {
      curated: (policy.curatedVenues || []).length,
      verifiedGeneratedConferences: conferenceResult.venues.length,
      retainedGeneratedConferences: retainedConferences.length,
      rejectedConferenceCandidates: conferenceResult.rejections.length,
      journalCandidates: candidates.length,
      verifiedJournals: discovered.length,
      rejectedJournals: rejections.length,
    },
    venues,
    rejections: [...conferenceResult.rejections, ...rejections],
  });
  console.log(`Wrote ${venues.length} catalog venues (${discovered.length}/${candidates.length} journals verified; ${rejections.length} rejected).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export const __test = {
  normalize,
  canonicalJournalQuery,
  publisherMatches,
  validIssn,
  tokenScore,
  dblpStream,
  mergeCatalogVenues,
};
