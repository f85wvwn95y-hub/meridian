(() => {
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const hoverEl = document.getElementById("hover");
  const toastEl = document.getElementById("toast");
  const clockEl = document.getElementById("clock");

  let W = 0, H = 0, DPR = window.devicePixelRatio || 1;
  let land = [];
  let cellSize = 5;
  let cols = 72, rows = 36;
  let cellState = new Map(); // id -> {ownerName, color, defense, illum}
  let subsolar = { lat: 0, lon: 0 };
  let me = null;
  let ws = null;
  let hoveredId = null;

  function resize() {
    const wrap = document.getElementById("mapWrap");
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    DPR = window.devicePixelRatio || 1;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }
  window.addEventListener("resize", resize);

  function project(lon, lat) {
    const x = ((lon + 180) / 360) * W;
    const y = ((90 - lat) / 180) * H;
    return [x, y];
  }
  function unproject(x, y) {
    const lon = (x / W) * 360 - 180;
    const lat = 90 - (y / H) * 180;
    return { lon, lat };
  }

  function cellIdFromLonLat(lon, lat) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((lon + 180) / cellSize)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / cellSize)));
    return row * cols + col;
  }
  function cellBounds(id) {
    const col = id % cols;
    const row = Math.floor(id / cols);
    return {
      lon0: -180 + col * cellSize,
      lat0: 90 - row * cellSize,
      lon1: -180 + (col + 1) * cellSize,
      lat1: 90 - (row + 1) * cellSize,
    };
  }

  function illumFill(illum, owned) {
    if (illum === "rush") return owned ? "rgba(255,211,92,0.55)" : "rgba(255,211,92,0.16)";
    if (illum === "day") return owned ? "rgba(92,201,255,0.4)" : "rgba(92,201,255,0.06)";
    return owned ? "rgba(42,51,72,0.85)" : "rgba(20,24,36,0.5)";
  }

  function draw() {
    ctx.fillStyle = "#060911";
    ctx.fillRect(0, 0, W, H);

    // land silhouette
    ctx.fillStyle = "#141b2b";
    ctx.strokeStyle = "#232e46";
    ctx.lineWidth = 1;
    for (const ring of land) {
      ctx.beginPath();
      ring.forEach(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // grid cells (illumination + ownership tint)
    for (const [id, c] of cellState.entries()) {
      const { lon0, lat0, lon1, lat1 } = cellBounds(id);
      const [x0, y0] = project(lon0, lat0);
      const [x1, y1] = project(lon1, lat1);
      ctx.fillStyle = illumFill(c.illum, !!c.color);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (c.color) {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      }
      if (c.guild) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x0 + 2, y0 + 2, 3, 3);
      }
      if (id === hoveredId) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
      }
    }

    // subsolar marker
    const [sx, sy] = project(subsolar.lon, subsolar.lat);
    ctx.fillStyle = "#ffe89a";
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff3c9";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toastEl.style.opacity = "0"), 2200);
  }

  function updateStats() {
    if (!me) return;
    document.getElementById("statName").textContent = me.name;
    document.getElementById("statGuild").textContent = me.guild || "none";
    document.getElementById("statLumen").textContent = Math.round(me.lumen);
    document.getElementById("statCells").textContent = me.cellCount;
  }

  function renderLeaderboard(lb) {
    const rows = lb
      .map((p) => {
        const tag = p.guild ? ` <span style="color:#8993ad">[${escapeHtml(p.guild)}]</span>` : "";
        return `<div class="lb-row"><span class="swatch" style="background:${p.color}"></span>
        <span class="lb-name">${escapeHtml(p.name)}${tag}</span><span>${Math.round(p.lumen)}</span></div>`;
      })
      .join("");
    document.getElementById("lbRows").innerHTML = rows;
  }

  function renderGuildLeaderboard(gl) {
    const rows = (gl || [])
      .map(
        (g) => `<div class="lb-row">
        <span class="lb-name">[${escapeHtml(g.guild)}]</span><span>${g.cellCount} cells</span></div>`
      )
      .join("");
    document.getElementById("guildRows").innerHTML = rows || `<div class="lb-row" style="color:#8993ad">No guilds yet</div>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function connect(name, guild) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", name, guild }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "welcome") {
        cellSize = msg.cellSize;
        cols = 360 / cellSize;
        rows = 180 / cellSize;
        cellState = new Map(msg.cells.map((c) => [c.id, c]));
        subsolar = msg.subsolar;
        me = msg.you;
        renderLeaderboard(msg.leaderboard);
        renderGuildLeaderboard(msg.guildLeaderboard);
        document.getElementById("statOnline").textContent = msg.playerCount;
        updateStats();
        draw();
      } else if (msg.type === "tick") {
        subsolar = msg.subsolar;
        for (const c of msg.changed) cellState.set(c.id, c);
        renderLeaderboard(msg.leaderboard);
        renderGuildLeaderboard(msg.guildLeaderboard);
        document.getElementById("statOnline").textContent = msg.playerCount;
        clockEl.textContent = "UTC " + msg.serverTimeUTC.slice(11, 19);
        draw();
      } else if (msg.type === "cellUpdate") {
        cellState.set(msg.cell.id, msg.cell);
        draw();
      } else if (msg.type === "you") {
        me = msg.you;
        updateStats();
      } else if (msg.type === "leaderboard") {
        renderLeaderboard(msg.leaderboard);
        renderGuildLeaderboard(msg.guildLeaderboard);
        document.getElementById("statOnline").textContent = msg.playerCount;
      } else if (msg.type === "error") {
        showToast(msg.message);
      }
    };
    ws.onclose = () => showToast("Disconnected from server.");
  }

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const { lon, lat } = unproject(e.clientX - rect.left, e.clientY - rect.top);
    hoveredId = cellIdFromLonLat(lon, lat);
    const c = cellState.get(hoveredId);
    if (c) {
      const owner = c.color ? c.ownerName + (c.guild ? ` [${c.guild}]` : "") : "unclaimed";
      hoverEl.textContent = `${lat.toFixed(1)}°, ${lon.toFixed(1)}° — ${owner} — ${c.illum} — defense ${c.defense}`;
    }
    draw();
  });

  canvas.addEventListener("click", (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const rect = canvas.getBoundingClientRect();
    const { lon, lat } = unproject(e.clientX - rect.left, e.clientY - rect.top);
    const id = cellIdFromLonLat(lon, lat);
    ws.send(JSON.stringify({ type: "claim", cellId: id }));
  });

  fetch("land.json")
    .then((r) => r.json())
    .then((rings) => {
      land = rings;
      resize();
    });

  document.getElementById("joinBtn").addEventListener("click", enter);
  document.getElementById("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") enter();
  });
  document.getElementById("guildInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") enter();
  });
  function enter() {
    const name = document.getElementById("nameInput").value.trim() || "Wanderer";
    const guild = document.getElementById("guildInput").value.trim();
    document.getElementById("joinModal").remove();
    connect(name, guild);
  }

  resize();
})();
