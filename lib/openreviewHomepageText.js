import { parseOpenReviewDue, canonicalOpenReviewUrl } from './openreviewDirectory.js';

function clean(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function key(value = '') {
  return clean(value).toLowerCase().replace(/[’‘]/g, "'");
}

const IGNORE_LINES = new Set([
  'open for submissions',
  'active venues',
  'show all venues',
  'show all active venues',
]);

function isDueLine(line = '') {
  return /^Due\s+\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2}\s+at\s+\d{1,2}:\d{2}\s+/i.test(clean(line));
}

function isOpenLine(line = '') {
  return /^Open for Submissions$/i.test(clean(line));
}

/**
 * Parse the rendered text a human sees on openreview.net.
 * This deliberately avoids OpenReview's component/DOM structure.
 */
export function parseOpenReviewHomepageText(bodyText = '', anchors = []) {
  const lines = String(bodyText)
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);

  const marker = lines.findIndex((line) => /^Open for Submissions$/i.test(line));
  if (marker < 0) return [];

  const anchorMap = new Map();
  for (const anchor of anchors || []) {
    const text = clean(anchor?.text);
    const href = clean(anchor?.href);
    if (!text || !href || !/openreview\.net\/group\?id=|^\/group\?id=/i.test(href)) continue;
    const k = key(text);
    const list = anchorMap.get(k) || [];
    if (!list.includes(href)) list.push(href);
    anchorMap.set(k, list);
  }

  const out = [];
  for (let i = marker + 1; i < lines.length; i++) {
    const title = lines[i];
    if (!title || IGNORE_LINES.has(key(title)) || isDueLine(title) || isOpenLine(title)) continue;

    const status = lines[i + 1] || '';
    if (!isDueLine(status) && !isOpenLine(status)) continue;

    const hrefs = anchorMap.get(key(title)) || [];
    const href = hrefs[0];
    if (!href) continue;

    let groupId = '';
    try {
      const url = new URL(href, 'https://openreview.net');
      groupId = url.searchParams.get('id') || '';
    } catch {
      // Skip malformed links.
    }
    if (!groupId) continue;

    out.push({
      groupId,
      title,
      href: canonicalOpenReviewUrl(href),
      statusText: status,
      deadline: isDueLine(status) ? parseOpenReviewDue(status) : null,
      status: isOpenLine(status) ? 'open' : 'due',
    });
    i += 1;
  }

  const byId = new Map();
  for (const entry of out) {
    const old = byId.get(entry.groupId);
    if (!old || (!old.deadline && entry.deadline)) byId.set(entry.groupId, entry);
  }
  return [...byId.values()];
}
