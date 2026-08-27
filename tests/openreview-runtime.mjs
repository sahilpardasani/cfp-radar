import assert from "node:assert/strict";
import { groupOpenReviewEntries } from "../lib/openreviewDirectory.js";
import { mergeOpenReviewIntoStore } from "../lib/openreviewLive.js";

const entries = [
  { groupId: "EMNLP.cc/2026/Workshop/LMP", title: "EMNLP 2026 Workshop LMP", deadline: "2026-07-13T13:00:00.000Z", url: "https://openreview.net/group?id=EMNLP.cc%2F2026%2FWorkshop%2FLMP" },
  { groupId: "EMNLP.cc/2026/Workshop/LMP-Challenge", title: "EMNLP 2026 Workshop LMP Challenge", deadline: "2026-07-13T13:00:00.000Z", url: "https://openreview.net/group?id=EMNLP.cc%2F2026%2FWorkshop%2FLMP-Challenge" },
  { groupId: "EMNLP.cc/2026/Workshop/ORACLE", title: "EMNLP 2026 Workshop ORACLE", deadline: "2026-08-01T11:59:00.000Z", url: "https://openreview.net/group?id=EMNLP.cc%2F2026%2FWorkshop%2FORACLE" },
  { groupId: "EMNLP.cc/2026/Workshop/ORACLE-ARR", title: "EMNLP 2026 Workshop ORACLE ARR Commitment", deadline: "2026-08-01T00:00:00.000Z", url: "https://openreview.net/group?id=EMNLP.cc%2F2026%2FWorkshop%2FORACLE-ARR" },
];
const groups = groupOpenReviewEntries(entries);
const live = { entries, groups, source: "test", checkedAt: new Date().toISOString(), cache: "fresh" };
const out = mergeOpenReviewIntoStore([], live);
assert.equal(out.sync.mirroredEntries, 4);
assert.equal(out.items.length, 2);
const lmp = out.items.find((x) => /LMP/.test(x.name));
assert.ok(lmp);
assert.equal(lmp.openreviewTracks.length, 2);
assert.equal(lmp.openreviewDeadlines.length, 1);
const oracle = out.items.find((x) => /ORACLE/.test(x.name));
assert.ok(oracle);
assert.equal(oracle.openreviewDeadlines.length, 2);
assert.ok(oracle.openreviewTracks.every((t) => t.url.includes("openreview.net/group")));

const mixedEntries = [
  ...entries,
  { groupId: "COLM.cc/2026/Workshop/CBW/Reviewers", title: "COLM 2026 Workshop CBW Reviewers", deadline: null, url: "https://openreview.net/group?id=COLM.cc/2026/Workshop/CBW/Reviewers" },
  { groupId: "TMLR", title: "Transactions on Machine Learning Research", deadline: null, url: "https://openreview.net/group?id=TMLR" },
  { groupId: "Brown.edu/2026/MLSJ", title: "Brown University 2026 MLSJ", deadline: "2026-07-14T04:59:00.000Z", url: "https://openreview.net/group?id=Brown.edu/2026/MLSJ" },
];
const mixedLive = {
  entries: mixedEntries.filter((e) => !/Reviewers|Transactions on Machine Learning Research|Brown University/i.test(e.title)),
  rawEntries: mixedEntries.length,
  groups,
  source: "test",
  checkedAt: new Date().toISOString(),
  cache: "fresh",
};
const mixedOut = mergeOpenReviewIntoStore([], mixedLive);
assert.equal(mixedOut.sync.activeDirectoryEntries, mixedEntries.length);
assert.equal(mixedOut.sync.eligibleConferenceWorkshopEntries, entries.length);

const previousOpenReview = [{
  id: "or-still-open", name: "Still Open 2026", acronym: "SO 2026", type: "conference",
  source: "openreview", deadline: "2099-08-01T00:00:00.000Z", cfpUrl: "https://openreview.net/group?id=SO/2026",
}];
const partialMerge = mergeOpenReviewIntoStore(previousOpenReview, {
  entries: [], groups: [], source: "partial-test", complete: false,
  checkedAt: new Date().toISOString(), failures: [{ groupId: "X", error: "rate limited" }],
});
assert.ok(partialMerge.items.some((item) => item.id === "or-still-open"), "partial live fetch must preserve still-open prior OpenReview cards");

const identityEntries = [
  { groupId: "brown.edu/Brown_University/2099/MLSJ", title: "Brown University 2099 MLSJ", deadline: "2099-07-15T04:59:00.000Z", url: "https://openreview.net/group?id=brown.edu/Brown_University/2099/MLSJ" },
  { groupId: "uni-konstanz.de/Universitat_Konstanz/2099/Multimod", title: "Universitat Konstanz 2099 Multimod", deadline: "2099-09-20T12:06:00.000Z", url: "https://openreview.net/group?id=uni-konstanz.de/Universitat_Konstanz/2099/Multimod" },
  { groupId: "MICCAI.org/2099/Challenge/MAMA-Synth", title: "MICCAI 2099 Challenge MAMA-Synth", deadline: "2099-07-15T21:59:00.000Z", url: "https://openreview.net/group?id=MICCAI.org/2099/Challenge/MAMA-Synth" },
  { groupId: "MICCAI.org/2099/Doctoral_Symposium", title: "MICCAI 2099 Doctoral Symposium", deadline: "2099-07-30T23:59:00.000Z", url: "https://openreview.net/group?id=MICCAI.org/2099/Doctoral_Symposium" },
];
const identityLive = { entries: identityEntries, groups: groupOpenReviewEntries(identityEntries), source: "identity-test", complete: false, checkedAt: new Date().toISOString() };
const identityOut = mergeOpenReviewIntoStore([], identityLive);
assert.equal(identityOut.items.length, 4, "distinct OpenReview groups must remain separate cards");
for (const entry of identityEntries) {
  const card = identityOut.items.find((item) => item.name === entry.title);
  assert.ok(card, `${entry.title} must have its own card`);
  assert.equal(card.openreviewTracks[0].groupId, entry.groupId, `${entry.title} must retain its own OpenReview track`);
}

const curated = [{
  id: "oracle-curated",
  name: "EMNLP 2026 Workshop ORACLE",
  acronym: "ORACLE",
  type: "workshop",
  source: "curated",
  publisher: "ACL Anthology",
  cfpUrl: "https://sites.google.com/view/workshoporacle/call-for-papers",
  url: "https://sites.google.com/view/workshoporacle/",
  deadline: "2026-08-02T03:59:00.000Z",
}];
const enriched = mergeOpenReviewIntoStore(curated, live);
const enrichedOracle = enriched.items.find((x) => x.id === "oracle-curated");
assert.ok(enrichedOracle);
assert.equal(enrichedOracle.cfpUrl, curated[0].cfpUrl, "official CFP URL must not be overwritten by OpenReview");
assert.equal(enrichedOracle.url, curated[0].url, "official venue URL must not be overwritten by OpenReview");
assert.equal(enrichedOracle.source, "curated", "original discovery source must be preserved");
assert.equal(enrichedOracle.publisher, "ACL Anthology", "publisher must be preserved");
assert.equal(enrichedOracle.deadline, curated[0].deadline, "existing verified deadline must remain authoritative");
assert.ok(enrichedOracle.openreviewUrl.includes("openreview.net"));
assert.equal(enrichedOracle.openreviewDeadlines.length, 2);

const ihci = [{
  id: "ihci-2026",
  name: "International Conference on Intelligent Human-Computer Interaction",
  acronym: "IHCI 2026",
  type: "conference",
  source: "cmt",
  url: "https://ihci2026.com",
  cfpUrl: "https://ihci2026.com",
  deadline: "2026-08-14T23:59:00-12:00",
}];
const humaEntry = [{
  groupId: "acmmm.org/ACMMM/2026/Workshop/HUMA",
  title: "ACMMM 2026 Workshop HUMA",
  deadline: "2026-08-07T11:59:00.000Z",
  url: "https://openreview.net/group?id=acmmm.org/ACMMM/2026/Workshop/HUMA",
  cfpUrl: "https://huma2026.github.io/",
}];
const ihciRegression = mergeOpenReviewIntoStore(ihci, {
  entries: humaEntry,
  groups: groupOpenReviewEntries(humaEntry),
  source: "identity-regression-test",
  checkedAt: new Date().toISOString(),
  cache: "fresh",
});
const preservedIhci = ihciRegression.items.find((x) => x.id === "ihci-2026");
assert.ok(preservedIhci, "IHCI must remain in the catalog");
assert.equal(preservedIhci.cfpUrl, "https://ihci2026.com");
assert.equal(preservedIhci.openreviewMirror, undefined, "HUMA must never attach to IHCI via the substring 'huma' in 'human'");
assert.ok(ihciRegression.items.some((x) => x.name === "ACMMM 2026 Workshop HUMA"), "HUMA remains its own OpenReview card");



// Non-OpenReview workflow regression: unrelated established venues must survive
// byte-for-byte (except object cloning) when the live OpenReview mirror is added.
const nonOpenReviewCatalog = [
  {
    id: "cmt-conf", name: "Example CMT Conference 2026", acronym: "ECMT",
    type: "conference", source: "cmt", cfpUrl: "https://example.org/cfp",
    url: "https://example.org", deadline: "2026-09-01T23:59:00.000Z", publisher: "IEEE"
  },
  {
    id: "easychair-workshop", name: "Example Workshop 2026", acronym: "EW",
    type: "workshop", source: "easychair", cfpUrl: "https://easychair.org/cfp/ew2026",
    url: "https://example.edu/ew2026", deadline: "2026-08-20T23:59:00.000Z"
  },
  {
    id: "hotcrp-conf", name: "Example HotCRP Conference 2026", acronym: "EHC",
    type: "conference", source: "hotcrp", cfpUrl: "https://ehc2026.hotcrp.com",
    url: "https://ehc2026.org", deadline: "2026-10-01T23:59:00.000Z"
  },
  {
    id: "journal", name: "Example Journal", acronym: "EJ", type: "journal",
    source: "curated", cfpUrl: "https://publisher.example/journal/submit",
    url: "https://publisher.example/journal", deadline: null, publisher: "Springer"
  },
];
const additive = mergeOpenReviewIntoStore(nonOpenReviewCatalog, live);
for (const original of nonOpenReviewCatalog) {
  const preserved = additive.items.find((x) => x.id === original.id);
  assert.ok(preserved, `${original.id} must remain in the catalog`);
  for (const field of ["name", "acronym", "type", "source", "cfpUrl", "url", "deadline", "publisher"]) {
    assert.equal(preserved[field] ?? null, original[field] ?? null, `${original.id}.${field} must not be changed by OpenReview`);
  }
  assert.equal(preserved.openreviewMirror, undefined, `${original.id} must not be reclassified as OpenReview`);
}

console.log("OpenReview runtime merge tests passed.");

const { __test } = await import("../lib/openreviewLive.js");
assert.equal(__test.epochToIso(1783943940000), "2026-07-13T11:59:00.000Z");
assert.equal(__test.deadlineFromGroup({ content: { submission_deadline: { value: 1783943940000 } } }), "2026-07-13T11:59:00.000Z");
assert.equal(__test.officialUrlFromGroup({
  content: { website: { value: "https://cpl2026.sites.uu.nl/" } },
}), "https://cpl2026.sites.uu.nl/");
assert.equal(__test.officialUrlFromGroup({
  content: { website: { value: "https://openreview.net/group?id=not-a-cfp" } },
}), null, "an OpenReview submission URL is not an official CFP website");
assert.equal(__test.isWorkshopOrganizerCall("WACV 2027 Workshop Proposals"), true);
assert.equal(__test.isWorkshopOrganizerCall("WACV 2027 Workshop Vision-Language Learning"), false);
assert.equal(__test.isOpenCallInvitation({ id: "X/2026/-/Submission", duedate: 4102444800000 }), true);
assert.equal(__test.isOpenCallInvitation({ id: "X/2026/-/Camera_Ready", duedate: 4102444800000 }), false);
assert.equal(__test.trackNameFromInvitation({ id: "X/2026/-/ARR_Commitment" }, "EMNLP 2026 Workshop ORACLE"), "EMNLP 2026 Workshop ORACLE ARR Commitment");

const officialTracks = {
  deadline: "2026-08-01T23:59:00.000Z",
  tracks: [
    { type: "main_submission", date: new Date("2026-08-01T23:59:00.000Z") },
    { type: "arr_commitment", date: new Date("2026-07-31T23:59:00.000Z") },
    { type: "challenge_submission", date: new Date("2026-07-25T23:59:00.000Z") },
  ],
};
const officialTrackTestNow = new Date("2026-07-14T12:00:00.000Z");
assert.equal(
  __test.officialDeadlineForInvitation(officialTracks, { id: "X/-/ARR_Commitment" }, officialTrackTestNow),
  "2026-07-31T23:59:00.000Z",
  "ARR commitment must use the official ARR deadline"
);
assert.equal(
  __test.officialDeadlineForInvitation(officialTracks, { id: "X/-/Challenge_Submission" }, officialTrackTestNow),
  "2026-07-25T23:59:00.000Z",
  "challenge invitations must use the official challenge deadline"
);
assert.equal(
  __test.officialDeadlineForInvitation(officialTracks, { id: "X/-/Submission" }, officialTrackTestNow),
  "2026-08-01T23:59:00.000Z",
  "main submissions must use the official main-paper deadline"
);
console.log("Official CFP deadline selection tests passed.");

// Current-open admission: future-opening and expired invitations are excluded.
const nowMsCurrentOpen = new Date("2026-07-13T12:00:00Z").getTime();
assert.equal(__test.isOpenCallInvitation({
  id: "X/-/Submission",
  cdate: new Date("2026-07-20T00:00:00Z").getTime(),
  duedate: new Date("2026-08-01T00:00:00Z").getTime(),
}, nowMsCurrentOpen), false);
assert.equal(__test.isOpenCallInvitation({
  id: "X/-/Submission",
  cdate: new Date("2026-07-01T00:00:00Z").getTime(),
  duedate: new Date("2026-07-10T00:00:00Z").getTime(),
}, nowMsCurrentOpen), false);
assert.equal(__test.isOpenCallInvitation({
  id: "X/-/Submission",
  cdate: new Date("2026-07-01T00:00:00Z").getTime(),
  duedate: new Date("2026-08-01T00:00:00Z").getTime(),
}, nowMsCurrentOpen), true);

const homepageAuthoritativeFixture = `
<h1>Active Venues</h1>
<a href="/group?id=Future%2F2027">Future 2027 Conference</a>
<h1>Open for Submissions</h1>
<a href="/group?id=COLM%2F2026%2FWorkshop%2FLSEI">COLM 2026 Workshop LSEI</a>
<span>Due 13 Jul 2026 at 07:59 Eastern Daylight Time</span>
<a href="/group?id=EMNLP%2F2026%2FWorkshop%2FLMP">EMNLP 2026 Workshop LMP</a>
<span>Due 13 Jul 2026 at 09:00 Eastern Daylight Time</span>
<a href="/group?id=EMNLP%2F2026%2FWorkshop%2FLMP_Challenge">EMNLP 2026 Workshop LMP Challenge</a>
<span>Due 13 Jul 2026 at 09:00 Eastern Daylight Time</span>
`;
const homepageOpen = __test.homepageOpenEntriesFromHtml(
  homepageAuthoritativeFixture,
  new Date("2026-07-13T10:00:00Z")
);
assert.equal(homepageOpen.length, 3, "every item in OpenReview's open section must be imported");
assert.ok(homepageOpen.every((e) => e.url.includes("openreview.net/group")));

const placeholderHomepageFixture = `
<h1>Open for Submissions</h1>
<ul><li><h2><a href="/group?id=MICCAI.org%2F2026%2FWorkshop%2FELAMI">MICCAI 2026 Workshop ELAMI</a></h2><p>Due ...</p></li></ul>
`;
const placeholderCandidates = __test.homepageCandidateEntriesFromHtml(placeholderHomepageFixture);
assert.equal(placeholderCandidates.length, 1, "SSR Due placeholders must retain their group id for API hydration");
assert.equal(placeholderCandidates[0].groupId, "MICCAI.org/2026/Workshop/ELAMI");
