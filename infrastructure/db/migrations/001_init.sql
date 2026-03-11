-- =====================
-- URL STATE TABLE
-- =====================
CREATE TABLE IF NOT EXISTS urls (
  id SERIAL PRIMARY KEY,

  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL UNIQUE,

  domain TEXT,
  depth INT DEFAULT 0,

  status TEXT DEFAULT 'pending',

  discovered_at TIMESTAMP DEFAULT NOW(),
  last_crawled_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_urls_domain
ON urls(domain);

CREATE INDEX IF NOT EXISTS idx_urls_status
ON urls(status);



-- =====================
-- PAGE CONTENT TABLE
-- =====================
CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,

  url_id INT REFERENCES urls(id)
    ON DELETE CASCADE,

  status_code INT,

  title TEXT,
  description TEXT,
  h1 TEXT,
  fetched_at TIMESTAMP DEFAULT NOW()
);



-- =====================
-- LINK GRAPH
-- =====================
CREATE TABLE IF NOT EXISTS links (
  from_url_id INT REFERENCES urls(id)
    ON DELETE CASCADE,

  to_url_id INT REFERENCES urls(id)
    ON DELETE CASCADE,

  discovered_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (from_url_id, to_url_id)
);
