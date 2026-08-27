import fs from "node:fs";
import path from "node:path";
import { safeExternalUrl } from "../cfpLinks.js";

const DATA_PATH = path.join(process.cwd(), "data", "venue-history.json");
const COVERAGE_PATH = path.join(process.cwd(), "data", "venue-history-coverage.json");
const RECORDS_PATH = path.join(process.cwd(), "data", "venue-history-records");
let cache = null;
let coverageCache = null;
const bundleCache = new Map();

function shardPath(venueId) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(venueId || ""))
    ? path.join(RECORDS_PATH, `${venueId}.json`)
    : null;
}

function readVenueShard(venueId) {
  const filePath = shardPath(venueId);
  if (!filePath) return null;
  try {
    const modifiedAt = fs.statSync(filePath).mtimeMs;
    const previous = bundleCache.get(venueId);
    if (previous?.modifiedAt === modifiedAt) return previous.value;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value?.venue?.id !== venueId) return null;
    bundleCache.set(venueId, { modifiedAt, value });
    return value;
  } catch {
    return null;
  }
}

export function readVenueHistorySnapshot() {
  try {
    const modifiedAt = fs.statSync(DATA_PATH).mtimeMs;
    if (cache?.modifiedAt === modifiedAt) return cache.value;
    const value = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    cache = { modifiedAt, value };
    return value;
  } catch {
    return { schemaVersion: 1, updatedAt: null, source: "unavailable", venues: [], editions: [], papers: [], insights: [] };
  }
}

function safeUrl(value) {
  return value ? safeExternalUrl(value) : null;
}

function publicPaper(paper) {
  return {
    ...paper,
    publisherUrl: safeUrl(paper.publisherUrl),
    dblpUrl: safeUrl(paper.dblpUrl),
    openAccessUrl: safeUrl(paper.openAccessUrl),
    membership: paper.membership ? { ...paper.membership, evidenceUrl: safeUrl(paper.membership.evidenceUrl) } : null,
  };
}

function publicEdition(edition) {
  return {
    ...edition,
    volumes: (edition.volumes || []).map((volume) => ({
      ...volume,
      publisherUrl: safeUrl(volume.publisherUrl),
      dblpUrl: safeUrl(volume.dblpUrl),
      tocXmlUrl: undefined,
    })),
  };
}

export function loadJsonVenueBundle(venueId) {
  const shard = readVenueShard(venueId);
  if (shard) {
    return {
      updatedAt: shard.updatedAt,
      source: shard.source,
      venue: {
        ...shard.venue,
        officialUrl: safeUrl(shard.venue.officialUrl),
        identityEvidence: shard.venue.identityEvidence
          ? { ...shard.venue.identityEvidence, url: safeUrl(shard.venue.identityEvidence.url) }
          : null,
      },
      editions: (shard.editions || []).map(publicEdition),
      papers: (shard.papers || []).map(publicPaper),
      insights: shard.insights || null,
    };
  }
  const snapshot = readVenueHistorySnapshot();
  const venue = (snapshot.venues || []).find((entry) => entry.id === venueId);
  if (!venue) return null;
  return {
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
    venue: {
      ...venue,
      officialUrl: safeUrl(venue.officialUrl),
      identityEvidence: venue.identityEvidence ? { ...venue.identityEvidence, url: safeUrl(venue.identityEvidence.url) } : null,
    },
    editions: (snapshot.editions || []).filter((edition) => edition.venueId === venueId).map(publicEdition),
    papers: (snapshot.papers || []).filter((paper) => paper.venueId === venueId).map(publicPaper),
    insights: (snapshot.insights || []).find((insight) => insight.venueId === venueId) || null,
  };
}

export function historyCoverageMap() {
  let snapshot;
  try {
    const modifiedAt = fs.statSync(COVERAGE_PATH).mtimeMs;
    if (coverageCache?.modifiedAt === modifiedAt) snapshot = coverageCache.value;
    else {
      snapshot = JSON.parse(fs.readFileSync(COVERAGE_PATH, "utf8"));
      coverageCache = { modifiedAt, value: snapshot };
    }
  } catch {
    snapshot = readVenueHistorySnapshot();
  }
  return new Map((snapshot.venues || []).map((venue) => [venue.id, {
    status: venue.coverage?.status || "unavailable",
    paperCount: Number(venue.coverage?.paperCount || 0),
    editionCount: Number(venue.coverage?.editionCount || 0),
    startYear: venue.coverage?.startYear || null,
    endYear: venue.coverage?.endYear || null,
    updatedAt: snapshot.updatedAt,
  }]));
}
