import { safeExternalUrl } from "../cfpLinks.js";
import { getActiveCFPs } from "../cfp.js";
import { rankVenuePapers } from "./rankPapers.js";
import { loadVenueBundle } from "./repository.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SORTS = new Set(["relevance", "representative", "recent", "cited"]);

export function validVenueId(value) {
  return ID_PATTERN.test(String(value || ""));
}

function safeUrl(value) {
  return value ? safeExternalUrl(value) : null;
}

function publicBundle(bundle) {
  if (!bundle) return null;
  return {
    ...bundle,
    venue: {
      ...bundle.venue,
      officialUrl: safeUrl(bundle.venue.officialUrl),
      identityEvidence: bundle.venue.identityEvidence
        ? { ...bundle.venue.identityEvidence, url: safeUrl(bundle.venue.identityEvidence.url) }
        : null,
    },
    editions: (bundle.editions || []).map((edition) => ({
      ...edition,
      volumes: (edition.volumes || []).map((volume) => ({
        ...volume,
        publisherUrl: safeUrl(volume.publisherUrl),
        dblpUrl: safeUrl(volume.dblpUrl),
        tocXmlUrl: undefined,
      })),
    })),
    papers: (bundle.papers || []).map((paper) => ({
      ...paper,
      publisherUrl: safeUrl(paper.publisherUrl),
      dblpUrl: safeUrl(paper.dblpUrl),
      openAccessUrl: safeUrl(paper.openAccessUrl),
      membership: paper.membership
        ? { ...paper.membership, evidenceUrl: safeUrl(paper.membership.evidenceUrl) }
        : null,
    })),
  };
}

function currentCallFor(venueId, now = new Date()) {
  const { items } = getActiveCFPs(now);
  const call = items.find((item) => item.venueId === venueId);
  if (!call) return null;
  return {
    id: call.id,
    name: call.name,
    acronym: call.acronym,
    domain: call.domain,
    topics: call.topics || [],
    deadline: call.deadline,
    cfpUrl: safeUrl(call.resolvedCfpUrl),
  };
}

function filtersFor(bundle) {
  return {
    years: [...new Set(bundle.editions.map((edition) => edition.eventYear))].sort((a, b) => b - a),
    topics: [...new Set(bundle.papers.flatMap((paper) => paper.topics || []))].sort(),
    methods: [...new Set(bundle.papers.flatMap((paper) => paper.methodTags || []))].sort(),
  };
}

export async function venueHistorySummary(venueId, { now = new Date() } = {}) {
  if (!validVenueId(venueId)) return null;
  const bundle = publicBundle(await loadVenueBundle(venueId));
  if (!bundle) return null;
  const currentCall = currentCallFor(venueId, now);
  return {
    updatedAt: bundle.updatedAt,
    source: bundle.source,
    venue: bundle.venue,
    coverage: bundle.venue.coverage,
    editions: bundle.editions.map((edition) => ({
      ...edition,
      paperCount: bundle.papers.filter((paper) => paper.editionId === edition.id).length,
    })),
    insights: bundle.insights,
    filters: filtersFor(bundle),
    currentCall,
    defaultQuery: [currentCall?.domain, ...(currentCall?.topics || [])].filter(Boolean).join(" "),
  };
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const parsed = Number(Buffer.from(String(value), "base64url").toString("utf8"));
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset) {
  return offset == null ? null : Buffer.from(String(offset)).toString("base64url");
}

export async function searchVenuePapers(venueId, searchParams, { now = new Date() } = {}) {
  if (!validVenueId(venueId)) return null;
  const bundle = publicBundle(await loadVenueBundle(venueId));
  if (!bundle) return null;
  const currentCall = currentCallFor(venueId, now);
  const explicitQuery = String(searchParams.get("q") || "").trim().slice(0, 500);
  const query = explicitQuery || [currentCall?.domain, ...(currentCall?.topics || [])].filter(Boolean).join(" ");
  const sortCandidate = String(searchParams.get("sort") || "relevance");
  const sort = SORTS.has(sortCandidate) ? sortCandidate : "relevance";
  const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 20));
  const offset = decodeCursor(searchParams.get("cursor"));
  const result = rankVenuePapers(bundle.papers, {
    query,
    sort,
    year: searchParams.get("year") || null,
    topic: String(searchParams.get("topic") || "").slice(0, 120) || null,
    method: String(searchParams.get("method") || "").slice(0, 120) || null,
    openAccess: searchParams.get("openAccess") === "1",
    offset,
    limit,
  });
  return {
    venueId,
    query,
    sort,
    total: result.total,
    items: result.items,
    nextCursor: encodeCursor(result.nextOffset),
  };
}

export async function venueInsights(venueId) {
  if (!validVenueId(venueId)) return null;
  const bundle = publicBundle(await loadVenueBundle(venueId));
  return bundle ? { venueId, updatedAt: bundle.updatedAt, insights: bundle.insights } : null;
}

export const __test = { decodeCursor, encodeCursor };
