import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeConferenceBaseline } from "../scripts/snapshot-conference-ids.mjs";
import { __test as historySyncTest } from "../scripts/sync-venue-history.mjs";

const workflow = fs.readFileSync(".github/workflows/pipeline.yml", "utf8");
const historyWorkflow = fs.readFileSync(".github/workflows/venue-history.yml", "utf8");

assert.match(workflow, /cron:\s*"17 4 \*\/2 \* \*"/, "the full pipeline must run every two days");

for (const command of [
  "npm run scrape",
  "npm run sync:rankings",
  "npm run sync:workshops",
  "npm run watchlist",
  "npm run sync:workshop-proposals",
  "npm run discover:web",
  "npm run sync:book-calls",
  "npm run sync:reviewer-calls",
  "npm run verify",
  "npm run legitimacy",
  "npm run audit:refresh",
  "npm run prune:closed",
  "npm run snapshot:conference-ids",
  "npm run expand:venue-history -- --reuse-journals",
  "npm run sync:venue-history -- --new-conferences-from=",
]) {
  assert.ok(workflow.includes(command), `scheduled pipeline is missing: ${command}`);
}

assert.doesNotMatch(
  workflow,
  /\|\|\s*echo\s+["']?[^"'\n]*soft-failed/i,
  "a required call family must not silently soft-fail",
);

assert.match(historyWorkflow, /npm run sync:venue-history/);
assert.match(historyWorkflow, /data\/venue-history-coverage\.json/);
assert.match(historyWorkflow, /cron:\s*"37 5 \* \* 1"/, "verified scholarly history should refresh weekly");
assert.match(workflow, /data\/venue-history-pending\.json/);

for (const workflowName of fs.readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"))) {
  const source = fs.readFileSync(`.github/workflows/${workflowName}`, "utf8");
  if (/\bgit push\b/.test(source)) {
    assert.match(source, /group:\s*cfp-data-pipeline/, `${workflowName} must serialize writes to shared CFP data`);
  }
}

const baselinePath = path.join(os.tmpdir(), `cfp-radar-baseline-${process.pid}.json`);
try {
  writeConferenceBaseline(baselinePath, ["existing-conf"], new Date("2026-08-02T12:00:00Z"));
  assert.deepEqual([...historySyncTest.readConferenceBaseline(baselinePath)], ["existing-conf"]);
} finally {
  fs.rmSync(baselinePath, { force: true });
}

const incrementalConfig = {
  venues: [{ id: "demo-history", match: { callIds: ["new-demo-conf"] }, externalIds: { dblpStream: "conf/demo" } }],
};
const incremental = historySyncTest.incrementalSelection(
  incrementalConfig,
  [{ id: "existing-conf", type: "conference" }, { id: "new-demo-conf", type: "conference" }],
  { previousIds: new Set(["existing-conf"]), shardMatches: () => true },
);
assert.deepEqual(incremental.newCalls.map((call) => call.id), ["new-demo-conf"]);
assert.deepEqual([...incremental.venueIds], ["demo-history"], "a newly added exact-mapped conference must trigger history sync");

console.log("Pipeline cadence OK: every call family runs every two days, new conferences trigger history sync, and full history refreshes weekly.");
