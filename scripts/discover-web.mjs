#!/usr/bin/env node
/**
 * Bounded, resumable multi-source CFP discovery.
 *
 * Watchlist venues are established identities, but the current call and a future
 * submission deadline must still be verified on an official page.
 * WikiCFP is only a lead source. Outside-watchlist venues must resolve to an
 * official CFP and pass deepLegitimacyCheck before admission.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepLegitimacyCheck } from "../lib/legitimacy.js";
import { externalAdmissionDecision } from "../lib/admissionPolicy.js";
import { mapLimit } from "../lib/asyncPool.js";
import {
  classifyDiscoverySource, discoverWikiCfpLeads, inferVenueFromPage, norm,
  resolveOfficialCfp, searchWatchlistVenue, extractDeadlineTracks,
  selectOpenSubmissionTrack,
} from "../lib/webDiscovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data", "cfps.json");
const WATCH = path.join(ROOT, "data", "watchlist.json");
const STATE = path.join(ROOT, "data", "discovery-state.json");
const REJECTS = path.join(ROOT, "data", "discovery-rejections.json");
const year = Number(process.env.CFP_YEAR) || new Date().getUTCFullYear();
const maxExternal = process.env.MAX_EXTERNAL_CANDIDATES == null ? 100 : Number(process.env.MAX_EXTERNAL_CANDIDATES);
const watchBatch = process.env.WATCHLIST_BATCH_SIZE == null ? 500 : Number(process.env.WATCHLIST_BATCH_SIZE);
const concurrency = Math.max(1, Math.min(20, Number(process.env.DISCOVERY_CONCURRENCY) || 8));
const dryRun = process.env.DISCOVERY_DRY_RUN === "1";
const focusLead = process.env.WIKICFP_LEAD_URL || "";
const focusWatchlistAcronym = norm(process.env.WATCHLIST_ACRONYM || "");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
function slug(s) { return norm(s).replace(/ /g, "-"); }
function existingMatch(items, venue) {
  const a = norm(venue.acronym).replace(/\b20\d{2}\b/g, "").trim();
  const n = norm(venue.name);
  return items.some(x => {
    const xa = norm(x.acronym).replace(/\b20\d{2}\b/g, "").trim();
    const xn = norm(x.name);
    return (a && xa === a) || (n && (xn === n || xn.includes(n) || n.includes(xn)));
  });
}
function candidateFrom(venue, result, source, fromWatchlist) {
  const selected = result.selectedTrack || selectOpenSubmissionTrack(result.deadlineTracks || []);
  if (!selected) throw new Error("No open submission track found on official page");
  return {
    id: `${fromWatchlist ? "watch-web" : "external"}-${slug(venue.acronym || venue.name)}-${year}-${selected.type}`,
    name: venue.name, acronym: venue.acronym, type: venue.type || "conference",
    domain: venue.field || "Computer Science / AI", tier: fromWatchlist ? (venue.tier || "established") : "community",
    conferenceRank: fromWatchlist ? (venue.conferenceRank || null) : null,
    conferenceRankRaw: fromWatchlist ? (venue.conferenceRankRaw || null) : null,
    conferenceRankSource: fromWatchlist ? (venue.rankingSource || null) : null,
    conferenceRankingUrl: fromWatchlist ? (venue.rankingUrl || null) : null,
    source, topics: [venue.field || "computer science", "artificial intelligence"],
    abstractDeadline: selected.type === "abstract_submission" ? selected.date.toISOString() : null,
    deadline: selected.date.toISOString(), deadlineType: selected.type,
    notification: null, eventDates: null, location: null,
    url: result.page.url, cfpUrl: result.page.url,
    submissionUrl: result.submissionLinks?.[0]?.url || null, templateUrl: null,
    format: { style: null, pageLimit: null, anonymized: null, references: null },
    fromWatchlist, discoveredAt: new Date().toISOString(),
    discoveryEvidence: {
      officialPage: result.page.url, deadlineFoundOnOfficialPage: true,
      selectedSubmissionTrack: selected.type, selectedDeadlineEvidence: selected.raw,
      allDeadlineTracks: (result.deadlineTracks || []).map(t => ({ type: t.type, date: t.date.toISOString(), raw: t.raw })),
      leadSource: result.searchResult?.url || null,
      submissionPlatforms: (result.submissionLinks || []).map(x => x.url),
    },
  };
}
function rejectionRecord(lead, stage, reason, retryable = false) {
  return { lead: lead?.url || lead, title: lead?.title || null, stage, reason, retryable, checkedAt: new Date().toISOString() };
}

async function processWatchVenue(venue, items) {
  if (existingMatch(items, venue)) return { kind: "skip" };
  try {
    const found = await searchWatchlistVenue(venue, year);
    if (!found) return { kind: "not-open" };
    const candidate = candidateFrom({ ...venue, type: "conference" }, found, classifyDiscoverySource(found.page.url), true);
    candidate.legitimacy = { level: "trusted", checkedAt: new Date().toISOString(), basis: "established-watchlist-identity-and-current-official-cfp" };
    candidate.admission = { status: "trusted", checkedAt: new Date().toISOString(), source: "backend-watchlist-web-discovery", rationale: "Established watchlist identity; official current CFP and an open submission track verified." };
    return { kind: "admit", candidate };
  } catch (e) {
    return { kind: "error", rejection: rejectionRecord(venue.acronym, "watchlist-current-call", e.message, /NETWORK|timeout|fetch/i.test(`${e.code} ${e.message}`)) };
  }
}

async function processExternalLead(lead, items) {
  try {
    const page = await resolveOfficialCfp(lead.url);
    const tracks = extractDeadlineTracks(page.text);
    const selectedTrack = selectOpenSubmissionTrack(tracks);
    if (!selectedTrack) return { kind: "reject", rejection: rejectionRecord(lead, "deadline", "No future paper-submission track found on the official page") };
    const inferred = inferVenueFromPage(page, lead.title);
    if (!inferred.name || existingMatch(items, inferred)) return { kind: "skip" };
    const result = {
      page, selectedTrack, deadlineTracks: tracks, deadline: selectedTrack.date, searchResult: lead,
      submissionLinks: page.links.filter(x => /cmt3\.research\.microsoft|easychair|hotcrp|openreview|paperplaza|edas\.info/i.test(x.url)),
    };
    const candidate = candidateFrom(inferred, result, "wikicfp-lead", false);
    candidate.discoveryEvidence.wikicfpLead = lead.url;
    const vetted = await deepLegitimacyCheck(candidate);
    const decision = externalAdmissionDecision(candidate, vetted);
    if (!decision.admitted) {
      return { kind: "reject", rejection: rejectionRecord(lead, "legitimacy", `Outside-watchlist venue failed rigorous admission: ${decision.reasons.join("; ")}`) };
    }
    candidate.legitimacy = {
      level: "trusted", checkedAt: vetted.checkedAt, proceedings: vetted.proceedings,
      ranking: vetted.ranking, parentConference: vetted.parentConference,
      publisherEvidence: vetted.publisherEvidence,
    };
    candidate.admission = { status: "trusted", confidence: decision.confidence, checkedAt: vetted.checkedAt, source: "backend-external-discovery", rationale: "Official CFP and future deadline verified; identity and publication history independently corroborated." };
    return { kind: "admit", candidate };
  } catch (e) {
    const retryable = /NETWORK|timeout|fetch|HTTP 429|HTTP 5/i.test(`${e.code} ${e.message}`);
    return { kind: retryable ? "defer" : "reject", rejection: rejectionRecord(lead, "resolve-official-cfp", e.message, retryable) };
  }
}

async function main() {
  const store = readJson(DATA, { items: [] });
  const watch = readJson(WATCH, { conferences: [], journals: [] });
  const state = readJson(STATE, { watchCursor: 0, deferredExternal: [] });
  const rejections = readJson(REJECTS, { items: [] });
  const items = [...(store.items || [])];
  let watchAdded = 0, externalAdded = 0, externalRejected = 0, deferred = 0;

  const allWatch = focusWatchlistAcronym
    ? (watch.conferences || []).filter((venue) => norm(venue.acronym) === focusWatchlistAcronym)
    : (watch.conferences || []);
  if (focusWatchlistAcronym && !allWatch.length) {
    throw new Error(`No watchlist venue found for WATCHLIST_ACRONYM=${process.env.WATCHLIST_ACRONYM}`);
  }
  const start = allWatch.length ? state.watchCursor % allWatch.length : 0;
  const batch = Array.from({ length: Math.min(watchBatch, allWatch.length) }, (_, i) => allWatch[(start + i) % allWatch.length]);
  const watchResults = await mapLimit(batch, concurrency, v => processWatchVenue(v, items));
  for (const r of watchResults) {
    if (r.kind === "admit" && !existingMatch(items, r.candidate)) { items.push(r.candidate); watchAdded++; console.log(`+ watchlist: ${r.candidate.acronym} → ${r.candidate.deadline.slice(0,10)} (${r.candidate.deadlineType})`); }
    if (r.rejection) rejections.items.push(r.rejection);
  }
  if (!focusWatchlistAcronym) {
    state.watchCursor = allWatch.length ? (start + batch.length) % allWatch.length : 0;
  }

  let leads;
  if (focusLead) leads = [{ url: focusLead, title: process.env.WIKICFP_LEAD_TITLE || focusLead }];
  else if (maxExternal <= 0) leads = [];
  else {
    const discovered = await discoverWikiCfpLeads(year);
    const deferredLeads = (state.deferredExternal || []).map(x => ({ url: x.url, title: x.title || x.url }));
    const seen = new Set(); leads = [...deferredLeads, ...discovered].filter(x => x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, maxExternal);
  }
  state.deferredExternal = [];
  const extResults = await mapLimit(leads, concurrency, lead => processExternalLead(lead, items));
  for (let i = 0; i < extResults.length; i++) {
    const r = extResults[i], lead = leads[i];
    if (r.kind === "admit" && !existingMatch(items, r.candidate)) { items.push(r.candidate); externalAdded++; console.log(`+ external verified: ${r.candidate.acronym} → ${r.candidate.deadline.slice(0,10)} (${r.candidate.deadlineType})`); }
    else if (r.kind === "defer") { deferred++; state.deferredExternal.push({ url: lead.url, title: lead.title, attempts: 1, lastError: r.rejection.reason }); rejections.items.push(r.rejection); console.warn(`~ deferred network failure: ${lead.url}`); }
    else if (r.kind === "reject") { externalRejected++; rejections.items.push(r.rejection); console.warn(`- rejected external lead: ${r.rejection.reason}`); }
  }

  rejections.items = rejections.items.slice(-500);
  if (!dryRun && (watchAdded || externalAdded)) {
    store.items = items; store.updatedAt = new Date().toISOString();
    store.source = "curated + OpenReview + bounded multi-source discovery + verified external leads";
    writeJson(DATA, store);
  }
  writeJson(STATE, { ...state, lastRunAt: new Date().toISOString(), lastSummary: { watchAdded, externalAdded, externalRejected, deferred, watchBatch: batch.length } });
  writeJson(REJECTS, rejections);
  console.log(`Discovery complete: ${watchAdded} watchlist added; ${externalAdded} external admitted; ${externalRejected} external rejected; ${deferred} deferred; ${batch.length}/${allWatch.length} watchlist venues checked.`);
}

main().catch(e => { console.error(e); process.exit(1); });
