// Persistence layer backed by a small Cloudflare Worker proxy in front of D1
// (see cloudflare-worker/d1-proxy.js). We go through a Worker with a native
// D1 binding rather than calling Cloudflare's control-plane REST API
// directly, since that API can reject requests from some hosts' outbound IP
// ranges even with fully valid credentials.
//
// If the required env vars aren't set, every function becomes a harmless
// no-op so local development and testing work exactly as before -- state
// just lives in memory only, same as the original prototype.
const PROXY_URL = (process.env.D1_PROXY_URL || "").trim();
const PROXY_SECRET = (process.env.D1_PROXY_SECRET || "").trim();

const enabled = Boolean(PROXY_URL && PROXY_SECRET);

if (enabled) {
  console.log(`D1 proxy config -- url: ${PROXY_URL}, secret length: ${PROXY_SECRET.length}`);
}

async function query(sql, params = []) {
  if (!enabled) return null;
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: {
      "X-Proxy-Secret": PROXY_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) {
    console.error("D1 proxy query failed:", JSON.stringify(json.error || json));
    return null;
  }
  return json.results ?? [];
}

/** Returns a Map<id, {ownerName, color, defense, guild}> of every persisted owned cell. */
async function loadAllCells() {
  if (!enabled) {
    console.log("Persistence disabled (no D1_PROXY_URL/D1_PROXY_SECRET) -- starting fresh.");
    return new Map();
  }
  try {
    const rows = await query(
      "SELECT id, owner_name, color, defense, guild FROM cells WHERE owner_name IS NOT NULL"
    );
    const map = new Map();
    for (const row of rows || []) {
      map.set(row.id, {
        ownerName: row.owner_name,
        color: row.color,
        defense: row.defense,
        guild: row.guild || null,
      });
    }
    console.log(`Loaded ${map.size} owned cells from D1.`);
    return map;
  } catch (err) {
    console.error("D1 load failed, starting fresh:", err.message);
    return new Map();
  }
}

/** Batch-upsert a list of {id, ownerName, color, defense, guild} cells. */
async function saveCells(cellList) {
  if (!enabled || cellList.length === 0) return;
  const now = Date.now();
  // D1 supports multi-row INSERT ... ON CONFLICT in a single statement.
  const placeholders = cellList.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const sql = `
    INSERT INTO cells (id, owner_name, color, defense, guild, updated_at)
    VALUES ${placeholders}
    ON CONFLICT(id) DO UPDATE SET
      owner_name = excluded.owner_name,
      color = excluded.color,
      defense = excluded.defense,
      guild = excluded.guild,
      updated_at = excluded.updated_at
  `;
  const params = [];
  for (const c of cellList) {
    params.push(c.id, c.ownerName, c.color, c.defense, c.guild || null, now);
  }
  try {
    await query(sql, params);
  } catch (err) {
    console.error("D1 save failed:", err.message);
  }
}

const USER_COLUMNS =
  "id, username, password_hash, salt, guild, lumen, season_lumen, career_lumen, color, founder, is_supporter, google_sub, apple_sub, email";

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    salt: row.salt,
    guild: row.guild || null,
    lumen: row.lumen,
    seasonLumen: row.season_lumen || 0,
    careerLumen: row.career_lumen || 0,
    color: row.color || null,
    founder: !!row.founder,
    isSupporter: !!row.is_supporter,
    googleSub: row.google_sub || null,
    appleSub: row.apple_sub || null,
    email: row.email || null,
  };
}

/** Looks up an account by username. Returns null if not found or persistence is off. */
async function getUserByUsername(username) {
  if (!enabled) return null;
  const rows = await query(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`, [username]);
  return rowToUser((rows || [])[0]);
}

/** Looks up an account linked to a given Google account (the token's "sub" claim). */
async function getUserByGoogleSub(googleSub) {
  if (!enabled || !googleSub) return null;
  const rows = await query(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`, [googleSub]);
  return rowToUser((rows || [])[0]);
}

/** Looks up an account linked to a given Apple account (the token's "sub" claim). */
async function getUserByAppleSub(appleSub) {
  if (!enabled || !appleSub) return null;
  const rows = await query(`SELECT ${USER_COLUMNS} FROM users WHERE apple_sub = ?`, [appleSub]);
  return rowToUser((rows || [])[0]);
}

/** Creates a new account. Returns the new user's id, or null if the username is taken.
 * googleSub/appleSub/email are optional -- set when the account is created via OAuth sign-in.
 * passwordHash/salt are still required (schema has them NOT NULL); OAuth-only signups pass
 * a random, un-guessable value that can never be produced by a real password login attempt. */
async function createUser({ username, passwordHash, salt, guild, founder, googleSub, appleSub, email }) {
  if (!enabled) return null;
  const existing = await getUserByUsername(username);
  if (existing) return null;
  await query(
    `INSERT INTO users (username, password_hash, salt, guild, lumen, founder, created_at, google_sub, apple_sub, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, passwordHash, salt, guild || null, 20, founder ? 1 : 0, Date.now(), googleSub || null, appleSub || null, email || null]
  );
  const created = await getUserByUsername(username);
  return created ? created.id : null;
}

/** Persists an account's current lumen/guild/season progress/color (called periodically, like cell flushes). */
async function saveUserState(userId, { lumen, guild, seasonLumen, careerLumen, color }) {
  if (!enabled) return;
  try {
    await query("UPDATE users SET lumen = ?, guild = ?, season_lumen = ?, career_lumen = ?, color = ? WHERE id = ?", [
      lumen, guild || null, seasonLumen || 0, careerLumen || 0, color || null, userId,
    ]);
  } catch (err) {
    console.error("D1 user save failed:", err.message);
  }
}

/** Returns the top N accounts of all time by cumulative career Lumen -- includes offline players,
 * unlike the in-memory season leaderboard which only shows who's currently connected. */
async function getAllTimeLeaderboard(limit = 10) {
  if (!enabled) return [];
  try {
    const rows = await query(
      "SELECT username, career_lumen, guild, color, founder FROM users ORDER BY career_lumen DESC LIMIT ?",
      [limit]
    );
    return (rows || []).map((r) => ({
      name: r.username, careerLumen: Math.round(r.career_lumen || 0), guild: r.guild || null,
      color: r.color, founder: !!r.founder,
    }));
  } catch (err) {
    console.error("D1 all-time leaderboard load failed:", err.message);
    return [];
  }
}

/** Atomically-ish increments and returns the running total of accounts ever created, for the founder cutoff. */
async function incrementAndGetAccountCount() {
  if (!enabled) return 0;
  const meta = await getGameMeta(["total_accounts"]);
  const next = (Number(meta.total_accounts) || 0) + 1;
  await setGameMeta("total_accounts", String(next));
  return next;
}

/** Reads a small set of persistent key/value settings (season number, timers, etc). */
async function getGameMeta(keys) {
  if (!enabled || !keys || keys.length === 0) return {};
  const placeholders = keys.map(() => "?").join(", ");
  const rows = await query(`SELECT key, value FROM game_meta WHERE key IN (${placeholders})`, keys);
  const out = {};
  for (const row of rows || []) out[row.key] = row.value;
  return out;
}

async function setGameMeta(key, value) {
  if (!enabled) return;
  try {
    await query(
      `INSERT INTO game_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  } catch (err) {
    console.error("D1 game_meta save failed:", err.message);
  }
}

/** Archives a completed season's top players/guilds into season_history. */
async function archiveSeason(summary) {
  if (!enabled) return;
  try {
    await query(
      "INSERT INTO season_history (season_number, ended_at, top_players, top_guilds) VALUES (?, ?, ?, ?)",
      [summary.seasonNumber, summary.endedAt, JSON.stringify(summary.topPlayers), JSON.stringify(summary.topGuilds)]
    );
  } catch (err) {
    console.error("D1 season archive failed:", err.message);
  }
}

/** Zeroes season_lumen for every account -- called once at season rollover, including offline players. */
async function resetAllSeasonLumen() {
  if (!enabled) return;
  try {
    await query("UPDATE users SET season_lumen = 0");
  } catch (err) {
    console.error("D1 season reset failed:", err.message);
  }
}

/** Returns the most recent N archived seasons, newest first, for a Hall of Fame panel. */
async function getRecentSeasons(limit = 5) {
  if (!enabled) return [];
  try {
    const rows = await query(
      "SELECT season_number, ended_at, top_players, top_guilds FROM season_history ORDER BY season_number DESC LIMIT ?",
      [limit]
    );
    return (rows || []).map((row) => ({
      seasonNumber: row.season_number,
      endedAt: row.ended_at,
      topPlayers: JSON.parse(row.top_players || "[]"),
      topGuilds: JSON.parse(row.top_guilds || "[]"),
    }));
  } catch (err) {
    console.error("D1 season history load failed:", err.message);
    return [];
  }
}

/** Upserts one day's aggregate, privacy-respecting usage stats (no player-identifying data). */
async function upsertDailyStats(date, { peakPlayers, totalClaims, newAccounts }) {
  if (!enabled) return;
  try {
    await query(
      `INSERT INTO daily_stats (date, peak_players, total_claims, new_accounts, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         peak_players = excluded.peak_players,
         total_claims = excluded.total_claims,
         new_accounts = excluded.new_accounts,
         updated_at = excluded.updated_at`,
      [date, peakPlayers, totalClaims, newAccounts, Date.now()]
    );
  } catch (err) {
    console.error("D1 daily_stats save failed:", err.message);
  }
}

/** Returns the most recent N days of aggregate stats, newest first. */
async function getDailyStats(days = 14) {
  if (!enabled) return [];
  try {
    const rows = await query("SELECT date, peak_players, total_claims, new_accounts FROM daily_stats ORDER BY date DESC LIMIT ?", [days]);
    return (rows || []).map((r) => ({
      date: r.date, peakPlayers: r.peak_players, totalClaims: r.total_claims, newAccounts: r.new_accounts,
    }));
  } catch (err) {
    console.error("D1 daily_stats load failed:", err.message);
    return [];
  }
}

module.exports = {
  enabled,
  loadAllCells,
  saveCells,
  getUserByUsername,
  getUserByGoogleSub,
  getUserByAppleSub,
  createUser,
  saveUserState,
  getGameMeta,
  setGameMeta,
  archiveSeason,
  resetAllSeasonLumen,
  getRecentSeasons,
  upsertDailyStats,
  getDailyStats,
  incrementAndGetAccountCount,
  getAllTimeLeaderboard,
};
