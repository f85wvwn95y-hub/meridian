# Meridian: Race the Dawn

A real-time multiplayer territory game where the map is Earth and the clock is
real UTC time. A live day/night terminator, computed from actual solar
position math, sweeps across the map exactly as it does on the real planet.
Cells near that line are a "rush zone" — 3x income, half-price to conquer —
so there's always a hot zone live somewhere in the world, no matter what time
zone you're in. See `DESIGN.md` for the full concept and reasoning.

## Run it locally

```
npm install
npm start
```

Then open `http://localhost:8787` in a few different browser tabs (each tab
= one player) to see multiplayer claiming and the terminator moving live.

The land data (`public/land.json`) is already generated from real coastline
data, so you don't need to regenerate it. If you ever want to (e.g. after
tuning simplification), run:

```
node scripts/build-land.js
```

## How it works

- `solar.js` — computes the sun's subsolar point and per-location solar
  elevation from real UTC time (declination + hour angle approximation,
  accurate to ~1°).
- `grid.js` — divides the globe into 5°x5° cells.
- `server.js` — authoritative game state: ownership, defense, Lumen economy,
  a 2-second tick that recomputes illumination and broadcasts changes over
  WebSocket.
- `public/client.js` — canvas rendering of real coastlines + the grid +
  live terminator marker, click-to-claim, leaderboard.

No accounts, no database yet — state lives in memory and resets when the
server restarts. That's the right amount of scope for a prototype; see
"Taking this further" below for what a real launch needs.

## Deploying so people around the world can actually join

Any host that supports long-lived WebSocket connections works. Easiest options:

1. **Render / Railway / Fly.io** — connect this folder as a repo, they auto-detect
   `npm start`, done. All three have free/cheap tiers and give you a public URL.
2. **A small VPS** (DigitalOcean, Hetzner, etc.) — `npm install --production`,
   run with `pm2 start server.js`, put Caddy or nginx in front for HTTPS/WSS.
3. **Glitch** — good for a quick public demo link, less good for sustained load.

Set the `PORT` environment variable if your host requires a specific port
(most inject it automatically; `server.js` already reads `process.env.PORT`).

## Taking this further

- **Persistence**: swap the in-memory `Map`s in `server.js` for Postgres or
  Redis so empires survive restarts and the world can scale past one process.
- **Accounts**: add email/OAuth login so a player's empire is tied to them,
  not a browser tab.
- **Scaling past one process**: once concurrent players exceed what a single
  Node process can broadcast to, shard the world by region and connect
  shards with Redis pub/sub or NATS.
- **Mobile**: the client is plain HTML/canvas/JS, so a touch-friendly layout
  and PWA wrapper get you a mobile experience without a rewrite.
- **Notifications**: "the dawn line is entering your territory in 10 minutes"
  push notifications would make the core hook even stickier.
