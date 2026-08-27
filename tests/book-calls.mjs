import assert from "node:assert/strict";
import { assessBookCall, extractBookCallDeadline, hostAllowed } from "../lib/bookCallDiscovery.js";
import { dedupeCalls } from "../lib/dedupeCalls.js";

const source = {
  publisher: "Example University Press",
  officialDomains: ["press.example.edu"],
  memberships: ["AUPresses"],
  peerReviewVerified: true,
  scopeKeywords: ["artificial intelligence"],
};
const page = {
  url: "https://press.example.edu/ai-book",
  text: "Call for chapters. Chapter proposal deadline: September 30, 2026. This peer-reviewed volume studies artificial intelligence and data science.",
};
const accepted = assessBookCall({ source, page, type: "chapter-proposal", now: new Date("2026-07-14T00:00:00Z") });
assert.equal(accepted.admitted, true);
assert.equal(accepted.deadline.date.toISOString(), "2026-09-30T23:59:00.000Z");

const bogus = assessBookCall({ source, page: { ...page, url: "https://random-books.example/call", text: `${page.text} Guaranteed publication via WhatsApp.` }, type: "chapter-proposal" });
assert.equal(bogus.admitted, false);
assert.ok(bogus.reasons.includes("not-on-approved-publisher-domain"));
assert.ok(bogus.reasons.includes("predatory-or-guaranteed-publication-language"));

const rolling = assessBookCall({ source, page: { url: "https://press.example.edu/authors", text: "We welcome book proposals in artificial intelligence. All books undergo external review." }, type: "book-proposal" });
assert.equal(rolling.admitted, true);
assert.equal(rolling.rolling, true);
assert.equal(extractBookCallDeadline("Proposal deadline: 31 October 2026").date.toISOString(), "2026-10-31T23:59:00.000Z");
assert.equal(hostAllowed("https://books.press.example.edu/call", source.officialDomains), true);
const footerOnly = assessBookCall({
  source: { ...source, scopeKeywords: ["quantum computing"] },
  page: { url: "https://press.example.edu/authors", text: "We welcome book proposals. All books undergo peer review. Privacy policy." },
  type: "book-proposal",
});
assert.equal(footerOnly.admitted, false, "a generic privacy footer must not establish CS/AI relevance");
const reviewedOfficialRoute = assessBookCall({
  source: { ...source, scopeKeywords: ["computer science", "artificial intelligence"] },
  page: { url: "https://press.example.edu/authors", text: "Publish with our university press." },
  type: "book-proposal",
  evidenceOverrides: {
    reviewedAt: "2026-07-17",
    proposalRouteVerified: true,
    subjectFitVerified: true,
  },
});
assert.equal(reviewedOfficialRoute.admitted, true, "operator-reviewed official evidence can resolve an ambiguous generic publisher page");
assert.equal(reviewedOfficialRoute.evidence.relevance.verifiedFromConfiguredOfficialEvidence, true);
const distinctVolumes = dedupeCalls([
  { id: "a", acronym: "emerald", type: "chapter-proposal", name: "AI Education", deadline: "2026-09-30T23:59:00Z" },
  { id: "b", acronym: "emerald", type: "chapter-proposal", name: "Industry 5.0", deadline: "2026-09-30T23:59:00Z" },
]);
assert.equal(distinctVolumes.items.length, 2, "different volumes from one publisher must not collapse when deadlines match");
console.log("Book and chapter proposal integrity tests passed.");
