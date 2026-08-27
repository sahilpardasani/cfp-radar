/**
 * Deadline-verification agent.
 *
 * For a given venue it fetches the official CFP page, extracts the visible text,
 * and asks the free LLM to pull out the *paper submission deadline*. It then
 * compares that against the deadline stored in data/cfps.json and returns a
 * verdict so the dashboard can flag anything that drifted or can't be confirmed.
 *
 * Verdicts:
 *   confirmed   - official page states a deadline within 1 day of our stored one
 *   mismatch    - official page states a *different* deadline (we surface both)
 *   unverified  - page reachable but no deadline could be extracted (e.g. JS-only)
 *   unreachable - page could not be fetched
 *   skipped     - nothing to check (rolling journal / TBD umbrella / no cfpUrl)
 */

import { chat, parseJSONLoose, llmReady } from "./llm.js";
import { extractDeadlineTracks, selectOpenSubmissionTrack } from "./webDiscovery.js";
import { fetchRemote, readResponseText } from "./safeFetch.js";
import { mapLimit } from "./asyncPool.js";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "./promptSecurity.js";

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const { response: res } = await fetchRemote(url, {
    headers: { "User-Agent": "CFP-Radar-DeadlineCheck/1.0" },
    timeoutMs: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await readResponseText(res, 2 * 1024 * 1024);
  return htmlToText(html);
}

const SYSTEM =
  "You extract the PAPER SUBMISSION DEADLINE from a call-for-papers web page. " +
  "Return the full-paper (or main) submission deadline, not abstract/camera-ready/notification. " +
  "If the page shows only an abstract deadline, return that but say so. Reply with STRICT JSON only. " +
  UNTRUSTED_CONTENT_RULE;

function daysApart(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (isNaN(a) || isNaN(b)) return Infinity;
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

/** Verify a single venue. Returns a verification object (never throws). */
export async function verifyVenueDeadline(venue) {
  const base = { checkedAt: new Date().toISOString(), foundDeadline: null, note: "" };

  // Nothing to verify against.
  if (venue.deadlineTBD) return { ...base, status: "skipped", note: "Umbrella entry (many sub-deadlines)." };
  if (!venue.deadline) return { ...base, status: "skipped", note: "Rolling / no fixed deadline." };
  const url = venue.cfpUrl || venue.url;
  if (!url) return { ...base, status: "skipped", note: "No CFP URL on record." };
  let text;
  try {
    text = await fetchText(url);
  } catch (e) {
    return { ...base, status: "unreachable", note: `Could not fetch page: ${e.message}` };
  }
  if (!text || text.length < 120) {
    return { ...base, status: "unverified", note: "Page returned little/no text (likely JavaScript-rendered)." };
  }

  // Every scheduled run must still check the official page when no optional LLM
  // key is configured. Use the deterministic deadline parser as the baseline.
  if (!llmReady()) {
    const selected = selectOpenSubmissionTrack(extractDeadlineTracks(text));
    if (!selected) {
      return {
        ...base,
        status: "unverified",
        note: "Official page fetched; deterministic parser found no current submission deadline.",
      };
    }
    const foundIso = selected.date.toISOString();
    const gap = daysApart(foundIso, venue.deadline);
    return gap <= 1.5
      ? {
          ...base,
          status: "confirmed",
          foundDeadline: foundIso,
          note: `Matches official page (${selected.type}; deterministic check).`,
        }
      : {
          ...base,
          status: "mismatch",
          foundDeadline: foundIso,
          note: `Official page shows ${selected.date.toISOString().slice(0, 10)} ` +
            `for ${selected.type}; stored value differs (deterministic check).`,
        };
  }

  const prompt = `${untrustedPromptField("CFP PAGE TEXT (truncated)", text, 9000)}\n\nReturn JSON:
{ "submissionDeadline": "YYYY-MM-DD or null", "isAbstractOnly": true|false, "evidence": "the exact sentence/date text you used, or null" }`;

  let parsed;
  try {
    const out = await chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      { json: true, temperature: 0, maxTokens: 400 }
    );
    parsed = parseJSONLoose(out);
  } catch (e) {
    return { ...base, status: "unverified", note: `LLM error: ${e.message}` };
  }

  const found = parsed?.submissionDeadline;
  if (!found) {
    return { ...base, status: "unverified", note: "No deadline found on the page." };
  }
  const foundIso = new Date(found).toISOString();
  const gap = daysApart(found, venue.deadline);
  if (gap <= 1.5) {
    return {
      ...base,
      status: "confirmed",
      foundDeadline: foundIso,
      note: parsed.isAbstractOnly ? "Matches (page shows abstract deadline)." : "Matches official page.",
    };
  }
  return {
    ...base,
    status: "mismatch",
    foundDeadline: foundIso,
    note: `Official page says ${found}${parsed.isAbstractOnly ? " (abstract)" : ""}; stored value differs. ${
      parsed.evidence ? "Evidence: " + parsed.evidence : ""
    }`.trim(),
  };
}

/** Verify many venues with limited concurrency. */
export async function verifyMany(venues, concurrency = 4) {
  return mapLimit(venues, concurrency, async (v) => ({
    id: v.id,
    acronym: v.acronym,
    storedDeadline: v.deadline,
    ...(await verifyVenueDeadline(v)),
  }));
}
