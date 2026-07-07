# Meridian: Race the Dawn

## The hook

Every other multiplayer world game has the same problem: half the planet is asleep while the other half plays, so "global" really means "whoever's timezone the servers favor." Meridian turns that into the entire game.

The map is Earth. The clock is real UTC time. A live day/night terminator — calculated from the actual position of the sun — sweeps across the map exactly as it does on the real planet. Resources ("Lumen shards") spawn along that moving dawn/dusk line, and cells near it generate bonus income. Because the line is always crossing *someone's* territory, there is no dead time zone and no "off-peak" server. Sydney's morning rush is Lisbon's evening lull is Rio's midnight calm — all at once, all live, all mattering.

Slogan: **the sun never sets on the game.**

## Core loop

1. The world is divided into a grid of cells (5° longitude × 5° latitude).
2. Every tick, the server computes the sun's subsolar point from real UTC time and rates each cell's illumination (day / night / twilight).
3. Cells in twilight (within a few degrees of the terminator) spawn Lumen shards and pay out a claiming bonus — this is the "rush zone," and it visibly crawls around the globe in real time.
4. Players claim unclaimed or weaker cells by spending accumulated Lumen. Owned cells passively generate Lumen for their owner, faster in daylight, slower at night, best at dawn.
5. Empires persist between sessions. Because income keeps accruing while you're offline (slowly) and spikes when the dawn line reaches your territory, there's a natural reason to log in when it's *your* morning — and a natural reason for globally distributed guilds to hand off active defense as the line moves, like passing a baton around the planet.

## Why it's unique

- The central mechanic *is* the theme: "players around the world" isn't marketing, it's the literal game clock.
- No twitch reflexes required to compete globally — the game rewards showing up at your local dawn, which levels the playing field between time zones instead of favoring one region's prime time.
- Guilds spanning multiple continents have a real strategic reason to coordinate handoffs, creating natural cross-cultural cooperation.

## Prototype scope (this build)

- Node.js + WebSocket real-time server, in-memory state.
- Real coastline data (Natural Earth 110m, via `world-atlas`) rendered on canvas — an actual world map, not an abstraction.
- Real solar-position math for the terminator (subsolar point from declination + hour angle), not a cosmetic animation.
- Click-to-claim territory, live leaderboard, live UTC clock, dawn/dusk rush-zone highlighting.
- No accounts yet — anonymous nickname per session, single server / single world instance.

## Path to a real global launch

- Swap in-memory state for Postgres/Redis so state survives restarts and scales past one process.
- Add accounts (email/OAuth) so empires persist across devices.
- Shard the world across regions with a message bus (e.g. Redis pub/sub or NATS) once concurrent players exceed what one Node process handles.
- Add mobile-friendly touch controls and push notifications for "the dawn line is entering your territory."
