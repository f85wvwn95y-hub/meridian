// Optional persistence layer backed by Cloudflare D1's HTTP API.
// If the required env vars aren't set, every function becomes a harmless
// no-op so local development and testing work exactly as before --
// state just lives in memory only, same as the original prototype.
// .trim() guards against stray whitespace/newlines that can sneak in when
// environment variables are pasted into a host's dashboard.
const ACCOUNT_ID = (process.env.CF_ACCOUNT_ID || "").trim();
const API_TOKEN = (process.env.CF_API_TOKEN || "").trim();
const DATABASE_ID = (process.env.CF_D1_DATABASE_ID || "").trim();

const enabled = Boolean(ACCOUNT_ID && API_TOKEN && DATABASE_ID);

const API_URL = enabled
  ? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`
  : null;

if (enabled) {
  console.log(
    `D1 config -- account_id: "${ACCOUNT_ID}" (len ${ACCOUNT_ID.length}), ` +
    `database_id: "${DATABASE_ID}" (len ${DATABASE_ID.length}), ` +
    `token length: ${API_TOKEN.length}, url: ${API_URL}`
  );
}

async function query(sql, params = []) {
  if (!enabled) return null;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) {
    console.error("D1 query failed:", JSON.stringify(json.errors || json));
    return null;
  }
  return json.result?.[0]?.results ?? [];
}

/** Returns a Map<id, {ownerName, color, defense}> of every persisted owned cell. */
async function loadAllCells() {
  if (!enabled) {
    console.log("Persistence disabled (no CF_ACCOUNT_ID/CF_API_TOKEN/CF_D1_DATABASE_ID) -- starting fresh.");
    return new Map();
  }
  try {
    const rows = await query(
      "SELECT id, owner_name, color, defense FROM cells WHERE owner_name IS NOT NULL"
    );
    const map = new Map();
    for (const row of rows || []) {
      map.set(row.id, { ownerName: row.owner_name, color: row.color, defense: row.defense });
    }
    console.log(`Loaded ${map.size} owned cells from D1.`);
    return map;
  } catch (err) {
    console.error("D1 load failed, starting fresh:", err.message);
    return new Map();
  }
}

/** Batch-upsert a list of {id, ownerName, color, defense} cells. */
async function saveCells(cellList) {
  if (!enabled || cellList.length === 0) return;
  const now = Date.now();
  // D1 supports multi-row INSERT ... ON CONFLICT in a single statement.
  const placeholders = cellList.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const sql = `
    INSERT INTO cells (id, owner_name, color, defense, updated_at)
    VALUES ${placeholders}
    ON CONFLICT(id) DO UPDATE SET
      owner_name = excluded.owner_name,
      color = excluded.color,
      defense = excluded.defense,
      updated_at = excluded.updated_at
  `;
  const params = [];
  for (const c of cellList) {
    params.push(c.id, c.ownerName, c.color, c.defense, now);
  }
  try {
    await query(sql, params);
  } catch (err) {
    console.error("D1 save failed:", err.message);
  }
}

module.exports = { enabled, loadAllCells, saveCells };
