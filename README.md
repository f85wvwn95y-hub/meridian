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

- `persistence.js` — optional layer that saves owned territory to a
  Cloudflare D1 database over its HTTP API, so claims survive restarts and
  redeploys. If the required env vars aren't set, this is a no-op and the
  game behaves exactly like the original in-memory-only prototype.

Still no player accounts — territory persists by name/color, but a
reconnecting player gets a new session identity, so they can't yet resume
crediting income to an old empire. That's the next logical step (see
"Taking this further").

## Persistence (optional, recommended for a real deploy)

By default state lives in memory and resets on every restart. To make
claimed territory survive restarts/redeploys, set three environment
variables and Meridian will automatically start persisting to Cloudflare D1:

- `CF_ACCOUNT_ID` — your Cloudflare account ID (visible on the right side of
  any page in the Cloudflare dashboard, or on the Workers & Pages overview).
- `CF_API_TOKEN` — a Cloudflare API token with D1 edit permissions. Create
  one at My Profile → API Tokens → Create Token, using the "Edit Cloudflare
  Workers" template (it includes D1) or a custom token scoped to D1 Edit.
- `CF_D1_DATABASE_ID` — the UUID of the D1 database to use (a database named
  `meridian` with the right `cells` table already exists if you set this up
  with Claude's help; otherwise create one and run the schema in
  `scripts/d1-schema.sql`).

On Render: Dashboard → your service → **Environment** → add the three
variables → save (triggers an automatic redeploy). Without them, Meridian
just logs "Persistence: OFF (in-memory only)" and runs as before.

## Google / Apple sign-in (optional)

Alongside username/password and guest play, Meridian supports "Continue with
Google" and "Continue with Apple" -- both optional, controlled by env vars:

- `GOOGLE_CLIENT_ID` -- an OAuth 2.0 Client ID from
  [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  (Create Credentials → OAuth client ID → Web application). Add your live
  domain (e.g. `https://meridian-ruff.onrender.com`) under "Authorized
  JavaScript origins" -- no client secret needed, this flow only uses the
  public client ID.
- `APPLE_CLIENT_ID` -- a Services ID from your
  [Apple Developer account](https://developer.apple.com/account/resources/identifiers/list/serviceId)
  with "Sign in with Apple" enabled. Under that Services ID's configuration,
  add your live domain to "Domains and Subdomains" and add your exact page
  URL (e.g. `https://meridian-ruff.onrender.com/`) as a "Return URL".

Both buttons only appear once the server confirms the corresponding env var
is set (`GET /config`) -- unset either one and that button just doesn't show,
no broken UI. No client secret or private key is required for either
provider: the client-side SDKs hand back a signed ID token, and the server
verifies it directly against Google's/Apple's public keys.

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
- **Scaling past one process**: once concurrent players exceed what a single
  Node process can broadcast to, shard the world by region and connect
  shards with Redis pub/sub or NATS.
- **Mobile**: the client is plain HTML/canvas/JS, so a touch-friendly layout
  and PWA wrapper get you a mobile experience without a rewrite.
- **Notifications**: "the dawn line is entering your territory in 10 minutes"
  push notifications would make the core hook even stickier.
