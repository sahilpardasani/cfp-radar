import { NextResponse } from "next/server";
import { readStore } from "@/lib/cfp";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = readStore();
  const healthy = Array.isArray(store?.items);

  return NextResponse.json(
    {
      status: healthy ? "ok" : "unavailable",
      service: "cfp-radar",
      catalogItems: healthy ? store.items.length : 0,
      catalogUpdatedAt: store?.updatedAt || null,
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
