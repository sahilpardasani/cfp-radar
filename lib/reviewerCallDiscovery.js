const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const RECRUITMENT_RE = [
  /\bcall\s+for\s+(?:volunteer\s+)?(?:paper\s+|ethics\s+|external\s+)?reviewers?\b/i,
  /\b(?:seeking|recruiting|looking\s+for|invite|inviting)\b[^.!?]{0,90}\breviewers?\b/i,
  /\bvolunteers?\b[^.!?]{0,70}\bserve\s+as\s+(?:a\s+)?reviewers?\b/i,
  /\bvolunteer\s+to\s+review\b/i,
];

const CLOSED_RE = /\b(?:reviewer (?:recruitment|registration|applications?)|call for reviewers?)\b[^.!?]{0,80}\b(?:closed|ended|no longer accepting)\b/i;
const FORM_HOSTS = new Set(["forms.gle", "docs.google.com", "forms.office.com", "tinyurl.com"]);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function domainAllowed(url, domains = []) {
  const host = hostOf(url);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function parseDate(raw, fallbackYear) {
  const value = String(raw || "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  let match = value.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?/i);
  if (match && MONTHS[match[1].toLowerCase()] != null) {
    return new Date(Date.UTC(Number(match[3] || fallbackYear), MONTHS[match[1].toLowerCase()], Number(match[2]), 23, 59));
  }
  match = value.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?/i);
  if (match && MONTHS[match[2].toLowerCase()] != null) {
    return new Date(Date.UTC(Number(match[3] || fallbackYear), MONTHS[match[2].toLowerCase()], Number(match[1]), 23, 59));
  }
  return null;
}

export function isReviewerRecruitmentCall(text) {
  const value = String(text || "");
  return !CLOSED_RE.test(value) && RECRUITMENT_RE.some((pattern) => pattern.test(value));
}

export function extractReviewerDeadline(text, labels = [], now = new Date()) {
  const plain = String(text || "").replace(/\s+/g, " ");
  const year = Number((plain.match(/\b20\d{2}\b/) || [])[0]) || now.getUTCFullYear();
  const effectiveLabels = labels.length
    ? labels
    : ["reviewer application deadline", "reviewer registration deadline", "reviewer sign-up deadline"];
  const datePattern = "(?:[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:,?\\s+20\\d{2})?)";

  for (const label of effectiveLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = plain.match(new RegExp(`${escaped}[^.;]{0,100}?(${datePattern})`, "i"));
    const parsed = match ? parseDate(match[1], year) : null;
    if (parsed) return { date: parsed, evidence: match[0] };
  }
  return null;
}

export function assessReviewerPage({ source, page, now = new Date() }) {
  const reasons = [];
  if (!page?.url || !domainAllowed(page.url, source.officialDomains || [])) reasons.push("not-on-allowlisted-official-domain");
  if (!isReviewerRecruitmentCall(page?.text)) reasons.push("no-current-explicit-reviewer-recruitment");

  const identityTerms = [source.acronym, source.venue]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .filter((value) => value.length >= 3);
  const pageText = String(page?.text || "").toLowerCase();
  if (identityTerms.length && !identityTerms.some((term) => pageText.includes(term))) reasons.push("venue-identity-not-confirmed");

  const reviewerLinks = (page?.links || []).filter((link) =>
    /reviewer|volunteer|interest form|sign[\s-]?up/i.test(`${link.text || ""} ${link.url || ""}`)
  );
  const configuredApplication = source.applicationUrl && (page?.links || []).find((link) =>
    link.url === source.applicationUrl || link.url?.startsWith(source.applicationUrl)
  );
  const application = configuredApplication || reviewerLinks.find((link) => {
    const host = hostOf(link.url);
    return domainAllowed(link.url, source.officialDomains || []) || FORM_HOSTS.has(host);
  });
  if (!application) reasons.push("no-reviewer-application-route-linked-from-official-page");

  const deadline = extractReviewerDeadline(page?.text, source.deadlineLabels, now);
  const reviewEndsAt = source.reviewEndsAt ? new Date(source.reviewEndsAt) : null;
  if (reviewEndsAt && reviewEndsAt <= now) reasons.push("review-service-window-ended");

  return {
    admitted: reasons.length === 0,
    reasons,
    applicationUrl: application?.url || null,
    deadline,
  };
}

export function reviewerFreshnessExpiry(now = new Date(), reviewEndsAt = null, freshnessDays = 6) {
  const freshness = new Date(now.getTime() + freshnessDays * 24 * 60 * 60 * 1000);
  const serviceEnd = reviewEndsAt ? new Date(reviewEndsAt) : null;
  if (serviceEnd && Number.isFinite(serviceEnd.getTime()) && serviceEnd < freshness) return serviceEnd;
  return freshness;
}
