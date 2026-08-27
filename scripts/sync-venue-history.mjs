#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readVenueHistoryConfig } from "../lib/venue-history/config.js";
import { syncDblpVenue } from "../lib/venue-history/providers/dblp.js";
import { syncCrossrefJournal } from "../lib/venue-history/providers/crossrefJournal.js";
import { syncAclAnthologyVenue } from "../lib/venue-history/providers/aclAnthology.js";
import { enrichPapersWithOpenAlex } from "../lib/venue-history/providers/openalex.js";
import { buildVenueInsights, classifyPaper } from "../lib/venue-history/taxonomy.js";
import { writeSnapshotToPostgres } from "../lib/venue-history/postgresWriter.js";
import { mapLimit } from "../lib/asyncPool.js";
import { getActiveCFPs } from "../lib/cfp.js";
import { resolveVenueIdentity } from "../lib/venue-history/identity.js";

const OUTPUT = path.join(process.cwd(), "data", "venue-history.json");
const COVERAGE_OUTPUT = path.join(process.cwd(), "data", "venue-history-coverage.json");
const RECORDS_OUTPUT = path.join(process.cwd(), "data", "venue-history-records");
const PENDING_OUTPUT = path.join(process.cwd(), "data", "venue-history-pending.json");
const selectedIds = new Set(process.argv
  .filter((arg) => arg.startsWith("--venue="))
  .map((arg) => arg.slice("--venue=".length))
  .filter(Boolean));
const selectedType = process.argv.find((arg) => arg.startsWith("--type="))?.split("=")[1] || null;
const baselinePath = process.argv.find((arg) => arg.startsWith("--new-conferences-from="))?.slice("--new-conferences-from=".length) || null;
const missingOnly = process.argv.includes("--missing");
const incrementalMode = Boolean(baselinePath || missingOnly);
if (selectedType && !["conference", "journal", "workshop"].includes(selectedType)) {
  throw new Error(`Unsupported venue-history type: ${selectedType}`);
}

function previousSnapshot() {
  try {
    const manifest = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
    if (!manifest.sharded) return manifest;
    const records = (manifest.venues || []).map((venue) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(venue.id)) throw new Error(`Unsafe venue-history ID: ${venue.id}`);
      return JSON.parse(fs.readFileSync(path.join(RECORDS_OUTPUT, `${venue.id}.json`), "utf8"));
    });
    return {
      ...manifest,
      venues: records.map((record) => record.venue),
      editions: records.flatMap((record) => record.editions || []),
      papers: records.flatMap((record) => record.papers || []),
      insights: records.map((record) => record.insights).filter(Boolean),
    };
  } catch {
    return { schemaVersion: 1, venues: [], editions: [], papers: [], insights: [] };
  }
}

function replaceVenueRecords(snapshot, venueId, next) {
  return {
    venues: [...(snapshot.venues || []).filter((entry) => entry.id !== venueId), next.venue],
    editions: [...(snapshot.editions || []).filter((entry) => entry.venueId !== venueId), ...next.editions],
    papers: [...(snapshot.papers || []).filter((entry) => entry.venueId !== venueId), ...next.papers],
    insights: [...(snapshot.insights || []).filter((entry) => entry.venueId !== venueId), next.insights],
  };
}

function writeAtomic(filePath, value, { compact = false } = {}) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, compact ? 0 : 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function writeVenueShards(snapshot, selectedVenueIds = null) {
  fs.mkdirSync(RECORDS_OUTPUT, { recursive: true, mode: 0o700 });
  const groupByVenue = (entries) => {
    const grouped = new Map();
    for (const entry of entries || []) {
      if (!grouped.has(entry.venueId)) grouped.set(entry.venueId, []);
      grouped.get(entry.venueId).push(entry);
    }
    return grouped;
  };
  const editions = groupByVenue(snapshot.editions);
  const papers = groupByVenue(snapshot.papers);
  const insights = new Map((snapshot.insights || []).map((entry) => [entry.venueId, entry]));
  for (const venue of snapshot.venues || []) {
    if (selectedVenueIds && !selectedVenueIds.has(venue.id)) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(venue.id)) throw new Error(`Unsafe venue-history ID: ${venue.id}`);
    writeAtomic(path.join(RECORDS_OUTPUT, `${venue.id}.json`), {
      schemaVersion: snapshot.schemaVersion,
      updatedAt: snapshot.updatedAt,
      source: snapshot.source,
      venue,
      editions: editions.get(venue.id) || [],
      papers: papers.get(venue.id) || [],
      insights: insights.get(venue.id) || null,
    }, { compact: true });
  }
}

function verifiedShardMatches(venue) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(venue.id || ""))) return false;
  try {
    const filePath = path.join(RECORDS_OUTPUT, `${venue.id}.json`);
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const normalizedExternalIds = (value) => JSON.stringify(
      Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)))
    );
    return record?.venue?.id === venue.id
      && record.venue.coverage?.status === "verified"
      && Array.isArray(record.papers)
      && record.papers.length > 0
      && normalizedExternalIds(record.venue.externalIds) === normalizedExternalIds(venue.externalIds);
  } catch {
    return false;
  }
}

function readConferenceBaseline(filePath) {
  const resolved = path.resolve(filePath);
  const stats = fs.statSync(resolved);
  if (!stats.isFile() || stats.size > 2 * 1024 * 1024) throw new Error("The conference baseline is invalid or too large.");
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.conferenceIds) || value.conferenceIds.length > 20_000) {
    throw new Error("The conference baseline has an unsupported format.");
  }
  const ids = value.conferenceIds.map((id) => String(id || "").trim());
  if (ids.some((id) => !id || id.length > 200)) throw new Error("The conference baseline contains an invalid ID.");
  return new Set(ids);
}

function incrementalSelection(config, activeConferences, {
  previousIds = null,
  includeMissing = false,
  shardMatches = verifiedShardMatches,
} = {}) {
  const newCalls = previousIds
    ? activeConferences.filter((call) => !previousIds.has(call.id))
    : [];
  const venueIds = new Set();
  for (const call of newCalls) {
    const venueId = resolveVenueIdentity(call, config);
    if (venueId) venueIds.add(venueId);
  }
  if (includeMissing) {
    for (const venue of config.venues || []) {
      if (!shardMatches(venue)) venueIds.add(venue.id);
    }
  }
  return { newCalls, venueIds };
}

function pendingCall(call, newCallIds) {
  return {
    callId: String(call.id || "").slice(0, 200),
    name: String(call.name || "").slice(0, 500),
    acronym: String(call.acronym || "").slice(0, 120),
    detectedAsNew: newCallIds.has(call.id),
    reason: "no-exact-authoritative-history-identity",
  };
}

function writeIncrementalState({ activeConferences, newCalls, completed = [] }) {
  const newCallIds = new Set(newCalls.map((call) => call.id));
  const unresolved = activeConferences
    .filter((call) => !resolveVenueIdentity(call))
    .map((call) => pendingCall(call, newCallIds));
  const failures = completed
    .filter((entry) => entry && !entry.result)
    .map((entry) => ({
      venueId: entry.venue.id,
      reason: "history-provider-failed",
      error: String(entry.run.error || "Provider failed").slice(0, 500),
    }));
  writeAtomic(PENDING_OUTPUT, {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    newConferenceIds: [...newCallIds].sort(),
    synchronizedVenueIds: completed.filter((entry) => entry?.result).map((entry) => entry.venue.id).sort(),
    pending: [...unresolved, ...failures],
  });
}

function snapshotSubset(snapshot, venueIds) {
  return {
    ...snapshot,
    venues: snapshot.venues.filter((entry) => venueIds.has(entry.id)),
    editions: snapshot.editions.filter((entry) => venueIds.has(entry.venueId)),
    papers: snapshot.papers.filter((entry) => venueIds.has(entry.venueId)),
    insights: snapshot.insights.filter((entry) => venueIds.has(entry.venueId)),
  };
}

async function syncVenue(venue, config) {
  const provider = venue.historyProvider || (venue.externalIds?.issns?.length ? "crossref-journal" : "dblp");
  const primary = provider === "crossref-journal"
    ? await syncCrossrefJournal(venue, config.providers?.crossref)
    : provider === "acl-anthology"
      ? await syncAclAnthologyVenue(venue, config.providers?.aclAnthology)
      : await syncDblpVenue(venue, config.providers?.dblp);
  const openAlex = await enrichPapersWithOpenAlex(primary.papers, config.providers?.openalex);
  const editionYear = new Map(primary.editions.map((edition) => [edition.id, edition.eventYear]));
  const uniquePapers = [...new Map(openAlex.papers.map((paper) => [paper.id, paper])).values()];
  const papers = uniquePapers.map((paper) => {
    const classification = classifyPaper(paper.title, paper.abstract);
    return {
      ...paper,
      venueId: venue.id,
      eventYear: editionYear.get(paper.editionId),
      topics: [...new Set([...classification.topics, ...(paper.openAlexTopics || [])])],
      methodTags: classification.methodTags,
      classificationEvidence: classification.evidence,
    };
  });
  const years = primary.editions.map((edition) => edition.eventYear).sort();
  const coverage = {
    status: primary.venue.identityEvidence?.confidence === 1 && papers.length ? "verified" : "partial",
    mode: venue.coverageMode || "source-indexed",
    maxPapersPerYear: venue.maxPapersPerYear || null,
    paperCount: papers.length,
    editionCount: primary.editions.length,
    startYear: years[0] || null,
    endYear: years.at(-1) || null,
    membershipSource: provider === "crossref-journal"
      ? "Crossref exact journal ISSN"
      : provider === "acl-anthology"
        ? "ACL Anthology exact venue volumes"
        : "DBLP exact proceedings tables of contents",
  };
  const aliases = [...new Set([
    ...(venue.match?.acronyms || []),
    ...(venue.match?.names || []),
  ])];
  return {
    venue: { ...primary.venue, aliases, coverage },
    editions: primary.editions,
    papers,
    insights: buildVenueInsights(venue.id, papers, primary.editions),
    providerStatus: { [provider]: "complete", openalex: openAlex.skipped || `enriched ${openAlex.enriched} papers` },
  };
}

async function main() {
  const config = readVenueHistoryConfig();
  const configured = config.venues || [];
  const configuredIds = new Set(configured.map((venue) => venue.id));
  const unknownIds = [...selectedIds].filter((id) => !configuredIds.has(id));
  if (unknownIds.length) throw new Error(`Unknown configured venue: ${unknownIds.join(", ")}`);

  let targetIds = selectedIds.size ? new Set(selectedIds) : null;
  let activeConferences = [];
  let newCalls = [];
  if (incrementalMode) {
    activeConferences = getActiveCFPs(new Date()).items.filter((call) => call.type === "conference");
  }
  if (baselinePath || missingOnly) {
    const selection = incrementalSelection(config, activeConferences, {
      previousIds: baselinePath ? readConferenceBaseline(baselinePath) : null,
      includeMissing: missingOnly,
    });
    newCalls = selection.newCalls;
    targetIds ||= new Set();
    for (const venueId of selection.venueIds) targetIds.add(venueId);
  }

  const targets = configured.filter((venue) =>
    (!targetIds || targetIds.has(venue.id)) && (!selectedType || venue.venueType === selectedType)
  );
  if (!targets.length) {
    if (incrementalMode) {
      writeIncrementalState({ activeConferences, newCalls });
      console.log(`No verified history refresh was needed (${newCalls.length} new conference call(s), 0 mapped or missing venues).`);
      return;
    }
    throw new Error("No venue-history sources are configured for the requested selection.");
  }
  let records = previousSnapshot();
  async function executeVenue(venue) {
    const startedAt = new Date().toISOString();
    try {
      const result = await syncVenue(venue, config);
      return { venue, result, run: { venueId: venue.id, state: "complete", startedAt, finishedAt: new Date().toISOString(), providerStatus: result.providerStatus } };
    } catch (error) {
      return { venue, result: null, run: { venueId: venue.id, state: "failed", startedAt, finishedAt: new Date().toISOString(), error: error.message } };
    }
  }
  const journalTargets = targets.filter((venue) => venue.historyProvider === "crossref-journal" || venue.externalIds?.issns?.length);
  const dblpTargets = targets.filter((venue) => !journalTargets.includes(venue));
  const [dblpResults, journalResults] = await Promise.all([
    mapLimit(dblpTargets, 1, executeVenue),
    mapLimit(journalTargets, Math.max(1, Math.min(3, Number(process.env.JOURNAL_HISTORY_CONCURRENCY) || 2)), executeVenue),
  ]);
  const byVenue = new Map([...dblpResults, ...journalResults].map((entry) => [entry.venue.id, entry]));
  const completed = targets.map((venue) => byVenue.get(venue.id));
  const runs = completed.map((entry) => entry.run);
  for (const entry of completed) {
    if (entry.result) {
      records = { ...records, ...replaceVenueRecords(records, entry.venue.id, entry.result) };
      console.log(`${entry.venue.id}: ${entry.result.editions.length} editions, ${entry.result.papers.length} verified papers`);
    } else {
      console.error(`${entry.venue.id}: ${entry.run.error}; retaining the previous verified snapshot`);
    }
  }
  const successfulVenueIds = new Set(completed.filter((entry) => entry.result).map((entry) => entry.venue.id));
  if (!successfulVenueIds.size) {
    if (incrementalMode) {
      writeIncrementalState({ activeConferences, newCalls, completed });
      console.error("No incremental venue-history source completed; failures were recorded for the next retry.");
      return;
    }
    throw new Error("No venue-history source completed successfully.");
  }
  const snapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "verified-provider-snapshot",
    venues: records.venues.sort((a, b) => a.id.localeCompare(b.id)),
    editions: records.editions.sort((a, b) => a.venueId.localeCompare(b.venueId) || b.eventYear - a.eventYear),
    papers: records.papers.sort((a, b) => a.venueId.localeCompare(b.venueId) || b.eventYear - a.eventYear || a.title.localeCompare(b.title)),
    insights: records.insights.sort((a, b) => a.venueId.localeCompare(b.venueId)),
    runs,
  };
  const fullRefresh = !incrementalMode && !selectedIds.size && !selectedType;
  writeVenueShards(snapshot, fullRefresh ? null : successfulVenueIds);
  writeAtomic(OUTPUT, {
    schemaVersion: snapshot.schemaVersion,
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
    sharded: true,
    recordDirectory: "data/venue-history-records",
    paperCount: snapshot.papers.length,
    venues: snapshot.venues,
    editions: snapshot.editions,
    insights: snapshot.insights,
    runs: snapshot.runs,
  });
  writeAtomic(COVERAGE_OUTPUT, {
    schemaVersion: 1,
    updatedAt: snapshot.updatedAt,
    venues: snapshot.venues.map((venue) => ({
      id: venue.id,
      venueType: venue.venueType,
      coverage: venue.coverage,
    })),
  });
  if (incrementalMode) writeIncrementalState({ activeConferences, newCalls, completed });
  try {
    const database = await writeSnapshotToPostgres(fullRefresh ? snapshot : snapshotSubset(snapshot, successfulVenueIds));
    console.log(database.written ? "PostgreSQL mirror updated." : `PostgreSQL mirror skipped: ${database.reason}.`);
  } catch (error) {
    // PostgreSQL is an optional mirror. The committed, verified JSON shards are
    // the durable fallback, so a database outage must not suppress a new CFP or
    // erase successfully fetched history from the dashboard deployment.
    const code = String(error?.code || error?.name || "database-error").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    console.error(`PostgreSQL mirror failed (${code || "database-error"}); verified JSON history remains available.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export const __test = { verifiedShardMatches, readConferenceBaseline, incrementalSelection, snapshotSubset };
