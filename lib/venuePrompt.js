import { venueContextLine } from "./cfp.js";
import { hybridSearch } from "./hybridSearch.js";

const DEFAULT_PAPER_PROMPT_CHARS = 6_000;
const DEFAULT_VENUE_LIMIT = 18;

/**
 * Keep evidence from the beginning, middle and end of long papers. This avoids
 * exceeding provider TPM limits while still covering framing, methods/results,
 * and conclusions/references instead of silently using only the abstract.
 */
export function paperPromptExcerpt(text, maxChars = DEFAULT_PAPER_PROMPT_CHARS) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  const third = Math.floor((maxChars - 90) / 3);
  const middleStart = Math.max(third, Math.floor(value.length / 2) - Math.floor(third / 2));
  return [
    `[BEGINNING OF PAPER]\n${value.slice(0, third)}`,
    `[MIDDLE OF PAPER]\n${value.slice(middleStart, middleStart + third)}`,
    `[END OF PAPER]\n${value.slice(-third)}`,
  ].join("\n\n");
}

/**
 * Rank the complete live catalog locally, then send the best candidates with
 * their full metadata to the model. Every open venue participates in the
 * deterministic ranking; the bounded LLM payload stays below Groq TPM limits.
 */
export function venueContextForPaper(venues, paperText, { limit = DEFAULT_VENUE_LIMIT } = {}) {
  const source = Array.isArray(venues) ? venues : [];
  const ranked = hybridSearch(source, String(paperText || "").slice(0, 12_000)).items;
  const selected = [];
  const seen = new Set();
  for (const venue of [...ranked, ...source]) {
    if (!venue?.id || seen.has(venue.id)) continue;
    seen.add(venue.id);
    selected.push(venue);
    if (selected.length >= limit) break;
  }
  return {
    selected,
    context: selected.map(venueContextLine).join("\n"),
    totalCount: source.length,
  };
}
