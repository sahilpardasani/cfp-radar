import { NextResponse } from "next/server";
import { getActiveWorkshopProposals } from "@/lib/workshopProposals";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getActiveWorkshopProposals(new Date()), {
    headers: { "Cache-Control": "no-store" },
  });
}
