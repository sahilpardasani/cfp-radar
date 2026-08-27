import { fetchRemote, readResponseText } from "../../safeFetch.js";
import { mapLimit } from "../../asyncPool.js";

const MAX_PAGES_PER_YEAR = 20;
const ROWS_PER_PAGE = 250;
let lastCrossrefRequestAt = 0;
let crossrefStartQueue = Promise.resolve();

async function throttleCrossref() {
  const previous = crossrefStartQueue;
  let release;
  crossrefStartQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, 350 - (Date.now() - lastCrossrefRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastCrossrefRequestAt = Date.now();
  release();
}

function normalizedIssn(value) {
  return String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
}

function dateParts(item) {
  return item?.published?.["date-parts"]?.[0]
    || item?.["published-online"]?.["date-parts"]?.[0]
    || item?.["published-print"]?.["date-parts"]?.[0]
    || item?.issued?.["date-parts"]?.[0]
    || [];
}

function text(value) {
  return String(Array.isArray(value) ? value[0] : value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function authorName(author = {}) {
  return text(author.name) || [text(author.given), text(author.family)].filter(Boolean).join(" ");
}

function exactIssnMatch(item, configuredIssns) {
  const allowed = new Set(configuredIssns.map(normalizedIssn));
  return (item?.ISSN || []).some((value) => allowed.has(normalizedIssn(value)));
}

function publicDoiUrl(doi) {
  return doi ? `https://doi.org/${encodeURI(String(doi).toLowerCase())}` : null;
}

function normalizedDoi(value) {
  const doi = String(value || "").trim().toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
  return doi.length <= 300 && /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

function isJournalFrontMatterTitle(value) {
  const title = text(value).toLowerCase().replace(/[–—]/g, "-");
  if (!title) return true;
  return [
    /^\d{4}\s+index\b/,
    /^index\s+(?:to|for)\b/,
    /\binformation for authors\b/,
    /\bpublication information\b/,
    /^editorial board\b/,
    /^(?:front|back) matter\b/,
    /^(?:front|back) cover\b/,
    /^table of contents\b/,
    /^contents\b/,
    /^issue information\b/,
    /^(?:list of|acknowledg(?:e)?ment to) reviewers\b/,
  ].some((pattern) => pattern.test(title));
}

export function parseCrossrefJournalItems(items, { venue, year, evidenceUrl }) {
  const issns = venue.externalIds?.issns || [];
  const editionId = `${venue.id}-${year}`;
  const papers = [];
  for (const item of items || []) {
    const doi = normalizedDoi(item?.DOI);
    const title = text(item?.title);
    if (!doi || !title || isJournalFrontMatterTitle(title) || !exactIssnMatch(item, issns)) continue;
    const publicationYear = Number(dateParts(item)[0]) || year;
    if (publicationYear !== year) continue;
    papers.push({
      id: `crossref:${doi}`,
      crossrefId: doi,
      editionId,
      proceedingsKey: `journal:${normalizedIssn(issns[0])}:${year}`,
      title,
      authors: (item.author || []).map((author, index) => ({
        position: index + 1,
        name: authorName(author),
        orcid: text(author.ORCID).replace(/^https?:\/\/orcid\.org\//i, "") || null,
        dblpPid: null,
      })).filter((author) => author.name),
      publicationYear,
      pages: text(item.page) || null,
      doi,
      publisherUrl: publicDoiUrl(doi),
      dblpUrl: null,
      // Crossref delivery links may still be paywalled or TDM-only. Only the
      // optional OpenAlex enrichment is allowed to label a URL open access.
      openAccessUrl: null,
      abstract: text(item.abstract) || null,
      citationCount: Number.isFinite(item["is-referenced-by-count"]) ? item["is-referenced-by-count"] : null,
      membership: {
        source: "Crossref exact journal ISSN",
        status: "verified",
        confidence: 1,
        evidenceUrl,
      },
      venueId: venue.id,
      eventYear: year,
    });
  }
  return papers;
}

async function crossrefJson(url, providerConfig = {}) {
  const mailto = process.env.CROSSREF_MAILTO || providerConfig.mailto;
  if (mailto) url.searchParams.set("mailto", mailto);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await throttleCrossref();
    const { response } = await fetchRemote(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `CFP-Radar-VenueHistory/1.0${mailto ? ` (mailto:${mailto})` : ""}`,
      },
      timeoutMs: 45_000,
    });
    lastStatus = response.status;
    if (response.ok) return JSON.parse(await readResponseText(response, 16 * 1024 * 1024));
    const retryAfter = Number(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => {});
    if (response.status !== 429 && response.status < 500) break;
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30_000, retryAfter * 1_000)
      : Math.min(30_000, 1_500 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  throw new Error(`Crossref request failed (HTTP ${lastStatus || "network"}).`);
}

async function journalIdentity(venue, providerConfig) {
  const baseUrl = String(providerConfig.baseUrl || "https://api.crossref.org").replace(/\/$/, "");
  const issns = venue.externalIds?.issns || [];
  if (!issns.length) throw new Error(`${venue.id} has no configured ISSN.`);
  const url = new URL(`${baseUrl}/journals/${encodeURIComponent(issns[0])}`);
  const data = await crossrefJson(url, providerConfig);
  const record = data?.message;
  const allowed = new Set(issns.map(normalizedIssn));
  if (!(record?.ISSN || []).some((value) => allowed.has(normalizedIssn(value)))) {
    throw new Error(`${venue.id} Crossref identity did not return the configured ISSN.`);
  }
  return { record, evidenceUrl: url.toString() };
}

async function worksForYear(venue, year, providerConfig) {
  const baseUrl = String(providerConfig.baseUrl || "https://api.crossref.org").replace(/\/$/, "");
  const issn = venue.externalIds.issns[0];
  let cursor = "*";
  const items = [];
  let evidenceUrl = null;
  const configuredLimit = Number(venue.maxPapersPerYear);
  const representativeLimit = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(MAX_PAGES_PER_YEAR * ROWS_PER_PAGE, Math.floor(configuredLimit))
    : null;
  // Crossref sometimes classifies indexes, covers, and author instructions as
  // journal articles. Fetch a small bounded buffer so filtering that front
  // matter does not unnecessarily shrink representative coverage.
  const retrievalLimit = representativeLimit
    ? Math.min(MAX_PAGES_PER_YEAR * ROWS_PER_PAGE, Math.ceil(representativeLimit * 1.5))
    : null;
  const pageBudget = retrievalLimit ? Math.ceil(retrievalLimit / ROWS_PER_PAGE) : MAX_PAGES_PER_YEAR;
  for (let page = 0; page < pageBudget; page += 1) {
    const url = new URL(`${baseUrl}/journals/${encodeURIComponent(issn)}/works`);
    url.searchParams.set("filter", `from-pub-date:${year}-01-01,until-pub-date:${year}-12-31,type:journal-article`);
    url.searchParams.set("rows", String(Math.min(ROWS_PER_PAGE, retrievalLimit ? retrievalLimit - items.length : ROWS_PER_PAGE)));
    url.searchParams.set("cursor", cursor);
    if (representativeLimit) {
      url.searchParams.set("sort", "published");
      url.searchParams.set("order", "desc");
    }
    url.searchParams.set("select", "DOI,title,author,published,published-online,published-print,issued,page,ISSN,URL,abstract,is-referenced-by-count,volume,issue");
    evidenceUrl ||= url.toString();
    const data = await crossrefJson(url, providerConfig);
    const batch = data?.message?.items || [];
    items.push(...batch);
    if (retrievalLimit && items.length >= retrievalLimit) break;
    const nextCursor = data?.message?.["next-cursor"];
    if (!batch.length || batch.length < ROWS_PER_PAGE || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  if (!representativeLimit && items.length >= MAX_PAGES_PER_YEAR * ROWS_PER_PAGE) {
    throw new Error(`${venue.id} exceeded the bounded Crossref result budget for ${year}.`);
  }
  return { items: retrievalLimit ? items.slice(0, retrievalLimit) : items, evidenceUrl };
}

export async function syncCrossrefJournal(venue, providerConfig = {}) {
  const { record, evidenceUrl: identityUrl } = await journalIdentity(venue, providerConfig);
  const startYear = Number(venue.historyStartYear);
  const endYear = Number(venue.historyEndYear);
  const years = Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
  const concurrency = Math.max(1, Math.min(4, Number(process.env.CROSSREF_HISTORY_CONCURRENCY) || 2));
  const results = await mapLimit(years, concurrency, async (year) => {
    const result = await worksForYear(venue, year, providerConfig);
    const configuredLimit = Number(venue.maxPapersPerYear);
    const parsedPapers = parseCrossrefJournalItems(result.items, { venue, year, evidenceUrl: result.evidenceUrl });
    const yearPapers = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? parsedPapers.slice(0, Math.floor(configuredLimit))
      : parsedPapers;
    if (!yearPapers.length) return null;
    return { papers: yearPapers, edition: {
      id: `${venue.id}-${year}`,
      venueId: venue.id,
      eventYear: year,
      title: `${venue.canonicalName} — ${year}`,
      location: "Journal",
      verificationStatus: "verified",
      membershipSource: "crossref-exact-issn",
      volumes: [{
        proceedingsKey: `journal:${normalizedIssn(venue.externalIds.issns[0])}:${year}`,
        title: `${venue.canonicalName} — ${year}`,
        publisher: record.publisher || venue.publisher || null,
        publicationYear: year,
        series: venue.canonicalName,
        volume: null,
        isbn: [],
        publisherUrl: venue.officialUrl,
        dblpUrl: null,
        tocXmlUrl: null,
      }],
    } };
  });
  const completed = results.filter(Boolean);
  const editions = completed.map((result) => result.edition);
  const papers = completed.flatMap((result) => result.papers);
  if (!papers.length) throw new Error(`${venue.id} returned no exact-ISSN journal articles for the configured years.`);
  return {
    venue: {
      id: venue.id,
      canonicalName: venue.canonicalName,
      acronym: venue.acronym,
      venueType: venue.venueType,
      status: venue.status,
      officialUrl: venue.officialUrl,
      externalIds: venue.externalIds,
      identityEvidence: {
        source: "Crossref exact ISSN registry",
        externalId: venue.externalIds.issns.join(","),
        url: identityUrl,
        confidence: 1,
        verifiedAt: new Date().toISOString(),
      },
    },
    editions: editions.sort((a, b) => b.eventYear - a.eventYear),
    papers,
  };
}

export const __test = {
  normalizedIssn,
  normalizedDoi,
  exactIssnMatch,
  dateParts,
  text,
  authorName,
  isJournalFrontMatterTitle,
};
