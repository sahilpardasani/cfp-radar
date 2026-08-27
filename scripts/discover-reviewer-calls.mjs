#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { mapLimit } from "../lib/asyncPool.js";
import { fetchPage } from "../lib/webDiscovery.js";
import { assessReviewerPage, reviewerFreshnessExpiry } from "../lib/reviewerCallDiscovery.js";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "data", "reviewer-call-sources.json");
const DATA_PATH = path.join(ROOT, "data", "reviewer-calls.json");
const REJECTIONS_PATH = path.join(ROOT, "data", "reviewer-call-rejections.json");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const write = (file, value) => {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
};

async function inspectSource(source, now) {
  try {
    const page = await fetchPage(source.officialUrl, Number(process.env.DISCOVERY_FETCH_TIMEOUT_MS) || 15000, 1);
    const assessment = assessReviewerPage({ source, page, now });
    return { status: assessment.admitted ? "active" : "inactive", source, page, assessment };
  } catch (error) {
    return { status: "error", source, error: String(error?.message || error) };
  }
}

async function main() {
  const now = new Date();
  const config = read(SOURCES_PATH, { freshnessDays: 6, sources: [] });
  const store = read(DATA_PATH, { source: "verified official venue reviewer calls", items: [] });
  const existing = new Map((store.items || []).map((item) => [item.id, item]));
  const rejected = [];
  const concurrency = Math.max(1, Number(process.env.REVIEWER_DISCOVERY_CONCURRENCY) || 6);
  const results = await mapLimit(config.sources || [], concurrency, (source) => inspectSource(source, now));
  let refreshed = 0;

  for (const result of results) {
    const { source } = result;
    if (result.status === "inactive") {
      existing.delete(source.id);
      rejected.push({
        id: source.id,
        venue: source.venue,
        officialUrl: source.officialUrl,
        checkedAt: now.toISOString(),
        reasons: result.assessment.reasons,
      });
      continue;
    }
    if (result.status === "error") {
      const previous = existing.get(source.id);
      if (!previous || new Date(previous.expiresAt || previous.deadline || 0) <= now) existing.delete(source.id);
      rejected.push({
        id: source.id,
        venue: source.venue,
        officialUrl: source.officialUrl,
        checkedAt: now.toISOString(),
        reasons: ["temporary-fetch-failure"],
        detail: result.error,
      });
      continue;
    }

    const { page, assessment } = result;
    refreshed++;
    const deadline = assessment.deadline?.date || null;
    const expiresAt = deadline
      ? null
      : reviewerFreshnessExpiry(now, source.reviewEndsAt, Number(config.freshnessDays) || 6);
    existing.set(source.id, {
      id: source.id,
      type: "reviewer-call",
      venue: source.venue,
      acronym: source.acronym,
      venueType: source.venueType || "Conference",
      role: source.role || "Paper Reviewer",
      name: `${source.venue} Call for ${source.role === "Ethics Reviewer" ? "Ethics Reviewers" : "Reviewers"}`,
      domain: source.domain || "Computer Science",
      callUrl: page.url,
      applicationUrl: assessment.applicationUrl,
      deadline: deadline?.toISOString() || undefined,
      rolling: !deadline,
      expiresAt: expiresAt?.toISOString(),
      reviewEndsAt: source.reviewEndsAt || undefined,
      reviewPeriod: source.reviewPeriod || undefined,
      eventDates: source.eventDates || undefined,
      location: source.location || undefined,
      eligibility: source.eligibility || undefined,
      verifiedAt: now.toISOString(),
      deadlineEvidence: assessment.deadline?.evidence,
      integrity: { level: "trusted", officialPage: true, explicitRecruitment: true },
    });
  }

  const items = [...existing.values()]
    .filter((item) => new Date(item.deadline || item.expiresAt || 0) > now)
    .sort((a, b) => new Date(a.deadline || a.reviewEndsAt || "9999-12-31") - new Date(b.deadline || b.reviewEndsAt || "9999-12-31"));
  write(DATA_PATH, {
    ...store,
    updatedAt: now.toISOString(),
    checkedSources: (config.sources || []).length,
    items,
  });
  write(REJECTIONS_PATH, { updatedAt: now.toISOString(), items: rejected });
  console.log(`Reviewer-call discovery: checked ${config.sources.length}; refreshed ${refreshed}; ${items.length} active; rejected or unavailable ${rejected.length}.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
