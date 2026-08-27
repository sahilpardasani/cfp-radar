import { NextResponse } from "next/server";
import { venueInsights } from "@/lib/venue-history/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request, { params }) {
  const { venueId } = await params;
  const result = await venueInsights(venueId);
  if (!result) return NextResponse.json({ error: "Verified venue insights are unavailable." }, { status: 404 });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
