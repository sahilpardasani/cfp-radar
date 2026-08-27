const CLOSED_STATUSES = new Set(["closed", "expired", "inactive", "cancelled", "canceled", "archived"]);

export function callClosure(item, now = new Date()) {
  const status = String(item?.status || item?.callStatus || "").toLowerCase();
  if (CLOSED_STATUSES.has(status)) return { active: false, reason: `status:${status}` };

  // Imported lead snapshots are not live CFPs. A parent workshop directory—or
  // a claimed deadline with no direct page—is insufficient for admission.
  if (item?.source === "current-open-call-seed") {
    const hasVerifiedDirectCall = Boolean(
      item?.officialWorkshopDiscovery?.officialWorkshopPage ||
      item?.discoveryEvidence?.officialWorkshopPage ||
      (item?.verification?.status === "confirmed" && item?.cfpUrl)
    );
    if (!hasVerifiedDirectCall) return { active: false, reason: "unverified-current-call-seed" };
  }

  const rawDeadline = item?.closesAt || item?.expiresAt || item?.deadline;
  if (rawDeadline) {
    const deadline = new Date(rawDeadline);
    if (!Number.isFinite(deadline.getTime())) return { active: false, reason: "invalid-deadline" };
    if (deadline.getTime() <= now.getTime()) return { active: false, reason: "deadline-passed", closedAt: deadline.toISOString() };
    return { active: true, reason: "future-deadline" };
  }

  // Journals commonly accept rolling submissions. Finite calls without a date
  // remain visible only when the source explicitly says their deadline is TBD or
  // the active submission platform exposes no public deadline.
  if (item?.type === "journal" || item?.rolling === true) return { active: true, reason: "rolling" };
  if (item?.deadlineTBD === true || item?.deadlineStatus === "openreview-active-no-public-deadline") {
    return { active: true, reason: "active-deadline-unpublished" };
  }
  return { active: false, reason: "finite-call-without-deadline" };
}

export function isCallActive(item, now = new Date()) {
  return callClosure(item, now).active;
}

export function partitionCalls(items, now = new Date()) {
  const active = [];
  const closed = [];
  for (const item of items || []) {
    const lifecycle = callClosure(item, now);
    if (lifecycle.active) active.push(item);
    else closed.push({
      ...item,
      lifecycle: {
        ...(item.lifecycle || {}),
        status: lifecycle.reason.startsWith("unverified-") ? "deprecated" : "closed",
        reason: lifecycle.reason,
        closedAt: lifecycle.closedAt || now.toISOString(),
        archivedAt: now.toISOString(),
      },
    });
  }
  return { active, closed };
}
