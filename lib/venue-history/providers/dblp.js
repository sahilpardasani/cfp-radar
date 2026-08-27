import { mapLimit } from "../../asyncPool.js";
import { fetchRemote, readResponseText } from "../../safeFetch.js";

let lastDblpRequestAt = 0;

async function throttleDblp() {
  const waitMs = Math.max(0, 1_100 - (Date.now() - lastDblpRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastDblpRequestAt = Date.now();
}

function decodeXml(value = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function cleanText(value = "") {
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function firstTag(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? cleanText(match[1]) : null;
}

function allTags(xml, tag) {
  const values = [];
  const pattern = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = pattern.exec(xml))) values.push({ attributes: match[1], value: cleanText(match[2]) });
  return values;
}

function attribute(attributes = "", name) {
  return new RegExp(`\\b${name}=["']([^"']+)["']`, "i").exec(attributes)?.[1] || null;
}

function absoluteDblpUrl(baseUrl, path) {
  if (!path) return null;
  try {
    return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
  } catch {
    return null;
  }
}

async function fetchDblpText(url) {
  let lastStatus = 0;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await throttleDblp();
    try {
      const { response } = await fetchRemote(url, {
        headers: { "User-Agent": "CFP-Radar-VenueHistory/1.0 (mailto:noreply@example.com)" },
        timeoutMs: 30_000,
      });
      lastStatus = response.status;
      if (response.ok) return readResponseText(response, 24 * 1024 * 1024);
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      if (response.status !== 429 && response.status < 500) break;
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(15_000, retryAfter * 1_000)
        : 2_000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
  throw new Error(lastStatus
    ? `DBLP request failed (HTTP ${lastStatus}).`
    : `DBLP request failed (${lastError?.code || lastError?.message || "network error"}).`);
}

export function parseDblpIndex(xml, { venueId, baseUrl = "https://dblp.org", startYear, endYear }) {
  const editions = [];
  // Some DBLP streams place an official-event link between the heading and
  // <dblpcites>. Stop at the next heading so one edition cannot absorb another.
  const sectionPattern = /<h2>([\s\S]*?)<\/h2>(?:(?!<h2>)[\s\S])*?<dblpcites>([\s\S]*?)<\/dblpcites>/gi;
  let section;
  while ((section = sectionPattern.exec(xml))) {
    const heading = cleanText(section[1]);
    const eventYear = Number(heading.match(/\b(19|20)\d{2}\b/)?.[0]);
    if (!eventYear || eventYear < startYear || eventYear > endYear) continue;
    const volumes = [];
    const proceedingsPattern = /<proceedings\b([^>]*)>([\s\S]*?)<\/proceedings>/gi;
    let proceeding;
    while ((proceeding = proceedingsPattern.exec(section[2]))) {
      const key = attribute(proceeding[1], "key");
      const relativeUrl = firstTag(proceeding[2], "url");
      const dblpUrl = absoluteDblpUrl(baseUrl, relativeUrl);
      volumes.push({
        proceedingsKey: key,
        title: firstTag(proceeding[2], "title"),
        publisher: firstTag(proceeding[2], "publisher"),
        publicationYear: Number(firstTag(proceeding[2], "year")) || eventYear,
        series: firstTag(proceeding[2], "series"),
        volume: firstTag(proceeding[2], "volume"),
        isbn: allTags(proceeding[2], "isbn").map((entry) => entry.value),
        publisherUrl: firstTag(proceeding[2], "ee"),
        dblpUrl,
        tocXmlUrl: dblpUrl?.replace(/\.html(?:#.*)?$/, ".xml") || null,
      });
    }
    if (!volumes.length) continue;
    editions.push({
      id: `${venueId}-${eventYear}`,
      venueId,
      eventYear,
      title: heading,
      location: heading.includes(":") ? heading.split(":").slice(1).join(":").trim() : null,
      verificationStatus: "verified",
      membershipSource: "dblp-exact-stream",
      volumes,
    });
  }
  return editions.sort((a, b) => b.eventYear - a.eventYear);
}

export function parseDblpToc(xml, { edition, volume, baseUrl = "https://dblp.org" }) {
  const papers = [];
  const pattern = /<inproceedings\b([^>]*)>([\s\S]*?)<\/inproceedings>/gi;
  let match;
  while ((match = pattern.exec(xml))) {
    const key = attribute(match[1], "key");
    if (!key) continue;
    const authors = allTags(match[2], "author").map((entry, index) => ({
      position: index + 1,
      name: entry.value,
      orcid: attribute(entry.attributes, "orcid"),
      dblpPid: attribute(entry.attributes, "pid"),
    }));
    const electronicEdition = firstTag(match[2], "ee");
    const doi = /^https?:\/\/doi\.org\/(.+)$/i.exec(electronicEdition || "")?.[1] || null;
    papers.push({
      id: `dblp:${key}`,
      dblpKey: key,
      editionId: edition.id,
      proceedingsKey: volume.proceedingsKey,
      title: firstTag(match[2], "title"),
      authors,
      publicationYear: Number(firstTag(match[2], "year")) || edition.eventYear,
      pages: firstTag(match[2], "pages"),
      doi,
      publisherUrl: electronicEdition,
      dblpUrl: absoluteDblpUrl(baseUrl, `rec/${key}`),
      openAccessUrl: null,
      abstract: null,
      citationCount: null,
      membership: {
        source: "DBLP exact proceedings table of contents",
        status: "verified",
        confidence: 1,
        evidenceUrl: volume.dblpUrl,
      },
    });
  }
  return papers;
}

function bindingValue(binding, key) {
  return binding?.[key]?.value || null;
}

export function parseDblpSparql(data, { venueId, editions, startYear, endYear }) {
  const editionByToc = new Map(editions.flatMap((edition) =>
    edition.volumes.map((volume) => [String(volume.dblpUrl || "").replace(/\.(?:html|xml)$/, ""), edition])
  ));
  const papers = [];
  for (const binding of data?.results?.bindings || []) {
    const toc = bindingValue(binding, "toc");
    const normalizedToc = String(toc || "").replace(/\.(?:html|xml)$/, "");
    const edition = editionByToc.get(normalizedToc);
    const eventYear = edition?.eventYear;
    if (!edition || eventYear < startYear || eventYear > endYear) continue;
    const dblpUrl = bindingValue(binding, "publ");
    const dblpKey = dblpUrl?.match(/\/rec\/(.+)$/)?.[1];
    const doiUrl = bindingValue(binding, "doi");
    const doi = /^https?:\/\/doi\.org\/(.+)$/i.exec(doiUrl || "")?.[1] || null;
    const tocUrl = toc ? `${toc}.html` : edition.volumes[0]?.dblpUrl;
    const volume = edition.volumes.find((entry) => entry.dblpUrl?.replace(/\.html$/, "") === toc) || edition.volumes[0];
    const authors = String(bindingValue(binding, "authors") || "")
      .split(" ||| ")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({ position: index + 1, name, orcid: null, dblpPid: null }));
    if (!dblpKey || !bindingValue(binding, "title")) continue;
    papers.push({
      id: `dblp:${dblpKey}`,
      dblpKey,
      editionId: edition.id,
      proceedingsKey: volume?.proceedingsKey || null,
      title: bindingValue(binding, "title"),
      authors,
      publicationYear: Number(bindingValue(binding, "year")) || eventYear,
      pages: bindingValue(binding, "pages"),
      doi,
      publisherUrl: doiUrl,
      dblpUrl,
      openAccessUrl: null,
      abstract: null,
      citationCount: null,
      membership: {
        source: "DBLP exact stream and proceedings table of contents",
        status: "verified",
        confidence: 1,
        evidenceUrl: tocUrl,
      },
      venueId,
      eventYear,
    });
  }
  return papers;
}

async function papersFromSparql(venue, editions, providerConfig) {
  const sparqlUrl = providerConfig.sparqlUrl;
  if (!sparqlUrl) return null;
  const stream = venue.externalIds.dblpStream;
  const limitPerEdition = 6_000;
  const papers = [];
  for (const edition of editions) {
    const tocUrls = (edition.volumes || [])
      .map((volume) => String(volume.dblpUrl || "").replace(/\.(?:html|xml)$/, ""))
      .filter(Boolean);
    if (!tocUrls.length) continue;
    const tocValues = tocUrls.map((url) => `<${url}>`).join(" ");
    const query = `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?publ (SAMPLE(?title0) AS ?title) (SAMPLE(?year0) AS ?year)
  (SAMPLE(?doi0) AS ?doi) (SAMPLE(?pages0) AS ?pages) (SAMPLE(?toc0) AS ?toc)
  (GROUP_CONCAT(DISTINCT ?authorName; separator=" ||| ") AS ?authors)
WHERE {
  VALUES ?toc0 { ${tocValues} }
  ?publ dblp:publishedInStream <https://dblp.org/streams/${stream}> ;
        dblp:listedOnTocPage ?toc0 ; dblp:authoredBy ?author ;
        dblp:title ?title0 ; dblp:yearOfPublication ?year0 .
  ?author dblp:primaryCreatorName ?authorName .
  OPTIONAL { ?publ dblp:doi ?doi0 }
  OPTIONAL { ?publ dblp:pagination ?pages0 }
}
GROUP BY ?publ
LIMIT ${limitPerEdition}`;
    const url = new URL(sparqlUrl);
    url.searchParams.set("query", query);
    await throttleDblp();
    const { response } = await fetchRemote(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": "CFP-Radar-VenueHistory/1.0" },
      timeoutMs: 60_000,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`DBLP SPARQL request failed (HTTP ${response.status}).`);
    }
    const data = JSON.parse(await readResponseText(response, 24 * 1024 * 1024));
    const bindingCount = data?.results?.bindings?.length || 0;
    if (bindingCount >= limitPerEdition) {
      throw new Error(`${venue.id} ${edition.eventYear} reached the DBLP per-edition safety limit; refusing a truncated result.`);
    }
    papers.push(...parseDblpSparql(data, {
      venueId: venue.id,
      editions: [edition],
      startYear: Number(venue.historyStartYear),
      endYear: Number(venue.historyEndYear),
    }));
  }
  return papers;
}

export async function syncDblpVenue(venue, providerConfig = {}) {
  const baseUrl = providerConfig.baseUrl || "https://dblp.org";
  const stream = venue.externalIds?.dblpStream;
  if (!stream) throw new Error(`${venue.id} has no configured DBLP stream.`);
  const startYear = Number(venue.historyStartYear);
  const endYear = Number(venue.historyEndYear);
  const indexUrl = `${baseUrl.replace(/\/$/, "")}/db/${stream}/index.xml`;
  const indexXml = await fetchDblpText(indexUrl);
  const editions = parseDblpIndex(indexXml, { venueId: venue.id, baseUrl, startYear, endYear });
  if (!editions.length) throw new Error(`${venue.id} has no DBLP editions in the configured year range.`);
  let papers = null;
  try {
    papers = await papersFromSparql(venue, editions, providerConfig);
  } catch (error) {
    console.warn(`${venue.id}: ${error.message}; falling back to individual DBLP tables of contents`);
  }
  if (!papers?.length) {
    const jobs = editions.flatMap((edition) => edition.volumes.map((volume) => ({ edition, volume })));
    const batches = await mapLimit(jobs, 1, async ({ edition, volume }) => {
      if (!volume.tocXmlUrl) return [];
      const xml = await fetchDblpText(volume.tocXmlUrl);
      return parseDblpToc(xml, { edition, volume, baseUrl });
    });
    papers = batches.flat();
  }
  if (!papers.length) throw new Error(`${venue.id} returned no exact DBLP proceedings members.`);
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
        source: "DBLP exact stream",
        externalId: stream,
        url: `${baseUrl.replace(/\/$/, "")}/db/${stream}/index.html`,
        confidence: 1,
        verifiedAt: new Date().toISOString(),
      },
    },
    editions,
    papers,
  };
}

export const __test = { cleanText, firstTag, allTags, attribute, bindingValue };
