import { notFound } from "next/navigation";
import RelatedWorkExplorer from "@/components/venue-history/RelatedWorkExplorer";
import { venueHistoryEnabled } from "@/lib/venue-history/config";
import { validVenueId } from "@/lib/venue-history/service";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { venueId } = await params;
  return {
    title: `${venueId.toUpperCase()} past work & venue fit — CFP Radar`,
    description: "Verified prior editions, accepted papers, themes, and research methods for this academic venue.",
  };
}

export default async function RelatedWorkPage({ params }) {
  const { venueId } = await params;
  if (!venueHistoryEnabled() || !validVenueId(venueId)) notFound();
  return <RelatedWorkExplorer venueId={venueId} />;
}
