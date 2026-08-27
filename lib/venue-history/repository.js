import { venueHistoryEnabled } from "./config.js";
import { loadJsonVenueBundle } from "./jsonRepository.js";
import { loadPostgresVenueBundle } from "./postgresRepository.js";

/** Read PostgreSQL when configured; retain the generated snapshot as rollback. */
export async function loadVenueBundle(venueId) {
  if (!venueHistoryEnabled()) return null;
  const snapshotBundle = loadJsonVenueBundle(venueId);
  if (process.env.DATABASE_URL) {
    try {
      const databaseBundle = await loadPostgresVenueBundle(venueId);
      if (databaseBundle) {
        const databaseTime = new Date(databaseBundle.updatedAt || 0).getTime();
        const snapshotTime = new Date(snapshotBundle?.updatedAt || 0).getTime();
        if (!snapshotBundle || databaseTime >= snapshotTime) return databaseBundle;
        console.warn("Venue-history database is older than the verified snapshot; using the snapshot.");
      }
    } catch (error) {
      console.error("Venue-history database read failed; using the verified snapshot.", error?.message || error);
    }
  }
  return snapshotBundle;
}
