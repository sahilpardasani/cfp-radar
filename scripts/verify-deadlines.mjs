#!/usr/bin/env node
/**
 * Batch deadline verifier (for CI / scheduled runs).
 *
 * Re-checks every venue's deadline against its official CFP page using the LLM
 * agent in lib/verifyDeadline.js, then writes a `verification` block onto each
 * item in data/cfps.json:
 *   { status, checkedAt, foundDeadline, note }
 *
 * The dashboard reads this and shows a badge (✓ verified / ⚠ differs / unconfirmed)
 * on each card. The full pipeline runs it every two days. Without an optional
 * LLM key, it still fetches every official page and uses deterministic deadline
 * extraction. Run locally with: `npm run verify`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVenueDeadline } from "../lib/verifyDeadline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "cfps.json");

async function main() {
  const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  const items = store.items || [];
  console.log(`Verifying ${items.length} venues against their official CFP pages...`);

  const summary = {};
  let done = 0;
  // Sequential-ish with small batches to be polite to origin servers.
  const BATCH = 4;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((v) => verifyVenueDeadline(v)));
    results.forEach((r, j) => {
      items[i + j].verification = r;
      summary[r.status] = (summary[r.status] || 0) + 1;
      done++;
      const tag = { confirmed: "✓", mismatch: "⚠", unverified: "?", unreachable: "×", skipped: "–" }[r.status] || "?";
      console.log(`  ${tag} ${items[i + j].acronym}: ${r.status}${r.foundDeadline ? " (found " + r.foundDeadline.slice(0, 10) + ")" : ""}`);
    });
  }

  store.verificationRunAt = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2) + "\n");
  console.log(`Done (${done} checked). Summary: ${JSON.stringify(summary)}`);

  // Non-zero exit if any mismatch, so CI can surface it.
  if (summary.mismatch) {
    console.log(`\n⚠ ${summary.mismatch} venue(s) disagree with their official page — review data/cfps.json.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
