import { databaseSslConfig } from "./postgresConfig.js";

let poolPromise = null;

async function pool() {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = import("pg").then(({ default: pg }) => new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: databaseSslConfig(),
      max: Math.max(1, Math.min(10, Number(process.env.DATABASE_POOL_MAX) || 5)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    }));
  }
  return poolPromise;
}

export async function loadPostgresVenueBundle(venueId) {
  const database = await pool();
  if (!database) return null;
  const [venueResult, editionsResult, papersResult, insightsResult] = await Promise.all([
    database.query(`
      SELECT id, canonical_name AS "canonicalName", acronym, venue_type AS "venueType", status,
             official_url AS "officialUrl", external_ids AS "externalIds",
             identity_evidence AS "identityEvidence", coverage
      FROM venues WHERE id = $1`, [venueId]),
    database.query(`
      SELECT id, venue_id AS "venueId", event_year AS "eventYear", title, location,
             verification_status AS "verificationStatus", membership_source AS "membershipSource", volumes
      FROM venue_editions WHERE venue_id = $1 ORDER BY event_year DESC`, [venueId]),
    database.query(`
      SELECT p.id, ep.edition_id AS "editionId", e.event_year AS "eventYear", p.dblp_key AS "dblpKey",
             p.proceedings_key AS "proceedingsKey", p.title, p.publication_year AS "publicationYear",
             p.pages, p.doi, p.publisher_url AS "publisherUrl", p.dblp_url AS "dblpUrl",
             p.open_access_url AS "openAccessUrl", p.abstract, p.citation_count AS "citationCount",
             p.topics, p.method_tags AS "methodTags", p.classification_evidence AS "classificationEvidence",
             COALESCE(a.authors, '[]'::json) AS authors,
             json_build_object('source', ep.membership_source, 'status', ep.membership_status,
               'confidence', ep.membership_confidence, 'evidenceUrl', ep.evidence_url) AS membership
      FROM edition_papers ep
      JOIN venue_editions e ON e.id = ep.edition_id
      JOIN papers p ON p.id = ep.paper_id
      LEFT JOIN (
        SELECT paper_id, json_agg(json_build_object('position', author_position, 'name', author_name,
          'orcid', orcid, 'dblpPid', dblp_pid) ORDER BY author_position) AS authors
        FROM paper_authors GROUP BY paper_id
      ) a ON a.paper_id = p.id
      WHERE e.venue_id = $1 ORDER BY e.event_year DESC, p.title`, [venueId]),
    database.query(`
      SELECT venue_id AS "venueId", start_year AS "startYear", end_year AS "endYear",
             paper_count AS "paperCount", themes, methods,
             extraction_evidence AS "extractionEvidence", generated_at AS "generatedAt"
      FROM venue_insights WHERE venue_id = $1`, [venueId]),
  ]);
  if (!venueResult.rows[0]) return null;
  return {
    updatedAt: insightsResult.rows[0]?.generatedAt || null,
    source: "postgres",
    venue: venueResult.rows[0],
    editions: editionsResult.rows,
    papers: papersResult.rows.map((paper) => ({ ...paper, venueId })),
    insights: insightsResult.rows[0] || null,
  };
}

export async function closeVenueHistoryPool() {
  if (!poolPromise) return;
  const database = await poolPromise;
  await database.end();
  poolPromise = null;
}
