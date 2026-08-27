import { NextResponse } from "next/server";
import { getActiveReviewerCalls } from "@/lib/reviewerCalls";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getActiveReviewerCalls(new Date()), {
    headers: { "Cache-Control": "no-store" },
  });
}
