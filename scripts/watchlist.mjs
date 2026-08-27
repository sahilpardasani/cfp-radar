#!/usr/bin/env node
/**
 * Watchlist matcher (backend only).
 *
 * Reads data/watchlist.json — a list of conferences/journals we track (mined from
 * the user's publication lists) — and, on every pipeline run, checks whether any of
 * them currently has an OPEN CFP. When a watched venue opens (a future submission
 * deadline appears on OpenReview), it is injected into data/cfps.json as a live card
 * so it shows up on the dashboard automatically. Journals on the watchlist are matched
 * against Crossref to confirm they're indexed before being surfaced.
 *
 * The frontend never reads watchlist.json — only cfps.json. Run: `npm run watchlist`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepLegitimacyCheck } from "../lib/legitimacy.js";
import { mapLimit } from "../lib/asyncPool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "cfps.json");
const WATCH = path.join(__dirname, "..", "data", "watchlist.json");
const API = "https://api2.openreview.net";
const CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.WATCHLIST_CONCURRENCY) || 10));

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "CFP-Radar-Watchlist/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const SUBMISSION_SUFFIXES = ["/-/Submission", "/-/Blind_Submission"];
async function confirmJournal(journal) {
  try {
    const q = encodeURIComponent(journal.name);
    const data = await getJSON(`https://api.crossref.org/journals?query=${q}&rows=5`);
    const items = data?.message?.items || [];
    const target = norm(journal.name);
    const match = items.find((x) => {
      const title = norm(x.title || x["container-title"] || "");
      return title === target || title.includes(target) || target.includes(title);
    });
    return match || null;
  } catch {
    return null;
  }
}

async function fetchDueDate(venueId) {
  for (const suf of SUBMISSION_SUFFIXES) {
    try {
      const d = await getJSON(`${API}/invitations?id=${encodeURIComponent(venueId + suf)}`);
      const inv = d?.invitations?.[0];
      if (inv && typeof inv.duedate === "number") return inv.duedate;
    } catch {}
  }
  return null;
}

async function main() {
  const store = JSON.parse(fs.readFileSync(DATA, "utf-8"));
  const watch = JSON.parse(fs.readFileSync(WATCH, "utf-8"));
  const byId = new Map((store.items || []).map((c) => [c.id, c]));
  const existingAcr = new Set((store.items || []).map((c) => norm(c.acronym)));
  const nowMs = Date.now();

  let active = [];
  try {
    const g = await getJSON(`${API}/groups?id=active_venues`);
    active = g?.groups?.[0]?.members || [];
  } catch (e) {
    console.warn(`OpenReview unreachable (${e.message}); watchlist match skipped this run.`);
  }

  const conf = watch.conferences || [];
  const conferenceResults = await mapLimit(conf, CONCURRENCY, async (w) => {
    const acr = norm(w.acronym);
    if (!acr) return { kind: "skip" };
    // Already on the dashboard?
    if (existingAcr.has(acr)) return { kind: "skip" };
    // Find an active OpenReview venue whose id contains the acronym as a token.
    const match = active.find((id) => new RegExp(`(^|[^a-z0-9])${acr.replace(/ /g, "[^a-z0-9]*")}([^a-z0-9]|$)`, "i").test(id));
    if (!match) return { kind: "waiting", acronym: w.acronym };
    const due = await fetchDueDate(match);
    if (!due || due <= nowMs) return { kind: "waiting", acronym: w.acronym };
    const id = "watch-" + match.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (byId.has(id)) return { kind: "skip" };
    const candidate = {
      id,
      name: w.name,
      acronym: w.acronym,
      type: "conference",
      domain: w.field || "AI (General)",
      tier: w.tier || "community",
      conferenceRank: w.conferenceRank || null,
      conferenceRankRaw: w.conferenceRankRaw || null,
      conferenceRankSource: w.rankingSource || null,
      conferenceRankingUrl: w.rankingUrl || null,
      source: "openreview",
      topics: [w.field || "computer science"],
      abstractDeadline: null,
      deadline: new Date(due).toISOString(),
      notification: null,
      eventDates: null,
      location: null,
      url: `https://openreview.net/group?id=${match}`,
      cfpUrl: `https://openreview.net/group?id=${match}`,
      templateUrl: null,
      format: { style: null, pageLimit: null, anonymized: null, references: null },
      openreviewId: match,
      fromWatchlist: true,
      discoveredAt: new Date().toISOString(),
    };
    const vetted = await deepLegitimacyCheck(candidate);
    if (vetted.level !== "trusted") {
      return { kind: "rejected", acronym: w.acronym };
    }
    candidate.legitimacy = { level: "trusted", checkedAt: vetted.checkedAt, proceedings: vetted.proceedings, ranking: vetted.ranking, parentConference: vetted.parentConference, publisherEvidence: vetted.publisherEvidence };
    candidate.admission = { status: "trusted", checkedAt: vetted.checkedAt, source: "backend-watchlist" };
    return { kind: "admit", candidate, match };
  });

  let opened = 0;
  const stillWatching = [];
  for (const result of conferenceResults) {
    if (result.kind === "waiting") stillWatching.push(result.acronym);
    if (result.kind === "rejected") {
      stillWatching.push(result.acronym);
      console.warn(`  - ${result.acronym} found open but not admitted: legitimacy check did not pass`);
    }
    if (result.kind === "admit" && !byId.has(result.candidate.id)) {
      byId.set(result.candidate.id, result.candidate);
      opened++;
      console.log(`  + ${result.candidate.acronym} opened → ${result.candidate.deadline.slice(0, 10)} (via ${result.match})`);
    }
  }

  const journals = watch.journals || [];
  const existingJournalNames = new Set([...byId.values()].map((item) => norm(item.name)));
  const journalResults = await mapLimit(journals, CONCURRENCY, async (j) => {
    if (existingJournalNames.has(norm(j.name))) return { kind: "skip" };
    const indexed = await confirmJournal(j);
    if (!indexed) return { kind: "not-indexed" };
    const id = "watch-journal-" + norm(j.name).replace(/ /g, "-");
    const candidate = {
      id,
      name: j.name,
      acronym: j.acronym,
      type: "journal",
      domain: j.field || "AI (General)",
      tier: "indexed",
      publisher: j.publisher || indexed.publisher || null,
      source: "crossref",
      topics: [...new Set([j.field || "computer science", ...(j.topics || [])])],
      abstractDeadline: null,
      deadline: null,
      notification: null,
      eventDates: "Rolling submissions",
      location: null,
      url: j.officialUrl || indexed.URL || `https://search.crossref.org/?q=${encodeURIComponent(j.name)}`,
      cfpUrl: j.officialUrl || indexed.URL || null,
      templateUrl: null,
      format: { style: j.publisher || null, pageLimit: null, anonymized: null, references: null },
      fromWatchlist: true,
      indexing: { source: "Crossref", issn: indexed.ISSN || [] },
      issn: indexed.ISSN || [],
      discoveredAt: new Date().toISOString(),
    };
    const vetted = await deepLegitimacyCheck(candidate);
    if (vetted.level !== "trusted") {
      return { kind: "rejected", acronym: j.acronym };
    }
    candidate.legitimacy = { level: "trusted", checkedAt: vetted.checkedAt, proceedings: vetted.proceedings, ranking: vetted.ranking, parentConference: vetted.parentConference, publisherEvidence: vetted.publisherEvidence };
    candidate.admission = { status: "trusted", checkedAt: vetted.checkedAt, source: "backend-watchlist" };
    return { kind: "admit", candidate };
  });

  let journalsAdded = 0;
  for (const result of journalResults) {
    if (result.kind === "rejected") console.warn(`  - ${result.acronym} matched Crossref but not admitted: SCImago/identity legitimacy check did not pass`);
    if (result.kind === "admit" && !byId.has(result.candidate.id)) {
      byId.set(result.candidate.id, result.candidate);
      journalsAdded++;
      console.log(`  + ${result.candidate.acronym} indexed journal added (rolling submissions)`);
    }
  }

  if (opened || journalsAdded) {
    store.items = [...byId.values()];
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(DATA, JSON.stringify(store, null, 2) + "\n");
  }
  console.log(`Watchlist: ${conf.length} conferences and ${journals.length} journals checked with concurrency ${CONCURRENCY}; ${opened} newly open, ${stillWatching.length} waiting, ${journalsAdded} indexed journals added.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
