// Lightweight in-memory abuse-prevention helpers. All state is per-process
// and resets on restart -- that's fine, these are throttles against
// scripted abuse, not permanent bans that need to survive redeploys.

const MAX_CONNECTIONS_PER_IP = 8;
const connectionsByIp = new Map(); // ip -> open connection count

function getClientIp(req) {
  // Render (and most hosts) sit behind a proxy, so the real client IP shows
  // up in X-Forwarded-For rather than the raw socket address.
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/** Returns false if this IP is already at the concurrent-connection cap. */
function tryAddConnection(ip) {
  const count = connectionsByIp.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return false;
  connectionsByIp.set(ip, count + 1);
  return true;
}

function removeConnection(ip) {
  const count = connectionsByIp.get(ip) || 0;
  if (count <= 1) connectionsByIp.delete(ip);
  else connectionsByIp.set(ip, count - 1);
}

/** A simple sliding-window rate limiter: at most `max` calls per `windowMs`, keyed by whatever you pass in (an IP, a ws instance, etc). */
function makeLimiter(max, windowMs) {
  const hits = new Map(); // key -> array of recent timestamps
  return function allow(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

const signupLimiter = makeLimiter(5, 60 * 60 * 1000); // 5 signups / hour / IP
const loginLimiter = makeLimiter(10, 5 * 60 * 1000); // 10 login attempts / 5 min / IP
const oauthLimiter = makeLimiter(15, 5 * 60 * 1000); // 15 Google/Apple sign-in attempts / 5 min / IP
const messageLimiter = makeLimiter(20, 1000); // 20 messages / second / connection
const chatLimiter = makeLimiter(1, 2000); // 1 guild chat message / 2 sec / connection
const declareWarLimiter = makeLimiter(3, 10 * 60 * 1000); // 3 war declarations / 10 min / IP -- it's free, so it needs its own cap to prevent toast-spam abuse

module.exports = {
  MAX_CONNECTIONS_PER_IP,
  getClientIp,
  tryAddConnection,
  removeConnection,
  signupLimiter,
  loginLimiter,
  oauthLimiter,
  messageLimiter,
  chatLimiter,
  declareWarLimiter,
};
