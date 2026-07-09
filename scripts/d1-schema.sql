-- Run this once against a fresh D1 database (via the Cloudflare dashboard's
-- D1 console, or `wrangler d1 execute <db-name> --file=scripts/d1-schema.sql`)
-- before pointing Meridian at it with CF_D1_DATABASE_ID.

CREATE TABLE IF NOT EXISTS cells (
  id INTEGER PRIMARY KEY,
  owner_name TEXT,
  color TEXT,
  defense REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
