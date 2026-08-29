import assert from "node:assert/strict";
import fs from "node:fs";
import { getActiveCFPs } from "../lib/cfp.js";
import { resolveVenueIdentity } from "../lib/venue-history/identity.js";
import { parseDblpIndex, parseDblpSparql } from "../lib/venue-history/providers/dblp.js";
import { __test as crossrefTest, parseCrossrefJournalItems } from "../lib/venue-history/providers/crossrefJournal.js";
import { parseBibtexEntries, __test as aclAnthologyTest } from "../lib/venue-history/providers/aclAnthology.js";
import { classifyPaper } from "../lib/venue-history/taxonomy.js";
import { rankVenuePapers } from "../lib/venue-history/rankPapers.js";
import { loadJsonVenueBundle } from "../lib/venue-history/jsonRepository.js";
import { searchVenuePapers, venueHistorySummary } from "../lib/venue-history/service.js";
import { databaseSslConfig } from "../lib/venue-history/postgresConfig.js";
import { readVenueHistoryConfig } from "../lib/venue-history/config.js";
import { __test as catalogTest } from "../scripts/expand-venue-history-config.mjs";

const FEATURE_TEST_NOW = new Date("2026-08-02T12:00:00-04:00");

assert.equal(resolveVenueIdentity({ id: "ihci-2026", acronym: "IHCI 2026" }), "ihci");
assert.equal(resolveVenueIdentity({ id: "other", acronym: "IHCI", name: "Unrelated" }), "ihci");
assert.equal(resolveVenueIdentity({ id: "other", acronym: "HCI", name: "International HCI Symposium" }), null, "similar names must not be guessed");
assert.equal(resolveVenueIdentity({ id: "iui-2027", acronym: "IUI 2027" }), "iui");
assert.equal(resolveVenueIdentity({
  id: "future-finnlp",
  acronym: "Unknown",
  openreviewUrl: "https://openreview.net/group?id=EMNLP/2027/Workshop/FinNLP",
}), "finnlp", "future repeat workshops should resolve through their exact OpenReview series");
assert.equal(resolveVenueIdentity({
  id: "wrong-finnlp",
  acronym: "FinNLP",
  openreviewUrl: "https://openreview.net/group?id=OtherConf/2027/Workshop/FinNLP",
}), null, "a similar workshop acronym under another series must not be guessed");

const indexFixture = `<bht><h2>16th IHCI 2024: Twente, The Netherlands</h2><dblpcites><r><proceedings key="conf/ihci/2024-1"><title>IHCI 2024 Part I</title><publisher>Springer</publisher><year>2025</year><series>Lecture Notes in Computer Science</series><volume>15557</volume><isbn>123</isbn><ee>https://doi.org/10.1007/example</ee><url>db/conf/ihci/ihci2024-1.html</url></proceedings></r></dblpcites><h2>12th IHCI 2020</h2><dblpcites><r><proceedings key="conf/ihci/2020"><title>old</title><year>2020</year><url>db/conf/ihci/ihci2020.html</url></proceedings></r></dblpcites></bht>`;
const parsedEditions = parseDblpIndex(indexFixture, { venueId: "ihci", baseUrl: "https://dblp.org", startYear: 2022, endYear: 2025 });
assert.equal(parsedEditions.length, 1);
assert.equal(parsedEditions[0].eventYear, 2024);
assert.equal(parsedEditions[0].volumes[0].tocXmlUrl, "https://dblp.org/db/conf/ihci/ihci2024-1.xml");
const linkedHeadingEditions = parseDblpIndex(
  '<h2>CHI 2025: Yokohama</h2><a href="https://chi2025.acm.org/">official</a><dblpcites><r><proceedings key="conf/chi/2025"><title>CHI 2025</title><year>2025</year><url>db/conf/chi/chi2025.html</url></proceedings></r></dblpcites>',
  { venueId: "chi", baseUrl: "https://dblp.org", startYear: 2025, endYear: 2025 },
);
assert.equal(linkedHeadingEditions.length, 1, "DBLP indexes may place an official link before the proceedings block");

const sparqlFixture = { results: { bindings: [{
  publ: { value: "https://dblp.org/rec/conf/ihci/Example24" },
  title: { value: "A Privacy-Preserving Human-AI System." },
  year: { value: "2025" },
  doi: { value: "https://doi.org/10.1007/example_1" },
  pages: { value: "1-12" },
  toc: { value: "https://dblp.org/db/conf/ihci/ihci2024-1" },
  authors: { value: "Ada Author ||| Bob Researcher" },
}] } };
const parsedPapers = parseDblpSparql(sparqlFixture, { venueId: "ihci", editions: parsedEditions, startYear: 2022, endYear: 2025 });
assert.equal(parsedPapers.length, 1);
assert.equal(parsedPapers[0].eventYear, 2024);
assert.equal(parsedPapers[0].membership.confidence, 1);
assert.equal(parsedPapers[0].authors.length, 2);

const genericEdition = [{
  id: "demo-2024",
  eventYear: 2024,
  volumes: [{ proceedingsKey: "conf/demo/2024", dblpUrl: "https://dblp.org/db/conf/demo/demo2024.html" }],
}];
const genericPapers = parseDblpSparql({ results: { bindings: [{
  ...sparqlFixture.results.bindings[0],
  publ: { value: "https://dblp.org/rec/conf/demo/Example24" },
  toc: { value: "https://dblp.org/db/conf/demo/demo2024" },
}] } }, { venueId: "demo", editions: genericEdition, startYear: 2024, endYear: 2024 });
assert.equal(genericPapers[0].editionId, "demo-2024", "DBLP membership resolution must not depend on an IHCI URL pattern");

const journalVenue = {
  id: "example-journal",
  externalIds: { issns: ["1234-5678"] },
};
const journalPapers = parseCrossrefJournalItems([
  {
    DOI: "10.1000/EXAMPLE",
    title: ["A Trustworthy AI Journal Article"],
    ISSN: ["1234-5678"],
    published: { "date-parts": [[2025, 4, 2]] },
    author: [{ given: "Ada", family: "Author", ORCID: "https://orcid.org/0000-0000-0000-0001" }],
    "is-referenced-by-count": 7,
  },
  {
    DOI: "10.1000/WRONG",
    title: ["Wrong journal"],
    ISSN: ["9999-9999"],
    published: { "date-parts": [[2025]] },
  },
], { venue: journalVenue, year: 2025, evidenceUrl: "https://api.crossref.org/journals/1234-5678/works" });
assert.equal(journalPapers.length, 1, "journal membership requires an exact configured ISSN");
assert.equal(journalPapers[0].membership.confidence, 1);
assert.equal(journalPapers[0].authors[0].name, "Ada Author");
assert.equal(journalPapers[0].openAccessUrl, null, "Crossref delivery links must not be mislabeled as open access");
assert.equal(crossrefTest.isJournalFrontMatterTitle("IEEE Transactions on Neural Networks and Learning Systems Information for Authors"), true);
assert.equal(crossrefTest.isJournalFrontMatterTitle("2025 Index IEEE Transactions on Neural Networks and Learning Systems"), true);
assert.equal(crossrefTest.isJournalFrontMatterTitle("Uncertainty-Aware Graph Neural Networks: A Multihop Evidence Fusion Approach"), false);

const anthologyEntries = parseBibtexEntries(`@proceedings{demo-2025-0,
    title = "Proceedings of Demo",
    year = "2025"
}
@inproceedings{author-2025-demo,
    title = "A {M}ultilingual {LLM} Study",
    author = "Author, Ada  and
      Researcher, Bob",
    year = "2025",
    url = "https://aclanthology.org/2025.demo-1.1/",
    pages = "1--10"
}`);
assert.equal(anthologyEntries.length, 2);
assert.equal(anthologyEntries[1].fields.title, "A Multilingual LLM Study");
assert.match(anthologyEntries[1].fields.author, /Researcher, Bob/);
assert.deepEqual(
  aclAnthologyTest.volumeIds('<a href=/volumes/2025.finnlp-1.bib>bib</a><a href=/volumes/2025.finnlp-1/>volume</a>', 2025, "finnlp"),
  ["2025.finnlp-1"],
);
assert.deepEqual(
  aclAnthologyTest.volumeIds('<a href=/volumes/2023.conll-babylm/>volume</a>', 2023, "babylm"),
  ["2023.conll-babylm"],
  "exact ACL event pages may use a parent-conference prefix in their volume ID",
);

assert.equal(catalogTest.canonicalJournalQuery({ name: "Artificial Intelligence (AIJ)" }), "Artificial Intelligence");
assert.equal(catalogTest.publisherMatches("IEEE", "Institute of Electrical and Electronics Engineers (IEEE)", {
  IEEE: ["institute of electrical and electronics engineers", "ieee"],
}), true);
assert.equal(catalogTest.validIssn("1234-567X"), true);
assert.equal(catalogTest.dblpStream("https://dblp.uni-trier.de/db/conf/chi"), "conf/chi");
assert.equal(catalogTest.tokenScore("ACM CHI Conference on Human Factors in Computing Systems 2027", "International Conference on Human Factors in Computing Systems") >= 0.6, true);
assert.equal(catalogTest.tokenScore("CCS CSS", "ACM Conference on Computer and Communications Security") < 0.6, true);
const mergedCatalog = catalogTest.mergeCatalogVenues(
  [{ id: "demo", venueType: "conference", match: { callIds: ["demo-2026"], names: ["Demo 2026"] } }],
  [{ id: "demo", venueType: "conference", match: { callIds: ["demo-2027"], names: ["Demo 2027"] } }],
);
assert.equal(mergedCatalog.length, 1);
assert.deepEqual(mergedCatalog[0].match.callIds, ["demo-2026", "demo-2027"], "stable venue history must survive and recognize later CFP editions");

const classified = classifyPaper("A Privacy-Preserving Federated Learning Framework for Human-AI Interaction");
assert.ok(classified.topics.includes("privacy, trust & security"));
assert.ok(classified.methodTags.includes("privacy-preserving ML"));

const ranked = rankVenuePapers([
  { id: "privacy", title: "Privacy-Preserving AI", eventYear: 2024, topics: ["privacy"], methodTags: [], authors: [] },
  { id: "robot", title: "Social Robot Navigation", eventYear: 2025, topics: ["robotics"], methodTags: [], authors: [] },
], { query: "privacy AI", limit: 10 });
assert.equal(ranked.items[0].id, "privacy");

const manifest = JSON.parse(fs.readFileSync("data/venue-history.json", "utf8"));
const historyConfig = readVenueHistoryConfig();
const coverageIndex = JSON.parse(fs.readFileSync("data/venue-history-coverage.json", "utf8"));
const pendingHistory = JSON.parse(fs.readFileSync("data/venue-history-pending.json", "utf8"));
const pendingProviderFailures = new Set((pendingHistory.pending || [])
  .filter((entry) => entry.reason === "history-provider-failed")
  .map((entry) => entry.venueId));
const shardFiles = fs.readdirSync("data/venue-history-records").filter((name) => name.endsWith(".json"));
const shards = shardFiles.map((name) => JSON.parse(fs.readFileSync(`data/venue-history-records/${name}`, "utf8")));
const snapshot = {
  ...manifest,
  venues: shards.map((record) => record.venue),
  editions: shards.flatMap((record) => record.editions || []),
  papers: shards.flatMap((record) => record.papers || []),
  insights: shards.map((record) => record.insights).filter(Boolean),
};
assert.equal(manifest.sharded, true, "large histories must be sharded so API requests load only one venue");
const shardVenueIds = new Set(snapshot.venues.map((venue) => venue.id));
const configuredVenueIds = new Set(historyConfig.venues.map((venue) => venue.id));
for (const venueId of configuredVenueIds) {
  assert.equal(
    shardVenueIds.has(venueId) || pendingProviderFailures.has(venueId),
    true,
    `${venueId} must have a verified shard or an explicit provider-failure retry record`,
  );
}
for (const venueId of shardVenueIds) {
  assert.equal(configuredVenueIds.has(venueId), true, `${venueId} must still be present in the exact venue catalog`);
}
assert.equal(manifest.paperCount, snapshot.papers.length);
assert.equal(snapshot.venues.length >= 1, true);
assert.equal(snapshot.papers.length >= 50_000, true);
assert.equal(new Set(snapshot.papers.map((paper) => paper.id)).size, snapshot.papers.length, "paper IDs must be globally unique");
const journalVenueIds = new Set(snapshot.venues.filter((venue) => venue.venueType === "journal").map((venue) => venue.id));
for (const paper of snapshot.papers.filter((entry) => journalVenueIds.has(entry.venueId))) {
  assert.equal(crossrefTest.isJournalFrontMatterTitle(paper.title), false, `journal front matter must be excluded: ${paper.title}`);
}
assert.equal(coverageIndex.updatedAt, snapshot.updatedAt);
assert.deepEqual(coverageIndex.venues.map((venue) => venue.id).sort(), snapshot.venues.map((venue) => venue.id).sort());
for (const venue of snapshot.venues) {
  const venuePapers = snapshot.papers.filter((paper) => paper.venueId === venue.id);
  assert.equal(venue.coverage.status, "verified");
  assert.equal(venue.coverage.paperCount, venuePapers.length);
  assert.equal(venuePapers.length > 0, true);
  for (const paper of venuePapers) {
    assert.equal(paper.membership.status, "verified");
    assert.equal(paper.membership.confidence, 1);
    assert.match(paper.membership.evidenceUrl, /^https:\/\//);
  }
}
const ihci = snapshot.venues.find((venue) => venue.id === "ihci");
assert.equal(ihci.coverage.status, "verified");
assert.equal(ihci.coverage.editionCount, 4);
assert.equal(ihci.coverage.paperCount >= 250, true);
assert.deepEqual(snapshot.editions.filter((edition) => edition.venueId === "ihci").map((edition) => edition.eventYear), [2025, 2024, 2023, 2022]);
const ihciPapers = snapshot.papers.filter((paper) => paper.venueId === "ihci");
assert.equal(new Set(ihciPapers.map((paper) => paper.id)).size, ihciPapers.length, "paper IDs must be unique");
for (const paper of ihciPapers) {
  assert.equal(paper.membership.status, "verified");
  assert.equal(paper.membership.confidence, 1);
  assert.match(paper.membership.evidenceUrl, /^https:\/\/dblp\.org\/db\/conf\/ihci\//);
}

const bundle = loadJsonVenueBundle("ihci");
assert.equal(bundle.papers.length, ihci.coverage.paperCount);
const activeFeatureItems = getActiveCFPs(FEATURE_TEST_NOW).items;
const activeCallForVenue = (venueId) => activeFeatureItems.find((item) => item.venueId === venueId) || null;
const assertCurrentCallMatchesLifecycle = (historySummary, venueId) => {
  const activeCall = activeCallForVenue(venueId);
  if (!activeCall) {
    assert.equal(historySummary.currentCall, null, `${venueId} must not resurrect a pruned call`);
    return;
  }
  assert.equal(historySummary.currentCall?.id, activeCall.id, `${venueId} should expose its active call`);
};
const summary = await venueHistorySummary("ihci", { now: FEATURE_TEST_NOW });
assert.equal(summary.coverage.status, "verified");
assertCurrentCallMatchesLifecycle(summary, "ihci");
const search = await searchVenuePapers("ihci", new URLSearchParams("q=privacy&limit=5"), { now: FEATURE_TEST_NOW });
assert.equal(search.items.length > 0, true);
assert.equal(search.items.length <= 5, true);
const journalSummary = await venueHistorySummary("ai-and-ethics", { now: FEATURE_TEST_NOW });
assert.equal(journalSummary.venue.venueType, "journal");
assertCurrentCallMatchesLifecycle(journalSummary, "ai-and-ethics");
const journalSearch = await searchVenuePapers("ai-and-ethics", new URLSearchParams("q=governance&limit=5"), { now: FEATURE_TEST_NOW });
assert.equal(journalSearch.items.length, 5);
const workshopSummary = await venueHistorySummary("finnlp", { now: FEATURE_TEST_NOW });
assert.equal(workshopSummary.venue.venueType, "workshop");
assertCurrentCallMatchesLifecycle(workshopSummary, "finnlp");

const activeIhci = activeFeatureItems.find((item) => item.id === "ihci-2026");
if (activeIhci) {
  assert.equal(activeIhci.venueId, "ihci");
  assert.equal(activeIhci.historyCoverage.paperCount, ihci.coverage.paperCount);
}
const storedCallIds = new Set(JSON.parse(fs.readFileSync("data/cfps.json", "utf8")).items.map((item) => item.id));
const activeHistoryIds = new Map(activeFeatureItems.map((item) => [item.id, item.venueId]));
for (const [callId, venueId] of [
  ["iui-2027", "iui"],
  ["wsdm-2027", "wsdm"],
  ["j-springer-ai-and-ethics", "ai-and-ethics"],
  ["j-springer-ai-and-society", "ai-and-society"],
  ["j-springer-philosophy-and-technology", "philosophy-and-technology"],
  ["or-emnlp-2026-workshop-finnlp", "finnlp"],
  ["or-emnlp-2026-workshop-mrl", "mrl"],
  ["or-hipeac-2027-workshop-dasip", "dasip"],
  ["or-neurips-2026", "neurips"],
  ["chi-2027", "chi"],
  ["sigmod-2027-r4", "sigmod"],
  ["aamas-2027", "aamas"],
  ["icassp-2027", "icassp"],
  ["dai-2026", "dai"],
  ["or-inlg-2026", "inlg"],
  ["or-nldl-2027", "nldl"],
  ["or-taai-2026", "taai"],
  ["or-bnaic-benelearn-2026", "bnaic-benelearn"],
  ["or-ieee-embs-bsn-2026", "ieee-bsn"],
  ["emnlp-2026-ws-woah", "woah"],
  ["or-emnlp-2026-workshop-babylm", "babylm"],
  ["nca-springer", "nca-springer"],
  ["j-ieee-tnnls", "j-ieee-tnnls"],
  ["j-nature-machine-intelligence", "j-nature-machine-intelligence"],
]) {
  if (storedCallIds.has(callId)) {
    assert.equal(activeHistoryIds.get(callId), venueId, `${callId} should expose its exact verified history`);
  }
}
assert.equal(activeHistoryIds.get("or-ccs-2026-css"), undefined, "an unrelated CCS acronym must not inherit ACM CCS history");
const previousFlag = process.env.VENUE_HISTORY_ENABLED;
process.env.VENUE_HISTORY_ENABLED = "0";
assert.equal(getActiveCFPs(FEATURE_TEST_NOW).items.find((item) => item.id === "ihci-2026")?.venueId, undefined, "rollback flag must remove the feature additively");
if (previousFlag === undefined) delete process.env.VENUE_HISTORY_ENABLED;
else process.env.VENUE_HISTORY_ENABLED = previousFlag;

const cardSource = fs.readFileSync("components/CFPCard.jsx", "utf8");
assert.match(cardSource, /Past work &amp; venue fit/);
assert.match(cardSource, /historyCoverage\?\.paperCount/);

assert.deepEqual(databaseSslConfig({ DATABASE_SSL: "1" }), { rejectUnauthorized: true });
assert.deepEqual(databaseSslConfig({ DATABASE_SSL: "1", DATABASE_CA_CERT: "line1\\nline2" }), {
  ca: "line1\nline2",
  rejectUnauthorized: true,
});
assert.equal(databaseSslConfig({ DATABASE_SSL: "0" }), false);

console.log(`Venue history OK: ${snapshot.venues.length} venues, ${snapshot.editions.length} editions/year groups, and ${snapshot.papers.length} exact-membership papers verified.`);
