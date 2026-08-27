import fs from "node:fs";
import path from "node:path";
import { isCallActive } from "./callLifecycle.js";
import { dedupeCalls } from "./dedupeCalls.js";
import { sanitizeExternalUrlFields } from "./cfpLinks.js";

const DATA_PATH = path.join(process.cwd(), "data", "workshop-proposals.json");

export function getActiveWorkshopProposals(now = new Date()) {
  try {
    const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const items = dedupeCalls((store.items || [])
      .filter((item) => isCallActive(item, now))).items
      .map((item) => sanitizeExternalUrlFields(item, ["cfpUrl", "submissionUrl"]))
      .filter((item) => item.cfpUrl)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    return { ...store, count: items.length, items };
  } catch {
    return { updatedAt: null, source: "empty", count: 0, items: [] };
  }
}
