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

/** Looks up an account by username. Returns null if not found or persistence is off. */
async function getUserByUsername(username) {
  if (!enabled) return null;
  const rows = await query(
    "SELECT id, username, password_hash, salt, guild, lumen FROM users WHERE username = ?",
    [username]
  );
  const row = (rows || [])[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    salt: row.salt,
    guild: row.guild || null,
    lumen: row.lumen,
  };
}

/** Creates a new account. Returns the new user's id, or null if the username is taken. */
async function createUser({ username, passwordHash, salt, guild }) {
  if (!enabled) return null;
  const existing = await getUserByUsername(username);
  if (existing) return null;
  await query(
    "INSERT INTO users (username, password_hash, salt, guild, lumen, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [username, passwordHash, salt, guild || null, 20, Date.now()]
  );
  const created = await getUserByUsername(username);
  return created ? created.id : null;
}

/** Persists an account's current lumen/guild (called periodically, like cell flushes). */
async function saveUserState(userId, { lumen, guild }) {
  if (!enabled) return;
  try {
    await query("UPDATE users SET lumen = ?, guild = ? WHERE id = ?", [lumen, guild || null, userId]);
  } catch (err) {
    console.error("D1 user save failed:", err.message);
  }
}

module.exports = {
  enabled,
  loadAllCells,
  saveCells,
  getUserByUsername,
  createUser,
  saveUserState,
};
