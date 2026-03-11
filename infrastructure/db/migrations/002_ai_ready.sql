-- ============================================================
-- Migration 002 — AI/RAG-ready schema
--
-- Safe to run on a DB that already has 001_init applied.
-- Uses ALTER TABLE ... ADD COLUMN IF NOT EXISTS everywhere
-- so re-runs are idempotent.
-- New tables (chunks, robots_cache, crawl_sessions) use
-- CREATE TABLE IF NOT EXISTS — safe on fresh DBs too.
--
-- pgvector is OPTIONAL. If not installed, embedding_vector
-- is stored as TEXT (JSON array string). Run migration 003
-- after installing pgvector to upgrade the column type.
-- ============================================================


-- ── 2. urls — composite index (base indexes exist from 001) ───────────────────
CREATE INDEX IF NOT EXISTS idx_urls_domain_status ON urls(domain, status);


-- ── 3. pages — add all AI/RAG columns ─────────────────────────────────────────
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS author TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS excerpt TEXT,
  ADD COLUMN IF NOT EXISTS word_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reading_time INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lang TEXT,
  ADD COLUMN IF NOT EXISTS quality_score INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quality_length_score INT,
  ADD COLUMN IF NOT EXISTS quality_density_score INT,
  ADD COLUMN IF NOT EXISTS quality_readability_score INT,
  ADD COLUMN IF NOT EXISTS quality_structure_score INT,
  ADD COLUMN IF NOT EXISTS quality_uniqueness_score INT,
  ADD COLUMN IF NOT EXISTS quality_freshness_score INT,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS quality_flags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS passes_quality_gate BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS modified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS og_image TEXT,
  ADD COLUMN IF NOT EXISTS rendered_with TEXT DEFAULT 'http',
  ADD COLUMN IF NOT EXISTS proxy_used TEXT;

CREATE INDEX IF NOT EXISTS idx_pages_url_id ON pages(url_id);
CREATE INDEX IF NOT EXISTS idx_pages_quality ON pages(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_pages_content_type ON pages(content_type);
CREATE INDEX IF NOT EXISTS idx_pages_passes_quality ON pages(passes_quality_gate) WHERE passes_quality_gate = TRUE;
CREATE INDEX IF NOT EXISTS idx_pages_domain_quality ON pages(url_id, quality_score);


-- ── 4. chunks table ───────────────────────────────────────────────────────────
-- embedding_vector stored as TEXT (JSON array) until pgvector is available.
-- Migration 003 will ALTER it to vector(1536) once pgvector is installed.
CREATE TABLE IF NOT EXISTS chunks (
  id               SERIAL PRIMARY KEY,

  page_id          INT REFERENCES pages(id)  ON DELETE CASCADE,
  url_id           INT REFERENCES urls(id)   ON DELETE CASCADE,

  chunk_index      INT     NOT NULL,
  total_chunks     INT     NOT NULL,

  text             TEXT    NOT NULL,
  token_estimate   INT,

  char_start       INT,
  char_end         INT,

  section_heading  TEXT,
  word_count       INT,

  -- Embedding metadata (populated by extractor-worker)
  -- Type is TEXT until pgvector is installed (see migration 003)
  embedding_model  TEXT,
  embedding_vector TEXT,   -- stores '[0.1,0.2,...]' JSON string for now

  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_url_id  ON chunks(url_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_model
  ON chunks(embedding_model) WHERE embedding_model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_unembedded
  ON chunks(id) WHERE embedding_vector IS NULL AND embedding_model IS NULL;


-- ── 5. robots_cache table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS robots_cache (
  domain               TEXT PRIMARY KEY,
  sitemap_urls         TEXT[]  DEFAULT '{}',
  crawl_delay_seconds  FLOAT   DEFAULT 0,
  disallow_count       INT     DEFAULT 0,
  fetched_at           TIMESTAMP DEFAULT NOW(),
  expires_at           TIMESTAMP DEFAULT NOW() + INTERVAL '1 hour'
);


-- ── 6. links — add missing indexes ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_url_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_url_id);


-- ── 7. crawl_sessions table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crawl_sessions (
  id             TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  status         TEXT DEFAULT 'running',
  max_depth      INT  DEFAULT 3,
  pages_crawled  INT  DEFAULT 0,
  pages_queued   INT  DEFAULT 0,
  pages_failed   INT  DEFAULT 0,
  started_at     TIMESTAMP DEFAULT NOW(),
  completed_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_domain ON crawl_sessions(domain);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON crawl_sessions(status);
