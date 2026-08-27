import { NextResponse } from "next/server";
import { getActiveCFPs } from "@/lib/cfp";
import { legitimacyOf, deepLegitimacyCheck } from "@/lib/legitimacy";
import { guardExpensiveRequest } from "@/lib/apiSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/legitimacy?id=<venue>&deep=1
 *   - default: fast heuristic screen for one venue
 *   - deep=1: also fetch the CFP page and run the LLM red-flag analysis
 * GET /api/legitimacy  -> heuristic screen for every active venue (summary)
 */
export async function GET(req) {
  const { items } = getActiveCFPs(new Date());
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const deep = url.searchParams.get("deep");

  if (id) {
    const v = items.find((x) => x.id === id);
    if (!v) return NextResponse.json({ error: "Unknown venue id" }, { status: 404 });
    if (deep) {
      const blocked = guardExpensiveRequest(req, "deep-legitimacy", { limit: 10 });
      if (blocked) return blocked;
    }
    const result = deep ? await deepLegitimacyCheck(v) : legitimacyOf(v);
    return NextResponse.json({ id, ...result }, { headers: { "Cache-Control": "no-store" } });
  }

  const results = items.map((v) => ({ id: v.id, acronym: v.acronym, ...legitimacyOf(v) }));
  const summary = results.reduce((a, r) => ((a[r.level] = (a[r.level] || 0) + 1), a), {});
  return NextResponse.json({ summary, results }, { headers: { "Cache-Control": "no-store" } });
}
