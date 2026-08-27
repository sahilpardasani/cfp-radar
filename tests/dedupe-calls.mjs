import assert from "node:assert/strict";
import fs from "node:fs";
import { callIdentityKey, dedupeCalls } from "../lib/dedupeCalls.js";

const sameWorkshopA = { id: "a", type: "workshop", acronym: "WMT 2026", name: "WMT at EMNLP", deadline: "2026-08-07T23:59:00-12:00", topics: ["translation"] };
const sameWorkshopB = { id: "b", type: "workshop", acronym: "WMT 2026", name: "Conference on Machine Translation", deadline: "2026-08-07T23:59:00-12:00", topics: ["multilingual"], cfpUrl: "https://example.org/wmt" };
const laterRound = { ...sameWorkshopB, id: "c", deadline: "2026-09-01T23:59:00-12:00" };
assert.equal(callIdentityKey(sameWorkshopA), callIdentityKey(sameWorkshopB));
const fixture = dedupeCalls([sameWorkshopA, sameWorkshopB, laterRound]);
assert.equal(fixture.items.length, 2, "same call merges but a different deadline remains separate");
assert.deepEqual(new Set(fixture.items[0].topics), new Set(["translation", "multilingual"]));
assert.equal(fixture.duplicates.length, 1);

const live = JSON.parse(fs.readFileSync("data/cfps.json", "utf8")).items;
const result = dedupeCalls(live);
assert.equal(result.items.length + result.duplicates.length, live.length);
console.log(`Deduplication tests passed: ${result.duplicates.length} duplicate live records detected for pruning.`);
