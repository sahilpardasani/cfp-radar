CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  acronym TEXT NOT NULL,
  venue_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  official_url TEXT,
  external_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  identity_evidence JSONB,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS venue_aliases (
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'config',
  valid_from INTEGER,
  valid_to INTEGER,
  PRIMARY KEY (venue_id, alias)
);

CREATE TABLE IF NOT EXISTS venue_external_ids (
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  verified_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE IF NOT EXISTS venue_editions (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  event_year INTEGER NOT NULL CHECK (event_year BETWEEN 1900 AND 2200),
  title TEXT NOT NULL,
  location TEXT,
  verification_status TEXT NOT NULL,
  membership_source TEXT NOT NULL,
  volumes JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (venue_id, event_year)
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  dblp_key TEXT UNIQUE,
  proceedings_key TEXT,
  doi TEXT UNIQUE,
  title TEXT NOT NULL,
  abstract TEXT,
  publication_year INTEGER,
  pages TEXT,
  citation_count INTEGER,
  publisher_url TEXT,
  dblp_url TEXT,
  open_access_url TEXT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  method_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification_evidence TEXT
);

CREATE TABLE IF NOT EXISTS paper_external_ids (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (provider, external_id),
  UNIQUE (paper_id, provider)
);

CREATE TABLE IF NOT EXISTS edition_papers (
  edition_id TEXT NOT NULL REFERENCES venue_editions(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  membership_source TEXT NOT NULL,
  membership_confidence NUMERIC(4,3) NOT NULL CHECK (membership_confidence >= 0 AND membership_confidence <= 1),
  membership_status TEXT NOT NULL,
  evidence_url TEXT,
  PRIMARY KEY (edition_id, paper_id)
);

CREATE TABLE IF NOT EXISTS paper_authors (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  author_position INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  orcid TEXT,
  dblp_pid TEXT,
  PRIMARY KEY (paper_id, author_position)
);

CREATE TABLE IF NOT EXISTS venue_insights (
  venue_id TEXT PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  start_year INTEGER,
  end_year INTEGER,
  paper_count INTEGER NOT NULL DEFAULT 0,
  themes JSONB NOT NULL DEFAULT '[]'::jsonb,
  methods JSONB NOT NULL DEFAULT '[]'::jsonb,
  extraction_evidence TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  venue_id TEXT,
  state TEXT NOT NULL,
  cursor TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS venue_editions_venue_year_idx ON venue_editions (venue_id, event_year DESC);
CREATE INDEX IF NOT EXISTS edition_papers_paper_idx ON edition_papers (paper_id);
CREATE INDEX IF NOT EXISTS papers_publication_year_idx ON papers (publication_year DESC);
CREATE INDEX IF NOT EXISTS papers_title_search_idx ON papers USING GIN (to_tsvector('english', title || ' ' || COALESCE(abstract, '')));

-- These tables are server-side application data. Enabling RLS with no public
-- policies makes Supabase/PostgREST access default-deny, while the owning
-- migration/application role used by Render or the backend retains access.
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE edition_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE venues, venue_aliases, venue_external_ids, venue_editions,
  papers, paper_external_ids, edition_papers, paper_authors, venue_insights,
  ingestion_runs FROM PUBLIC;
