import { NextResponse } from "next/server";
import { getActiveCFPs } from "@/lib/cfp";
import { verifyVenueDeadline, verifyMany } from "@/lib/verifyDeadline";
import { guardExpensiveRequest, requireAdminToken } from "@/lib/apiSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/verify-deadlines            -> verify all active venues (may be slow)
 * GET /api/verify-deadlines?id=aaai-2027 -> verify a single venue (fast, used by the UI)
 */
export async function GET(req) {
  const { items } = getActiveCFPs(new Date());
  const id = new URL(req.url).searchParams.get("id");

  if (id) {
    const blocked = guardExpensiveRequest(req, "verify-deadline", { limit: 30 });
    if (blocked) return blocked;
    const v = items.find((x) => x.id === id);
    if (!v) return NextResponse.json({ error: "Unknown venue id" }, { status: 404 });
    const result = await verifyVenueDeadline(v);
    return NextResponse.json({ id, ...result }, { headers: { "Cache-Control": "no-store" } });
  }

  // Verify everything (skips rolling journals / TBD umbrellas automatically).
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;
  const results = await verifyMany(items, 4);
  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({ summary, results }, { headers: { "Cache-Control": "no-store" } });
}
