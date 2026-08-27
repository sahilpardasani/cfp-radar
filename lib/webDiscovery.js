import { mapLimit } from "./asyncPool.js";
import { fetchRemote, readResponseText } from "./safeFetch.js";

/**
 * Multi-source CFP discovery helpers.
 * WikiCFP/search engines are lead sources only. A current official page is always
 * required before a call can be admitted.
 */

const UA = "CFP-Radar-Discovery/4.0 (+academic CFP verification)";
const SUBMISSION_HOSTS = [
  "cmt3.research.microsoft.com", "easychair.org", "openreview.net", "hotcrp.com",
  "springernature.com", "springer.com", "edas.info", "softconf.com",
  "precisionconference.com", "paperplaza.net",
];
const OFFICIAL_HOST_HINTS = [
  ".acm.org", ".ieee.org", ".computer.org", ".aaai.org", ".aclweb.org",
  ".neurips.cc", ".icml.cc", ".iclr.cc", ".thecvf.com", ".usenix.org",
  ".springer.com", ".edu", ".ac.uk", ".de", ".fr", ".org"
];
const CFP_LINK_RE = /(call[-_ ]?for[-_ ]?papers?|cfp|submission|important[-_ ]?dates?|author[-_ ]?information|dates?)/i;

function norm(s) { return (s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim(); }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function htmlText(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
function linksFrom(html, base) {
  const out = []; const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html || ""))) { try { out.push({ url: new URL(m[1], base).toString(), text: htmlText(m[2]) }); } catch {} }
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchPage(url, timeoutMs = Number(process.env.DISCOVERY_FETCH_TIMEOUT_MS) || 12000, retries = 1) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { response: res, finalUrl } = await fetchRemote(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        timeoutMs,
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
      const html = await readResponseText(res, 2 * 1024 * 1024);
      return { url: finalUrl, html, text: htmlText(html), links: linksFrom(html, finalUrl) };
    } catch (e) {
      last = e;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
  }
  const err = new Error(`Fetch failed for ${url}: ${last?.message || "unknown error"}`);
  err.code = last?.name === "TimeoutError" ? "NETWORK_TIMEOUT" : (last?.code || "NETWORK_ERROR");
  throw err;
}

export async function duckDuckGoSearch(query, max = 10) {
  const page = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const results = [];
  for (const link of page.links) {
    if (!/result__a/i.test(link.text + " " + link.url) && !link.url.includes("uddg=")) continue;
    let target = link.url;
    try { const u = new URL(target); target = u.searchParams.get("uddg") || target; } catch {}
    if (!/^https?:/i.test(target) || hostOf(target).includes("duckduckgo.com")) continue;
    results.push({ url: target, title: link.text }); if (results.length >= max) break;
  }
  if (!results.length) {
    for (const link of page.links) {
      let target = link.url; try { target = new URL(target).searchParams.get("uddg") || target; } catch {}
      if (/^https?:/i.test(target) && !hostOf(target).includes("duckduckgo.com")) {
        results.push({ url: target, title: link.text }); if (results.length >= max) break;
      }
    }
  }
  return results;
}

const MONTHS = { jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11 };
function parseCandidateDate(raw, fallbackYear) {
  const s = raw.replace(/[,]/g, " ").replace(/\s+/g, " ").trim(); let m;
  m = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(20\d{2})\b/i);
  if (m && MONTHS[m[1].toLowerCase()] != null) return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], 23, 59));
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(20\d{2})\b/i);
  if (m && MONTHS[m[2].toLowerCase()] != null) return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 23, 59));
  m = s.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 23, 59));
  m = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (m && MONTHS[m[1].toLowerCase()] != null && fallbackYear) return new Date(Date.UTC(fallbackYear, MONTHS[m[1].toLowerCase()], +m[2], 23, 59));
  return null;
}

function applyDeadlineTimezone(date, context) {
  if (!date) return null;
  // AoE means 23:59 at UTC-12. The parser's default is 23:59 UTC, so shift
  // the instant by twelve hours before it is stored and localized for users.
  if (/\b(?:AoE|Anywhere\s+on\s+Earth|UTC\s*[-−]\s*12)\b/i.test(context || "")) {
    return new Date(date.getTime() + 12 * 60 * 60 * 1000);
  }
  return date;
}

const TRACKS = [
  { type: "main_submission", re: /(?:main\s+track\s+|full[- ]?paper\s+|paper\s+)?submission\s+deadline/i, priority: 1 },
  { type: "main_submission", re: /(?:papers?|submissions?)\s+(?:are\s+)?due/i, priority: 1 },
  { type: "abstract_submission", re: /abstract\s+(?:registration\s+)?deadline/i, priority: 2 },
  { type: "late_breaking_submission", re: /(?:late[- ]?breaking|hot[- ]?off[- ]?the[- ]?press|short\s+paper|demo|poster)\s+(?:paper\s+)?submission\s+deadline/i, priority: 3 },
  { type: "workshop_submission", re: /workshop\s+(?:paper\s+)?submission\s+deadline/i, priority: 3 },
  { type: "arr_commitment", re: /ARR\s+commitment(?:\s+deadline)?/i, priority: 2 },
  { type: "direct_submission", re: /direct\s+submissions?(?:\s+deadline)?/i, priority: 2 },
  { type: "challenge_submission", re: /(?:challenge|shared\s+task|competition)\s+(?:paper\s+)?submission\s+deadline/i, priority: 3 },
  { type: "camera_ready", re: /camera[- ]?ready|final\s+(?:paper|manuscript)/i, priority: 99 },
  { type: "notification", re: /notification|acceptance\s+notice/i, priority: 99 },
  { type: "registration", re: /(?:author\s+)?registration/i, priority: 99 },
];

export function extractDeadlineTracks(text, now = new Date()) {
  const plain = String(text || "");
  const yearHint = Number((plain.match(/\b20\d{2}\b/) || [])[0]) || now.getUTCFullYear();
  const candidates = [];
  const lineLike = plain.split(/(?<=[.;|])\s+|\n+/).filter(Boolean);
  for (const chunk of lineLike) {
    let labels = TRACKS.filter(t => t.re.test(chunk));
    if (!labels.length) continue;
    // Specific tracks override the generic "submission deadline" matcher.
    // This prevents a late-breaking or workshop deadline from being mislabeled
    // as the main-paper deadline merely because the phrase also contains
    // "submission deadline".
    if (labels.some(t => t.type === "late_breaking_submission")) {
      labels = labels.filter(t => t.type === "late_breaking_submission");
    } else if (labels.some(t => t.type === "arr_commitment")) {
      labels = labels.filter(t => t.type === "arr_commitment");
    } else if (labels.some(t => t.type === "direct_submission")) {
      labels = labels.filter(t => t.type === "direct_submission");
    } else if (labels.some(t => t.type === "challenge_submission")) {
      labels = labels.filter(t => t.type === "challenge_submission");
    } else if (labels.some(t => t.type === "workshop_submission")) {
      labels = labels.filter(t => t.type === "workshop_submission");
    } else if (labels.some(t => t.type === "abstract_submission")) {
      labels = labels.filter(t => t.type === "abstract_submission");
    } else if (labels.some(t => ["camera_ready", "notification", "registration"].includes(t.type))) {
      labels = labels.filter(t => ["camera_ready", "notification", "registration"].includes(t.type));
    }
    const dateMatches = chunk.match(/(?:[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+20\d{2})?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:\s+20\d{2})?|20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2})/g) || [];
    for (const raw of dateMatches) {
      const d = applyDeadlineTimezone(parseCandidateDate(raw, yearHint), chunk);
      if (!d || d < new Date(now.getTime()-86400000) || d > new Date(now.getTime()+550*86400000)) continue;
      for (const label of labels) candidates.push({ type: label.type, priority: label.priority, date: d, raw: chunk.slice(0,220) });
    }
  }
  const uniq = new Map();
  for (const c of candidates) uniq.set(`${c.type}:${c.date.toISOString()}`, c);
  return [...uniq.values()].sort((a,b) => a.date-b.date || a.priority-b.priority);
}


export function extractSubmissionOpening(text, now = new Date()) {
  const plain = String(text || "");
  const lower = plain.toLowerCase();
  const yearHint = Number((plain.match(/\b20\d{2}\b/) || [])[0]) || now.getUTCFullYear();

  // Explicit closed / not-yet-open language overrides generic date mentions.
  const notYetOpen = /(?:submissions?|submission site|paper submissions?|call for papers?)\s+(?:are\s+)?(?:not yet open|will open|opens? later|forthcoming)/i.test(plain);
  const explicitlyClosed = /(?:submissions?|submission site|call for papers?)\s+(?:are\s+)?(?:closed|no longer accepting)/i.test(plain);
  const explicitlyOpen = /(?:submissions?|submission site|paper submissions?|call for papers?)\s+(?:are\s+)?(?:now\s+open|open\s+now|open(?:\s+for\s+submission)?[.!;])/i.test(plain) && !notYetOpen;

  const openingPatterns = [
    /(?:submissions?|submission site|paper submissions?|call for papers?)\s+(?:open|opens|opening)\s*(?:on|:)?\s*([^.;|]{0,80})/ig,
    /(?:opening date|submissions open date)\s*[:\-]?\s*([^.;|]{0,80})/ig,
  ];
  const dates = [];
  for (const re of openingPatterns) {
    let m;
    while ((m = re.exec(plain))) {
      const raw = m[1] || "";
      const candidates = raw.match(/(?:[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+20\d{2})?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:\s+20\d{2})?|20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2})/g) || [];
      for (const c of candidates) {
        const d = parseCandidateDate(c, yearHint);
        if (d && Number.isFinite(d.getTime())) dates.push(d);
      }
    }
  }
  dates.sort((a,b)=>a-b);
  const opensAt = dates[0] || null;
  return {
    opensAt,
    explicitlyOpen,
    notYetOpen,
    explicitlyClosed,
    isOpenNow: !explicitlyClosed && !notYetOpen && (explicitlyOpen || !opensAt || opensAt <= now),
  };
}

export function selectOpenSubmissionTrack(tracks, now = new Date()) {
  const submissionTypes = new Set(["main_submission","abstract_submission","late_breaking_submission","workshop_submission","arr_commitment","direct_submission","challenge_submission"]);
  const open = tracks.filter(t => submissionTypes.has(t.type) && t.date > now).sort((a,b) => a.priority-b.priority || a.date-b.date);
  return open[0] || null;
}

export function extractDeadline(text, now = new Date()) {
  return selectOpenSubmissionTrack(extractDeadlineTracks(text, now), now)?.date || null;
}

export function venueMatchScore(pageText, venue) {
  const hay = norm(pageText); const acr = norm(venue.acronym || "").replace(/\b20\d{2}\b/g, "").trim(); const name = norm(venue.name || ""); let score = 0;
  if (acr && new RegExp(`(^| )${acr.replace(/ /g, "[ -]?")}( |$)`, "i").test(hay)) score += .55;
  const tokens = name.split(" ").filter(x => x.length > 3); const hits = tokens.filter(x => hay.includes(x)).length;
  if (tokens.length) score += .45*(hits/tokens.length); return Math.min(1,score);
}
export function classifyDiscoverySource(url) { const h=hostOf(url); if(h.includes("wikicfp.com"))return"wikicfp"; if(h.includes("cmt3.research.microsoft.com"))return"cmt"; if(h.includes("easychair.org"))return"easychair"; if(h.includes("hotcrp.com"))return"hotcrp"; if(h.includes("openreview.net"))return"openreview"; if(h.includes("springer"))return"springer"; return"web"; }
export function isSubmissionPlatform(url){const h=hostOf(url);return SUBMISSION_HOSTS.some(x=>h===x||h.endsWith("."+x));}
export function looksOfficial(url,venue=null){const h=hostOf(url);if(OFFICIAL_HOST_HINTS.some(x=>h.endsWith(x)||h.includes(x.replace(/^\./,""))))return true;const acr=norm(venue?.acronym||"").replace(/\s/g,"");return!!acr&&norm(h).replace(/\s/g,"").includes(acr);}

export async function resolveOfficialCfp(seedUrl, venue = null) {
  const seed = await fetchPage(seedUrl);
  if (hostOf(seed.url).includes("wikicfp.com")) {
    const candidates = seed.links.filter(x=>!hostOf(x.url).includes("wikicfp.com"))
      .filter(x=>CFP_LINK_RE.test(x.text+" "+x.url)||looksOfficial(x.url,venue))
      .sort((a,b)=>Number(looksOfficial(b.url,venue))-Number(looksOfficial(a.url,venue)));
    for(const c of candidates.slice(0,8)){try{const page=await fetchPage(c.url);if(!venue||venueMatchScore(page.text,venue)>=.42)return page;}catch{}}
    throw Object.assign(new Error("WikiCFP lead had no verifiable official CFP link"),{code:"NO_OFFICIAL_CFP"});
  }
  const directScore=venue?venueMatchScore(seed.text,venue):1;
  if(directScore>=.42&&selectOpenSubmissionTrack(extractDeadlineTracks(seed.text)))return seed;
  for(const c of seed.links.filter(x=>CFP_LINK_RE.test(x.text+" "+x.url)).slice(0,8)){
    try{const page=await fetchPage(c.url);if((!venue||venueMatchScore(page.text,venue)>=.42)&&selectOpenSubmissionTrack(extractDeadlineTracks(page.text)))return page;}catch{}
  }
  return seed;
}

export function inferVenueFromPage(page,fallbackTitle=""){const text=page.text||"";const title=(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1];const clean=htmlText(title||fallbackTitle||"").replace(/\s*[|–—-]\s*(Call for Papers|CFP).*$/i,"").trim();const acronym=(clean.match(/\b[A-Z][A-Z0-9-]{2,12}\b/)||text.match(/\b[A-Z][A-Z0-9-]{2,12}\s+20\d{2}\b/)||[])[0]||clean.split(" ")[0];const type=/workshop/i.test(clean+" "+text.slice(0,1000))?"workshop":"conference";return{name:clean||acronym,acronym,type};}

export async function searchWatchlistVenue(venue,year=new Date().getUTCFullYear()){
  if (venue.officialUrl) {
    try {
      const page = await resolveOfficialCfp(venue.officialUrl, venue);
      const score = venueMatchScore(page.text, venue);
      const tracks = extractDeadlineTracks(page.text);
      const selectedTrack = selectOpenSubmissionTrack(tracks);
      if (score >= .55 && selectedTrack) {
        return {
          page,
          deadline: selectedTrack.date,
          selectedTrack,
          deadlineTracks: tracks,
          score,
          submissionLinks: page.links.filter(x => isSubmissionPlatform(x.url)),
          searchResult: { url: venue.officialUrl, title: `${venue.acronym} configured official site` },
        };
      }
    } catch {}
  }
  const queries=[`"${venue.acronym}" ${year} call for papers deadline`,`"${venue.acronym}" ${year} (CMT OR EasyChair OR HotCRP OR OpenReview OR submission)`];
  if(venue.name&&venue.name!==venue.acronym)queries.push(`"${venue.name}" ${year} call for papers`);
  const seen=new Set(),results=[];
  const searchGroups=await mapLimit(queries,3,async q=>{try{return await duckDuckGoSearch(q,8)}catch{return[]}});
  for(const group of searchGroups)for(const r of group){if(!seen.has(r.url)){seen.add(r.url);results.push(r);}}
  const inspected=await mapLimit(results.slice(0,18),6,async r=>{try{const page=await resolveOfficialCfp(r.url,venue);const score=venueMatchScore(page.text,venue);const tracks=extractDeadlineTracks(page.text);const selectedTrack=selectOpenSubmissionTrack(tracks);if(score>=.55&&selectedTrack){const submissionLinks=page.links.filter(x=>isSubmissionPlatform(x.url));return{page,deadline:selectedTrack.date,selectedTrack,deadlineTracks:tracks,score,submissionLinks,searchResult:r};}}catch{}return null;});
  return inspected.filter(Boolean).sort((a,b)=>b.score-a.score)[0]||null;
}

export async function discoverWikiCfpLeads(year=new Date().getUTCFullYear()){
  const topics=["artificial intelligence","machine learning","natural language processing","computer vision","data mining","human computer interaction","software engineering","cybersecurity","robotics","responsible AI"];
  const seen=new Map();
  const groups=await mapLimit(topics,4,async topic=>{const q=`site:wikicfp.com/cfp/servlet/event.showcfp ${year} "${topic}" deadline`;try{return await duckDuckGoSearch(q,12)}catch{return[]}});
  for(const results of groups)for(const r of results){if(hostOf(r.url).includes("wikicfp.com")&&/event\.showcfp/i.test(r.url))seen.set(r.url,r);}
  return[...seen.values()];
}
export {hostOf,norm};
