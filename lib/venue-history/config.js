import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "venue-history-config.json");
const CATALOG_PATH = path.join(process.cwd(), "data", "venue-history-catalog.json");

const FALLBACK = {
  schemaVersion: 1,
  providers: {},
  defaults: { historyStartYear: 2022, historyEndYear: new Date().getUTCFullYear() - 1 },
  venues: [],
};

let cache = null;

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function readVenueHistoryConfig() {
  try {
    const modifiedAt = `${fs.statSync(CONFIG_PATH).mtimeMs}:${fs.existsSync(CATALOG_PATH) ? fs.statSync(CATALOG_PATH).mtimeMs : 0}`;
    if (cache?.modifiedAt === modifiedAt) return cache.value;
    const parsed = readJson(CONFIG_PATH, FALLBACK);
    const catalog = readJson(CATALOG_PATH, { venues: [] });
    const venues = new Map();
    for (const venue of catalog.venues || []) venues.set(venue.id, venue);
    // Hand-maintained entries override generated catalog entries with the same ID.
    for (const venue of parsed.venues || []) venues.set(venue.id, venue);
    cache = { modifiedAt, value: { ...FALLBACK, ...parsed, venues: [...venues.values()] } };
    return cache.value;
  } catch {
    return FALLBACK;
  }
}

export function venueHistoryEnabled() {
  return process.env.VENUE_HISTORY_ENABLED !== "0";
}
