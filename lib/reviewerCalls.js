import fs from "node:fs";
import path from "node:path";
import { isCallActive } from "./callLifecycle.js";
import { dedupeCalls } from "./dedupeCalls.js";
import { sanitizeExternalUrlFields } from "./cfpLinks.js";

const DATA_PATH = path.join(process.cwd(), "data", "reviewer-calls.json");

export function getActiveReviewerCalls(now = new Date()) {
  try {
    const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const items = dedupeCalls((store.items || []).filter((item) => isCallActive(item, now))).items
      .map((item) => sanitizeExternalUrlFields(item, ["applicationUrl", "callUrl"]))
      .filter((item) => item.applicationUrl && item.callUrl)
      .sort((a, b) => {
        const left = new Date(a.deadline || a.reviewEndsAt || "9999-12-31").getTime();
        const right = new Date(b.deadline || b.reviewEndsAt || "9999-12-31").getTime();
        return left - right;
      });
    return { ...store, count: items.length, items };
  } catch {
    return { updatedAt: null, source: "empty", count: 0, items: [] };
  }
}
