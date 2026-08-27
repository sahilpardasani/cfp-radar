const FORMAL_RANKS = new Set(["A*", "A", "B", "C"]);

export function normalizeConferenceAcronym(value) {
  return String(value || "")
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function tokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function titleSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

export function normalizeConferenceRank(rawRank, rankGroups = {}) {
  const raw = String(rawRank || "").trim();
  if (rankGroups[raw]) return rankGroups[raw];
  if (FORMAL_RANKS.has(raw)) return raw;
  if (/^australasian\s+b$/i.test(raw)) return "B";
  if (/^australasian\s+c$/i.test(raw)) return "C";
  return "unranked";
}

export function createConferenceRankIndex(conferences = [], rankGroups = {}) {
  const byAcronym = new Map();
  for (const conference of conferences) {
    const key = normalizeConferenceAcronym(conference.acronym);
    if (!key) continue;
    const record = {
      ...conference,
      conferenceRank: normalizeConferenceRank(conference.rank, rankGroups),
    };
    const entries = byAcronym.get(key) || [];
    entries.push(record);
    byAcronym.set(key, entries);
  }
  return byAcronym;
}

export function findConferenceRanking(venue, index) {
  if (venue?.type && venue.type !== "conference") return null;
  const key = normalizeConferenceAcronym(venue?.acronym);
  const matches = key ? index.get(key) || [] : [];
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const scored = matches
    .map((match) => ({ match, score: titleSimilarity(match.title, venue?.name) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > scored[1].score) return scored[0].match;

  // Duplicate acronyms exist in ranking catalogs. A tie is safe only when all
  // possible records have the same grouped rank; otherwise do not guess.
  const possibleRanks = new Set(matches.map((match) => match.conferenceRank));
  return possibleRanks.size === 1 ? scored[0].match : null;
}

export function applyConferenceRanking(venue, ranking) {
  if (!ranking) return venue;
  return {
    ...venue,
    tier: ranking.conferenceRank,
    conferenceRank: ranking.conferenceRank,
    conferenceRankRaw: ranking.rank,
    conferenceRankSource: ranking.source || "ICORE2026",
    conferenceRankingUrl: ranking.detailPath
      ? `https://portal.core.edu.au${ranking.detailPath}`
      : null,
  };
}

export function conferenceRankGroupForItem(item) {
  if (item?.type !== "conference") return null;
  return normalizeConferenceRank(item.conferenceRank || item.tier);
}
