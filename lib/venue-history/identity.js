import { readVenueHistoryConfig } from "./config.js";

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedSet(values = []) {
  return new Set(values.map(normalize).filter(Boolean));
}

function openReviewSeries(call) {
  for (const value of [call?.openreviewUrl, call?.url, call?.cfpUrl]) {
    try {
      const url = new URL(value);
      if (url.hostname !== "openreview.net" && !url.hostname.endsWith(".openreview.net")) continue;
      const groupId = url.searchParams.get("id");
      if (!groupId) continue;
      return normalize(decodeURIComponent(groupId).split("/").filter((part) => !/^(?:19|20)\d{2}$/.test(part)).join(" "));
    } catch { /* Not an OpenReview group URL. */ }
  }
  return null;
}

/** Resolve only configured exact identities. Fuzzy guesses never reach users. */
export function resolveVenueIdentity(call, config = readVenueHistoryConfig()) {
  const callId = String(call?.id || "").toLowerCase();
  const acronym = normalize(call?.acronym);
  const name = normalize(call?.name);
  const series = openReviewSeries(call);

  for (const venue of config.venues || []) {
    const match = venue.match || {};
    if ((match.callIds || []).some((id) => String(id).toLowerCase() === callId)) return venue.id;
    if (series && normalizedSet(match.openreviewSeries).has(series)) return venue.id;
    if (acronym && normalizedSet(match.acronyms).has(acronym)) return venue.id;
    if (name && normalizedSet(match.names).has(name)) return venue.id;
  }
  return null;
}

export function configuredVenue(venueId, config = readVenueHistoryConfig()) {
  return (config.venues || []).find((venue) => venue.id === venueId) || null;
}

export const __test = { normalize, openReviewSeries };
