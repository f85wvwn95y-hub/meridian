-- Run this once against a fresh D1 database (via the Cloudflare dashboard's
-- D1 console, or `wrangler d1 execute <db-name> --file=scripts/d1-schema.sql`)
-- before pointing Meridian at it with CF_D1_DATABASE_ID.

CREATE TABLE IF NOT EXISTS cells (
  id INTEGER PRIMARY KEY,
  owner_name TEXT,
  color TEXT,
  defense REAL NOT NULL DEFAULT 0,
  guild TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  guild TEXT,
  lumen REAL NOT NULL DEFAULT 20,
  created_at INTEGER NOT NULL
);
