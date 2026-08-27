import fs from "node:fs/promises";
import path from "node:path";
import { closeVenueHistoryPool } from "./postgresRepository.js";
import { databaseSslConfig } from "./postgresConfig.js";

const MIGRATION_PATH = path.join(process.cwd(), "migrations", "001_venue_history.sql");

async function createPool() {
  const { default: pg } = await import("pg");
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: databaseSslConfig(),
    max: 2,
    connectionTimeoutMillis: 10_000,
  });
}

export async function writeSnapshotToPostgres(snapshot) {
  if (!process.env.DATABASE_URL) return { written: false, reason: "DATABASE_URL is not configured" };
  const database = await createPool();
  let client = null;
  let transactionStarted = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(await fs.readFile(MIGRATION_PATH, "utf8"));
    for (const venue of snapshot.venues || []) {
      await client.query(`
        INSERT INTO venues (id, canonical_name, acronym, venue_type, status, official_url, external_ids, identity_evidence, coverage, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, acronym=EXCLUDED.acronym,
          venue_type=EXCLUDED.venue_type, status=EXCLUDED.status, official_url=EXCLUDED.official_url,
          external_ids=EXCLUDED.external_ids, identity_evidence=EXCLUDED.identity_evidence,
          coverage=EXCLUDED.coverage, updated_at=NOW()`,
        [venue.id, venue.canonicalName, venue.acronym, venue.venueType, venue.status, venue.officialUrl,
          JSON.stringify(venue.externalIds || {}), JSON.stringify(venue.identityEvidence || null),
          JSON.stringify(venue.coverage || {})]
      );
      await client.query("DELETE FROM venue_aliases WHERE venue_id = $1", [venue.id]);
      for (const alias of venue.aliases || []) {
        await client.query(`INSERT INTO venue_aliases (venue_id, alias, source) VALUES ($1,$2,'config')`, [venue.id, alias]);
      }
      await client.query("DELETE FROM venue_external_ids WHERE venue_id = $1", [venue.id]);
      for (const [provider, externalId] of Object.entries(venue.externalIds || {})) {
        const values = Array.isArray(externalId) ? externalId : [externalId];
        for (const value of values.filter(Boolean)) {
          await client.query(`INSERT INTO venue_external_ids (venue_id, provider, external_id, confidence, verified_at)
            VALUES ($1,$2,$3,$4,$5)`, [venue.id, provider, String(value), 1, venue.identityEvidence?.verifiedAt || snapshot.updatedAt]);
        }
      }
      await client.query("DELETE FROM edition_papers WHERE edition_id IN (SELECT id FROM venue_editions WHERE venue_id = $1)", [venue.id]);
      await client.query("DELETE FROM venue_editions WHERE venue_id = $1", [venue.id]);
    }
    for (const edition of snapshot.editions || []) {
      await client.query(`
        INSERT INTO venue_editions (id, venue_id, event_year, title, location, verification_status, membership_source, volumes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [edition.id, edition.venueId, edition.eventYear, edition.title, edition.location,
          edition.verificationStatus, edition.membershipSource, JSON.stringify(edition.volumes || [])]
      );
    }
    for (const paper of snapshot.papers || []) {
      await client.query(`
        INSERT INTO papers (id, dblp_key, proceedings_key, doi, title, abstract, publication_year, pages,
          citation_count, publisher_url, dblp_url, open_access_url, topics, method_tags, classification_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (id) DO UPDATE SET dblp_key=EXCLUDED.dblp_key, proceedings_key=EXCLUDED.proceedings_key,
          doi=EXCLUDED.doi, title=EXCLUDED.title, abstract=EXCLUDED.abstract,
          publication_year=EXCLUDED.publication_year, pages=EXCLUDED.pages,
          citation_count=EXCLUDED.citation_count, publisher_url=EXCLUDED.publisher_url,
          dblp_url=EXCLUDED.dblp_url, open_access_url=EXCLUDED.open_access_url,
          topics=EXCLUDED.topics, method_tags=EXCLUDED.method_tags,
          classification_evidence=EXCLUDED.classification_evidence`,
        [paper.id, paper.dblpKey, paper.proceedingsKey, paper.doi, paper.title, paper.abstract,
          paper.publicationYear, paper.pages, paper.citationCount, paper.publisherUrl, paper.dblpUrl,
          paper.openAccessUrl, JSON.stringify(paper.topics || []), JSON.stringify(paper.methodTags || []),
          paper.classificationEvidence]
      );
      await client.query("DELETE FROM paper_authors WHERE paper_id = $1", [paper.id]);
      await client.query("DELETE FROM paper_external_ids WHERE paper_id = $1", [paper.id]);
      for (const [provider, externalId] of Object.entries({
        dblp: paper.dblpKey,
        crossref: paper.crossrefId,
        aclAnthology: paper.aclAnthologyId,
        openalex: paper.openAlexId,
      })) {
        if (!externalId) continue;
        await client.query(`INSERT INTO paper_external_ids (paper_id, provider, external_id)
          VALUES ($1,$2,$3)`, [paper.id, provider, String(externalId)]);
      }
      for (const author of paper.authors || []) {
        await client.query(`INSERT INTO paper_authors (paper_id, author_position, author_name, orcid, dblp_pid)
          VALUES ($1,$2,$3,$4,$5)`, [paper.id, author.position, author.name, author.orcid, author.dblpPid]);
      }
      await client.query(`
        INSERT INTO edition_papers (edition_id, paper_id, membership_source, membership_confidence, membership_status, evidence_url)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (edition_id, paper_id) DO UPDATE SET
          membership_source=EXCLUDED.membership_source, membership_confidence=EXCLUDED.membership_confidence,
          membership_status=EXCLUDED.membership_status, evidence_url=EXCLUDED.evidence_url`,
        [paper.editionId, paper.id, paper.membership?.source, paper.membership?.confidence,
          paper.membership?.status, paper.membership?.evidenceUrl]
      );
    }
    for (const insight of snapshot.insights || []) {
      await client.query(`
        INSERT INTO venue_insights (venue_id, start_year, end_year, paper_count, themes, methods,
          extraction_evidence, generated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (venue_id) DO UPDATE SET start_year=EXCLUDED.start_year, end_year=EXCLUDED.end_year,
          paper_count=EXCLUDED.paper_count, themes=EXCLUDED.themes, methods=EXCLUDED.methods,
          extraction_evidence=EXCLUDED.extraction_evidence, generated_at=EXCLUDED.generated_at`,
        [insight.venueId, insight.startYear, insight.endYear, insight.paperCount, JSON.stringify(insight.themes || []),
          JSON.stringify(insight.methods || []), insight.extractionEvidence, insight.generatedAt]
      );
    }
    await client.query(`INSERT INTO ingestion_runs (provider, state, started_at, finished_at, error_summary)
      VALUES ('venue-history-sync','complete',NOW(),NOW(),NULL)`);
    await client.query("COMMIT");
    transactionStarted = false;
    return { written: true };
  } catch (error) {
    if (client && transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client?.release();
    await database.end();
    await closeVenueHistoryPool();
  }
}
