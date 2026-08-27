function host(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

/** WikiCFP can supply a lead, never the admitted page or the trust decision. */
export function externalAdmissionDecision(candidate, vetted, now = new Date()) {
  const reasons = [];
  const deadline = new Date(candidate?.deadline || "");
  if (!Number.isFinite(deadline.getTime()) || deadline <= now) reasons.push("no future submission deadline");
  if (!candidate?.discoveryEvidence?.deadlineFoundOnOfficialPage) reasons.push("deadline not verified on official page");
  if (!candidate?.discoveryEvidence?.officialPage) reasons.push("official CFP page missing");
  if (/wikicfp\.com$/.test(host(candidate?.cfpUrl))) reasons.push("WikiCFP cannot be the admitted CFP page");
  if (vetted?.level !== "trusted") reasons.push("legitimacy verdict is not trusted");
  if (vetted?.evidenceQuality !== "corroborated") reasons.push("identity evidence is not corroborated");
  if ((vetted?.score ?? -Infinity) < 3) reasons.push("legitimacy score below threshold");

  const isPublicationVenue = !["journal", "special-issue"].includes(candidate?.type);
  if (isPublicationVenue) {
    const proceedings = vetted?.proceedings || {};
    const publisher = vetted?.publisherEvidence || {};
    const parent = vetted?.parentConference || {};
    if (!proceedings.established && !publisher.currentEditionConfirmed && !parent.confirmed) {
      reasons.push("no established proceedings, publisher confirmation, or official parent listing");
    }
  } else if (!vetted?.ranking?.identityConfirmed) {
    reasons.push("journal identity not independently confirmed");
  }

  return { admitted: reasons.length === 0, reasons, confidence: reasons.length ? "insufficient" : "high" };
}
