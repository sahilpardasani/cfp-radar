import assert from "node:assert/strict";
import {
  parseOpenReviewDue,
  baseVenueTitle,
  trackLabel,
  groupOpenReviewEntries,
  parseOpenReviewDirectory,
} from "../lib/openreviewDirectory.js";

assert.equal(
  parseOpenReviewDue("Due 13 Jul 2026 at 07:59 Eastern Daylight Time"),
  "2026-07-13T11:59:00.000Z"
);
assert.equal(parseOpenReviewDue("Open for Submissions"), null);
assert.equal(baseVenueTitle("EMNLP 2026 Workshop ORACLE ARR Commitment"), "EMNLP 2026 Workshop ORACLE");
assert.equal(baseVenueTitle("EMNLP 2026 Workshop ORACLE"), "EMNLP 2026 Workshop ORACLE");
assert.equal(baseVenueTitle("AutoML 2026 Late Breaking Track"), "AutoML 2026");
assert.equal(trackLabel("EMNLP 2026 Workshop ORACLE ARR Commitment", "EMNLP 2026 Workshop ORACLE"), "ARR Commitment");

const grouped = groupOpenReviewEntries([
  { title: "EMNLP 2026 Workshop LMP", deadline: "2026-07-13T13:00:00.000Z", url: "a", groupId: "a" },
  { title: "EMNLP 2026 Workshop LMP Challenge", deadline: "2026-07-13T13:00:00.000Z", url: "b", groupId: "b" },
  { title: "EMNLP 2026 Workshop ORACLE ARR Commitment", deadline: "2026-08-01T00:00:00.000Z", url: "c", groupId: "c" },
  { title: "EMNLP 2026 Workshop ORACLE", deadline: "2026-08-01T11:59:00.000Z", url: "d", groupId: "d" },
]);
assert.equal(grouped.length, 2);
const lmp = grouped.find((g) => g.title.includes("LMP"));
assert.equal(lmp.deadlines.length, 1);
assert.deepEqual(lmp.deadlines[0].tracks.sort(), ["Challenge", "Main submission"].sort());
const oracle = grouped.find((g) => g.title.includes("ORACLE"));
assert.equal(oracle.deadlines.length, 2);


const homepageFixture = `
  <h1>Active Venues</h1>
  <a href="/group?id=old%2Fvenue">Old Venue</a>
  <h1>Open for Submissions</h1>
  <a href="/group?id=colmweb.org%2FCOLM%2F2026%2FWorkshop%2FLSEI&referrer=%5BHomepage%5D%28%2F%29">COLM 2026 Workshop LSEI</a>
  <span>Due 13 Jul 2026 at 07:59 Eastern Daylight Time</span>
  <a href="/group?id=EMNLP%2F2026%2FWorkshop%2FLMP&referrer=%5BHomepage%5D%28%2F%29">EMNLP 2026 Workshop LMP</a>
  <span>Due 13 Jul 2026 at 09:00 Eastern Daylight Time</span>
  <a href="/group?id=EMNLP%2F2026%2FWorkshop%2FLMP_Challenge&referrer=%5BHomepage%5D%28%2F%29">EMNLP 2026 Workshop LMP Challenge</a>
  <span>Due 13 Jul 2026 at 09:00 Eastern Daylight Time</span>
  <a href="/group?id=Brown.edu%2F2026%2FMLSJ&referrer=%5BHomepage%5D%28%2F%29">Brown University 2026 MLSJ</a>
  <span>Due 14 Jul 2026 at 00:59 Eastern Daylight Time</span>
  <a href="/group?id=COLM%2F2026%2FWorkshop%2FCBW%2FReviewers&referrer=%5BHomepage%5D%28%2F%29">COLM 2026 Workshop CBW Reviewers</a>
  <span>Open for Submissions</span>
`;
const parsedHomepage = parseOpenReviewDirectory(homepageFixture);
assert.equal(parsedHomepage.length, 5);
assert.equal(parsedHomepage[0].title, "COLM 2026 Workshop LSEI");
assert.equal(parsedHomepage[0].deadline, "2026-07-13T11:59:00.000Z");
assert.ok(parsedHomepage[0].url.includes("colmweb.org%2FCOLM%2F2026%2FWorkshop%2FLSEI"));
assert.equal(parsedHomepage[3].title, "Brown University 2026 MLSJ");
assert.equal(parsedHomepage[4].deadline, null);
assert.equal(parsedHomepage[4].status, "open");

console.log("OpenReview directory parsing and grouping tests passed.");
