/** Shape returned by GET /_railgate/api/tunnels. */
export interface ActiveTunnelView {
  subdomain: string;
  url: string;
  clientIp: string | null;
  openedAt: number;
  requestCount: number;
  wsConnections: number;
  pendingRequests: number;
}

export interface HistoricTunnelView {
  subdomain: string;
  clientIp: string | null;
  openedAt: number;
  closedAt: number | null;
  requestCount: number;
  closeReason: string | null;
}

export interface DashboardData {
  baseDomain: string;
  protocol: "http" | "https";
  openMode: boolean;
  durableHistory: boolean;
  active: ActiveTunnelView[];
  history: HistoricTunnelView[];
}

/**
 * The dashboard is a single self-contained page (no build step, no external
 * assets) that polls the JSON API and renders active + historic tunnels.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>railgate</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #131722;
    --border: #232838;
    --text: #d7dce5;
    --muted: #8a93a6;
    --accent: #5b8def;
    --live: #2ec27e;
    --dead: #6b7280;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg);
    color: var(--text);
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 18px; margin: 0; letter-spacing: 0.5px; }
  header .domain { color: var(--muted); }
  header .spacer { flex: 1; }
  .badge {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  main { padding: 24px; max-width: 1100px; }
  section { margin-bottom: 36px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: var(--panel); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.live { background: var(--live); box-shadow: 0 0 6px var(--live); }
  .dot.dead { background: var(--dead); }
  .empty { color: var(--muted); padding: 16px 12px; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>railgate</h1>
  <span class="domain" id="domain"></span>
  <span class="spacer"></span>
  <span class="badge" id="mode"></span>
  <span class="badge" id="storage"></span>
</header>
<main>
  <section>
    <h2>Active tunnels (<span id="active-count">0</span>)</h2>
    <table>
      <thead><tr>
        <th>Tunnel</th><th>URL</th><th>Client</th><th>Opened</th>
        <th class="num">Requests</th><th class="num">WS</th><th class="num">In-flight</th>
      </tr></thead>
      <tbody id="active-body"></tbody>
    </table>
  </section>
  <section>
    <h2>History (<span id="history-count">0</span>)</h2>
    <table>
      <thead><tr>
        <th>Tunnel</th><th>Client</th><th>Opened</th><th>Closed</th>
        <th class="num">Requests</th><th>Duration</th><th>Reason</th>
      </tr></thead>
      <tbody id="history-body"></tbody>
    </table>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmtTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function fmtDuration(from, to) {
  if (!from || !to) return "-";
  let s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); s %= 60;
  if (m < 60) return m + "m " + s + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function render(data) {
  $("domain").textContent = data.baseDomain || "";
  $("mode").textContent = data.openMode ? "open mode" : "token auth";
  $("storage").textContent = data.durableHistory ? "persistent history" : "in-memory history";

  const active = data.active || [];
  const history = data.history || [];
  $("active-count").textContent = active.length;
  $("history-count").textContent = history.length;

  $("active-body").innerHTML = active.length
    ? active.map((t) =>
        "<tr>" +
        "<td><span class='dot live'></span>" + esc(t.subdomain) + "</td>" +
        "<td><a href='" + esc(t.url) + "' target='_blank' rel='noopener'>" + esc(t.url) + "</a></td>" +
        "<td class='muted'>" + esc(t.clientIp || "-") + "</td>" +
        "<td class='muted'>" + esc(fmtTime(t.openedAt)) + "</td>" +
        "<td class='num'>" + t.requestCount + "</td>" +
        "<td class='num'>" + t.wsConnections + "</td>" +
        "<td class='num'>" + t.pendingRequests + "</td>" +
        "</tr>"
      ).join("")
    : "<tr><td colspan='7' class='empty'>No active tunnels.</td></tr>";

  $("history-body").innerHTML = history.length
    ? history.map((t) =>
        "<tr>" +
        "<td><span class='dot dead'></span>" + esc(t.subdomain) + "</td>" +
        "<td class='muted'>" + esc(t.clientIp || "-") + "</td>" +
        "<td class='muted'>" + esc(fmtTime(t.openedAt)) + "</td>" +
        "<td class='muted'>" + esc(fmtTime(t.closedAt)) + "</td>" +
        "<td class='num'>" + t.requestCount + "</td>" +
        "<td class='muted'>" + esc(fmtDuration(t.openedAt, t.closedAt)) + "</td>" +
        "<td class='muted'>" + esc(t.closeReason || "-") + "</td>" +
        "</tr>"
      ).join("")
    : "<tr><td colspan='7' class='empty'>No history yet.</td></tr>";
}

async function poll() {
  try {
    const res = await fetch("/_railgate/api/tunnels", { cache: "no-store" });
    if (res.ok) render(await res.json());
  } catch (e) { /* transient — retry on next tick */ }
}

poll();
setInterval(poll, 3000);
</script>
</body>
</html>
`;
