#!/usr/bin/env node
/**
 * OpenReview browser agent.
 *
 * Source of truth: the rendered homepage section headed exactly
 * "Open for Submissions". It never scrapes the broader Active Venues list.
 * The visible OpenReview deadline is persisted immediately for countdowns.
 * Optional enrichment follows each OpenReview group to an official venue site.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseOpenReviewDue, parseOpenReviewDirectory, groupOpenReviewEntries, canonicalOpenReviewUrl } from "../lib/openreviewDirectory.js";
import { mergeOpenReviewIntoStore } from "../lib/openreviewLive.js";
import { fetchPage, extractDeadlineTracks, selectOpenSubmissionTrack } from "../lib/webDiscovery.js";
import { parseOpenReviewHomepageText } from "../lib/openreviewHomepageText.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "data", "cfps.json");
const SNAPSHOT_PATH = path.join(ROOT, "data", "openreview-last-good.json");
const ENRICH_CACHE_PATH = path.join(ROOT, "data", "openreview-official-cache.json");
const HOME = "https://openreview.net/";
const NAV_TIMEOUT = Number(process.env.OPENREVIEW_BROWSER_TIMEOUT_MS || 90000);
const ENRICH = process.env.OPENREVIEW_BROWSER_ENRICH === "1";
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.OPENREVIEW_ENRICH_CONCURRENCY || 4));

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function isExternalUrl(url = "") {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host && !/(^|\.)openreview\.net$/.test(host) && !/(^|\.)openreview\.ai$/.test(host);
  } catch { return false; }
}

async function renderedOpenCalls(page) {
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.waitForFunction(
    () => document.body?.innerText?.includes("Open for Submissions"),
    { timeout: NAV_TIMEOUT }
  );
  // Give the React directory a brief chance to finish rendering. We avoid
  // networkidle because OpenReview keeps background connections alive.
  await page.waitForTimeout(2500);

  // Primary path: parse the exact visible text users see, then join titles
  // back to their canonical OpenReview anchors. This is intentionally
  // independent of OpenReview's React component/DOM structure.
  const rendered = await page.evaluate(() => ({
    bodyText: document.body?.innerText || "",
    anchors: [...document.querySelectorAll("a[href]")].map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      href: a.href,
    })),
  }));
  let rawEntries = parseOpenReviewHomepageText(rendered.bodyText, rendered.anchors);

  // Secondary path: parse the fully rendered HTML when visible-text matching
  // cannot recover links (for example, if link text is visually split).
  if (!rawEntries.length) {
    const html = await page.content();
    rawEntries = parseOpenReviewDirectory(html).map((e) => ({
      groupId: e.groupId,
      title: e.title,
      href: e.url,
      statusText: e.rawStatus || "",
      deadline: e.deadline || null,
      status: e.status || "active",
    }));
  }

  // Final fallback path: walk DOM order after the exact heading. OpenReview has
  // changed card wrappers several times; document order + nearest <li> is
  // stable and does not depend on elements having non-zero geometry.
  if (!rawEntries.length) {
    rawEntries = await page.evaluate(() => {
      const clean = (s = "") => String(s).replace(/\s+/g, " ").trim();
      const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
      const heading = headings.find((el) => clean(el.textContent) === "Open for Submissions");
      if (!heading) return [];
      const nextHeading = headings.find(
        (el) => el !== heading && Boolean(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      const anchors = [...document.querySelectorAll('a[href*="/group?id="],a[href*="openreview.net/group?id="]')];
      const out = [];
      for (const a of anchors) {
        if (!(heading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (nextHeading && !(a.compareDocumentPosition(nextHeading) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const title = clean(a.textContent);
        if (!title || /^OpenReview$/i.test(title)) continue;
        const card = a.closest("li") || a.closest("article") || a.parentElement;
        const statusText = clean(card?.innerText || "");
        if (!/Due\s+\d{1,2}\s+[A-Za-z]+\s+20\d{2}\s+at/i.test(statusText) && !/Open for Submissions/i.test(statusText)) continue;
        let groupId = "";
        try { groupId = new URL(a.href).searchParams.get("id") || ""; } catch {}
        if (!groupId) continue;
        out.push({ groupId, title, href: a.href, statusText, deadline: null, status: "active" });
      }
      return out;
    });
  }

  const now = Date.now();
  const byId = new Map();
  for (const row of rawEntries) {
    const deadline = row.deadline || parseOpenReviewDue(row.statusText);
    const explicitOpen = row.status === "open" || /Open for Submissions/i.test(row.statusText);
    if (deadline && new Date(deadline).getTime() <= now) continue;
    if (!deadline && !explicitOpen) continue;
    const entry = {
      groupId: row.groupId,
      title: clean(row.title),
      deadline,
      status: deadline ? "due" : "open",
      url: canonicalOpenReviewUrl(row.href),
      openreviewUrl: canonicalOpenReviewUrl(row.href),
      rawStatus: clean(row.statusText).slice(0, 400),
      deadlineSource: "openreview-homepage",
    };
    const old = byId.get(entry.groupId);
    if (!old || (!old.deadline && entry.deadline)) byId.set(entry.groupId, entry);
  }
  return [...byId.values()];
}

async function officialLinkFromGroupPage(browser, entry) {
  const page = await browser.newPage();
  try {
    await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(900);
    const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => ({
      href: a.href,
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
    })));
    const preferred = links.find((l) => /official|website|homepage|conference|workshop|call for papers|cfp/i.test(l.text) && !/openreview/i.test(l.href))
      || links.find((l) => !/openreview|github|twitter|x\.com|mailto:/i.test(l.href));
    return preferred?.href || null;
  } catch { return null; }
  finally { await page.close(); }
}

async function enrichOne(browser, entry, cache) {
  const cached = cache[entry.groupId];
  if (cached?.checkedAt && Date.now() - new Date(cached.checkedAt).getTime() < 7 * 86400000) {
    return { ...entry, ...cached.value };
  }
  const officialUrl = await officialLinkFromGroupPage(browser, entry);
  let value = { officialUrl: officialUrl || null, cfpUrl: officialUrl || entry.url };
  if (officialUrl && isExternalUrl(officialUrl)) {
    try {
      const page = await fetchPage(officialUrl, { timeoutMs: 15000 });
      const tracks = extractDeadlineTracks(page?.text || "");
      const selected = selectOpenSubmissionTrack(tracks, new Date());
      if (selected?.deadline) {
        value = {
          ...value,
          deadline: selected.deadline.toISOString(),
          deadlineSource: "official-cfp",
          cfpUrl: page?.url || officialUrl,
          officialUrl: page?.url || officialUrl,
        };
      }
    } catch { /* OpenReview homepage deadline remains valid fallback */ }
  }
  cache[entry.groupId] = { checkedAt: new Date().toISOString(), value };
  return { ...entry, ...value };
}

async function mapLimit(values, limit, fn) {
  const out = new Array(values.length); let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= values.length) return;
      try { out[i] = await fn(values[i], i); }
      catch { out[i] = values[i]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length || 1) }, worker));
  return out;
}

function persist(entries, source) {
  if (!entries.length) throw new Error("Rendered Open for Submissions section produced zero calls");
  const groups = groupOpenReviewEntries(entries);
  const live = { entries, groups, checkedAt: new Date().toISOString(), source, warning: null };
  const store = readJSON(DATA_PATH, { updatedAt: null, source: "seed", items: [] });
  const merged = mergeOpenReviewIntoStore(store.items || [], live);
  const next = {
    ...store,
    updatedAt: live.checkedAt,
    source: `${store.source || "curated"} + rendered OpenReview open calls`,
    openreviewSync: { ...merged.sync, checkedAt: live.checkedAt, mirroredEntries: entries.length, groupedCards: groups.length, warning: null },
    items: merged.items,
  };
  writeJSON(DATA_PATH, next);
  writeJSON(SNAPSHOT_PATH, live);
  return { entries: entries.length, groups: groups.length, total: next.items.length };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    let entries = await renderedOpenCalls(page);
    if (ENRICH) {
      const cache = readJSON(ENRICH_CACHE_PATH, {});
      entries = await mapLimit(entries, ENRICH_CONCURRENCY, (entry) => enrichOne(browser, entry, cache));
      writeJSON(ENRICH_CACHE_PATH, cache);
    }
    const result = persist(entries, ENRICH ? "OpenReview homepage + official CFP agent" : "OpenReview homepage");
    console.log(`OpenReview sync persisted ${result.entries} currently open calls as ${result.groups} cards; catalog now has ${result.total} entries.`);
  } catch (error) {
    const snapshot = readJSON(SNAPSHOT_PATH, null);
    const current = snapshot?.entries?.filter((e) => !e.deadline || new Date(e.deadline).getTime() > Date.now()) || [];
    if (current.length) {
      const result = persist(current, "OpenReview last-good current snapshot");
      console.warn(`Live OpenReview browser sync failed (${error.message}); retained ${result.entries} still-open calls from the last-good snapshot.`);
      return;
    }
    throw error;
  } finally { await browser.close(); }
}

main().catch((error) => {
  console.error(`OpenReview browser sync failed: ${error.message}`);
  if (process.env.OPENREVIEW_BROWSER_OPTIONAL === '1') process.exit(0);
  process.exit(1);
});
