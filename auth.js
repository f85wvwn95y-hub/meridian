// Password hashing + session tokens for registered accounts. No external
// auth service needed -- just Node's built-in crypto.
//
// Sessions are stateless signed tokens (HMAC-SHA256 over a JSON payload),
// not database-backed sessions. Tokens expire after 30 days, so a copied
// browser token is not a permanent credential. If SESSION_SECRET isn't set (e.g. local dev), we fall
// back to a random secret generated at startup -- that just means existing
// tokens stop working after a restart, which only forces a re-login, not a
// data loss. Set SESSION_SECRET in production so logins survive restarts.
const crypto = require("crypto");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.log("SESSION_SECRET not set -- using a random secret for this run (sessions won't survive a restart).");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(payload) {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + SESSION_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!Number.isSafeInteger(payload.uid) || typeof payload.username !== "string" || payload.username.length > 20) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= Date.now() || payload.exp <= payload.iat || payload.exp - payload.iat > SESSION_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
