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
  statProvider.textContent = msg.provider;
  statScanned.textContent = fmtNum(msg.scannedContracts);
  statHits.textContent = fmtNum(msg.hits.length);
  statUpdated.textContent = fmtTs(msg.cycleStartedAt);

  statusEl.textContent = msg.marketOpen
    ? msg.errors.length
      ? `live — ${msg.errors.length} error(s) last cycle`
      : "market open — live"
    : "market closed";
  statusEl.className = "status " + (msg.errors.length ? "error" : msg.marketOpen ? "open" : "closed");

  emptyEl.style.display = msg.hits.length === 0 ? "block" : "none";

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
