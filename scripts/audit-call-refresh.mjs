#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MAX_AGE_MINUTES = Math.max(
  1,
  Number(process.env.MAX_PIPELINE_REFRESH_AGE_MINUTES || 480),
);
const now = Date.now();

function read(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function assertRecent(label, value) {
  const checkedAt = new Date(value).getTime();
  if (!Number.isFinite(checkedAt)) {
    throw new Error(`${label} has no valid refresh timestamp.`);
  }
  const ageMinutes = (now - checkedAt) / 60_000;
  if (ageMinutes < -5 || ageMinutes > MAX_AGE_MINUTES) {
    throw new Error(
      `${label} was not refreshed in this pipeline run ` +
      `(age ${ageMinutes.toFixed(1)} minutes; limit ${MAX_AGE_MINUTES}).`,
    );
  }
}

function configuredCount(relativePath, key) {
  const config = read(relativePath);
  return (config[key] || []).length;
}

const cfps = read("data/cfps.json");
assertRecent("Conference, workshop-paper, journal, and special-issue catalog", cfps.verificationRunAt);
for (const item of cfps.items || []) {
  assertRecent(`CFP ${item.id || item.acronym || item.name}`, item.verification?.checkedAt);
}

const workshopProposals = read("data/workshop-proposals.json");
assertRecent("Workshop-organizer calls", workshopProposals.updatedAt);
const workshopSourceCount = configuredCount("data/workshop-proposal-sources.json", "sources");
if (workshopProposals.checkedSources !== workshopSourceCount) {
  throw new Error(
    `Workshop-organizer source coverage is incomplete: ` +
    `${workshopProposals.checkedSources ?? 0}/${workshopSourceCount}.`,
  );
}

const bookCalls = read("data/book-calls.json");
assertRecent("Book and chapter calls", bookCalls.updatedAt);
const publisherCount = configuredCount("data/book-call-sources.json", "publishers");
if (bookCalls.checkedPublishers !== publisherCount) {
  throw new Error(
    `Book/chapter publisher coverage is incomplete: ` +
    `${bookCalls.checkedPublishers ?? 0}/${publisherCount}.`,
  );
}

const reviewerCalls = read("data/reviewer-calls.json");
assertRecent("Reviewer calls", reviewerCalls.updatedAt);
const reviewerSourceCount = configuredCount("data/reviewer-call-sources.json", "sources");
if (reviewerCalls.checkedSources !== reviewerSourceCount) {
  throw new Error(
    `Reviewer-call source coverage is incomplete: ` +
    `${reviewerCalls.checkedSources ?? 0}/${reviewerSourceCount}.`,
  );
}

console.log(
  `Refresh audit passed: ${(cfps.items || []).length} paper/journal calls, ` +
  `${workshopSourceCount} workshop-organizer sources, ${publisherCount} publishers, ` +
  `and ${reviewerSourceCount} reviewer sources were checked.`,
);
