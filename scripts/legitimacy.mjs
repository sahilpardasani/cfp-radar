#!/usr/bin/env node
/**
 * Autonomous legitimacy pass (for CI / scheduled runs).
 *
 * For every venue it runs the deep legitimacy check — an autonomous Crossref
 * proceedings-history lookup (confirms an established series by acronym match),
 * plus the heuristic red-flag screen and an optional LLM read of the CFP page —
 * and stamps the result onto each item in data/cfps.json as:
 *   "legitimacy": { "level", "reasons", "proceedings": {...}, "llm": {...}, "checkedAt" }
 *
 * The dashboard then shows a resolved Trusted / Caution verdict WITHOUT the user
 * having to check anything. Runs weekly via .github/workflows/legitimacy.yml.
 * The LLM layer needs GROQ_API_KEY (optional); the Crossref + heuristic layers
 * need no key. Run: `npm run legitimacy`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepLegitimacyCheck } from "../lib/legitimacy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "cfps.json");

async function main() {
  const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  const items = store.items || [];
  console.log(`Vetting ${items.length} venues (proceedings history + red-flag screen)...`);

  const summary = {};
  const BATCH = 4;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((v) => deepLegitimacyCheck(v)));
    results.forEach((r, j) => {
      items[i + j].legitimacy = {
        level: r.level,
        reasons: r.reasons,
        proceedings: r.proceedings,
        ranking: r.ranking || null,
        parentConference: r.parentConference || null,
        publisherEvidence: r.publisherEvidence || null,
        evidenceQuality: r.evidenceQuality || null,
        llm: r.llm || null,
        checkedAt: r.checkedAt,
      };
      summary[r.level] = (summary[r.level] || 0) + 1;
      const tag = { trusted: "✓", review: "?", caution: "⚠" }[r.level] || "?";
      const ed = r.proceedings?.established ? ` [${r.proceedings.editionsFound} eds]` : "";
      console.log(`  ${tag} ${items[i + j].acronym}: ${r.level}${ed}`);
    });
  }

  store.legitimacyRunAt = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2) + "\n");
  console.log(`Done. Summary: ${JSON.stringify(summary)}`);
  if (summary.caution) console.log(`\n⚠ ${summary.caution} venue(s) flagged Caution — review data/cfps.json.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
