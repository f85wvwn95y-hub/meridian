const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { subsolarPoint, solarElevation } = require("./solar");
const { CELL_SIZE, allCellIds, cellCenter } = require("./grid");
const persistence = require("./persistence");
const auth = require("./auth");

const PORT = process.env.PORT || 8787;
const TICK_MS = 2000;
const FLUSH_MS = 20000; // how often owned territory / accounts get persisted to D1
const BASE_CLAIM_COST = 10;
const MAX_DEFENSE = 40;
const DEFENSE_GROWTH_PER_SEC = 0.4;
const RUSH_HALF_WIDTH_DEG = 6; // solar elevation within +/- this = "rush zone"
const MIN_CLAIM_INTERVAL_MS = 150; // basic anti-spam throttle on claims per connection

const PALETTE = [
  "#ff5c5c", "#5cc9ff", "#ffd35c", "#7dff5c", "#c65cff",
  "#ff8f5c", "#5cffd3", "#ff5ca8", "#a8ff5c", "#5c7dff",
];

// ---- world state ----
const cells = new Map(); // id -> { ownerId, ownerName, color, defense, guild, illum }
for (const id of allCellIds()) {
  cells.set(id, { ownerId: null, ownerName: null, color: null, defense: 0, guild: null, illum: "night" });
}

const players = new Map(); // ws -> player
let nextColor = 0;
let playerSeq = 1;

const MAX_GUILD_LEN = 6;
function sanitizeGuild(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_GUILD_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeUsername(raw) {
  const cleaned = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return cleaned.length >= 3 ? cleaned : null;
}

function cellCountFor(ownerName) {
  let count = 0;
  for (const c of cells.values()) if (c.ownerName === ownerName) count++;
  return count;
}

/** Gathers every currently-owned cell in the shape persistence.saveCells expects. */
function ownedCellsSnapshot() {
  const out = [];
  for (const [id, c] of cells.entries()) {
    if (c.ownerName) {
      out.push({ id, ownerName: c.ownerName, color: c.color, defense: c.defense, guild: c.guild });
    }
  }
  return out;
}

async function flushToDisk() {
  const snapshot = ownedCellsSnapshot();
  if (snapshot.length > 0) await persistence.saveCells(snapshot);

  // Also persist lumen/guild for any currently-connected registered accounts.
  const accountSaves = [...players.values()]
    .filter((p) => p.kind === "account")
    .map((p) => persistence.saveUserState(p.userId, { lumen: p.lumen, guild: p.guild }));
  await Promise.all(accountSaves);
}

function assignColor() {
  const c = PALETTE[nextColor % PALETTE.length];
  nextColor++;
  return c;
}

function illumCategory(elevDeg) {
  if (Math.abs(elevDeg) <= RUSH_HALF_WIDTH_DEG) return "rush";
  return elevDeg > 0 ? "day" : "night";
}

function incomeFor(illum) {
  if (illum === "rush") return 3;
  if (illum === "day") return 1;
  return 0.3;
}

// Returns Infinity to signal "can't be claimed" (e.g. attacking a guildmate).
function claimCost(cell, illum, attackerGuild) {
  // Ownership survives restarts via ownerName even when no live player (ownerId)
  // is currently connected to that identity, so cost is based on ownerName.
  if (!cell.ownerName) return BASE_CLAIM_COST;
  if (cell.guild && attackerGuild && cell.guild === attackerGuild) return Infinity;
  const attackCost = BASE_CLAIM_COST + cell.defense;
  return illum === "rush" ? attackCost * 0.5 : attackCost;
}

function leaderboard() {
  return [...players.values()]
    .map((p) => ({ name: p.name, color: p.color, guild: p.guild, lumen: Math.round(p.lumen), cellCount: p.cellCount }))
    .sort((a, b) => b.lumen - a.lumen)
    .slice(0, 10);
}

/** Ranks guilds by total territory currently held (persists across restarts,
 * since it's derived from cell ownership rather than who's online). */
function guildLeaderboard() {
  const totals = new Map(); // guild -> { cellCount, totalDefense }
  for (const c of cells.values()) {
    if (!c.guild) continue;
    const t = totals.get(c.guild) || { cellCount: 0, totalDefense: 0 };
    t.cellCount += 1;
    t.totalDefense += c.defense;
    totals.set(c.guild, t);
  }
  return [...totals.entries()]
    .map(([guild, t]) => ({ guild, cellCount: t.cellCount, totalDefense: Math.round(t.totalDefense) }))
    .sort((a, b) => b.cellCount - a.cellCount)
    .slice(0, 10);
}

function publicCell(id) {
  const c = cells.get(id);
  return {
    id,
    ownerName: c.ownerName,
    color: c.color,
    defense: Math.round(c.defense),
    guild: c.guild,
    illum: c.illum,
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of players.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// ---- game tick: recompute illumination, accrue income/defense, broadcast ----
function startTicking() {
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    const subsolar = subsolarPoint(new Date(now));
    const changedIds = [];

    for (const id of allCellIds()) {
      const cell = cells.get(id);
      const { lon, lat } = cellCenter(id);
      const elev = solarElevation(lat, lon, subsolar);
      const illum = illumCategory(elev);
      if (illum !== cell.illum) changedIds.push(id);
      cell.illum = illum;

      if (cell.ownerId) {
        const owner = [...players.values()].find((p) => p.id === cell.ownerId);
        if (owner) {
          owner.lumen += incomeFor(illum) * dt;
          cell.defense = Math.min(MAX_DEFENSE, cell.defense + DEFENSE_GROWTH_PER_SEC * dt);
        }
      }
    }

    broadcast({
      type: "tick",
      subsolar,
      changed: changedIds.map(publicCell),
      leaderboard: leaderboard(),
      guildLeaderboard: guildLeaderboard(),
      playerCount: players.size,
      serverTimeUTC: new Date(now).toISOString(),
    });

    for (const [ws, player] of players.entries()) {
      send(ws, { type: "you", you: player });
    }
  }, TICK_MS);

  // Periodically persist owned territory so it survives restarts/redeploys.
  setInterval(() => {
    flushToDisk().catch((err) => console.error("Periodic flush failed:", err.message));
  }, FLUSH_MS);
}

// ---- websocket handling ----
const app = express();
app.get("/health", (req, res) => res.status(200).send("ok")); // for uptime pingers -- cheap, no static file read
app.use(express.static(path.join(__dirname, "public")));
let server;
let wss;

async function main() {
  const persisted = await persistence.loadAllCells();
  for (const [id, saved] of persisted.entries()) {
    const cell = cells.get(id);
    if (cell) {
      cell.ownerId = null; // no live connection owns it yet -- income resumes once reclaimed
      cell.ownerName = saved.ownerName;
      cell.color = saved.color;
      cell.defense = saved.defense;
      cell.guild = saved.guild || null;
    }
  }

  server = app.listen(PORT, () => {
    console.log(`Meridian running: http://localhost:${PORT}`);
    console.log(`Persistence: ${persistence.enabled ? "ON (Cloudflare D1)" : "OFF (in-memory only)"}`);
  });
  wss = new WebSocketServer({ server });
  attachWebSocketHandlers();
  startTicking();
}

async function shutdown() {
  console.log("Shutting down -- flushing territory to disk...");
  try {
    await flushToDisk();
  } catch (err) {
    console.error("Shutdown flush failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Reconnects a returning player's income to any cells they still own: after
// a restart, or between sessions, persisted cells have ownerId=null (no live
// connection). Matching by ownerName restores accrual without needing the
// player to re-claim anything.
function relinkOwnedCells(player) {
  for (const cell of cells.values()) {
    if (cell.ownerName === player.name) cell.ownerId = player.id;
  }
}

function registerPlayer(ws, player) {
  relinkOwnedCells(player);
  players.set(ws, player);
  send(ws, {
    type: "welcome",
    you: player,
    token: player.token || null,
    cellSize: CELL_SIZE,
    cells: allCellIds().map(publicCell),
    subsolar: subsolarPoint(new Date()),
    leaderboard: leaderboard(),
    guildLeaderboard: guildLeaderboard(),
    playerCount: players.size,
  });
  broadcast({
    type: "leaderboard",
    leaderboard: leaderboard(),
    guildLeaderboard: guildLeaderboard(),
    playerCount: players.size,
  });
}

function attachWebSocketHandlers() {
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      if (msg.type === "guestJoin") {
        const name = (String(msg.name || "Wanderer").trim().slice(0, 20)) || "Wanderer";
        const guild = sanitizeGuild(msg.guild);
        const collision = await persistence.getUserByUsername(name.toLowerCase());
        if (collision) {
          send(ws, { type: "error", message: "That name belongs to a registered account -- log in or pick another." });
          return;
        }
        const player = {
          kind: "guest",
          id: `guest:${playerSeq++}`,
          name,
          guild,
          color: assignColor(),
          lumen: 20,
          cellCount: cellCountFor(name),
          lastClaimAt: 0,
        };
        registerPlayer(ws, player);
        return;
      }

      if (msg.type === "signup") {
        const username = sanitizeUsername(msg.username);
        const password = String(msg.password || "");
        if (!username) {
          send(ws, { type: "error", message: "Username must be 3-20 letters, numbers, or underscores." });
          return;
        }
        if (password.length < 6) {
          send(ws, { type: "error", message: "Password must be at least 6 characters." });
          return;
        }
        if (!persistence.enabled) {
          send(ws, { type: "error", message: "Accounts aren't available right now -- try Guest play instead." });
          return;
        }
        const guild = sanitizeGuild(msg.guild);
        const { hash, salt } = auth.hashPassword(password);
        const userId = await persistence.createUser({ username, passwordHash: hash, salt, guild });
        if (!userId) {
          send(ws, { type: "error", message: "That username is already taken." });
          return;
        }
        const token = auth.signToken({ uid: userId, username });
        const player = {
          kind: "account",
          id: `acct:${userId}`,
          userId,
          name: username,
          guild,
          color: assignColor(),
          lumen: 20,
          cellCount: cellCountFor(username),
          lastClaimAt: 0,
          token,
        };
        registerPlayer(ws, player);
        return;
      }

      if (msg.type === "login") {
        const username = sanitizeUsername(msg.username);
        const password = String(msg.password || "");
        if (!persistence.enabled) {
          send(ws, { type: "error", message: "Accounts aren't available right now -- try Guest play instead." });
          return;
        }
        const user = username ? await persistence.getUserByUsername(username) : null;
        if (!user || !auth.verifyPassword(password, user.salt, user.passwordHash)) {
          send(ws, { type: "error", message: "Invalid username or password." });
          return;
        }
        const token = auth.signToken({ uid: user.id, username: user.username });
        const player = {
          kind: "account",
          id: `acct:${user.id}`,
          userId: user.id,
          name: user.username,
          guild: user.guild,
          color: assignColor(),
          lumen: user.lumen,
          cellCount: cellCountFor(user.username),
          lastClaimAt: 0,
          token,
        };
        registerPlayer(ws, player);
        return;
      }

      if (msg.type === "resume") {
        const payload = auth.verifyToken(msg.token);
        if (!payload || !persistence.enabled) {
          send(ws, { type: "error", message: "Session expired -- please log in again." });
          return;
        }
        const user = await persistence.getUserByUsername(payload.username);
        if (!user || user.id !== payload.uid) {
          send(ws, { type: "error", message: "Session expired -- please log in again." });
          return;
        }
        const player = {
          kind: "account",
          id: `acct:${user.id}`,
          userId: user.id,
          name: user.username,
          guild: user.guild,
          color: assignColor(),
          lumen: user.lumen,
          cellCount: cellCountFor(user.username),
          lastClaimAt: 0,
          token: msg.token,
        };
        registerPlayer(ws, player);
        return;
      }

      const player = players.get(ws);
      if (!player) return;

      if (msg.type === "claim") {
        const now = Date.now();
        if (now - player.lastClaimAt < MIN_CLAIM_INTERVAL_MS) return;
        player.lastClaimAt = now;

        const id = Number(msg.cellId);
        const cell = cells.get(id);
        if (!cell || cell.ownerId === player.id) return;
        const cost = claimCost(cell, cell.illum, player.guild);
        if (!Number.isFinite(cost)) {
          send(ws, { type: "error", message: "Can't attack a guildmate's territory." });
          return;
        }
        if (player.lumen < cost) {
          send(ws, { type: "error", message: "Not enough Lumen." });
          return;
        }
        const prevOwner = cell.ownerId
          ? [...players.values()].find((p) => p.id === cell.ownerId)
          : null;
        player.lumen -= cost;
        if (prevOwner) prevOwner.cellCount = Math.max(0, prevOwner.cellCount - 1);
        cell.ownerId = player.id;
        cell.ownerName = player.name;
        cell.color = player.color;
        cell.defense = 0;
        cell.guild = player.guild;
        player.cellCount += 1;

        broadcast({ type: "cellUpdate", cell: publicCell(id) });
        broadcast({
          type: "leaderboard",
          leaderboard: leaderboard(),
          guildLeaderboard: guildLeaderboard(),
          playerCount: players.size,
        });
        send(ws, { type: "you", you: { ...player } });

        // Best-effort immediate save so a claim survives even a restart moments later.
        persistence
          .saveCells([
            { id, ownerName: cell.ownerName, color: cell.color, defense: cell.defense, guild: cell.guild },
          ])
          .catch((err) => console.error("Claim save failed:", err.message));
      }
    } catch (err) {
      console.error("Message handler error:", err);
      send(ws, { type: "error", message: "Something went wrong -- please try again." });
    }
  });

  ws.on("close", () => {
    const player = players.get(ws);
    players.delete(ws);
    if (player) {
      broadcast({
        type: "leaderboard",
        leaderboard: leaderboard(),
        guildLeaderboard: guildLeaderboard(),
        playerCount: players.size,
      });
    }
  });
});
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
