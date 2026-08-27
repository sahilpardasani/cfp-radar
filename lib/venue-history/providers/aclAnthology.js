import { mapLimit } from "../../asyncPool.js";
import { fetchRemote, readResponseText } from "../../safeFetch.js";

function decodeHtml(value = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function cleanLatex(value = "") {
  return decodeHtml(String(value))
    .replace(/\\&/g, "&")
    .replace(/[{}]/g, "")
    .replace(/\\([%_$#])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapBibValue(value = "") {
  let result = String(value).trim().replace(/,$/, "").trim();
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("{") && result.endsWith("}"))) {
    result = result.slice(1, -1);
  }
  return cleanLatex(result);
}

export function parseBibtexEntries(source) {
  const entries = [];
  for (const block of String(source || "").split(/\n(?=@)/)) {
    const header = /^@(\w+)\{([^,]+),\s*\n/i.exec(block);
    if (!header) continue;
    const fields = {};
    const body = block.slice(header[0].length).replace(/\n}\s*$/, "");
    let current = null;
    for (const line of body.split("\n")) {
      const start = /^\s*([a-z][a-z0-9_-]*)\s*=\s*(.*)$/i.exec(line);
      if (start) {
        if (current) fields[current.name] = unwrapBibValue(current.value);
        current = { name: start[1].toLowerCase(), value: start[2] };
      } else if (current) {
        current.value += ` ${line.trim()}`;
      }
    }
    if (current) fields[current.name] = unwrapBibValue(current.value);
    entries.push({ type: header[1].toLowerCase(), key: header[2].trim(), fields });
  }
  return entries;
}

function authors(value = "") {
  return String(value).split(/\s+and\s+/i).map((name, index) => {
    const parts = cleanLatex(name).split(",").map((part) => part.trim()).filter(Boolean);
    return {
      position: index + 1,
      name: parts.length > 1 ? `${parts.slice(1).join(" ")} ${parts[0]}` : parts[0],
      orcid: null,
      dblpPid: null,
    };
  }).filter((author) => author.name);
}

function volumeIds(html, year) {
  const found = new Set();
  const pattern = /href=(?:"|')?\/volumes\/([a-z0-9._-]+)\//gi;
  let match;
  while ((match = pattern.exec(html))) {
    // The exact event page is already the identity boundary. Volume IDs do not
    // always repeat the event slug (for example 2023.conll-babylm), so accept
    // every volume from the requested year that the official event page lists.
    if (match[1].toLowerCase().startsWith(`${year}.`)) found.add(match[1]);
  }
  return [...found];
}

async function anthologyText(url, { allowNotFound = false } = {}) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { response } = await fetchRemote(url, {
      headers: { "User-Agent": "CFP-Radar-VenueHistory/1.0" },
      timeoutMs: 30_000,
    });
    lastStatus = response.status;
    if (response.ok) return readResponseText(response, 12 * 1024 * 1024);
    await response.body?.cancel().catch(() => {});
    if (allowNotFound && response.status === 404) return null;
    if (response.status < 500 && response.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw new Error(`ACL Anthology request failed (HTTP ${lastStatus || "network"}).`);
}

function paperFromEntry(entry, { venue, year, editionId, volumeId, baseUrl }) {
  if (entry.type !== "inproceedings") return null;
  const field = entry.fields;
  let anthologyId = null;
  try {
    const sourceUrl = new URL(field.url);
    if (sourceUrl.hostname === "aclanthology.org") anthologyId = sourceUrl.pathname.match(/^\/([a-z0-9._-]+)\/?$/i)?.[1] || null;
  } catch { /* Exact official paper URL is required. */ }
  if (!field.title || !anthologyId) return null;
  const anthologyUrl = `${baseUrl}/${anthologyId}/`;
  const doi = field.doi ? field.doi.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() : null;
  return {
    id: `acl:${anthologyId}`,
    aclAnthologyId: anthologyId,
    editionId,
    proceedingsKey: volumeId,
    title: field.title,
    authors: authors(field.author),
    publicationYear: Number(field.year) || year,
    pages: field.pages?.replace(/--/g, "-") || null,
    doi,
    publisherUrl: anthologyUrl,
    dblpUrl: null,
    openAccessUrl: anthologyUrl.replace(/\/$/, ".pdf"),
    abstract: field.abstract || null,
    citationCount: null,
    membership: {
      source: "ACL Anthology exact venue volume",
      status: "verified",
      confidence: 1,
      evidenceUrl: `${baseUrl}/volumes/${volumeId}/`,
    },
    venueId: venue.id,
    eventYear: year,
  };
}

export async function syncAclAnthologyVenue(venue, providerConfig = {}) {
  const baseUrl = String(providerConfig.baseUrl || "https://aclanthology.org").replace(/\/$/, "");
  const eventSlug = venue.externalIds?.aclAnthologyEvent;
  if (!eventSlug) throw new Error(`${venue.id} has no configured ACL Anthology event slug.`);
  const startYear = Number(venue.historyStartYear);
  const endYear = Number(venue.historyEndYear);
  const years = Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
  const results = await mapLimit(years, 2, async (year) => {
    const eventUrl = `${baseUrl}/events/${eventSlug}-${year}/`;
    const html = await anthologyText(eventUrl, { allowNotFound: true });
    if (!html) return null;
    const ids = volumeIds(html, year, eventSlug);
    if (!ids.length) throw new Error(`${venue.id} ${year} has no exact ACL Anthology volumes.`);
    const bibFiles = await mapLimit(ids, 2, (id) => anthologyText(`${baseUrl}/volumes/${id}.bib`));
    const editionId = `${venue.id}-${year}`;
    const papers = bibFiles.flatMap((bib, index) => parseBibtexEntries(bib)
      .map((entry) => paperFromEntry(entry, { venue, year, editionId, volumeId: ids[index], baseUrl }))
      .filter(Boolean));
    if (!papers.length) throw new Error(`${venue.id} ${year} has no exact ACL Anthology paper records.`);
    return {
      edition: {
        id: editionId,
        venueId: venue.id,
        eventYear: year,
        title: `${venue.canonicalName} — ${year}`,
        location: null,
        verificationStatus: "verified",
        membershipSource: "acl-anthology-exact-event",
        volumes: ids.map((id) => ({
          proceedingsKey: id,
          title: id,
          publisher: "Association for Computational Linguistics",
          publicationYear: year,
          series: venue.canonicalName,
          volume: null,
          isbn: [],
          publisherUrl: `${baseUrl}/volumes/${id}/`,
          dblpUrl: null,
          tocXmlUrl: null,
        })),
      },
      papers,
    };
  });
  const completed = results.filter(Boolean);
  const papers = completed.flatMap((result) => result.papers);
  if (!papers.length) throw new Error(`${venue.id} returned no exact ACL Anthology venue members.`);
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
        source: "ACL Anthology exact venue series",
        externalId: eventSlug,
        url: `${baseUrl}/venues/${eventSlug}/`,
        confidence: 1,
        verifiedAt: new Date().toISOString(),
      },
    },
    editions: completed.map((result) => result.edition).sort((a, b) => b.eventYear - a.eventYear),
    papers,
  };
}

export const __test = { cleanLatex, authors, volumeIds };
