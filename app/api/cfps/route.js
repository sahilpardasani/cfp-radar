import { NextResponse } from "next/server";
import { getActiveCFPs } from "@/lib/cfp";

export const dynamic = "force-dynamic";

export async function GET() {
  // The automated pipeline is the source of truth. Avoid running hundreds of
  // network requests inside a user-facing page request; that was the reason
  // the UI repeatedly fell back to the old 293-card snapshot.
  const data = getActiveCFPs(new Date());
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
