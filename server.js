const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { subsolarPoint, solarElevation } = require("./solar");
const { CELL_SIZE, allCellIds, cellCenter } = require("./grid");
const persistence = require("./persistence");

const PORT = process.env.PORT || 8787;
const TICK_MS = 2000;
const FLUSH_MS = 20000; // how often owned territory gets persisted to D1
const BASE_CLAIM_COST = 10;
const MAX_DEFENSE = 40;
const DEFENSE_GROWTH_PER_SEC = 0.4;
const RUSH_HALF_WIDTH_DEG = 6; // solar elevation within +/- this = "rush zone"

const PALETTE = [
  "#ff5c5c", "#5cc9ff", "#ffd35c", "#7dff5c", "#c65cff",
  "#ff8f5c", "#5cffd3", "#ff5ca8", "#a8ff5c", "#5c7dff",
];

// ---- world state ----
const cells = new Map(); // id -> { ownerId, ownerName, color, defense, illum }
for (const id of allCellIds()) {
  cells.set(id, { ownerId: null, ownerName: null, color: null, defense: 0, illum: "night" });
}

const players = new Map(); // ws -> player
let nextColor = 0;
let playerSeq = 1;

/** Gathers every currently-owned cell in the shape persistence.saveCells expects. */
function ownedCellsSnapshot() {
  const out = [];
  for (const [id, c] of cells.entries()) {
    if (c.ownerName) out.push({ id, ownerName: c.ownerName, color: c.color, defense: c.defense });
  }
  return out;
}

async function flushToDisk() {
  const snapshot = ownedCellsSnapshot();
  if (snapshot.length > 0) await persistence.saveCells(snapshot);
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

function claimCost(cell, illum) {
  // Ownership survives restarts via ownerName even when no live player (ownerId)
  // is currently connected to that identity, so cost is based on ownerName.
  if (!cell.ownerName) return BASE_CLAIM_COST;
  const attackCost = BASE_CLAIM_COST + cell.defense;
  return illum === "rush" ? attackCost * 0.5 : attackCost;
}

function leaderboard() {
  return [...players.values()]
    .map((p) => ({ name: p.name, color: p.color, lumen: Math.round(p.lumen), cellCount: p.cellCount }))
    .sort((a, b) => b.lumen - a.lumen)
    .slice(0, 10);
}

function publicCell(id) {
  const c = cells.get(id);
  return { id, ownerName: c.ownerName, color: c.color, defense: Math.round(c.defense), illum: c.illum };
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

function attachWebSocketHandlers() {
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      const name = String(msg.name || "Wanderer").slice(0, 20);
      const player = {
        id: playerSeq++,
        name,
        color: assignColor(),
        lumen: 20,
        cellCount: 0,
      };
      players.set(ws, player);
      send(ws, {
        type: "welcome",
        you: player,
        cellSize: CELL_SIZE,
        cells: allCellIds().map(publicCell),
        subsolar: subsolarPoint(new Date()),
        leaderboard: leaderboard(),
        playerCount: players.size,
      });
      broadcast({ type: "leaderboard", leaderboard: leaderboard(), playerCount: players.size });
      return;
    }

    const player = players.get(ws);
    if (!player) return;

    if (msg.type === "claim") {
      const id = Number(msg.cellId);
      const cell = cells.get(id);
      if (!cell || cell.ownerId === player.id) return;
      const cost = claimCost(cell, cell.illum);
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
      player.cellCount += 1;

      broadcast({ type: "cellUpdate", cell: publicCell(id) });
      broadcast({ type: "leaderboard", leaderboard: leaderboard(), playerCount: players.size });
      send(ws, { type: "you", you: { ...player } });

      // Best-effort immediate save so a claim survives even a restart moments later.
      persistence
        .saveCells([{ id, ownerName: cell.ownerName, color: cell.color, defense: cell.defense }])
        .catch((err) => console.error("Claim save failed:", err.message));
    }
  });

  ws.on("close", () => {
    const player = players.get(ws);
    players.delete(ws);
    if (player) {
      broadcast({ type: "leaderboard", leaderboard: leaderboard(), playerCount: players.size });
    }
  });
});
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
