// Deploy this as its own Cloudflare Worker (separate from your website Worker).
// It exposes a tiny authenticated HTTP endpoint that Meridian's Node server
// calls to read/write the D1 database, using D1's native binding instead of
// Cloudflare's control-plane REST API (which some hosts' outbound IPs get
// blocked from reaching directly).
//
// Setup:
// 1. Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker.
// 2. Name it (e.g. "meridian-d1-proxy"), deploy the default hello-world code.
// 3. Click "Edit code", replace everything with this file's contents, Deploy.
// 4. Worker -> Settings -> Bindings -> Add -> D1 database.
//    Variable name: DB. Database: meridian.
// 5. Worker -> Settings -> Variables -> Add variable -> name it PROXY_SECRET,
//    give it a long random value, and toggle "Encrypt" so it's a secret.
// 6. Copy this Worker's URL (shown on its Overview page, ends in workers.dev).

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    const secret = request.headers.get("X-Proxy-Secret");
    if (!secret || secret !== env.PROXY_SECRET) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const { sql, params } = body || {};
    if (!sql || typeof sql !== "string") {
      return json({ success: false, error: "Missing sql" }, 400);
    }

    try {
      const stmt = env.DB.prepare(sql);
      const bound = Array.isArray(params) && params.length > 0 ? stmt.bind(...params) : stmt;
      const result = await bound.all();
      return json({ success: true, results: result.results });
    } catch (err) {
      return json({ success: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
