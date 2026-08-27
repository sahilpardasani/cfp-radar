import fs from "node:fs";
import path from "node:path";
import { isCallActive } from "./callLifecycle.js";
import { dedupeCalls } from "./dedupeCalls.js";
import { sanitizeExternalUrlFields } from "./cfpLinks.js";

const DATA_PATH = path.join(process.cwd(), "data", "book-calls.json");
const REVIEW_PATH = path.join(process.cwd(), "data", "book-call-candidates.json");

export function getActiveBookCalls(now = new Date()) {
  try {
    const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const items = dedupeCalls((store.items || []).filter((item) => isCallActive(item, now))).items
      .map((item) => sanitizeExternalUrlFields(item, ["callUrl", "seriesUrl", "cfpUrl", "url"]))
      .filter((item) => item.callUrl)
      .sort((a, b) => {
        if (a.rolling !== b.rolling) return a.rolling ? 1 : -1;
        return new Date(a.deadline || "9999-12-31") - new Date(b.deadline || "9999-12-31");
      });
    let reviewItems = [];
    try {
      reviewItems = (JSON.parse(fs.readFileSync(REVIEW_PATH, "utf8")).items || [])
        .filter((item) => isCallActive(item, now))
        .map((item) => sanitizeExternalUrlFields(item, ["callUrl"]))
        .filter((item) => item.callUrl);
    } catch {}
    return { ...store, count: items.length, reviewCount: reviewItems.length, items, reviewItems };
  } catch {
    return { updatedAt: null, source: "empty", count: 0, reviewCount: 0, items: [], reviewItems: [] };
  }
}
