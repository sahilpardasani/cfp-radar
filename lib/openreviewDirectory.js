const MODIFIER_RE = /\s+(ARR Commitment|Direct Submissions?|Challenge|Special Track|Extended Abstracts?|Archival|Non[- ]Archival|Non[- ]Proceedings|Full|Short|Reviewers?|Authors?|Abstracts?|Late Abstracts?|Cycle\s+\d+|Proposals?|Tutorials?|Highlights?|Proceedings?|Postproceedings?|AI Paper Track|Research Track|Industry Track|Creative AI Track|Education Track|Artificial Intelligence for Social Impact Track|Innovative Applications of AI|Datasets? and Benchmarks? Track|Applied Data Science Track|Hot Off the Press Track|Late Breaking Track|Methods Track|ABCD Track|Reproducibility Track|Brave New Ideas Track|Demo and Video Track|Position Paper Track|Blue Sky Ideas Track|Shared Tasks?)$/i;

export function decodeHtml(s = "") {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function stripHtml(s = "") {
  return decodeHtml(String(s).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function timezoneOffset(name = "") {
  const n = name.toLowerCase();
  if (n.includes("eastern daylight")) return "-04:00";
  if (n.includes("eastern standard")) return "-05:00";
  if (n.includes("central daylight")) return "-05:00";
  if (n.includes("central standard")) return "-06:00";
  if (n.includes("mountain daylight")) return "-06:00";
  if (n.includes("mountain standard")) return "-07:00";
  if (n.includes("pacific daylight")) return "-07:00";
  if (n.includes("pacific standard")) return "-08:00";
  if (n.includes("greenwich") || n.includes("utc")) return "+00:00";
  return null;
}

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseOpenReviewDue(text = "") {
  const clean = stripHtml(text);
  if (/open for submissions/i.test(clean) && !/due\s+\d/i.test(clean)) return null;
  // OpenReview renders strings such as:
  // "Due 18 Jul 2026 at 07:59 Eastern Daylight Time".
  // Do not depend on whitespace boundaries after the timezone because the
  // server-rendered directory can place badges/markup immediately after it.
  const m = clean.match(/Due\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\s+at\s+(\d{1,2}):(\d{2})\s+(Eastern Daylight Time|Eastern Standard Time|Central Daylight Time|Central Standard Time|Mountain Daylight Time|Mountain Standard Time|Pacific Daylight Time|Pacific Standard Time|Greenwich Mean Time|UTC|AoE)/i);
  if (!m) return null;
  const month = MONTH[m[2].slice(0, 3).toLowerCase()];
  const offset = m[6].toLowerCase() === "aoe" ? "-12:00" : timezoneOffset(m[6]);
  if (!month || !offset) return null;
  const iso = `${m[3]}-${String(month).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}T${String(m[4]).padStart(2, "0")}:${m[5]}:00${offset}`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function canonicalOpenReviewUrl(hrefOrGroupId = "") {
  const raw = decodeHtml(String(hrefOrGroupId)).trim();
  if (!raw) return "https://openreview.net/";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `https://openreview.net${raw}`;
  // Keep slashes readable in the group id. OpenReview accepts the canonical
  // query form and this avoids double-encoding ids copied from its directory.
  return `https://openreview.net/group?id=${raw}`;
}

export function parseOpenReviewDirectory(html = "") {
  const source = String(html);

  // The homepage contains a broad "Active Venues" directory and a later
  // "Open for Submissions" section. For CFP cards, the latter is the source
  // of truth because it carries the exact display title, current due time and
  // canonical group link shown by OpenReview.
  const marker = source.search(/Open for Submissions/i);
  const openSection = marker >= 0 ? source.slice(marker) : source;
  const entries = [];

  // Accept both relative and absolute canonical OpenReview group links and
  // preserve query parameters such as referrer. The group id itself is read
  // from the id= parameter rather than reconstructed from the visible title.
  const re = /<a\b[^>]*href=["']([^"']*\bgroup\?[^"']*\bid=([^&"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...openSection.matchAll(re)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    let groupId = decodeHtml(match[2]);
    try { groupId = decodeURIComponent(groupId); } catch { /* preserve literal id */ }

    const exactHref = decodeHtml(match[1]);
    const title = stripHtml(match[3]);
    if (!groupId || !title || /^OpenReview$/i.test(title)) continue;

    // The status belongs to the text between this venue link and the next
    // venue link. Keep a generous bound because the due badge can be wrapped
    // in several nested elements in different OpenReview deployments.
    const relativeIndex = match.index || 0;
    const end = matches[i + 1]?.index ?? Math.min(openSection.length, relativeIndex + match[0].length + 2400);
    const nearby = stripHtml(openSection.slice(relativeIndex + match[0].length, end));
    const deadline = parseOpenReviewDue(nearby);
    const status = /open for submissions/i.test(nearby) ? "open" : deadline ? "due" : "active";

    entries.push({
      groupId,
      title,
      deadline,
      status,
      url: canonicalOpenReviewUrl(exactHref),
      rawStatus: nearby.slice(0, 280),
    });
  }

  // The same group may occur elsewhere on the homepage. Prefer the occurrence
  // carrying an actual due date, otherwise keep the latest open-section item.
  const byId = new Map();
  for (const entry of entries) {
    const old = byId.get(entry.groupId);
    if (!old || (!old.deadline && entry.deadline) || entry.status === "open") {
      byId.set(entry.groupId, entry);
    }
  }
  return [...byId.values()];
}

export function baseVenueTitle(title = "") {
  let s = String(title).replace(/\s+/g, " ").trim();
  // Strip only known trailing track/role modifiers. Repeat because e.g.
  // "Workshop X Direct Submission ARR Commitment" has two modifiers.
  let prev;
  do { prev = s; s = s.replace(MODIFIER_RE, "").trim(); } while (s !== prev);

  // Conference-level tracks collapse under the parent event.
  if (!/\b(?:Workshop|Challenge)\b/i.test(s)) {
    const m = s.match(/^(.*?\b20\d{2})(?:\s+(?:Conference|Symposium|Meeting))?(?:\s+.*?Track)?$/i);
    if (m && /\bTrack\b/i.test(title)) return m[1].trim();
  }
  return s;
}

export function trackLabel(title = "", base = baseVenueTitle(title)) {
  const full = String(title).replace(/\s+/g, " ").trim();
  if (full.toLowerCase() === base.toLowerCase()) return "Main submission";
  let suffix = full.slice(base.length).trim();
  suffix = suffix.replace(/^[-–—:]+\s*/, "");
  return suffix || "Main submission";
}

export function canonicalVenueKey(title = "") {
  return baseVenueTitle(title)
    .toLowerCase()
    .replace(/\bconference\b|\bsymposium\b|\bmeeting\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function groupOpenReviewEntries(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const base = baseVenueTitle(entry.title);
    const key = canonicalVenueKey(base);
    if (!key) continue;
    const group = groups.get(key) || { key, title: base, entries: [] };
    group.entries.push({ ...entry, track: trackLabel(entry.title, base) });
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    const deadlineBuckets = new Map();
    for (const e of g.entries) {
      const k = e.deadline || "open-no-deadline";
      const bucket = deadlineBuckets.get(k) || { deadline: e.deadline, tracks: [], links: [] };
      if (!bucket.tracks.includes(e.track)) bucket.tracks.push(e.track);
      bucket.links.push({ label: e.track, url: e.url, groupId: e.groupId });
      deadlineBuckets.set(k, bucket);
    }
    return {
      ...g,
      deadlines: [...deadlineBuckets.values()].sort((a, b) => {
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      }),
      primary: g.entries[0],
    };
  });
}
