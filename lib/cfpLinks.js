function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isWorkshopProposalUrl(value, linkPolicy = {}) {
  const normalized = safeHttpUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  return (linkPolicy.workshopProposalPathPatterns || []).some((pattern) =>
    haystack.includes(String(pattern).toLowerCase())
  );
}

/**
 * Return a safe, semantically correct call URL. Workshop-paper cards must never
 * send users to a parent conference's call for workshop organizers.
 */
export function primaryCfpUrl(item, linkPolicy = {}) {
  // OpenReview is the submission system, not the CFP, when its venue metadata
  // publishes an external official website. Keep the OpenReview group URL on
  // the separate submission button and prefer that verified external link here.
  const candidates = [item?.links?.call, item?.officialCfpUrl, item?.cfpUrl, item?.url];
  for (const candidate of candidates) {
    const url = safeHttpUrl(candidate);
    if (!url) continue;
    if (item?.type === "workshop" && isWorkshopProposalUrl(url, linkPolicy)) continue;
    return url;
  }
  return null;
}

export function safeExternalUrl(value) {
  return safeHttpUrl(value);
}

/**
 * Copy a public record while removing unsafe external-link schemes. Pipeline
 * data is still treated as untrusted at the API boundary because it may have
 * originated in a scraped page.
 */
export function sanitizeExternalUrlFields(item, fields) {
  const safe = { ...item };
  for (const field of fields) {
    const value = safeHttpUrl(item?.[field]);
    if (value) safe[field] = value;
    else delete safe[field];
  }
  return safe;
}
