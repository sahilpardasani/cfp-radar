import {
  parseOpenReviewDirectory,
  groupOpenReviewEntries,
  canonicalVenueKey,
  canonicalOpenReviewUrl,
  parseOpenReviewDue,
} from "./openreviewDirectory.js";
import {
  fetchPage,
  extractDeadlineTracks,
  selectOpenSubmissionTrack,
  duckDuckGoSearch,
  resolveOfficialCfp,
  venueMatchScore,
  extractSubmissionOpening,
} from "./webDiscovery.js";
import { mapLimit } from "./asyncPool.js";
import { isCallActive } from "./callLifecycle.js";
import { dedupeCalls } from "./dedupeCalls.js";

const OPENREVIEW_HOME = "https://openreview.net/";
const API = "https://api2.openreview.net";
const CACHE_MS = Number(process.env.OPENREVIEW_RUNTIME_CACHE_MS || 5 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.OPENREVIEW_RUNTIME_TIMEOUT_MS || 20000);
const CONCURRENCY = Math.max(1, Number(process.env.OPENREVIEW_RUNTIME_CONCURRENCY || 20));
const RETRIES = Math.max(0, Number(process.env.OPENREVIEW_RUNTIME_RETRIES || 2));
const SUBMISSION_INVITATION_SUFFIXES = ["Submission", "Blind_Submission", "Paper_Submission"];
const INVITATION_BATCH_SIZE = Math.max(10, Math.min(50, Number(process.env.OPENREVIEW_INVITATION_BATCH_SIZE || 50)));
const GROUP_BATCH_SIZE = Math.max(10, Math.min(50, Number(process.env.OPENREVIEW_GROUP_BATCH_SIZE || 50)));
const SEARCH_OFFICIAL = process.env.OPENREVIEW_SEARCH_OFFICIAL === "1";

let memoryCache = { at: 0, value: null };
const OFFICIAL_CACHE_MS = Number(process.env.OPENREVIEW_OFFICIAL_CACHE_MS || 24 * 60 * 60 * 1000);
const officialEvidenceCache = new Map();

function clean(s = "") {
  return String(s).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function unwrap(v) {
  if (v == null) return null;
  if (typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) return unwrap(v.value);
  return v;
}

function getContent(group, key) {
  return unwrap(group?.content?.[key]);
}

function parseMaybeJson(value) {
  const v = unwrap(value);
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function niceName(id) {
  const parts = String(id)
    .split("/")
    .filter(Boolean)
    .filter((p) => !/\.(com|org|net|edu|ai|cc|io|gov|lat)$/i.test(p));
  return clean(parts.join(" "));
}

function groupTitle(group, groupId) {
  const override = parseMaybeJson(getContent(group, "homepage_override"));
  const candidates = [
    override?.title,
    getContent(group, "title"),
    getContent(group, "venue_name"),
    getContent(group, "name"),
    getContent(group, "subtitle"),
  ].map(clean).filter(Boolean);
  return candidates[0] || niceName(groupId);
}

function classifyType(title = "") {
  if (/journal|TMLR|JMLR|DMLR|MELBA/i.test(title)) return "journal";
  if (/workshop|symposium|challenge|competition|shared task|doctoral symposium|tutorial/i.test(title)) return "workshop";
  return "conference";
}

function domainFor(s = "") {
  const x = s.toLowerCase();
  const map = [
    [/medical|clinical|health|miccai|mlhc|ml4h|radi|mri|oct/, "Medical AI"],
    [/cvpr|iccv|eccv|wacv|bmvc|vision|image|video|3d/, "Computer Vision"],
    [/acl|emnlp|naacl|eacl|coling|colm|nlp|language|speech|text/, "Natural Language Processing"],
    [/robot|icra|iros|corl|rss|manipulation|navigation/, "Robotics"],
    [/kdd|wsdm|cikm|icdm|data.?min/, "Data Mining"],
    [/security|privacy|crypto|sec/, "Security & Privacy"],
    [/chi|hci|human|user|interaction|ubicomp/, "Human-Computer Interaction"],
    [/fair|responsible|ethic|facct|social impact/, "Responsible AI"],
    [/system|mlsys|network|distributed|hipeac/, "Systems & Networking"],
  ];
  for (const [re, d] of map) if (re.test(x)) return d;
  return "Computer Science / AI";
}

function acronymFor(title = "") {
  const workshop = title.match(/\bWorkshop\s+([^ ]+)/i)?.[1];
  if (workshop) return workshop;
  const challenge = title.match(/\bChallenge\s+([^ ]+)/i)?.[1];
  if (challenge) return challenge;
  const first = title.match(/^([A-Z][A-Z0-9-]{1,24})(?:\s+20\d{2})?/i)?.[1];
  return first || title.slice(0, 36);
}

function epochToIso(value) {
  const raw = unwrap(value);
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (/^\d{10,13}$/.test(String(raw))) return epochToIso(Number(raw));
  const d = new Date(String(raw));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function deadlineFromGroup(group) {
  const override = parseMaybeJson(getContent(group, "homepage_override"));
  const direct = [
    override?.deadline,
    getContent(group, "submission_deadline"),
    getContent(group, "abstract_submission_deadline"),
    getContent(group, "paper_submission_deadline"),
    getContent(group, "deadline"),
  ];
  for (const v of direct) {
    const iso = epochToIso(v) || parseOpenReviewDue(String(v || ""));
    if (iso) return iso;
  }
  return null;
}

const CALL_RE = /(submission|submit|abstract|commitment|challenge|competition|shared.?task|proposal|paper|track)/i;
const NON_CFP_RE = /(camera.?ready|notification|rebuttal|discussion|official.?review|meta.?review|decision|withdraw|desk.?reject|revision|ethics.?review|review.?form|reviewers?|authors?|registration|application)/i;
const WORKSHOP_ORGANIZER_RE = /(?:call for |\b)(?:workshop|tutorial)[ _-]*(?:proposals?|proposal submissions?)\b/i;

function isWorkshopOrganizerCall(value = "") {
  return WORKSHOP_ORGANIZER_RE.test(clean(value));
}

function invitationDeadline(inv) {
  return epochToIso(inv?.duedate) || epochToIso(inv?.expdate);
}

function invitationOpensAt(inv) {
  return epochToIso(inv?.cdate) || epochToIso(inv?.date) || epochToIso(inv?.tmdate);
}

function isOpenCallInvitation(inv, now = Date.now()) {
  const id = clean(inv?.id || "");
  if (!id || NON_CFP_RE.test(id) || !CALL_RE.test(id)) return false;
  const due = invitationDeadline(inv);
  const opens = invitationOpensAt(inv);
  // A current call must already have opened and must not have expired.
  if (!due || new Date(due).getTime() <= now) return false;
  if (opens && new Date(opens).getTime() > now) return false;
  return true;
}

function officialUrlFromGroup(group) {
  const override = parseMaybeJson(getContent(group, "homepage_override"));
  const values = [
    override?.website, override?.homepage, override?.url, override?.venue_website,
    getContent(group, "website"), getContent(group, "homepage"),
    getContent(group, "venue_website"), getContent(group, "conference_website"),
    getContent(group, "workshop_website"), getContent(group, "url"),
  ];
  for (const raw of values) {
    const value = unwrap(raw);
    if (typeof value !== "string") continue;
    const match = value.match(/https?:\/\/[^\s<>"]+/i);
    if (match && !/openreview\.net/i.test(match[0])) return match[0].replace(/[),.;]+$/, "");
  }
  return null;
}

async function officialCfpEvidence(group, title) {
  const cacheKey = `${group?.id || title}`;
  const cached = officialEvidenceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OFFICIAL_CACHE_MS) return cached.value;

  const venue = {
    name: title,
    acronym: acronymFor(title),
    type: classifyType(title),
  };
  const candidates = [];
  const metadataUrl = officialUrlFromGroup(group);
  if (metadataUrl) candidates.push(metadataUrl);

  // OpenReview groups frequently omit the official website. In that case,
  // search for the exact current-year venue/workshop and resolve its CFP page.
  const year = title.match(/20\d{2}/)?.[0] || new Date().getUTCFullYear();
  const queries = [
    `"${title}" official call for papers deadline`,
    `"${venue.acronym}" ${year} official CFP submission deadline`,
  ];
  if (/workshop/i.test(title)) {
    const parent = title.match(/^(.+?20\d{2})\s+Workshop/i)?.[1];
    if (parent) queries.push(`"${parent}" workshops "${venue.acronym}"`);
  }

  if (!metadataUrl && SEARCH_OFFICIAL) {
    for (const query of queries) {
      try {
        const results = await duckDuckGoSearch(query, 8);
        for (const result of results) {
          if (/openreview\.net|wikicfp\.com/i.test(result.url)) continue;
          if (!candidates.includes(result.url)) candidates.push(result.url);
        }
      } catch { /* search failure is handled by OpenReview fallback */ }
    }
  }

  let best = null;
  for (const candidate of candidates.slice(0, 12)) {
    try {
      const page = await resolveOfficialCfp(candidate, venue);
      const score = venueMatchScore(page.text, venue);
      if (score < 0.42) continue;
      const checkedAt = new Date();
      const tracks = extractDeadlineTracks(page.text, checkedAt);
      const selected = selectOpenSubmissionTrack(tracks, checkedAt);
      const opening = extractSubmissionOpening(page.text, checkedAt);
      const evidence = {
        officialUrl: page.url || candidate,
        deadline: selected?.date?.toISOString?.() || null,
        trackType: selected?.type || null,
        tracks,
        opensAt: opening.opensAt?.toISOString?.() || null,
        explicitlyOpen: opening.explicitlyOpen,
        notYetOpen: opening.notYetOpen,
        explicitlyClosed: opening.explicitlyClosed,
        isOpenNow: opening.isOpenNow,
        score,
      };
      if (!best || (evidence.deadline && !best.deadline) || score > best.score) best = evidence;
      if (evidence.deadline && score >= 0.65) break;
    } catch { /* try the next official-page candidate */ }
  }

  const value = best || { officialUrl: metadataUrl || null, deadline: null, tracks: [], opensAt: null, explicitlyOpen: false, notYetOpen: false, explicitlyClosed: false, isOpenNow: null, score: 0 };
  officialEvidenceCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function officialDeadlineForInvitation(official, inv, now = new Date()) {
  const tracks = official?.tracks || [];
  if (!tracks.length) return official?.deadline || null;
  const label = clean(inv?.id || "").toLowerCase();
  const preferred = [];
  if (/arr.*commitment|commitment/.test(label)) preferred.push("arr_commitment");
  if (/direct.*submission/.test(label)) preferred.push("direct_submission");
  if (/challenge|shared task|competition/.test(label)) preferred.push("challenge_submission");
  if (/late breaking|hot off the press|short paper|demo|poster/.test(label)) preferred.push("late_breaking_submission");
  if (/abstract/.test(label)) preferred.push("abstract_submission");
  preferred.push("workshop_submission", "main_submission");
  for (const type of preferred) {
    const hit = tracks.filter((t) => t.type === type && t.date > now).sort((a, b) => a.date - b.date)[0];
    if (hit) return hit.date.toISOString();
  }
  return official?.deadline || null;
}

function trackNameFromInvitation(inv, title) {
  const rawId = String(inv?.id || "");
  const suffix = rawId.split("/").filter(Boolean).pop() || "Submission";
  const label = clean(suffix.replace(/[-_]/g, " "));
  if (/^(submission|blind submission|paper submission)$/i.test(label)) return title;
  return `${title} ${label}`.trim();
}

async function fetchWithRetry(url, json = true) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "CFP-Radar/3.0 (+OpenReview exhaustive mirror)" },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? res.json() : res.text();
    } catch (e) {
      last = e;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 350 * 2 ** attempt));
    }
  }
  throw last;
}

async function fetchOptionalJson(url) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "CFP-Radar/4.0 (+OpenReview current-call mirror)" },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res.json();
    } catch (error) {
      last = error;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, (error.status === 429 ? 1000 : 350) * 2 ** attempt));
    }
  }
  throw last;
}

async function submissionInvitationsForGroup(groupId) {
  // OpenReview API v2 removed the former `prefix=` query. Exact invitation ids
  // are stable and supported; almost every homepage group uses /-/Submission.
  for (const suffix of SUBMISSION_INVITATION_SUFFIXES) {
    const payload = await fetchOptionalJson(`${API}/invitations?id=${encodeURIComponent(`${groupId}/-/${suffix}`)}`);
    const invitations = payload?.invitations || [];
    if (invitations.length) return invitations;
  }
  return [];
}

async function hydrateHomepageCandidates(candidates, now = Date.now()) {
  const dueEntries = candidates.filter((entry) => entry.deadline && new Date(entry.deadline).getTime() > now);
  const unresolved = candidates.filter((entry) => !entry.deadline);
  const ids = unresolved.flatMap((entry) =>
    SUBMISSION_INVITATION_SUFFIXES.map((suffix) => `${entry.groupId}/-/${suffix}`)
  );
  const invitationBatches = [];
  for (let index = 0; index < ids.length; index += INVITATION_BATCH_SIZE) {
    invitationBatches.push(ids.slice(index, index + INVITATION_BATCH_SIZE));
  }

  const groupIds = [...new Set(candidates.map((entry) => entry.groupId).filter(Boolean))];
  const groupBatches = [];
  for (let index = 0; index < groupIds.length; index += GROUP_BATCH_SIZE) {
    groupBatches.push(groupIds.slice(index, index + GROUP_BATCH_SIZE));
  }

  // Invitation deadlines and venue metadata are independent API reads. Fetch
  // them concurrently so phase 1 remains fast while still capturing the
  // official website displayed inside each OpenReview venue page.
  const [results, groupResults] = await Promise.all([
    mapLimit(invitationBatches, 2, async (batch) => {
      try {
        const payload = await fetchOptionalJson(`${API}/invitations?ids=${encodeURIComponent(batch.join(","))}`);
        return { invitations: payload?.invitations || [], error: null, batch, kind: "invitation" };
      } catch (error) {
        return { invitations: [], error, batch, kind: "invitation" };
      }
    }),
    mapLimit(groupBatches, 4, async (batch) => {
      try {
        const payload = await fetchOptionalJson(`${API}/groups?ids=${encodeURIComponent(batch.join(","))}`);
        return { groups: payload?.groups || [], error: null, batch, kind: "group" };
      } catch (error) {
        return { groups: [], error, batch, kind: "group" };
      }
    }),
  ]);

  const groupById = new Map();
  for (const group of groupResults.flatMap((result) => result.groups)) {
    if (group?.id) groupById.set(group.id, group);
  }
  const addOfficialMetadata = (entry) => {
    const officialUrl = officialUrlFromGroup(groupById.get(entry.groupId));
    return officialUrl ? { ...entry, cfpUrl: officialUrl, officialUrl } : entry;
  };
  const invitations = results.flatMap((result) => result.invitations);
  const invitationByGroup = new Map();
  for (const invitation of invitations) {
    if (!isOpenCallInvitation(invitation, now)) continue;
    const groupId = String(invitation.id || "").replace(/\/-\/[^/]+$/, "");
    const previous = invitationByGroup.get(groupId);
    if (!previous || invitationDeadline(invitation) < invitationDeadline(previous)) {
      invitationByGroup.set(groupId, invitation);
    }
  }
  const entries = [...dueEntries];
  for (const entry of unresolved) {
    const invitation = invitationByGroup.get(entry.groupId);
    if (!invitation) continue;
    entries.push({
      ...entry,
      deadline: invitationDeadline(invitation),
      opensAt: invitationOpensAt(invitation),
      invitationId: invitation.id,
      status: "due",
      openreviewUrl: entry.url,
      deadlineSource: "openreview-api-batched-invitation",
      rawStatus: "Homepage-listed call; exact deadline hydrated from its OpenReview submission invitation.",
    });
  }
  return {
    entries: entries.map(addOfficialMetadata),
    requestFailures: [
      ...results.filter((result) => result.error),
      ...groupResults.filter((result) => result.error),
    ],
    unresolvedCount: candidates.length - entries.length,
  };
}

async function enrichActiveGroup(groupId) {
  const encoded = encodeURIComponent(groupId);
  const [groupPayload, invitationPayload] = await Promise.all([
    fetchWithRetry(`${API}/groups?id=${encoded}`).catch(() => null),
    submissionInvitationsForGroup(groupId).catch(() => []),
  ]);
  const group = groupPayload?.groups?.[0] || { id: groupId };
  const title = groupTitle(group, groupId);
  const type = classifyType(title);
  // This additive source is only for conferences/workshops/challenges, not journals or admin groups.
  if (type === "journal" || NON_CFP_RE.test(title) || isWorkshopOrganizerCall(`${title} ${groupId}`)) return [];

  const invitations = Array.isArray(invitationPayload) ? invitationPayload : [];
  const now = Date.now();
  const openCalls = invitations.filter((inv) => isOpenCallInvitation(inv, now));
  const groupDeadline = deadlineFromGroup(group);
  const official = await officialCfpEvidence(group, title);
  const openReviewUrl = canonicalOpenReviewUrl(groupId);

  const officialAllowsCurrent = official.isOpenNow !== false && !official.notYetOpen && !official.explicitlyClosed;
  const entries = (officialAllowsCurrent ? openCalls : []).map((inv) => ({
    groupId,
    title: trackNameFromInvitation(inv, title),
    opensAt: official.opensAt || invitationOpensAt(inv) || null,
    deadline: officialDeadlineForInvitation(official, inv) || invitationDeadline(inv) || groupDeadline,
    status: "due",
    url: openReviewUrl,
    openreviewUrl: openReviewUrl,
    cfpUrl: official.officialUrl || openReviewUrl,
    officialUrl: official.officialUrl,
    invitationId: inv.id,
    deadlineSource: officialDeadlineForInvitation(official, inv) ? "official-cfp" : "openreview",
    rawStatus: officialDeadlineForInvitation(official, inv)
      ? "Deadline verified on the official CFP page; OpenReview is the submission portal."
      : "Official CFP deadline unavailable; using the exact OpenReview invitation deadline.",
  })).filter((entry) => entry.deadline && new Date(entry.deadline).getTime() >= now);

  if (entries.length) return entries;

  // Do not admit a group merely because OpenReview marks it active. A fallback
  // without an open invitation is allowed only when the official CFP explicitly
  // says submissions are currently open and gives a future submission deadline.
  const fallbackDeadline = official.explicitlyOpen && official.isOpenNow
    ? [official.deadline, groupDeadline].filter(Boolean).find((d) => new Date(d).getTime() > now)
    : null;
  if (!fallbackDeadline) return [];
  return [{
    groupId,
    title,
    opensAt: official.opensAt || null,
    deadline: fallbackDeadline,
    status: "due",
    url: openReviewUrl,
    openreviewUrl: openReviewUrl,
    cfpUrl: official.officialUrl || openReviewUrl,
    officialUrl: official.officialUrl,
    deadlineSource: "official-cfp",
    rawStatus: "Official CFP explicitly confirms submissions are currently open; OpenReview is the submission portal.",
  }];
}


async function fastActiveGroupEntries(groupId) {
  const encoded = encodeURIComponent(groupId);
  const [groupPayload, invitationPayload] = await Promise.all([
    fetchWithRetry(`${API}/groups?id=${encoded}`).catch(() => null),
    submissionInvitationsForGroup(groupId).catch(() => []),
  ]);
  const group = groupPayload?.groups?.[0] || { id: groupId };
  const title = groupTitle(group, groupId);
  const type = classifyType(title);
  if (type === "journal" || NON_CFP_RE.test(title) || isWorkshopOrganizerCall(`${title} ${groupId}`)) return [];
  const now = Date.now();
  const openCalls = (Array.isArray(invitationPayload) ? invitationPayload : []).filter((inv) => isOpenCallInvitation(inv, now));
  const openReviewUrl = canonicalOpenReviewUrl(groupId);
  return openCalls.map((inv) => ({
    groupId,
    title: trackNameFromInvitation(inv, title),
    opensAt: invitationOpensAt(inv) || null,
    deadline: invitationDeadline(inv) || deadlineFromGroup(group),
    status: "due",
    url: openReviewUrl,
    openreviewUrl: openReviewUrl,
    cfpUrl: openReviewUrl,
    officialUrl: null,
    invitationId: inv.id,
    deadlineSource: "openreview-api",
    rawStatus: "Currently open OpenReview submission invitation.",
  })).filter((entry) => entry.deadline && new Date(entry.deadline).getTime() > now);
}

async function fastApiSnapshot() {
  const groups = await fetchWithRetry(`${API}/groups?id=active_venues`);
  const active = [...new Set(groups?.groups?.[0]?.members || [])];
  const results = await mapLimit(active, CONCURRENCY, async (groupId) => {
    try { return await fastActiveGroupEntries(groupId); }
    catch (error) { return { error }; }
  });
  const entries = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const value = results[i];
    if (value?.error) failures.push({ groupId: active[i], error: value.error.message });
    else entries.push(...(value || []));
  }
  if (!entries.length) throw new Error("OpenReview API returned no currently open submission invitations");
  return {
    entries,
    rawEntries: active.length,
    groups: groupOpenReviewEntries(entries),
    source: "openreview-api-fast-snapshot",
    complete: false,
    warning: failures.length ? `${failures.length} OpenReview groups will be retried on the next run.` : null,
    failures,
    checkedAt: new Date().toISOString(),
    cache: "fresh",
  };
}

async function apiExhaustiveEntries() {
  const groups = await fetchWithRetry(`${API}/groups?id=active_venues`);
  const active = [...new Set(groups?.groups?.[0]?.members || [])];
  const results = await mapLimit(active, CONCURRENCY, async (groupId) => {
    try { return await enrichActiveGroup(groupId); }
    catch (error) { return { error }; }
  });
  const entries = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r?.error) failures.push({ groupId: active[i], error: r.error.message });
    else entries.push(...(r || []));
  }
  return { entries, activeCount: active.length, failures };
}

export function homepageOpenEntriesFromHtml(html = "", now = new Date()) {
  // OpenReview itself labels this section "Open for Submissions". Treat that
  // rendered directory as the admission source of truth instead of guessing
  // whether an active venue group is open from invitation metadata.
  const parsed = parseOpenReviewDirectory(html);
  const nowMs = new Date(now).getTime();
  return parsed.filter((entry) => {
    if (entry.status === "open" && !entry.deadline) return true;
    if (!entry.deadline) return false;
    const due = new Date(entry.deadline).getTime();
    return Number.isFinite(due) && due > nowMs;
  });
}

export function homepageCandidateEntriesFromHtml(html = "") {
  // Current OpenReview SSR uses `Due ...` placeholders; retain those group ids
  // and hydrate the exact deadline from the supported invitation-id endpoint.
  return parseOpenReviewDirectory(html).filter((entry) =>
    !isWorkshopOrganizerCall(`${entry.title} ${entry.groupId}`) &&
    (entry.deadline || entry.status === "open" || /Due\s+\.\.\./i.test(entry.rawStatus || ""))
  );
}

async function fetchOpenReviewGroup(groupId) {
  try {
    const data = await fetchWithRetry(`${API}/groups?id=${encodeURIComponent(groupId)}`);
    return data?.groups?.[0] || { id: groupId, content: {} };
  } catch {
    return { id: groupId, content: {} };
  }
}

async function enrichHomepageEntry(entry) {
  const group = await fetchOpenReviewGroup(entry.groupId);
  const official = await officialCfpEvidence(group, entry.title);
  const displayedDeadline = entry.deadline;
  const officialDeadline = officialDeadlineForInvitation(official, { id: entry.title });
  const deadline = [officialDeadline, displayedDeadline]
    .filter(Boolean)
    .find((d) => Number.isFinite(new Date(d).getTime()) && new Date(d).getTime() > Date.now()) || null;
  return {
    ...entry,
    deadline,
    openreviewUrl: entry.url,
    cfpUrl: official?.officialUrl || entry.url,
    officialUrl: official?.officialUrl || null,
    deadlineSource: officialDeadline ? "official-cfp" : "openreview-homepage",
    rawStatus: officialDeadline
      ? "Official CFP deadline verified; OpenReview is the submission portal."
      : entry.rawStatus,
  };
}


export async function fetchOpenReviewHomepageSnapshot({ force = false } = {}) {
  // Fast authoritative phase. Prefer the exact homepage list; if OpenReview
  // serves a shell or blocks that request, fall back to the API invitation
  // feed without waiting for official-site enrichment.
  try {
    const html = await fetchWithRetry(OPENREVIEW_HOME, false);
    const candidates = homepageCandidateEntriesFromHtml(html);
    const hydrated = await hydrateHomepageCandidates(candidates);
    const entries = hydrated.entries;
    const failures = hydrated.requestFailures.map((result) => ({
      groupId: null,
      error: `${result.kind === "group" ? "Venue metadata" : "Invitation"} batch failed: ${result.error.message}`,
    }));
    const unresolved = hydrated.unresolvedCount;
    if (entries.length) {
      return {
        entries,
        rawEntries: candidates.length,
        groups: groupOpenReviewEntries(entries),
        source: "openreview-homepage-plus-exact-invitations",
        complete: failures.length === 0 && entries.length === candidates.length,
        warning: failures.length || unresolved
          ? `${failures.length + unresolved} of ${candidates.length} homepage calls could not be hydrated and will be retried.`
          : null,
        failures,
        checkedAt: new Date().toISOString(),
        cache: force ? "fresh" : "fresh",
      };
    }
    // If the homepage gave us venue ids but the invitation API could not
    // hydrate any of them, scanning active_venues would hit the same API
    // hundreds of additional times. Let the caller restore its last-good
    // snapshot instead, then retry this authoritative path next run.
    if (candidates.length) {
      const error = new Error(`OpenReview listed ${candidates.length} calls, but none of their exact submission invitations could be loaded`);
      error.code = "OPENREVIEW_HYDRATION_FAILED";
      throw error;
    }
  } catch (error) {
    if (error?.code === "OPENREVIEW_HYDRATION_FAILED") throw error;
    // Homepage unavailable or unparseable: retain the emergency API fallback.
  }
  return fastApiSnapshot();
}

export async function fetchOpenReviewDirectoryLive({ force = false, snapshot = null } = {}) {
  if (!force && memoryCache.value && Date.now() - memoryCache.at < CACHE_MS) {
    return { ...memoryCache.value, cache: "memory" };
  }

  // Primary architecture: use the homepage group list, whose SSR deadline text
  // is now a placeholder, then hydrate exact deadlines from invitation ids.
  // under "Open for Submissions", then enrich every entry with its official
  // conference/workshop CFP page and deadline. OpenReview remains the direct
  // submission portal; the official page becomes the card's CFP link.
  try {
    const currentSnapshot = snapshot || await fetchOpenReviewHomepageSnapshot({ force: true });
    const homepageEntries = currentSnapshot.entries;
    if (homepageEntries.length) {
      const enrichedResults = await mapLimit(homepageEntries, CONCURRENCY, async (entry) => {
        try { return { entry: await enrichHomepageEntry(entry), error: null }; }
        catch (error) { return { entry, error }; }
      });
      const failures = [];
      const entries = [];
      for (let i = 0; i < enrichedResults.length; i++) {
        const value = enrichedResults[i];
        if (value?.error) {
          failures.push({ groupId: homepageEntries[i].groupId, error: value.error.message });
          entries.push(value.entry);
        } else {
          entries.push(value.entry);
        }
      }
      const groups = groupOpenReviewEntries(entries);
      const value = {
        entries,
        rawEntries: currentSnapshot.rawEntries,
        groups,
        source: "openreview-homepage-plus-official-cfp-agent",
        complete: currentSnapshot.complete !== false && failures.length === 0,
        warning: failures.length ? `${failures.length} official CFP pages could not be enriched; OpenReview deadlines were retained.` : null,
        failures,
        checkedAt: new Date().toISOString(),
      };
      memoryCache = { at: Date.now(), value };
      return { ...value, cache: "fresh" };
    }
  } catch { /* fall through to API resilience path */ }

  const api = await apiExhaustiveEntries();
  const entries = api.entries;
  const groups = groupOpenReviewEntries(entries);
  const value = {
    entries,
    rawEntries: api.activeCount,
    groups,
    source: "openreview-api-fallback",
    complete: false,
    warning: api.failures.length
      ? `${api.failures.length} OpenReview groups could not be inspected and will be retried.`
      : "OpenReview homepage could not be parsed; using API fallback.",
    failures: api.failures,
    checkedAt: new Date().toISOString(),
  };
  memoryCache = { at: Date.now(), value };
  return { ...value, cache: "fresh" };
}

function existingMatch(items, group) {
  const key = group.key;
  const year = group.title.match(/20\d{2}/)?.[0];
  const acronym = acronymFor(group.title).toLowerCase();
  const groupIds = new Set(group.entries.map((entry) => entry.groupId).filter(Boolean));

  // OpenReview identities are exact. A fuzzy acronym match must never attach
  // one group's invitation/deadline to a different OpenReview-created card.
  const exactGroup = items.find((c) =>
    (c.openreviewTracks || []).some((track) => groupIds.has(track.groupId)) ||
    (c.openreviewLinks || []).some((link) => groupIds.has(link.groupId))
  );
  if (exactGroup) return exactGroup;

  const exactTitle = items.find((c) => canonicalVenueKey(c.name || c.acronym || "") === key);
  if (exactTitle) return exactTitle;

  // Fuzzy matching is only for a curated card that has not yet been linked to
  // OpenReview. It is deliberately unavailable between live OpenReview cards.
  return items.find((c) => {
    if (c.source === "openreview" || c.openreviewMirror) return false;
    const hay = `${c.acronym || ""} ${c.name || ""}`.toLowerCase();
    const tokens = new Set(hay.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []);
    return Boolean(year && hay.includes(year) && acronym.length >= 3 && tokens.has(acronym));
  });
}

function openReviewData(group) {
  const deadlines = group.deadlines.map((d) => ({
    deadline: d.deadline,
    tracks: d.tracks,
    links: d.links,
  }));
  const dated = deadlines
    .filter((d) => d.deadline)
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const primaryLink = group.entries[0]?.openreviewUrl || group.entries[0]?.url;
  const officialCfpUrl = group.entries.find((e) => e.cfpUrl && !/openreview\.net/i.test(e.cfpUrl))?.cfpUrl || null;
  return {
    openreviewPrimaryDeadline: dated[0]?.deadline || null,
    openreviewDeadlineStatus: dated.length ? "open-submission" : "openreview-active-no-public-deadline",
    openreviewTracks: group.entries.map((e) => ({
      name: e.track,
      opensAt: e.opensAt || null,
      deadline: e.deadline,
      url: e.openreviewUrl || e.url,
      cfpUrl: e.cfpUrl || null,
      deadlineSource: e.deadlineSource || "openreview",
      groupId: e.groupId,
      invitationId: e.invitationId,
    })),
    openreviewDeadlines: deadlines,
    openreviewUrl: primaryLink,
    officialCfpUrl,
    openreviewLinks: group.entries.map((e) => ({ label: e.track, url: e.url, groupId: e.groupId })),
    openreviewMirror: true,
  };
}

export function mergeOpenReviewIntoStore(staticItems = [], live) {
  const items = staticItems
    .filter((c) => !isWorkshopOrganizerCall(`${c.name || ""} ${(c.openreviewTracks || []).map((track) => track.groupId).join(" ")}`))
    .filter((c) => c.source !== "openreview" || (live.complete === false && isCallActive(c, new Date(live.checkedAt || Date.now()))))
    .map((c) => ({ ...c }));
  let merged = 0;
  let added = 0;

  for (const group of live.groups || []) {
    const data = openReviewData(group);
    const match = existingMatch(items, group);
    if (match) {
      Object.assign(match, data, { updatedAt: live.checkedAt });
      merged++;
      continue;
    }
    const type = classifyType(group.title);
    const domain = domainFor(group.title);
    items.push({
      id: `or-${group.key.replace(/[^a-z0-9]+/g, "-")}`,
      name: group.title,
      acronym: acronymFor(group.title),
      type,
      domain,
      tier: type === "workshop" ? "workshop" : "community",
      source: "openreview",
      topics: [domain],
      publisher: "OpenReview",
      legitimacy: { level: "trusted", basis: "Live OpenReview open/active venue source." },
      admission: { status: "trusted", checkedAt: live.checkedAt, source: live.source },
      discoveredAt: live.checkedAt,
      updatedAt: live.checkedAt,
      ...data,
      deadline: data.openreviewPrimaryDeadline,
      deadlineStatus: data.openreviewDeadlineStatus,
      cfpUrl: data.officialCfpUrl || data.openreviewUrl,
      url: data.officialCfpUrl || data.openreviewUrl,
    });
    added++;
  }

  return {
    items: dedupeCalls(items).items,
    sync: {
      checkedAt: live.checkedAt,
      activeDirectoryEntries: live.rawEntries ?? live.entries?.length ?? 0,
      openCallEntries: live.entries?.length || 0,
      eligibleConferenceWorkshopEntries: live.entries?.length || 0,
      directoryEntries: live.entries?.length || 0,
      groupedCards: live.groups?.length || 0,
      mirroredEntries: live.entries?.length || 0,
      mergedWithExistingCards: merged,
      addedCards: added,
      failedGroups: live.failures?.length || 0,
      source: live.source,
      cache: live.cache,
      warning: live.warning || null,
    },
  };
}

export const __test = {
  epochToIso,
  deadlineFromGroup,
  isOpenCallInvitation,
  invitationOpensAt,
  trackNameFromInvitation,
  groupTitle,
  officialUrlFromGroup,
  officialDeadlineForInvitation,
  isWorkshopOrganizerCall,
  homepageOpenEntriesFromHtml,
  homepageCandidateEntriesFromHtml,
  submissionInvitationsForGroup,
  hydrateHomepageCandidates,
};
