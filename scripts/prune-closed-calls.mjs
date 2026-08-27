#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { partitionCalls } from "../lib/callLifecycle.js";
import { dedupeCalls } from "../lib/dedupeCalls.js";

const ROOT = process.cwd();
const ARCHIVE_PATH = path.join(ROOT, "data", "closed-calls.json");
const stores = [
  { path: path.join(ROOT, "data", "cfps.json"), collection: "cfp" },
  { path: path.join(ROOT, "data", "workshop-proposals.json"), collection: "workshop-proposal" },
  { path: path.join(ROOT, "data", "book-calls.json"), collection: "book-call" },
  { path: path.join(ROOT, "data", "reviewer-calls.json"), collection: "reviewer-call" },
];
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeAtomic = (file, value) => {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
};

const now = new Date();
const archive = read(ARCHIVE_PATH, { updatedAt: null, items: [] });
const archivedByKey = new Map((archive.items || []).map((item) => [`${item.collection}:${item.id}`, item]));
let removed = 0;

for (const storeInfo of stores) {
  const store = read(storeInfo.path, { items: [] });
  const { active, closed } = partitionCalls(store.items, now);
  const deduplicated = dedupeCalls(active);
  const duplicateRecords = deduplicated.duplicates.map((item) => ({
    ...item,
    lifecycle: {
      status: "deprecated",
      reason: "duplicate-record",
      duplicateOf: item.duplicateOf,
      archivedAt: now.toISOString(),
    },
  }));
  for (const item of [...closed, ...duplicateRecords]) {
    archivedByKey.set(`${storeInfo.collection}:${item.id}`, { ...item, collection: storeInfo.collection });
  }
  if (closed.length || duplicateRecords.length) {
    writeAtomic(storeInfo.path, { ...store, updatedAt: now.toISOString(), items: deduplicated.items });
    removed += closed.length + duplicateRecords.length;
  }
  console.log(`${storeInfo.collection}: ${closed.length} closed/ineligible and ${duplicateRecords.length} duplicates removed; ${deduplicated.items.length} active retained.`);
}

archive.updatedAt = now.toISOString();
archive.items = [...archivedByKey.values()].map((item) =>
  item.lifecycle?.reason?.startsWith("unverified-")
    ? { ...item, lifecycle: { ...item.lifecycle, status: "deprecated" } }
    : item
).sort((a, b) =>
  String(b.lifecycle?.closedAt || "").localeCompare(String(a.lifecycle?.closedAt || ""))
);
writeAtomic(ARCHIVE_PATH, archive);
console.log(`Pruning complete: ${removed} calls archived in ${path.relative(ROOT, ARCHIVE_PATH)}.`);
