const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { subsolarPoint, solarElevation } = require("./solar");
const { CELL_SIZE, allCellIds, cellCenter } = require("./grid");
const persistence = require("./persistence");
const auth = require("./auth");
const security = require("./security");

const PORT = process.env.PORT || 8787;
const TICK_MS = 2000;
const FLUSH_MS = 20000; // how often owned territory / accounts get persisted to D1
const BASE_CLAIM_COST = 10;
const MAX_DEFENSE = 40; // passive growth ceiling -- untouched cells drift up to this on their own
const MAX_FORTIFIED_DEFENSE = 100; // active spending can push a cell's defense beyond MAX_DEFENSE, up to this
const DEFENSE_GROWTH_PER_SEC = 0.4;
const FORTIFY_INCREMENT = 5; // defense added per fortify action
const FORTIFY_BASE_COST = 8; // Lumen cost to fortify a cell currently at 0 defense
const RUSH_HALF_WIDTH_DEG = 6; // solar elevation within +/- this = "rush zone"
const MIN_CLAIM_INTERVAL_MS = 150; // basic anti-spam throttle on claims per connection

// ---- special abilities ----
const SHIELD_COST = 30;
const SHIELD_DURATION_MS = 60 * 1000;
const OVERCHARGE_COST = 25;
const OVERCHARGE_DURATION_MS = 30 * 1000;
const OVERCHARGE_MULTIPLIER = 2;
const SIEGE_COST = 20;
const SIEGE_DURATION_MS = 20 * 1000;
const SIEGE_DEFENSE_FACTOR = 0.5; // temporarily halves defense for claim-cost purposes
const ABILITY_COOLDOWN_MS = 45 * 1000; // per-ability-per-player

// ---- astronomy-tied events ----
const EQUINOX_LAT_THRESHOLD = 1; // |subsolar lat| <= this -> Equinox Convergence
const SOLSTICE_LAT_THRESHOLD = 23; // |subsolar lat| >= this -> Solstice Surge
const EQUINOX_INCOME_MULTIPLIER = 2;
const SOLSTICE_RUSH_WIDTH_MULTIPLIER = 2;

// ---- seasons ----
const SEASON_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 real days

// ---- guild wars ----
const WAR_DURATION_MS = 24 * 60 * 60 * 1000; // 24 real hours
const WAR_VICTORY_REWARD = 100; // Lumen bonus to each online winning-guild member

// Fortifying gets pricier the more defense a cell already has, so turtling
// an already-strong cell into a near-unbreakable one costs real investment.
function fortifyCost(defense) {
  return Math.round(FORTIFY_BASE_COST * (1 + defense / 20));
}

const PALETTE = [
  "#ff5c5c", "#5cc9ff", "#ffd35c", "#7dff5c", "#c65cff",
  "#ff8f5c", "#5cffd3", "#ff5ca8", "#a8ff5c", "#5c7dff",
];

// ---- world state ----
const cells = new Map(); // id -> { ownerId, ownerName, color, defense, guild, illum, shieldUntil, siegedUntil }
for (const id of allCellIds()) {
  cells.set(id, {
    ownerId: null, ownerName: null, color: null, defense: 0, guild: null, illum: "night",
    shieldUntil: 0, siegedUntil: 0,
  });
}

const players = new Map(); // ws -> player
let nextColor = 0;
let playerSeq = 1;

// Guild wars: key is "GUILDA|GUILDB" (alphabetically sorted) -> war record.
const wars = new Map();
let recentWarResults = []; // last few resolved wars, for display
const guildChatHistory = new Map(); // guild -> array of recent {from, text, at}
const GUILD_CHAT_HISTORY_LEN = 30;

// Season state -- loaded/persisted via game_meta; safe in-memory defaults for local dev.
let seasonNumber = 1;
let seasonStartedAt = Date.now();
let recentSeasons = []; // last few season summaries, for a Hall of Fame panel

function warKey(guildA, guildB) {
  return [guildA, guildB].sort().join("|");
}

function findActiveWar(guildA, guildB) {
  if (!guildA || !guildB || guildA === guildB) return null;
  const war = wars.get(warKey(guildA, guildB));
  if (!war) return null;
  return war.endsAt > Date.now() ? war : null;
}

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
    .map((p) => persistence.saveUserState(p.userId, { lumen: p.lumen, guild: p.guild, seasonLumen: p.seasonLumen }));
  await Promise.all(accountSaves);
}

function assignColor() {
  const c = PALETTE[nextColor % PALETTE.length];
  nextColor++;
  return c;
}

function illumCategory(elevDeg, rushWidth) {
  if (Math.abs(elevDeg) <= rushWidth) return "rush";
  return elevDeg > 0 ? "day" : "night";
}

function incomeFor(illum) {
  if (illum === "rush") return 3;
  if (illum === "day") return 1;
  return 0.3;
}

/** Derives the current live astronomy event from the subsolar latitude, if any. */
function currentEvent(subsolarLat) {
  const absLat = Math.abs(subsolarLat);
  if (absLat <= EQUINOX_LAT_THRESHOLD) {
    return { id: "equinox", name: "Equinox Convergence", desc: "The sun balances over the equator -- global income is doubled." };
  }
  if (absLat >= SOLSTICE_LAT_THRESHOLD) {
    return { id: "solstice", name: "Solstice Surge", desc: "Peak axial tilt -- rush zones are twice as wide." };
  }
  return null;
}

// Returns Infinity to signal "can't be claimed" (e.g. attacking a guildmate, or a shielded cell).
function claimCost(cell, illum, attackerGuild) {
  // Ownership survives restarts via ownerName even when no live player (ownerId)
  // is currently connected to that identity, so cost is based on ownerName.
  if (!cell.ownerName) return BASE_CLAIM_COST;
  if (cell.shieldUntil > Date.now()) return Infinity;
  if (cell.guild && attackerGuild && cell.guild === attackerGuild) return Infinity;
  const effectiveDefense = cell.siegedUntil > Date.now() ? cell.defense * SIEGE_DEFENSE_FACTOR : cell.defense;
  const attackCost = BASE_CLAIM_COST + effectiveDefense;
  return illum === "rush" ? attackCost * 0.5 : attackCost;
}

function leaderboard() {
  return [...players.values()]
    .map((p) => ({
      name: p.name, color: p.color, guild: p.guild,
      lumen: Math.round(p.lumen), seasonLumen: Math.round(p.seasonLumen || 0), cellCount: p.cellCount,
    }))
    .sort((a, b) => b.seasonLumen - a.seasonLumen)
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
  const now = Date.now();
  return {
    id,
    ownerName: c.ownerName,
    color: c.color,
    defense: Math.round(c.defense),
    guild: c.guild,
    illum: c.illum,
    shieldMsLeft: Math.max(0, c.shieldUntil - now),
    siegeMsLeft: Math.max(0, c.siegedUntil - now),
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

/** Snapshots the top performers for a season-end (or Hall of Fame) record. */
function seasonSnapshot() {
  return {
    topPlayers: leaderboard().slice(0, 3).map((p) => ({ name: p.name, guild: p.guild, seasonLumen: p.seasonLumen })),
    topGuilds: guildLeaderboard().slice(0, 3).map((g) => ({ guild: g.guild, cellCount: g.cellCount })),
  };
}

async function rolloverSeason(now) {
  const snapshot = seasonSnapshot();
  const summary = { seasonNumber, endedAt: now, ...snapshot };
  recentSeasons.unshift(summary);
  recentSeasons = recentSeasons.slice(0, 5);

  for (const player of players.values()) player.seasonLumen = 0;
  seasonNumber += 1;
  seasonStartedAt = now;

  broadcast({ type: "seasonEnd", summary, seasonNumber, seasonStartedAt });

  try {
    await persistence.archiveSeason(summary);
    await persistence.resetAllSeasonLumen();
    await persistence.setGameMeta("season_number", String(seasonNumber));
    await persistence.setGameMeta("season_started_at", String(seasonStartedAt));
  } catch (err) {
    console.error("Season rollover persistence failed:", err.message);
  }
}

/** Resolves any guild wars whose time window has ended: tallies the winner
 * and pays out a Lumen bonus to that guild's currently-online members. */
function resolveExpiredWars(now) {
  for (const [key, war] of wars.entries()) {
    if (war.endsAt > now || war.resolved) continue;
    war.resolved = true;
    const winner = war.scoreA === war.scoreB ? null : war.scoreA > war.scoreB ? war.guildA : war.guildB;
    const result = { guildA: war.guildA, guildB: war.guildB, scoreA: war.scoreA, scoreB: war.scoreB, winner, endedAt: now };
    recentWarResults.unshift(result);
    recentWarResults = recentWarResults.slice(0, 5);

    if (winner) {
      for (const p of players.values()) {
        if (p.guild === winner) p.lumen += WAR_VICTORY_REWARD;
      }
    }
    broadcast({ type: "warEnded", result });
    wars.delete(key);
  }
}

// ---- game tick: recompute illumination, accrue income/defense, broadcast ----
function startTicking() {
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    const subsolar = subsolarPoint(new Date(now));
    const event = currentEvent(subsolar.lat);
    const rushWidth = event && event.id === "solstice" ? RUSH_HALF_WIDTH_DEG * SOLSTICE_RUSH_WIDTH_MULTIPLIER : RUSH_HALF_WIDTH_DEG;
    const incomeMultiplier = event && event.id === "equinox" ? EQUINOX_INCOME_MULTIPLIER : 1;
    const changedIds = [];

    for (const id of allCellIds()) {
      const cell = cells.get(id);
      const { lon, lat } = cellCenter(id);
      const elev = solarElevation(lat, lon, subsolar);
      const illum = illumCategory(elev, rushWidth);
      if (illum !== cell.illum) changedIds.push(id);
      cell.illum = illum;

      if (cell.ownerId) {
        const owner = [...players.values()].find((p) => p.id === cell.ownerId);
        if (owner) {
          const overchargeActive = owner.overchargeUntil > now;
          const gained = incomeFor(illum) * dt * incomeMultiplier * (overchargeActive ? OVERCHARGE_MULTIPLIER : 1);
          owner.lumen += gained;
          owner.seasonLumen = (owner.seasonLumen || 0) + gained;
          // Passive drift only climbs to MAX_DEFENSE -- it never pulls a
          // fortified cell's defense back down below where a player paid it up to.
          if (cell.defense < MAX_DEFENSE) {
            cell.defense = Math.min(MAX_DEFENSE, cell.defense + DEFENSE_GROWTH_PER_SEC * dt);
          }
        }
      }
    }

    resolveExpiredWars(now);

    broadcast({
      type: "tick",
      subsolar,
      event,
      changed: changedIds.map(publicCell),
      leaderboard: leaderboard(),
      guildLeaderboard: guildLeaderboard(),
      playerCount: players.size,
      serverTimeUTC: new Date(now).toISOString(),
    });

    for (const [ws, player] of players.entries()) {
      send(ws, { type: "you", you: player });
    }

    if (now - seasonStartedAt >= SEASON_DURATION_MS) {
      rolloverSeason(now).catch((err) => console.error("Season rollover failed:", err.message));
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

  try {
    const meta = await persistence.getGameMeta(["season_number", "season_started_at"]);
    if (meta.season_number) seasonNumber = Number(meta.season_number);
    if (meta.season_started_at) seasonStartedAt = Number(meta.season_started_at);
    recentSeasons = await persistence.getRecentSeasons(5);
  } catch (err) {
    console.error("Season state load failed, starting fresh:", err.message);
  }

  server = app.listen(PORT, () => {
    console.log(`Meridian running: http://localhost:${PORT}`);
    console.log(`Persistence: ${persistence.enabled ? "ON (Cloudflare D1)" : "OFF (in-memory only)"}`);
  });
  wss = new WebSocketServer({ server, maxPayload: 4096 }); // 4KB is plenty for our small JSON messages
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
    fortify: {
      baseCost: FORTIFY_BASE_COST,
      increment: FORTIFY_INCREMENT,
      maxDefense: MAX_FORTIFIED_DEFENSE,
    },
    abilities: {
      shield: { cost: SHIELD_COST, durationMs: SHIELD_DURATION_MS },
      overcharge: { cost: OVERCHARGE_COST, durationMs: OVERCHARGE_DURATION_MS, multiplier: OVERCHARGE_MULTIPLIER },
      siege: { cost: SIEGE_COST, durationMs: SIEGE_DURATION_MS },
      cooldownMs: ABILITY_COOLDOWN_MS,
    },
    event: currentEvent(subsolarPoint(new Date()).lat),
    season: { number: seasonNumber, startedAt: seasonStartedAt, durationMs: SEASON_DURATION_MS },
    recentSeasons,
    guildChat: player.guild ? guildChatHistory.get(player.guild) || [] : [],
    wars: [...wars.values()].filter((w) => w.guildA === player.guild || w.guildB === player.guild),
    recentWarResults,
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
wss.on("connection", (ws, req) => {
  const ip = security.getClientIp(req);
  if (!security.tryAddConnection(ip)) {
    ws.close(1008, "Too many connections from your network -- please try again shortly.");
    return;
  }
  let ipReleased = false;
  const releaseIp = () => {
    if (ipReleased) return;
    ipReleased = true;
    security.removeConnection(ip);
  };

  ws.on("message", async (raw) => {
    if (!security.messageLimiter(ws)) return; // silently drop -- a flooding client just gets ignored

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
          seasonLumen: 0,
          cellCount: cellCountFor(name),
          lastClaimAt: 0,
          overchargeUntil: 0,
          cooldowns: {},
        };
        registerPlayer(ws, player);
        return;
      }

      if (msg.type === "signup") {
        if (!security.signupLimiter(ip)) {
          send(ws, { type: "error", message: "Too many accounts created from your network -- please try again later." });
          return;
        }
        const username = sanitizeUsername(msg.username);
        const password = String(msg.password || "");
        if (!username) {
          send(ws, { type: "error", message: "Username must be 3-20 letters, numbers, or underscores." });
          return;
        }
        if (password.length < 6 || password.length > 100) {
          send(ws, { type: "error", message: "Password must be 6-100 characters." });
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
          seasonLumen: 0,
          cellCount: cellCountFor(username),
          lastClaimAt: 0,
          overchargeUntil: 0,
          cooldowns: {},
          token,
        };
        registerPlayer(ws, player);
        return;
      }

      if (msg.type === "login") {
        if (!security.loginLimiter(ip)) {
          send(ws, { type: "error", message: "Too many login attempts from your network -- please wait a few minutes." });
          return;
        }
        const username = sanitizeUsername(msg.username);
        const password = String(msg.password || "").slice(0, 100);
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
          seasonLumen: user.seasonLumen || 0,
          cellCount: cellCountFor(user.username),
          lastClaimAt: 0,
          overchargeUntil: 0,
          cooldowns: {},
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
          seasonLumen: user.seasonLumen || 0,
          cellCount: cellCountFor(user.username),
          lastClaimAt: 0,
          overchargeUntil: 0,
          cooldowns: {},
          token: msg.token,
        };
        registerPlayer(ws, player);
        return;
      }

      const player = players.get(ws);
      if (!player) return;

      if (msg.type === "guildChat") {
        if (!security.chatLimiter(ws)) return;
        if (!player.guild) {
          send(ws, { type: "error", message: "Join a guild to use guild chat." });
          return;
        }
        const text = String(msg.text || "").trim().slice(0, 200);
        if (!text) return;
        const entry = { from: player.name, text, at: Date.now() };
        const history = guildChatHistory.get(player.guild) || [];
        history.push(entry);
        guildChatHistory.set(player.guild, history.slice(-GUILD_CHAT_HISTORY_LEN));
        for (const [pws, p] of players.entries()) {
          if (p.guild === player.guild) send(pws, { type: "guildChat", entry });
        }
        return;
      }

      if (msg.type === "declareWar") {
        if (!security.declareWarLimiter(ip)) {
          send(ws, { type: "error", message: "Too many war declarations from your network -- please wait a while." });
          return;
        }
        if (!player.guild) {
          send(ws, { type: "error", message: "Join a guild before declaring war." });
          return;
        }
        const target = sanitizeGuild(msg.targetGuild);
        if (!target || target === player.guild) {
          send(ws, { type: "error", message: "Pick a valid rival guild tag." });
          return;
        }
        if (findActiveWar(player.guild, target)) {
          send(ws, { type: "error", message: `Already at war with ${target}.` });
          return;
        }
        const now = Date.now();
        const war = {
          guildA: player.guild, guildB: target, scoreA: 0, scoreB: 0,
          declaredBy: player.name, startedAt: now, endsAt: now + WAR_DURATION_MS, resolved: false,
        };
        wars.set(warKey(player.guild, target), war);
        broadcast({ type: "warDeclared", war });
        return;
      }

      if (msg.type === "ability") {
        const kind = msg.ability;
        if (kind !== "shield" && kind !== "overcharge" && kind !== "siege") return;
        const now = Date.now();
        const lastUsed = (player.cooldowns && player.cooldowns[kind]) || 0;
        if (now - lastUsed < ABILITY_COOLDOWN_MS) {
          send(ws, { type: "error", message: `${kind[0].toUpperCase()}${kind.slice(1)} is on cooldown.` });
          return;
        }

        if (kind === "overcharge") {
          if (player.lumen < OVERCHARGE_COST) {
            send(ws, { type: "error", message: `Not enough Lumen for Overcharge (needs ${OVERCHARGE_COST}).` });
            return;
          }
          player.lumen -= OVERCHARGE_COST;
          player.overchargeUntil = now + OVERCHARGE_DURATION_MS;
          player.cooldowns.overcharge = now;
          send(ws, { type: "you", you: { ...player } });
          send(ws, { type: "toast", message: `Overcharge active for ${OVERCHARGE_DURATION_MS / 1000}s -- ${OVERCHARGE_MULTIPLIER}x income!` });
          return;
        }

        const id = Number(msg.cellId);
        const cell = cells.get(id);
        if (!cell) return;

        if (kind === "shield") {
          if (cell.ownerId !== player.id) {
            send(ws, { type: "error", message: "You can only shield your own territory." });
            return;
          }
          if (player.lumen < SHIELD_COST) {
            send(ws, { type: "error", message: `Not enough Lumen for Shield (needs ${SHIELD_COST}).` });
            return;
          }
          player.lumen -= SHIELD_COST;
          cell.shieldUntil = now + SHIELD_DURATION_MS;
          player.cooldowns.shield = now;
          broadcast({ type: "cellUpdate", cell: publicCell(id) });
          send(ws, { type: "you", you: { ...player } });
          send(ws, { type: "toast", message: `Shield raised for ${SHIELD_DURATION_MS / 1000}s.` });
          return;
        }

        if (kind === "siege") {
          if (!cell.ownerName) {
            send(ws, { type: "error", message: "Nothing to siege -- that cell is unclaimed." });
            return;
          }
          if (cell.ownerId === player.id) {
            send(ws, { type: "error", message: "You can't siege your own territory." });
            return;
          }
          if (cell.guild && cell.guild === player.guild) {
            send(ws, { type: "error", message: "Can't siege a guildmate's territory." });
            return;
          }
          if (player.lumen < SIEGE_COST) {
            send(ws, { type: "error", message: `Not enough Lumen for Siege (needs ${SIEGE_COST}).` });
            return;
          }
          player.lumen -= SIEGE_COST;
          cell.siegedUntil = now + SIEGE_DURATION_MS;
          player.cooldowns.siege = now;
          broadcast({ type: "cellUpdate", cell: publicCell(id) });
          send(ws, { type: "you", you: { ...player } });
          send(ws, { type: "toast", message: `Siege launched -- target's defense halved for ${SIEGE_DURATION_MS / 1000}s.` });
          return;
        }
        return;
      }

      if (msg.type === "claim") {
        const now = Date.now();
        if (now - player.lastClaimAt < MIN_CLAIM_INTERVAL_MS) return;
        player.lastClaimAt = now;

        const id = Number(msg.cellId);
        const cell = cells.get(id);
        if (!cell) return;

        if (cell.ownerId === player.id) {
          // Clicking territory you already hold fortifies it instead of a no-op re-claim.
          if (cell.defense >= MAX_FORTIFIED_DEFENSE) {
            send(ws, { type: "error", message: "This cell is already at maximum defense." });
            return;
          }
          const fCost = fortifyCost(cell.defense);
          if (player.lumen < fCost) {
            send(ws, { type: "error", message: `Not enough Lumen to fortify (needs ${fCost}).` });
            return;
          }
          player.lumen -= fCost;
          cell.defense = Math.min(MAX_FORTIFIED_DEFENSE, cell.defense + FORTIFY_INCREMENT);

          broadcast({ type: "cellUpdate", cell: publicCell(id) });
          send(ws, { type: "you", you: { ...player } });
          send(ws, {
            type: "toast",
            message: `Fortified -- defense now ${Math.round(cell.defense)} (-${fCost} Lumen)`,
          });

          persistence
            .saveCells([{ id, ownerName: cell.ownerName, color: cell.color, defense: cell.defense, guild: cell.guild }])
            .catch((err) => console.error("Fortify save failed:", err.message));
          return;
        }

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
        const prevGuild = cell.guild;
        player.lumen -= cost;
        if (prevOwner) prevOwner.cellCount = Math.max(0, prevOwner.cellCount - 1);
        cell.ownerId = player.id;
        cell.ownerName = player.name;
        cell.color = player.color;
        cell.defense = 0;
        cell.guild = player.guild;
        cell.siegedUntil = 0; // a fresh capture clears any lingering siege debuff
        cell.shieldUntil = 0;
        player.cellCount += 1;

        // A capture that flips territory between two warring guilds counts toward that war's score.
        if (prevGuild && player.guild && prevGuild !== player.guild) {
          const war = findActiveWar(player.guild, prevGuild);
          if (war) {
            if (war.guildA === player.guild) war.scoreA += 1;
            else war.scoreB += 1;
            broadcast({ type: "warUpdate", war });
          }
        }

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
    releaseIp();
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
