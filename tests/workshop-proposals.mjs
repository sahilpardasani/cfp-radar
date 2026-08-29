import assert from "node:assert/strict";
import fs from "node:fs";
import { extractWorkshopProposalDeadline, isWorkshopOrganizerCall } from "../lib/workshopProposalDiscovery.js";
import { __test as discoveryTest } from "../scripts/discover-workshop-proposals.mjs";

const config = JSON.parse(fs.readFileSync("data/workshop-proposal-sources.json", "utf8"));
const store = JSON.parse(fs.readFileSync("data/workshop-proposals.json", "utf8"));

const chi = "We invite you to submit a workshop proposal. Organizer submission deadline: Thursday, October 1, 2026.";
const parsed = extractWorkshopProposalDeadline(chi, ["Organizer submission deadline"], new Date("2026-07-14"));
assert.equal(parsed.date.toISOString(), "2026-10-01T23:59:00.000Z");
assert.equal(isWorkshopOrganizerCall(chi), true);
assert.ok(config.sources.length >= 5, "expected a useful configurable source list");
assert.ok(store.items.length >= 4, "expected verified open organizer calls");

for (const item of store.items) {
  assert.match(item.cfpUrl, /^https?:\/\//);
  assert.ok(item.deadline);
  assert.ok(item.conference);
}

const abortedSearch = Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
const transientResult = await discoveryTest.resolveSource(
  { id: "future-venue", conference: "Future Venue 2027", searchQuery: "future venue workshops" },
  { search: async () => { throw abortedSearch; } },
);
assert.equal(transientResult.status, "error");
assert.equal(transientResult.code, "ABORT_ERR");
assert.match(transientResult.error, /operation was aborted/i);

console.log(`Workshop proposals OK: ${config.sources.length} configured sources; ${store.items.length} verified calls.`);
