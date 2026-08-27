#!/usr/bin/env node
/**
 * Merge configured ranking datasets into the backend watchlist and live cards.
 *
 * Ranking data establishes venue identity and powers UI filtering. It does not
 * create a live CFP by itself: the normal discovery, deadline, and legitimacy
 * gates still decide whether a card may appear.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConferenceRanking,
  createConferenceRankIndex,
  findConferenceRanking,
  normalizeConferenceAcronym,
  normalizeConferenceRank,
} from "../lib/conferenceRankings.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "data", "ranking-sources.json");
const WATCHLIST_PATH = path.join(ROOT, "data", "watchlist.json");
const CFP_PATH = path.join(ROOT, "data", "cfps.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function rankingId(record) {
  return String(record.detailPath || "").match(/(\d+)\/?$/)?.[1] || null;
}

function existingMatch(existing, record) {
  const acronym = normalizeConferenceAcronym(record.acronym);
  const exactName = String(record.title || "").trim().toLowerCase();
  return existing.find(
    (entry) =>
      (acronym && normalizeConferenceAcronym(entry.acronym) === acronym) ||
      String(entry.name || "").trim().toLowerCase() === exactName
  );
}

const config = readJson(CONFIG_PATH);
const watchlist = readJson(WATCHLIST_PATH);
const cfpStore = readJson(CFP_PATH);
const originalConferences = watchlist.conferences || [];
let rankedWatchEntries = [];
let allRankingRecords = [];
let allRankGroups = {};

for (const source of config.sources || []) {
  if (source.venueType !== "conference") continue;
  const snapshot = readJson(path.join(ROOT, source.dataset));
  if (snapshot.source !== source.key || snapshot.total !== snapshot.conferences?.length) {
    throw new Error(`${source.key}: ranking snapshot metadata is inconsistent`);
  }
  allRankGroups = { ...allRankGroups, ...(source.rankGroups || {}) };
  allRankingRecords.push(...snapshot.conferences);
  rankedWatchEntries.push(
    ...snapshot.conferences.map((record) => {
      const existing = existingMatch(originalConferences, record);
      const groupedRank = normalizeConferenceRank(record.rank, source.rankGroups);
      return {
        ...(existing || {}),
        acronym: record.acronym,
        name: record.title,
        field: existing?.field || source.fieldMappings?.[record.primaryFor] || source.defaultField || "Other",
        tier: groupedRank,
        conferenceRank: groupedRank,
        conferenceRankRaw: record.rank,
        rankingSource: source.key,
        rankingId: rankingId(record),
        rankingUrl: record.detailPath ? `https://portal.core.edu.au${record.detailPath}` : source.officialUrl,
        dblpUrl: record.dblpUrl || existing?.dblpUrl || null,
        primaryFor: record.primaryFor || null,
      };
    })
  );
}

const representedAcronyms = new Set(rankedWatchEntries.map((entry) => normalizeConferenceAcronym(entry.acronym)));
const representedNames = new Set(rankedWatchEntries.map((entry) => String(entry.name || "").trim().toLowerCase()));
const nonRankingEntries = originalConferences.filter(
  (entry) =>
    !representedAcronyms.has(normalizeConferenceAcronym(entry.acronym)) &&
    !representedNames.has(String(entry.name || "").trim().toLowerCase())
);

watchlist.conferences = [...rankedWatchEntries, ...nonRankingEntries];
watchlist.updatedAt = new Date().toISOString();
watchlist.rankingSync = {
  checkedAt: new Date().toISOString(),
  sources: (config.sources || []).map((source) => source.key),
  importedRows: rankedWatchEntries.length,
};
writeJson(WATCHLIST_PATH, watchlist);

const rankIndex = createConferenceRankIndex(allRankingRecords, allRankGroups);
let enriched = 0;
cfpStore.items = (cfpStore.items || []).map((item) => {
  const ranking = findConferenceRanking(item, rankIndex);
  if (!ranking) return item;
  enriched++;
  return applyConferenceRanking(item, ranking);
});
if (enriched) {
  cfpStore.updatedAt = new Date().toISOString();
  writeJson(CFP_PATH, cfpStore);
}

console.log(
  `Ranking sync: ${rankedWatchEntries.length} configured conference rows, ` +
    `${nonRankingEntries.length} additional watchlist venues preserved, ${enriched} live cards enriched.`
);
