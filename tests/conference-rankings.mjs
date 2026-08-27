import assert from "node:assert/strict";
import fs from "node:fs";
import {
  conferenceRankGroupForItem,
  createConferenceRankIndex,
  findConferenceRanking,
  normalizeConferenceRank,
} from "../lib/conferenceRankings.js";

const snapshot = JSON.parse(fs.readFileSync("data/icore-2026-conferences.json", "utf8"));
const watchlist = JSON.parse(fs.readFileSync("data/watchlist.json", "utf8"));
const config = JSON.parse(fs.readFileSync("data/ranking-sources.json", "utf8"));
const dashboard = fs.readFileSync("components/Dashboard.jsx", "utf8");
const source = config.sources.find((entry) => entry.key === "ICORE2026");

assert.equal(snapshot.source, "ICORE2026");
assert.equal(snapshot.total, 987);
assert.equal(snapshot.conferences.length, 987);
assert.equal(new Set(snapshot.conferences.map((entry) => entry.detailPath)).size, 987);

const rankCounts = Object.fromEntries(
  ["A*", "A", "B", "Australasian B", "C", "Australasian C"].map((rank) => [
    rank,
    snapshot.conferences.filter((entry) => entry.rank === rank).length,
  ])
);
assert.deepEqual(rankCounts, {
  "A*": 62,
  A: 108,
  B: 249,
  "Australasian B": 6,
  C: 381,
  "Australasian C": 19,
});

const imported = watchlist.conferences.filter((entry) => entry.rankingSource === "ICORE2026");
assert.equal(imported.length, 987, "every ICORE2026 row must be represented in the watchlist");
assert.equal(new Set(imported.map((entry) => entry.rankingId)).size, 987);
assert.equal(
  imported.find((entry) => entry.acronym === "INFOCOM")?.officialUrl,
  "https://infocom2027.ieee-infocom.org",
  "configured official venue URLs must survive ranking synchronization"
);

assert.equal(normalizeConferenceRank("Australasian B", source.rankGroups), "B");
assert.equal(normalizeConferenceRank("National: USA", source.rankGroups), "unranked");
assert.equal(conferenceRankGroupForItem({ type: "conference", tier: "A*" }), "A*");
assert.equal(conferenceRankGroupForItem({ type: "journal", tier: "Q1" }), null);

const index = createConferenceRankIndex(snapshot.conferences, source.rankGroups);
const aaai = findConferenceRanking(
  { type: "conference", acronym: "AAAI 2026", name: "AAAI Conference on Artificial Intelligence" },
  index
);
assert.equal(aaai.conferenceRank, "A*");
const ambiguous = createConferenceRankIndex([
  { acronym: "DUP", title: "First Venue", rank: "A", source: "ICORE2026" },
  { acronym: "DUP", title: "Second Venue", rank: "B", source: "ICORE2026" },
]);
assert.equal(
  findConferenceRanking({ type: "conference", acronym: "DUP", name: "Unknown Venue" }, ambiguous),
  null,
  "ambiguous duplicate acronyms must not be assigned a guessed rank"
);
assert.match(dashboard, /Filter by conference ranking/);

console.log("Conference rankings OK: all 987 ICORE2026 rows imported and the UI rank filter is wired.");
