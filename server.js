const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { subsolarPoint, solarElevation } = require("./solar");
const { CELL_SIZE, allCellIds, cellCenter } = require("./grid");

const PORT = process.env.PORT || 8787;
const TICK_MS = 2000;
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
  if (!cell.ownerId) return BASE_CLAIM_COST;
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

// ---- websocket handling ----
const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = app.listen(PORT, () => {
  console.log(`Meridian running: http://localhost:${PORT}`);
});
const wss = new WebSocketServer({ server });

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
