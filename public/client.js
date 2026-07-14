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
  let fortifyCfg = { baseCost: 8, increment: 5, maxDefense: 100 }; // defaults, overwritten by server on welcome

  let abilityCfg = {
    shield: { cost: 30, durationMs: 60000 },
    overcharge: { cost: 25, durationMs: 30000, multiplier: 2 },
    siege: { cost: 20, durationMs: 20000 },
    cooldownMs: 45000,
  };
  let activeAbility = null; // "shield" | "overcharge" | "siege" | null -- awaiting a target click
  const abilityCooldownUntil = { shield: 0, overcharge: 0, siege: 0 };
  let currentEventState = null;
  let seasonInfo = { number: 1, startedAt: Date.now(), durationMs: 30 * 24 * 60 * 60 * 1000 };
  let recentSeasons = [];
  let myGuildChat = [];
  let myWars = [];
  let recentWarResults = [];
  let cosmeticsCfg = { baseColors: [], milestoneColors: [], supporterColors: [], founderColor: "#ffe066" };

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
      if (c.shieldMsLeft > 0) {
        ctx.strokeStyle = "#5cffea";
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1.5, y0 + 1.5, x1 - x0 - 3, y1 - y0 - 3);
      }
      if (c.siegeMsLeft > 0) {
        ctx.strokeStyle = "#ff5c5c";
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
        ctx.setLineDash([]);
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
    const toggleLumen = document.getElementById("toggleLumen");
    if (toggleLumen) toggleLumen.textContent = Math.round(me.lumen);
    updateGuildSectionsVisibility();
    updateAbilityButtons();
    renderCosmetics();
  }

  function renderLeaderboard(lb) {
    const rows = lb
      .map((p) => {
        const tag = p.guild ? ` <span style="color:#8993ad">[${escapeHtml(p.guild)}]</span>` : "";
        const badge = p.founder ? ` <span class="founder-badge">FOUNDER</span>` : "";
        const score = p.seasonLumen != null ? p.seasonLumen : p.lumen;
        return `<div class="lb-row"><span class="swatch" style="background:${p.color}"></span>
        <span class="lb-name">${escapeHtml(p.name)}${tag}${badge}</span><span>${Math.round(score)}</span></div>`;
      })
      .join("");
    document.getElementById("lbRows").innerHTML = rows;
  }

  function renderCosmetics() {
    const grid = document.getElementById("colorSwatches");
    if (!grid) return;
    const mySeasonLumen = (me && me.seasonLumen) || 0;
    const isSupporter = !!(me && me.isSupporter);
    const isFounder = !!(me && me.founder);
    const myColor = (me && me.color || "").toLowerCase();

    const swatches = [];
    for (const c of cosmeticsCfg.baseColors || []) swatches.push({ color: c, locked: false, label: "" });
    for (const m of cosmeticsCfg.milestoneColors || []) {
      swatches.push({ color: m.color, locked: mySeasonLumen < m.threshold, label: `${m.label} -- unlock at ${m.threshold} season Lumen` });
    }
    for (const s of cosmeticsCfg.supporterColors || []) {
      swatches.push({ color: s.color, locked: !isSupporter, label: `${s.label} -- supporter exclusive` });
    }
    if (cosmeticsCfg.founderColor) {
      swatches.push({ color: cosmeticsCfg.founderColor, locked: !isFounder, label: "Founder exclusive" });
    }

    grid.innerHTML = swatches
      .map((s) => {
        const cls = ["color-swatch"];
        if (s.locked) cls.push("locked");
        if (myColor === s.color.toLowerCase()) cls.push("selected");
        return `<div class="${cls.join(" ")}" style="background:${s.color}" data-color="${s.color}" title="${escapeHtml(s.label)}">${s.locked ? "&#128274;" : ""}</div>`;
      })
      .join("");

    grid.querySelectorAll(".color-swatch:not(.locked)").forEach((el) => {
      el.addEventListener("click", () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "setColor", color: el.dataset.color }));
        window.trackSignal("Color.Changed");
      });
    });
  }

  function renderEventBanner() {
    const el = document.getElementById("eventBanner");
    if (!currentEventState) {
      el.style.display = "none";
      return;
    }
    el.textContent = `${currentEventState.name} — ${currentEventState.desc}`;
    el.style.display = "block";
  }

  function renderSeasonInfo() {
    const daysLeft = Math.max(0, Math.ceil((seasonInfo.startedAt + seasonInfo.durationMs - Date.now()) / 86400000));
    document.getElementById("seasonInfoLine").textContent = `Season ${seasonInfo.number} — ${daysLeft}d left`;

    const rows = recentSeasons
      .map((s) => {
        const top = s.topPlayers && s.topPlayers[0];
        const topGuild = s.topGuilds && s.topGuilds[0];
        const who = top ? `${escapeHtml(top.name)} (${Math.round(top.seasonLumen)})` : "--";
        const guildWho = topGuild ? ` &middot; [${escapeHtml(topGuild.guild)}]` : "";
        return `<div class="hof-entry">Season ${s.seasonNumber}: ${who}${guildWho}</div>`;
      })
      .join("");
    document.getElementById("hofRows").innerHTML = rows || `<div class="hof-entry" style="color:#8993ad">No seasons completed yet</div>`;
    document.getElementById("shareSeasonBtn").style.display = recentSeasons.length > 0 ? "block" : "none";
  }

  function renderGuildChat() {
    const box = document.getElementById("guildChatMessages");
    box.innerHTML = myGuildChat
      .map((m) => `<div class="chat-msg"><b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}</div>`)
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function renderWars() {
    const rows = myWars
      .map((w) => {
        const total = Math.max(1, w.scoreA + w.scoreB);
        const pctA = Math.round((w.scoreA / total) * 100);
        return `<div class="war-row">
          <div class="war-title"><span>[${escapeHtml(w.guildA)}] ${w.scoreA} &ndash; ${w.scoreB} [${escapeHtml(w.guildB)}]</span></div>
          <div class="war-bar"><span class="a" style="width:${pctA}%"></span><span class="b" style="width:${100 - pctA}%"></span></div>
        </div>`;
      })
      .join("");
    const resultRows = recentWarResults
      .slice(0, 3)
      .map((r) => {
        const outcome = r.winner ? `[${escapeHtml(r.winner)}] won` : "Draw";
        return `<div class="hof-entry">[${escapeHtml(r.guildA)}] ${r.scoreA}-${r.scoreB} [${escapeHtml(r.guildB)}] &mdash; ${outcome}</div>`;
      })
      .join("");
    document.getElementById("warRows").innerHTML = rows + resultRows || `<div class="hof-entry" style="color:#8993ad">No active wars</div>`;
    document.getElementById("shareWarBtn").style.display = recentWarResults.length > 0 ? "block" : "none";
  }

  function updateGuildSectionsVisibility() {
    const inGuild = !!(me && me.guild);
    document.getElementById("guildChatSection").style.display = inGuild ? "block" : "none";
    document.getElementById("guildWarsSection").style.display = inGuild ? "block" : "none";
  }

  function updateAbilityButtons() {
    const now = Date.now();
    for (const kind of ["shield", "overcharge", "siege"]) {
      const btn = document.getElementById("ability" + kind[0].toUpperCase() + kind.slice(1));
      if (!btn) continue;
      const remaining = Math.max(0, abilityCooldownUntil[kind] - now);
      const cfg = abilityCfg[kind] || {};
      btn.disabled = remaining > 0 || !me || me.lumen < (cfg.cost || 0);
      btn.querySelector(".costTag").textContent = remaining > 0 ? `${Math.ceil(remaining / 1000)}s` : cfg.cost;
      btn.classList.toggle("active", activeAbility === kind);
    }
  }
  setInterval(updateAbilityButtons, 500);

  function renderGuildLeaderboard(gl) {
    const rows = (gl || [])
      .map(
        (g) => `<div class="lb-row">
        <span class="lb-name">[${escapeHtml(g.guild)}]</span><span>${g.cellCount} cells</span></div>`
      )
      .join("");
    document.getElementById("guildRows").innerHTML = rows || `<div class="lb-row" style="color:#8993ad">No guilds yet</div>`;
  }

  function renderAllTimeLeaderboard(list) {
    const el = document.getElementById("allTimeRows");
    if (!el) return;
    const rows = (list || [])
      .map((p) => {
        const tag = p.guild ? ` <span style="color:#8993ad">[${escapeHtml(p.guild)}]</span>` : "";
        const badge = p.founder ? ` <span class="founder-badge">FOUNDER</span>` : "";
        return `<div class="lb-row"><span class="swatch" style="background:${p.color || "#5c7dff"}"></span>
        <span class="lb-name">${escapeHtml(p.name)}${tag}${badge}</span><span>${Math.round(p.careerLumen)}</span></div>`;
      })
      .join("");
    el.innerHTML = rows || `<div class="lb-row" style="color:#8993ad">No career data yet</div>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function shareOrCopy(text, url) {
    if (navigator.share) {
      navigator.share({ title: "Meridian: Race the Dawn", text, url }).catch(() => {});
      return;
    }
    const fullText = url ? `${text} ${url}` : text;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(fullText).then(
        () => showToast("Copied to clipboard!"),
        () => showToast(fullText)
      );
    } else {
      showToast(fullText);
    }
  }

  function connect(joinMsg) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify(joinMsg));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "welcome") {
        if (msg.token) localStorage.setItem("meridianToken", msg.token);
        const modal = document.getElementById("joinModal");
        if (modal) modal.remove();
        cellSize = msg.cellSize;
        cols = 360 / cellSize;
        rows = 180 / cellSize;
        cellState = new Map(msg.cells.map((c) => [c.id, c]));
        subsolar = msg.subsolar;
        if (msg.fortify) fortifyCfg = msg.fortify;
        if (msg.abilities) abilityCfg = msg.abilities;
        if (msg.cosmetics) cosmeticsCfg = msg.cosmetics;
        currentEventState = msg.event || null;
        if (msg.season) seasonInfo = msg.season;
        recentSeasons = msg.recentSeasons || [];
        renderAllTimeLeaderboard(msg.allTimeLeaderboard);
        myGuildChat = msg.guildChat || [];
        myWars = msg.wars || [];
        recentWarResults = msg.recentWarResults || [];
        me = msg.you;
        renderLeaderboard(msg.leaderboard);
        renderGuildLeaderboard(msg.guildLeaderboard);
        renderEventBanner();
        renderSeasonInfo();
        renderGuildChat();
        renderWars();
        document.getElementById("statOnline").textContent = msg.playerCount;
        updateStats();
        draw();
        document.getElementById("helpBtn").style.display = "flex";
        if (!localStorage.getItem("meridianSeenTutorial")) showTutorial();
        window.trackSignal("Player.Joined", { authMethod: joinMsg.type });
      } else if (msg.type === "tick") {
        subsolar = msg.subsolar;
        for (const c of msg.changed) cellState.set(c.id, c);
        renderLeaderboard(msg.leaderboard);
        renderGuildLeaderboard(msg.guildLeaderboard);
        document.getElementById("statOnline").textContent = msg.playerCount;
        clockEl.textContent = "UTC " + msg.serverTimeUTC.slice(11, 19);
        if (msg.event !== undefined && msg.event?.id !== currentEventState?.id) {
          currentEventState = msg.event || null;
          renderEventBanner();
        }
        renderSeasonInfo();
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
      } else if (msg.type === "toast") {
        showToast(msg.message);
      } else if (msg.type === "allTimeLeaderboard") {
        renderAllTimeLeaderboard(msg.allTimeLeaderboard);
      } else if (msg.type === "guildChat") {
        myGuildChat.push(msg.entry);
        myGuildChat = myGuildChat.slice(-30);
        renderGuildChat();
      } else if (msg.type === "warUpdate") {
        const idx = myWars.findIndex((w) => w.guildA === msg.war.guildA && w.guildB === msg.war.guildB);
        if (idx >= 0) myWars[idx] = msg.war;
        else if (me && (msg.war.guildA === me.guild || msg.war.guildB === me.guild)) myWars.push(msg.war);
        renderWars();
      } else if (msg.type === "warDeclared") {
        if (me && (msg.war.guildA === me.guild || msg.war.guildB === me.guild)) {
          myWars.push(msg.war);
          renderWars();
        }
        showToast(`War declared: [${msg.war.guildA}] vs [${msg.war.guildB}]!`);
      } else if (msg.type === "warEnded") {
        myWars = myWars.filter((w) => !(w.guildA === msg.result.guildA && w.guildB === msg.result.guildB));
        recentWarResults.unshift(msg.result);
        recentWarResults = recentWarResults.slice(0, 5);
        renderWars();
        if (me && (msg.result.guildA === me.guild || msg.result.guildB === me.guild)) {
          const outcome = msg.result.winner ? (msg.result.winner === me.guild ? "Your guild won!" : "Your guild lost.") : "The war ended in a draw.";
          showToast(`War over: [${msg.result.guildA}] ${msg.result.scoreA}-${msg.result.scoreB} [${msg.result.guildB}] — ${outcome}`);
        }
      } else if (msg.type === "seasonEnd") {
        seasonInfo = { number: msg.seasonNumber, startedAt: msg.seasonStartedAt, durationMs: seasonInfo.durationMs };
        recentSeasons = [msg.summary, ...recentSeasons].slice(0, 5);
        renderSeasonInfo();
        showToast(`Season ${msg.summary.seasonNumber} complete! Season ${msg.seasonNumber} begins.`);
      } else if (msg.type === "error") {
        const modal = document.getElementById("joinModal");
        if (modal) {
          // Still on the login/signup screen -- show inline and stop, don't
          // treat this as a disconnect (a failed resume falls back to login).
          document.getElementById("authError").textContent = msg.message;
          if (joinMsg.type === "resume") {
            localStorage.removeItem("meridianToken");
            ws.close();
          }
        } else {
          showToast(msg.message);
        }
      }
    };
    ws.onclose = () => {
      if (!document.getElementById("joinModal")) showToast("Disconnected from server.");
    };
  }

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const { lon, lat } = unproject(e.clientX - rect.left, e.clientY - rect.top);
    hoveredId = cellIdFromLonLat(lon, lat);
    const c = cellState.get(hoveredId);
    if (c) {
      const owner = c.color ? c.ownerName + (c.guild ? ` [${c.guild}]` : "") : "unclaimed";
      let extra = "";
      if (!activeAbility && me && c.ownerName === me.name) {
        if (c.defense >= fortifyCfg.maxDefense) {
          extra = " — max defense";
        } else {
          const cost = Math.round(fortifyCfg.baseCost * (1 + c.defense / 20));
          extra = ` — click to fortify (${cost} Lumen)`;
        }
      }
      if (c.shieldMsLeft > 0) extra += ` — shielded (${Math.ceil(c.shieldMsLeft / 1000)}s)`;
      if (c.siegeMsLeft > 0) extra += ` — sieged (${Math.ceil(c.siegeMsLeft / 1000)}s)`;
      hoverEl.textContent = `${lat.toFixed(1)}°, ${lon.toFixed(1)}° — ${owner} — ${c.illum} — defense ${c.defense}${extra}`;
    }
    draw();
  });

  canvas.addEventListener("click", (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const rect = canvas.getBoundingClientRect();
    const { lon, lat } = unproject(e.clientX - rect.left, e.clientY - rect.top);
    const id = cellIdFromLonLat(lon, lat);

    if (activeAbility) {
      ws.send(JSON.stringify({ type: "ability", ability: activeAbility, cellId: id }));
      window.trackSignal("Ability.Used", { ability: activeAbility });
      abilityCooldownUntil[activeAbility] = Date.now() + (abilityCfg.cooldownMs || 45000);
      activeAbility = null;
      document.getElementById("abilityHint").textContent =
        "Shield protects a cell you own. Siege weakens an enemy cell. Overcharge doubles your income.";
      updateAbilityButtons();
      return;
    }

    ws.send(JSON.stringify({ type: "claim", cellId: id }));
    window.trackSignal("Cell.Clicked");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeAbility) {
      activeAbility = null;
      document.getElementById("abilityHint").textContent =
        "Shield protects a cell you own. Siege weakens an enemy cell. Overcharge doubles your income.";
      updateAbilityButtons();
    }
  });

  const abilityHints = {
    shield: "Click one of your own cells to raise a shield.",
    siege: "Click an enemy-owned cell to siege it.",
  };

  document.querySelectorAll(".abilityBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!ws || ws.readyState !== WebSocket.OPEN || btn.disabled) return;
      const kind = btn.dataset.ability;
      if (kind === "overcharge") {
        ws.send(JSON.stringify({ type: "ability", ability: "overcharge" }));
        window.trackSignal("Ability.Used", { ability: "overcharge" });
        abilityCooldownUntil.overcharge = Date.now() + (abilityCfg.cooldownMs || 45000);
        updateAbilityButtons();
        return;
      }
      activeAbility = activeAbility === kind ? null : kind;
      document.getElementById("abilityHint").textContent = activeAbility
        ? abilityHints[activeAbility]
        : "Shield protects a cell you own. Siege weakens an enemy cell. Overcharge doubles your income.";
      updateAbilityButtons();
    });
  });

  document.getElementById("guildChatSend").addEventListener("click", () => {
    const input = document.getElementById("guildChatInput");
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "guildChat", text }));
    input.value = "";
  });
  document.getElementById("guildChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("guildChatSend").click();
  });

  document.getElementById("warDeclareBtn").addEventListener("click", () => {
    const input = document.getElementById("warTargetInput");
    const targetGuild = input.value.trim();
    if (!targetGuild || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "declareWar", targetGuild }));
    window.trackSignal("War.Declared");
    input.value = "";
  });

  document.getElementById("tipJarLink").addEventListener("click", () => {
    window.trackSignal("TipJar.Clicked");
  });

  document.getElementById("inviteBtn").addEventListener("click", () => {
    shareOrCopy("Join me in Meridian: Race the Dawn -- claim territory as the real day/night line sweeps the globe.", location.href);
    window.trackSignal("Share.Invite");
  });
  document.getElementById("shareXBtn").addEventListener("click", () => {
    const text = encodeURIComponent("Claiming territory along the real day/night line in Meridian: Race the Dawn.");
    const url = encodeURIComponent(location.href);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
    window.trackSignal("Share.X");
  });

  document.getElementById("shareSeasonBtn").addEventListener("click", () => {
    if (!recentSeasons[0]) return;
    const s = recentSeasons[0];
    const top = s.topPlayers && s.topPlayers[0];
    const text = top
      ? `Meridian Season ${s.seasonNumber} is complete! Top player: ${top.name} with ${Math.round(top.seasonLumen)} Lumen.`
      : `Meridian Season ${s.seasonNumber} is complete!`;
    shareOrCopy(text, location.href);
    window.trackSignal("Share.SeasonResult");
  });
  function showTutorial() {
    document.getElementById("tutorialOverlay").style.display = "flex";
  }
  function hideTutorial() {
    document.getElementById("tutorialOverlay").style.display = "none";
    localStorage.setItem("meridianSeenTutorial", "1");
    window.trackSignal("Tutorial.Completed");
  }
  document.getElementById("tutorialDone").addEventListener("click", hideTutorial);
  document.getElementById("helpBtn").addEventListener("click", showTutorial);

  document.getElementById("shareWarBtn").addEventListener("click", () => {
    if (!recentWarResults[0]) return;
    const r = recentWarResults[0];
    const outcome = r.winner ? `[${r.winner}] won` : "It ended in a draw";
    const text = `Guild war: [${r.guildA}] ${r.scoreA}-${r.scoreB} [${r.guildB}] -- ${outcome} in Meridian: Race the Dawn.`;
    shareOrCopy(text, location.href);
    window.trackSignal("Share.WarResult");
  });

  fetch("land.json")
    .then((r) => r.json())
    .then((rings) => {
      land = rings;
      resize();
    });

  const sidebarToggle = document.getElementById("sidebarToggle");
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });
  }

  // ---- auth modal: tabs + submit handlers ----
  function clearAuthError() {
    const el = document.getElementById("authError");
    if (el) el.textContent = "";
  }

  document.querySelectorAll("#authTabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#authTabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".authPane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.pane + "Pane").classList.add("active");
      clearAuthError();
    });
  });

  document.getElementById("loginBtn").addEventListener("click", () => {
    clearAuthError();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!username || !password) {
      document.getElementById("authError").textContent = "Enter a username and password.";
      return;
    }
    connect({ type: "login", username, password });
  });

  document.getElementById("signupBtn").addEventListener("click", () => {
    clearAuthError();
    const username = document.getElementById("signupUsername").value.trim();
    const password = document.getElementById("signupPassword").value;
    const guild = document.getElementById("signupGuild").value.trim();
    if (username.length < 3) {
      document.getElementById("authError").textContent = "Username must be at least 3 characters.";
      return;
    }
    if (password.length < 6) {
      document.getElementById("authError").textContent = "Password must be at least 6 characters.";
      return;
    }
    connect({ type: "signup", username, password, guild });
  });

  document.getElementById("guestBtn").addEventListener("click", () => {
    clearAuthError();
    const name = document.getElementById("guestName").value.trim() || "Wanderer";
    const guild = document.getElementById("guestGuild").value.trim();
    connect({ type: "guestJoin", name, guild });
  });

  // Enter key submits whichever pane is currently active.
  document.querySelectorAll("#joinBox input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const activePane = document.querySelector(".authPane.active");
      if (activePane) activePane.querySelector(".submitBtn").click();
    });
  });

  resize();

  // Try to silently resume a previous session before showing the login screen.
  const savedToken = localStorage.getItem("meridianToken");
  if (savedToken) {
    connect({ type: "resume", token: savedToken });
  }
})();
