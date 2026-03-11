-- ============================================================
-- Migration 003 — pgvector upgrade
-- @requires-extension vector
--
-- Run AFTER installing pgvector on your Postgres server:
--
--   Docker:  use image pgvector/pgvector:pg15 instead of postgres:15
--   Ubuntu:  apt install postgresql-15-pgvector
--   macOS:   brew install pgvector
--
-- The migrate script skips this file automatically until pgvector
-- is available, then applies it on the next run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Upgrade embedding_vector TEXT → vector(1536), casting stored JSON strings
ALTER TABLE chunks
  ALTER COLUMN embedding_vector
    TYPE vector(1024)
    USING (
      CASE
        WHEN embedding_vector IS NULL THEN NULL
        ELSE embedding_vector::vector(1536)
      END
    );

-- ANN index for cosine similarity search
-- Tune lists = sqrt(total_rows), min 10, max 1000
CREATE INDEX IF NOT EXISTS idx_chunks_vector
  ON chunks USING ivfflat (embedding_vector vector_cosine_ops)
  WITH (lists = 100);
