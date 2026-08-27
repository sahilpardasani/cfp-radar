#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { mapLimit } from "../lib/asyncPool.js";
import { fetchPage, duckDuckGoSearch } from "../lib/webDiscovery.js";
import { assessBookCall, hostAllowed } from "../lib/bookCallDiscovery.js";
import { isCallActive } from "../lib/callLifecycle.js";
import { dedupeCalls } from "../lib/dedupeCalls.js";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "data", "book-call-sources.json");
const DATA_PATH = path.join(ROOT, "data", "book-calls.json");
const REJECTIONS_PATH = path.join(ROOT, "data", "book-call-rejections.json");
const CONCURRENCY = Math.max(1, Number(process.env.BOOK_DISCOVERY_CONCURRENCY || 5));
const MAX_RESULTS = Math.max(2, Number(process.env.BOOK_DISCOVERY_RESULTS_PER_QUERY || 6));
const SEEDS_ONLY = process.env.BOOK_DISCOVERY_SEEDS_ONLY === "1";

const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const write = (file, value) => {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
};
const slug = (value) => String(value || "call").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
const titleFromPage = (page, fallback) => String((page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || fallback)
  .replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();

function makeItem({ source, page, assessment, name, seriesUrl, description, domain }) {
  const checkedAt = new Date().toISOString();
  return {
    id: `${source.id}-${assessment.callType}-${slug(name || page.url)}`,
    name: name || titleFromPage(page, `${source.publisher} proposal call`),
    acronym: source.id,
    type: assessment.callType,
    publisher: source.publisher,
    domain: domain || source.scopeKeywords?.[0] || "Computer Science & AI",
    topics: source.scopeKeywords || [],
    deadline: assessment.deadline?.date?.toISOString() || null,
    rolling: assessment.rolling,
    callUrl: page.url,
    cfpUrl: page.url,
    url: page.url,
    seriesUrl: seriesUrl || null,
    description: description || null,
    source: "official-publisher",
    sourceConfigId: source.id,
    verifiedAt: checkedAt,
    deadlineEvidence: assessment.deadline?.evidence || null,
    integrity: {
      status: "trusted",
      officialDomain: assessment.evidence.officialDomain,
      memberships: assessment.evidence.memberships,
      peerReview: assessment.evidence.peerReview,
      relevance: assessment.evidence.relevance,
      checkedAt,
    },
    legitimacy: { level: "trusted", basis: "Official allowlisted scholarly publisher domain with peer-review and subject-fit evidence." },
  };
}

async function inspectCandidate(source, candidate) {
  if (!hostAllowed(candidate.url, source.officialDomains || [])) {
    return { rejection: { publisher: source.publisher, url: candidate.url, reasons: ["not-on-approved-publisher-domain"] } };
  }
  try {
    const page = await fetchPage(candidate.url, Number(process.env.DISCOVERY_FETCH_TIMEOUT_MS || 15000), 1);
    const assessment = assessBookCall({ source, page, type: candidate.type, supportingText: candidate.title || "" });
    if (!assessment.admitted) return { rejection: { publisher: source.publisher, url: page.url, reasons: assessment.reasons } };
    return { item: makeItem({ source, page, assessment, name: candidate.name }) };
  } catch (error) {
    return { rejection: { publisher: source.publisher, url: candidate.url, reasons: [`fetch-failed:${error.code || error.message}`] } };
  }
}

async function inspectSeed(source, seed) {
  try {
    const supportingUrl = seed.seriesUrl || seed.callUrl;
    if (!hostAllowed(seed.callUrl, source.officialDomains) || !hostAllowed(supportingUrl, source.officialDomains)) {
      throw new Error("seed links are outside the approved publisher domains");
    }
    const callPage = await fetchPage(seed.callUrl, 15000, 1);
    const seriesPage = supportingUrl === seed.callUrl ? callPage : await fetchPage(supportingUrl, 15000, 1);
    const assessment = assessBookCall({
      source,
      page: callPage,
      type: seed.type,
      supportingText: seriesPage.text,
      evidenceOverrides: seed.verifiedEvidence || {},
    });
    if (!assessment.admitted) return { rejection: { publisher: source.publisher, url: seed.callUrl, reasons: assessment.reasons } };
    return { item: makeItem({ source, page: callPage, assessment, name: seed.name, seriesUrl: seed.seriesUrl ? seriesPage.url : null, description: seed.description, domain: seed.domain }) };
  } catch (error) {
    const evidence = seed.verifiedEvidence || {};
    const transientFetchFailure = /HTTP[_ ]?(?:403|429|5\d\d)|fetch failed|network|timeout/i.test(String(error.message || error));
    if (
      transientFetchFailure &&
      evidence.allowTransientFetchFallback === true &&
      evidence.proposalRouteVerified === true &&
      evidence.subjectFitVerified === true &&
      evidence.reviewedAt &&
      source.peerReviewVerified === true &&
      hostAllowed(seed.callUrl, source.officialDomains || []) &&
      hostAllowed(seed.seriesUrl || seed.callUrl, source.officialDomains || [])
    ) {
      const assessment = assessBookCall({
        source,
        page: { url: seed.callUrl, text: "" },
        type: seed.type,
        evidenceOverrides: evidence,
      });
      if (assessment.admitted) {
        const item = makeItem({
          source,
          page: { url: seed.callUrl, html: "", text: "" },
          assessment,
          name: seed.name,
          seriesUrl: seed.seriesUrl || null,
          description: seed.description,
          domain: seed.domain,
        });
        item.integrity.verificationMode = "operator-reviewed-official-evidence-fallback";
        item.integrity.transientFetchFailure = String(error.message || error);
        return { item };
      }
    }
    return { rejection: { publisher: source.publisher, url: seed.callUrl, reasons: [`seed-verification-failed:${error.message}`] } };
  }
}

async function discoverPublisher(source, globalTopics) {
  const seedUrls = new Set((source.seedCalls || []).map((seed) => seed.callUrl));
  const candidates = (source.proposalUrls || [])
    .filter((url) => !seedUrls.has(url))
    .map((url) => ({ url, type: "book-proposal", name: `${source.publisher} book proposals` }));
  const topicQuery = (globalTopics || []).slice(0, 6).map((topic) => `"${topic}"`).join(" OR ");
  const domains = (source.officialDomains || []).slice(0, 3);
  const queries = [];
  for (const domain of domains) {
    queries.push(`site:${domain} ("call for chapters" OR "chapter proposals") (${topicQuery})`);
    queries.push(`site:${domain} ("book proposals" OR "submit a book proposal") (${topicQuery})`);
  }
  const searchGroups = SEEDS_ONLY ? [] : await mapLimit(queries, 2, async (query) => {
    try { return await duckDuckGoSearch(query, MAX_RESULTS); } catch { return []; }
  });
  for (let index = 0; index < searchGroups.length; index++) {
    const type = index % 2 === 0 ? "chapter-proposal" : "book-proposal";
    for (const result of searchGroups[index]) candidates.push({ ...result, type });
  }

  const seen = new Set();
  const unique = candidates.filter((candidate) => {
    const key = `${candidate.type}:${candidate.url}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const [seedResults, candidateResults] = await Promise.all([
    mapLimit(source.seedCalls || [], 2, (seed) => inspectSeed(source, seed)),
    mapLimit(unique.slice(0, 20), 3, (candidate) => inspectCandidate(source, candidate)),
  ]);
  return [...seedResults, ...candidateResults];
}

async function main() {
  const now = new Date();
  const config = read(SOURCES_PATH, { publishers: [], globalTopics: [] });
  const previous = read(DATA_PATH, { source: "verified official scholarly publishers", items: [] });
  const groups = await mapLimit(config.publishers || [], CONCURRENCY, (source) => discoverPublisher(source, config.globalTopics));
  const discovered = groups.flat().filter((result) => result?.item).map((result) => result.item);
  const rejections = groups.flat().filter((result) => result?.rejection).map((result) => ({ ...result.rejection, checkedAt: now.toISOString() }));

  // Preserve still-open results when a publisher temporarily fails, but replace
  // successfully rechecked identities with their fresh evidence.
  const activePrevious = (previous.items || []).filter((item) => isCallActive(item, now));
  const discoveredIds = new Set(discovered.map((item) => item.id));
  const discoveredUrls = new Set(discovered.map((item) => item.callUrl));
  const specializedRollingSources = new Set(discovered
    .filter((item) => item.type === "book-proposal" && item.seriesUrl)
    .map((item) => item.sourceConfigId));
  const definitivelyRejectedUrls = new Set(rejections
    .filter((entry) => !(entry.reasons || []).some((reason) => /fetch[- ]failed|network|timeout|HTTP[_ ]?(?:403|429|5\d\d)/i.test(reason)))
    .map((entry) => entry.url));
  const combined = [
    ...activePrevious.filter((item) =>
      !discoveredIds.has(item.id) &&
      !definitivelyRejectedUrls.has(item.callUrl) &&
      !(discoveredUrls.has(item.callUrl) && / book proposals$/i.test(item.name || "")) &&
      !(specializedRollingSources.has(item.sourceConfigId) && / book proposals$/i.test(item.name || ""))
    ),
    ...discovered,
  ];
  const items = dedupeCalls(combined).items.filter((item) => isCallActive(item, now));
  write(DATA_PATH, { source: "verified official scholarly publishers", updatedAt: now.toISOString(), checkedPublishers: config.publishers.length, items });
  write(REJECTIONS_PATH, { updatedAt: now.toISOString(), items: rejections.slice(-2000) });
  console.log(`Book/chapter discovery: checked ${config.publishers.length} trusted publishers; admitted ${discovered.length}; ${items.length} active; rejected ${rejections.length}.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
