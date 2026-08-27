function normalized(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function deadlineKey(item) {
  if (!item?.deadline) return item?.type === "journal" ? "rolling" : "undated";
  const timestamp = new Date(item.deadline).getTime();
  return Number.isFinite(timestamp) ? String(timestamp) : String(item.deadline);
}

const GENERIC_ACRONYMS = new Set(["conference", "workshop", "journal", "track", "full", "abstracts"]);

export function callIdentityKey(item) {
  const type = item?.type || "unknown";
  const deadline = deadlineKey(item);
  const acronym = normalized(item?.acronym);
  const name = normalized(item?.name);
  // Special issues from one journal can legitimately share an acronym/deadline.
  const nameOnlyTypes = new Set(["special-issue", "book-proposal", "chapter-proposal", "reviewer-call"]);
  const identity = !nameOnlyTypes.has(type) && item?.source !== "openreview" && !item?.openreviewMirror && acronym && !GENERIC_ACRONYMS.has(acronym)
    ? `acronym:${acronym}`
    : `name:${name}`;
  return `${type}|${identity}|${deadline}`;
}

function richness(item) {
  const scalarFields = ["cfpUrl", "url", "submissionUrl", "templateUrl", "publisher", "location", "eventDates", "notification"];
  let score = scalarFields.filter((field) => item?.[field]).length;
  score += Math.min(6, item?.topics?.length || 0) / 2;
  if (item?.verification?.status === "confirmed") score += 5;
  if (item?.discoveryEvidence?.officialWorkshopPage || item?.officialWorkshopDiscovery?.officialWorkshopPage) score += 4;
  if (item?.source === "official") score += 2;
  return score;
}

function mergeArrays(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

export function mergeDuplicateCalls(left, right) {
  const preferred = richness(right) > richness(left) ? right : left;
  const other = preferred === left ? right : left;
  return {
    ...other,
    ...preferred,
    id: preferred.id,
    topics: mergeArrays(preferred.topics, other.topics),
    indexedIn: mergeArrays(preferred.indexedIn, other.indexedIn),
    format: { ...(other.format || {}), ...(preferred.format || {}) },
    metrics: { ...(other.metrics || {}), ...(preferred.metrics || {}) },
    legitimacy: { ...(other.legitimacy || {}), ...(preferred.legitimacy || {}) },
    admission: { ...(other.admission || {}), ...(preferred.admission || {}) },
    deduplicatedFrom: mergeArrays(
      [preferred.id, ...(preferred.deduplicatedFrom || [])],
      [other.id, ...(other.deduplicatedFrom || [])]
    ).filter((id) => id !== preferred.id),
  };
}

export function dedupeCalls(items) {
  const unique = [];
  const duplicateRecords = [];
  const indexByKey = new Map();
  for (const item of items || []) {
    const key = callIdentityKey(item);
    const index = indexByKey.get(key);
    if (index == null) {
      indexByKey.set(key, unique.length);
      unique.push(item);
      continue;
    }
    const previous = unique[index];
    const merged = mergeDuplicateCalls(previous, item);
    unique[index] = merged;
    duplicateRecords.push({
      ...(merged.id === previous.id ? item : previous),
      duplicateOf: merged.id,
      duplicateIdentityKey: key,
    });
  }
  return { items: unique, duplicates: duplicateRecords };
}
