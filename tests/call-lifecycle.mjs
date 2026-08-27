import assert from "node:assert/strict";
import { callClosure, isCallActive, partitionCalls } from "../lib/callLifecycle.js";

const now = new Date("2026-07-14T16:00:00Z");
assert.equal(isCallActive({ type: "conference", deadline: "2026-07-14T15:59:59Z" }, now), false);
assert.equal(isCallActive({ type: "workshop", deadline: "2026-07-14T16:00:01Z" }, now), true);
assert.equal(isCallActive({ type: "special-issue", deadline: "2026-07-14T16:00:00Z" }, now), false);
assert.equal(isCallActive({ type: "journal", deadline: null }, now), true, "rolling journals remain active");
assert.equal(isCallActive({ type: "conference", deadlineTBD: true }, now), true);
assert.equal(isCallActive({ type: "workshop", deadline: null }, now), false, "unqualified finite calls are not immortal");
assert.equal(callClosure({ status: "closed", type: "journal" }, now).active, false);
assert.equal(isCallActive({
  source: "current-open-call-seed", type: "workshop", deadline: "2026-08-01T00:00:00Z",
  cfpUrl: "https://conference.example.org/workshops",
}, now), false, "unverified lead snapshots must never appear as live CFPs");
assert.equal(isCallActive({
  source: "current-open-call-seed", type: "workshop", deadline: "2026-08-01T00:00:00Z",
  cfpUrl: "https://workshop.example.org/cfp",
  discoveryEvidence: { officialWorkshopPage: "https://workshop.example.org/cfp" },
}, now), true, "officially enriched seed may become live");

const result = partitionCalls([
  { id: "paper", type: "conference", deadline: "2026-07-01T00:00:00Z" },
  { id: "special", type: "special-issue", deadline: "2026-08-01T00:00:00Z" },
  { id: "proposal", type: "workshop-proposal", deadline: "2026-06-01T00:00:00Z" },
], now);
assert.deepEqual(result.active.map((item) => item.id), ["special"]);
assert.deepEqual(result.closed.map((item) => item.id), ["paper", "proposal"]);
console.log("Call lifecycle tests passed.");
