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
  season_lumen REAL NOT NULL DEFAULT 0,
  career_lumen REAL NOT NULL DEFAULT 0,
  color TEXT,
  founder INTEGER NOT NULL DEFAULT 0,
  is_supporter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Small persistent key/value store for global game state (current season number,
-- when it started, etc) that needs to survive restarts/redeploys.
CREATE TABLE IF NOT EXISTS game_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Archive of completed seasons' top performers, for a Hall of Fame panel.
CREATE TABLE IF NOT EXISTS season_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_number INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  top_players TEXT,
  top_guilds TEXT
);

-- Aggregate, privacy-respecting daily usage stats (no player-identifying data) --
-- used for a lightweight /stats view rather than any third-party analytics service.
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  peak_players INTEGER NOT NULL DEFAULT 0,
  total_claims INTEGER NOT NULL DEFAULT 0,
  new_accounts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Granting "supporter" status manually (until real payment processing exists)
-- ---------------------------------------------------------------------------
-- There's no automated purchase flow yet -- the season pass paid track and the
-- supporter-exclusive cosmetic colors are gated by the users.is_supporter flag,
-- which you can set by hand whenever someone tips you (Ko-fi/BMC/GitHub
-- Sponsors) or however you decide to collect support. Run this against the
-- meridian D1 database (Cloudflare dashboard D1 console, or via the Cloudflare
-- MCP connector) after confirming payment:
--
--   UPDATE users SET is_supporter = 1 WHERE username = 'their_username_here';
--
-- To revoke: UPDATE users SET is_supporter = 0 WHERE username = '...';
-- The player will see their supporter-exclusive colors unlock the next time
-- their client receives a "you" update (within a couple seconds of any action).
