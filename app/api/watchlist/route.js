import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Intentionally disabled. The venue watchlist (data/watchlist.json) is a BACKEND-ONLY
// tool used by the pipeline (scripts/watchlist.mjs) and is not exposed to the frontend.
export async function GET() {
  return NextResponse.json({ error: "Not available. The watchlist is backend-only." }, { status: 404 });
}
