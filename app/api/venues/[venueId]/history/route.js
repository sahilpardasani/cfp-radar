import { NextResponse } from "next/server";
import { venueHistorySummary } from "@/lib/venue-history/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request, { params }) {
  const { venueId } = await params;
  const result = await venueHistorySummary(venueId);
  if (!result) return NextResponse.json({ error: "Verified venue history is unavailable." }, { status: 404 });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
