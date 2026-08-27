const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const BOOK_CALL_RE = /(?:submit(?:ting)?|send|invite|seek|welcome|accept)[^.!?]{0,100}(?:book|monograph|manuscript|edited collection)[^.!?]{0,80}proposals?|(?:book|monograph|manuscript) proposals?[^.!?]{0,80}(?:submit|welcome|accept|form)/i;
const CHAPTER_CALL_RE = /(?:call|invitation)[^.!?]{0,60}(?:for )?(?:book )?chapters?|chapter (?:abstracts?|proposals?)[^.!?]{0,80}(?:due|deadline|submit|invited)/i;
const PEER_REVIEW_RE = /peer[- ]review|external review|editorial board|academic review/i;
const RED_FLAG_RE = /guaranteed publication|guaranteed acceptance|publish in (?:three|3|seven|7) days|pay[- ]to[- ]publish|publication certificate|contact (?:us )?(?:on|via) whatsapp/i;
const RELEVANCE_GROUPS = [
  /artificial intelligence|machine learning|deep learning|neural network|large language model|generative ai/i,
  /computer science|computing|software engineering|programming language|information systems?/i,
  /data science|data mining|database|big data|knowledge graph|information retrieval/i,
  /robotics|computer vision|natural language processing|human[- ]computer interaction|cybersecurity|privacy/i,
  /digital humanities|artificial humanities|critical ai|algorithmic|digital media|platform studies/i,
  /bioinformatics|health informatics|medical ai|computational social science|science and technology studies/i,
];

export function hostAllowed(url, domains = []) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function parseDate(raw, fallbackYear) {
  const value = String(raw).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  let match = value.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?\b/i);
  if (match && MONTHS[match[2].toLowerCase()] != null) {
    return new Date(Date.UTC(Number(match[3] || fallbackYear), MONTHS[match[2].toLowerCase()], Number(match[1]), 23, 59));
  }
  match = value.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?\b/i);
  if (match && MONTHS[match[1].toLowerCase()] != null) {
    return new Date(Date.UTC(Number(match[3] || fallbackYear), MONTHS[match[1].toLowerCase()], Number(match[2]), 23, 59));
  }
  match = value.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59)) : null;
}

export function extractBookCallDeadline(text, now = new Date()) {
  const plain = String(text || "").replace(/\s+/g, " ");
  const year = Number((plain.match(/\b20\d{2}\b/) || [])[0]) || now.getUTCFullYear();
  const datePattern = "(?:[A-Za-z]{3,9}\\s+\\d{1,2}(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|\\d{1,2}(?!\\d)(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:,?\\s+20\\d{2})?|20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2})";
  const patterns = [
    new RegExp(`(?:chapter|abstract|proposal|expression of interest)[^.;]{0,45}(?:deadline|due|by|submission)[^.;]{0,55}?(${datePattern})`, "i"),
    new RegExp(`(?:deadline|due date|submit by|closes?)[^.;]{0,55}?(${datePattern})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    const date = match ? parseDate(match[1], year) : null;
    if (date) return { date, evidence: match[0] };
  }
  return null;
}

export function relevanceEvidence(text, configuredKeywords = []) {
  const plain = String(text || "");
  const groups = RELEVANCE_GROUPS.filter((pattern) => pattern.test(plain)).map((pattern) => pattern.source);
  const configured = configuredKeywords.filter((keyword) => plain.toLowerCase().includes(String(keyword).toLowerCase()));
  // One generic token (for example a site's footer link to a privacy policy)
  // is not sufficient evidence of subject fit.
  return { relevant: configured.length > 0 || groups.length >= 2, groups, configured };
}

export function assessBookCall({ source, page, type, now = new Date(), supportingText = "", evidenceOverrides = {} }) {
  const text = `${page?.text || ""} ${supportingText}`;
  const reasons = [];
  if (!page?.url || !hostAllowed(page.url, source.officialDomains || [])) reasons.push("not-on-approved-publisher-domain");
  if (!/^https:/i.test(page?.url || "")) reasons.push("official-link-is-not-https");
  if (!source.memberships?.length && !source.majorAcademicPublisher) reasons.push("publisher-reputation-not-established");
  if (RED_FLAG_RE.test(text)) reasons.push("predatory-or-guaranteed-publication-language");

  const callType = type || (CHAPTER_CALL_RE.test(text) ? "chapter-proposal" : "book-proposal");
  if (callType === "chapter-proposal" && !CHAPTER_CALL_RE.test(text)) reasons.push("no-explicit-call-for-chapters");
  if (callType === "book-proposal" && !BOOK_CALL_RE.test(text) && evidenceOverrides.proposalRouteVerified !== true) {
    reasons.push("no-explicit-book-proposal-route");
  }
  const relevance = relevanceEvidence(text, source.scopeKeywords || []);
  if (!relevance.relevant && evidenceOverrides.subjectFitVerified === true) {
    relevance.relevant = true;
    relevance.configured = [...new Set([
      ...relevance.configured,
      ...(source.scopeKeywords || []),
    ])];
    relevance.verifiedFromConfiguredOfficialEvidence = true;
  }
  if (!relevance.relevant) reasons.push("outside-cs-ai-data-scope");

  const deadline = extractBookCallDeadline(text, now);
  if (callType === "chapter-proposal" && !deadline) reasons.push("chapter-call-has-no-verifiable-deadline");
  if (deadline && deadline.date <= now) reasons.push("deadline-passed");
  const peerReview = PEER_REVIEW_RE.test(text) || source.peerReviewVerified === true;
  if (!peerReview) reasons.push("peer-review-process-not-established");

  return {
    admitted: reasons.length === 0,
    reasons,
    callType,
    deadline,
    rolling: callType === "book-proposal" && !deadline,
    evidence: {
      officialDomain: page?.url ? new URL(page.url).hostname : null,
      memberships: source.memberships || [],
      peerReview,
      relevance,
      operatorVerifiedEvidence: evidenceOverrides.reviewedAt || null,
    },
  };
}

export const __test = { BOOK_CALL_RE, CHAPTER_CALL_RE, RED_FLAG_RE };
