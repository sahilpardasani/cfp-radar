const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function parseDate(raw, fallbackYear) {
  const value = raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();
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

export function extractWorkshopProposalDeadline(text, labels = [], now = new Date()) {
  const plain = String(text || "").replace(/\s+/g, " ");
  const year = Number((plain.match(/\b20\d{2}\b/) || [])[0]) || now.getUTCFullYear();
  const effectiveLabels = labels.length ? labels : ["workshop proposal deadline", "deadline for workshop proposals"];
  const datePattern = "(?:[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:,?\\s+20\\d{2})?)";

  for (const label of effectiveLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = plain.match(new RegExp(`${escaped}[^.;]{0,100}?(${datePattern})`, "i"));
    const parsed = match ? parseDate(match[1], year) : null;
    if (parsed) return { date: parsed, evidence: match[0] };
  }
  return null;
}

export function isWorkshopOrganizerCall(text) {
  return /(?:call|invite|solicit)[^.!?]{0,80}(?:workshop|tutorial)[^.!?]{0,50}proposals?|workshop proposals?[^.!?]{0,80}(?:submit|submission|deadline)/i.test(String(text || ""));
}
