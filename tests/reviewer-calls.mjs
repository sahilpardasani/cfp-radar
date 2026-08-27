import assert from "node:assert/strict";
import fs from "node:fs";
import { assessReviewerPage, extractReviewerDeadline, isReviewerRecruitmentCall } from "../lib/reviewerCallDiscovery.js";
import { dedupeCalls } from "../lib/dedupeCalls.js";
import { isCallActive } from "../lib/callLifecycle.js";
import { hybridSearch } from "../lib/hybridSearch.js";

const config = JSON.parse(fs.readFileSync("data/reviewer-call-sources.json", "utf8"));
const store = JSON.parse(fs.readFileSync("data/reviewer-calls.json", "utf8"));
const source = {
  venue: "TrustedConf 2027",
  acronym: "TrustedConf",
  officialDomains: ["trustedconf.acm.org"],
  applicationUrl: "https://forms.gle/trusted-reviewer-form",
  deadlineLabels: ["Reviewer application deadline"],
};
const page = {
  url: "https://trustedconf.acm.org/reviewers",
  text: "TrustedConf 2027 Call for Reviewers. Reviewer application deadline: October 3, 2026.",
  links: [{ text: "reviewer application form", url: source.applicationUrl }],
};

assert.equal(isReviewerRecruitmentCall(page.text), true);
assert.equal(isReviewerRecruitmentCall("Reviewer applications are closed."), false);
assert.equal(extractReviewerDeadline(page.text, source.deadlineLabels).date.toISOString(), "2026-10-03T23:59:00.000Z");
assert.equal(assessReviewerPage({ source, page, now: new Date("2026-07-17T00:00:00Z") }).admitted, true);
assert.equal(assessReviewerPage({
  source,
  page: { ...page, url: "https://untrusted.example/reviewers" },
}).admitted, false, "an external form or page cannot establish legitimacy");

const duplicated = dedupeCalls([
  { id: "a", type: "reviewer-call", name: "TrustedConf Call for Reviewers", deadline: "2026-10-03T23:59:00Z" },
  { id: "b", type: "reviewer-call", name: "TrustedConf Call for Reviewers", deadline: "2026-10-03T23:59:00Z" },
]);
assert.equal(duplicated.items.length, 1);
assert.equal(isCallActive(
  { type: "reviewer-call", rolling: true, expiresAt: "2026-07-23T00:00:00Z" },
  new Date("2026-07-23T00:00:01Z")
), false, "an unrenewed reviewer call must disappear after its verification lease");
assert.deepEqual(
  hybridSearch([
    { type: "conference", name: "Paper submission" },
    { type: "reviewer-call", name: "Ethics reviewer opportunity" },
  ], "I want to review papers").items.map((item) => item.type),
  ["reviewer-call"]
);
assert.ok(config.sources.length >= 3);
assert.ok(store.items.length >= 3);
for (const item of store.items) {
  assert.equal(item.type, "reviewer-call");
  assert.match(item.callUrl, /^https:\/\//);
  assert.match(item.applicationUrl, /^https:\/\//);
  assert.equal(item.integrity?.level, "trusted");
}

console.log(`Reviewer calls OK: ${config.sources.length} configured sources; ${store.items.length} verified calls.`);
