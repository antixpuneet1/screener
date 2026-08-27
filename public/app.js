const statusEl = document.getElementById("status");
const bodyEl = document.getElementById("hits-body");
const emptyEl = document.getElementById("empty-state");
const statHits = document.getElementById("stat-hits");
const statScanned = document.getElementById("stat-scanned");
const statProvider = document.getElementById("stat-provider");
const statUpdated = document.getElementById("stat-updated");

function fmtNum(n) {
  return Number(n).toLocaleString("en-IN");
}

function fmtTs(iso) {
  try {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  } catch {
    return iso;
  }
}

function render(msg) {
  const banner = document.getElementById("config-banner");
  if (msg.configError) {
    banner.hidden = false;
    banner.textContent = `${msg.configError} — open Settings to fix this.`;
  } else {
    banner.hidden = true;
  }

  // Surface the actual failure text: the app window has no address bar, so the API
  // response isn't reachable, and an error count alone can't be diagnosed.
  const errPanel = document.getElementById("error-panel");
  const errList = document.getElementById("error-list");
  if (msg.errors && msg.errors.length > 0) {
    errPanel.hidden = false;
    document.getElementById("error-summary").textContent =
      `${msg.errors.length} batch error(s) last cycle — click for details`;
    errList.innerHTML = "";
    for (const e of msg.errors.slice(0, 5)) {
      const li = document.createElement("li");
      li.textContent = e;
      errList.appendChild(li);
    }
    if (msg.errors.length > 5) {
      const li = document.createElement("li");
      li.textContent = `…and ${msg.errors.length - 5} more (see screener.log)`;
      errList.appendChild(li);
    }
  } else {
    errPanel.hidden = true;
  }

  statProvider.textContent = msg.provider ?? "—";
  statHits.textContent = fmtNum(msg.hits.length);

  // While a cycle is in flight show live progress; a full F&O scan takes minutes, and
  // rendering zeros with a 1970 timestamp made a working app look broken.
  const p = msg.progress;
  if (p && p.phase === "loading-instruments") {
    statScanned.textContent = "…";
    statUpdated.textContent = p.detail || "loading contract list";
  } else if (p && p.phase === "scanning") {
    statScanned.textContent = `${fmtNum(p.quotedContracts)} / ${fmtNum(p.totalContracts)}`;
    statUpdated.textContent = `scanning — batch ${fmtNum(p.batchesDone)} of ${fmtNum(p.batchesTotal)}`;
  } else {
    statScanned.textContent = fmtNum(msg.scannedContracts);
    statUpdated.textContent = msg.cycleStartedAt ? fmtTs(msg.cycleStartedAt) : "no scan completed yet";
  }

  statusEl.textContent = msg.configError
    ? "not configured"
    : msg.marketOpen
      ? msg.errors.length
        ? `live — ${msg.errors.length} error(s) last cycle`
        : "market open — live"
      : "market closed";
  statusEl.className =
    "status " + (msg.configError || msg.errors.length ? "error" : msg.marketOpen ? "open" : "closed");

  emptyEl.style.display = msg.hits.length === 0 ? "block" : "none";
  emptyEl.textContent = msg.configError
    ? "Not configured yet — open Settings to add your Upstox token."
    : msg.progress
      ? "Scanning… results appear as contracts are quoted."
      : !msg.hasCompletedCycle
        ? "Waiting for the first scan to finish."
        : !msg.marketOpen
          ? "Market is closed (NSE trades 09:15–15:30 IST, Mon–Fri). Live data resumes at the next open."
          : "No Open = Low contracts detected yet this session.";

  bodyEl.innerHTML = "";
  for (const hit of msg.hits) {
    const tr = document.createElement("tr");
    tr.className = hit.optionType.toLowerCase() + (hit.isNew ? " new-hit" : "");
    tr.innerHTML = `
      <td>${hit.underlying}</td>
      <td>${hit.optionType}</td>
      <td>${fmtNum(hit.strike)}</td>
      <td>${hit.expiry}</td>
      <td>${hit.open.toFixed(2)}</td>
      <td>${hit.low.toFixed(2)}</td>
      <td>${hit.ltp.toFixed(2)}</td>
      <td>${fmtNum(hit.volume)}</td>
      <td>${fmtNum(hit.oi)}</td>
      <td>${hit.changeInOi >= 0 ? "+" : ""}${fmtNum(hit.changeInOi)}</td>
      <td>${fmtTs(hit.timestamp)}</td>
    `;
    bodyEl.appendChild(tr);
  }
}

// --- Settings panel ---------------------------------------------------------------

const panel = document.getElementById("settings-panel");
const elProvider = document.getElementById("set-provider");
const elToken = document.getElementById("set-token");
const elTokenState = document.getElementById("token-state");
const elRefresh = document.getElementById("set-refresh");
const elIgnoreHours = document.getElementById("set-ignore-hours");
const elMsg = document.getElementById("settings-msg");
const elFile = document.getElementById("settings-file");

function setMsg(text, kind) {
  elMsg.textContent = text;
  elMsg.className = "settings-msg" + (kind ? " " + kind : "");
}

async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  elProvider.value = s.provider;
  elRefresh.value = Math.round(s.refreshIntervalMs / 1000);
  elIgnoreHours.checked = s.ignoreMarketHours;
  elFile.textContent = s.settingsFile;
  document.getElementById("build-id").textContent = "build " + s.buildId;
  elTokenState.textContent = s.tokenSet
    ? `A token is set (${s.tokenMasked}, from ${s.tokenSource === "env" ? ".env" : "settings"}). Leave blank to keep it.`
    : "No token set yet.";
}

document.getElementById("settings-toggle").addEventListener("click", async () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    setMsg("", null);
    await loadSettings();
  }
});

document.getElementById("btn-test").addEventListener("click", async () => {
  setMsg("Testing token against Upstox…", "busy");
  const res = await fetch("/api/settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upstoxAccessToken: elToken.value }),
  });
  const r = await res.json();
  setMsg(r.message, r.ok ? "ok" : "err");
});

document.getElementById("btn-save").addEventListener("click", async () => {
  setMsg("Saving…", "busy");
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: elProvider.value,
      upstoxAccessToken: elToken.value,
      refreshIntervalMs: Number(elRefresh.value) * 1000,
      ignoreMarketHours: elIgnoreHours.checked,
    }),
  });
  const r = await res.json();
  if (!r.ok) {
    setMsg(r.message || "Save failed.", "err");
    return;
  }
  elToken.value = "";
  await loadSettings();
  setMsg(r.configError ? `Saved, but: ${r.configError}` : "Saved and applied.", r.configError ? "err" : "ok");
});

document.getElementById("btn-clear").addEventListener("click", async () => {
  if (!confirm("Remove the stored Upstox token?")) return;
  setMsg("Clearing…", "busy");
  const r = await (await fetch("/api/settings/clear-token", { method: "POST" })).json();
  elToken.value = "";
  await loadSettings();
  setMsg(r.ok ? "Token cleared." : "Could not clear token.", r.ok ? "ok" : "err");
});

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "screener-update") render(msg);
  };

  ws.onclose = () => {
    statusEl.textContent = "disconnected — retrying…";
    statusEl.className = "status error";
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
