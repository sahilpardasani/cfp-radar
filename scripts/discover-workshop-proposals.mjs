#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { duckDuckGoSearch, fetchPage, looksOfficial } from "../lib/webDiscovery.js";
import { extractWorkshopProposalDeadline, isWorkshopOrganizerCall } from "../lib/workshopProposalDiscovery.js";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "data", "workshop-proposal-sources.json");
const DATA_PATH = path.join(ROOT, "data", "workshop-proposals.json");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const write = (file, value) => {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
};

async function resolveSource(source, dependencies = {}) {
  const search = dependencies.search || duckDuckGoSearch;
  const fetch = dependencies.fetch || fetchPage;
  const candidates = [];
  const errors = [];
  let successfulFetches = 0;

  try {
    if (source.officialUrl) candidates.push(source.officialUrl);
    if (!source.officialUrl && source.searchQuery) {
      for (const result of await search(source.searchQuery, 8)) candidates.push(result.url);
    }
  } catch (error) {
    return {
      status: "error",
      source,
      error: String(error?.message || error),
      code: error?.code || "SEARCH_FAILED",
    };
  }

  for (const url of candidates) {
    try {
      if (!source.officialUrl && !looksOfficial(url, { acronym: source.conference })) continue;
      const page = await fetch(url, 15000, 1);
      successfulFetches++;
      if (!isWorkshopOrganizerCall(page.text)) continue;
      const deadline = extractWorkshopProposalDeadline(page.text, source.deadlineLabels);
      if (!deadline) continue;
      return { status: "matched", source, page, deadline };
    } catch (error) {
      errors.push({ url, error: String(error?.message || error), code: error?.code || "FETCH_FAILED" });
    }
  }

  if (candidates.length && successfulFetches === 0 && errors.length) {
    return {
      status: "error",
      source,
      error: errors.map((entry) => `${entry.url}: ${entry.error}`).join(" | "),
      code: errors[0].code,
    };
  }
  return { status: "no-current-call", source };
}

async function main() {
  const now = new Date();
  const config = read(SOURCES_PATH, { sources: [] });
  const store = read(DATA_PATH, { source: "verified official conference calls", items: [] });
  const results = await Promise.all((config.sources || []).map(resolveSource));
  const items = (store.items || []).filter((item) => new Date(item.deadline) >= now);
  const sourceErrors = results.filter((result) => result.status === "error");
  let refreshed = 0;

  for (const result of results.filter((entry) => entry.status === "matched")) {
    if (result.deadline.date < now) continue;
    const id = `${result.source.id}-workshop-proposals`;
    const existing = items.find((item) => item.id === id);
    const discovered = {
      id,
      conference: result.source.conference,
      name: existing?.name || "Call for Workshop Proposals",
      domain: result.source.domain || "Computer Science",
      deadline: result.deadline.date.toISOString(),
      deadlineTimezone: existing?.deadlineTimezone || "See official call",
      eventDates: existing?.eventDates || null,
      location: existing?.location || null,
      cfpUrl: result.page.url,
      submissionUrl: existing?.submissionUrl || null,
      submissionPlatform: result.source.submissionPlatform || existing?.submissionPlatform || null,
      requirements: existing?.requirements || null,
      verifiedAt: now.toISOString(),
      deadlineEvidence: result.deadline.evidence,
    };
    if (existing) Object.assign(existing, discovered);
    else items.push(discovered);
    refreshed++;
  }

  items.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  write(DATA_PATH, {
    ...store,
    updatedAt: now.toISOString(),
    checkedSources: (config.sources || []).length,
    successfulSourceChecks: results.length - sourceErrors.length,
    sourceErrors: sourceErrors.map((result) => ({
      id: result.source.id,
      conference: result.source.conference,
      code: result.code,
      detail: result.error,
      checkedAt: now.toISOString(),
    })),
    items,
  });
  for (const result of sourceErrors) {
    console.warn(`Workshop proposal source unavailable (${result.source.id}): ${result.error}`);
  }
  console.log(`Workshop proposal discovery: checked ${config.sources.length} configured conferences; refreshed ${refreshed}; ${items.length} open calls; ${sourceErrors.length} temporarily unavailable.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

export const __test = { resolveSource };
