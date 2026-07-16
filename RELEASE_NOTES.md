# Meridian: Race the Dawn — production release notes

This package is a browser multiplayer release for Meridian. It contains the
game server, player client, Cloudflare D1 schema/proxy, privacy policy, terms,
and account deletion instructions.

## Included in this release

- Real-time authoritative multiplayer game server with WebSocket message limits.
- Registered accounts, guests, optional Google and Apple sign-in.
- 30-day expiring signed account sessions.
- Minimum 10-character password requirement for new accounts.
- Private administrator statistics endpoint using an authorization header.
- Content Security Policy, HTTPS security headers, permissions limits, and
  optional exact-origin WebSocket protection.
- Player privacy policy and standalone data deletion instructions at
  `/delete-account.html`.
- TelemetryDeck privacy-friendly analytics already configured.

## Before going live

1. Create a fresh production `SESSION_SECRET` and `ADMIN_STATS_KEY`.
2. Set `PUBLIC_ORIGIN` to the exact HTTPS address where Meridian will run.
3. Confirm D1 persistence is working using a test account before inviting players.
4. Deploy the D1 proxy with its secret stored only in server-side settings.
5. Open `/health`, create a test account, reconnect, and verify saved progress.
6. Confirm the privacy, terms, and data-deletion links open from the game footer.

Detailed configuration is in `README.md` and `.env.example`.
