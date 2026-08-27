import { NextResponse } from "next/server";
import { getActiveBookCalls } from "@/lib/bookCalls";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getActiveBookCalls(new Date()), {
    headers: { "Cache-Control": "no-store" },
  });
}
