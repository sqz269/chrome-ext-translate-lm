const DEFAULTS = {
  endpoint: "http://localhost:1234/v1/chat/completions",
  model: "",
  targetLang: "English",
  systemPrompt:
    "You are a translation engine. Translate the user's content into {LANG}. " +
    "Output ONLY the translation — no preamble, no notes, no quotes.",
  detectPrompt:
    "Identify all text blobs in this image. Return a JSON array where each " +
    "element is {\"box_2d\": [ymin, xmin, ymax, xmax], \"label\": \"<the text>\"}. " +
    "Coordinates are normalized to 0-1000. Return ONLY the JSON array.",
  imageInTranslatePass: false
};

const textFields = ["endpoint", "model", "targetLang", "systemPrompt", "detectPrompt"];
const boolFields = ["imageInTranslatePass"];

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  for (const f of textFields) {
    document.getElementById(f).value = cfg[f] ?? DEFAULTS[f];
  }
  for (const f of boolFields) {
    document.getElementById(f).checked = cfg[f] ?? DEFAULTS[f];
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const out = {};
  for (const f of textFields) out[f] = document.getElementById(f).value;
  for (const f of boolFields) out[f] = document.getElementById(f).checked;
  await chrome.storage.sync.set(out);
  const s = document.getElementById("status");
  s.textContent = "Saved.";
  setTimeout(() => (s.textContent = ""), 1500);
});

load();

// ─── Diagnostics ──────────────────────────────────────────────────────────────
function fmtMs(v) {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
}

function renderStats(stats) {
  const tbody = document.getElementById("stats-body");
  const summary = document.getElementById("stats-summary");
  tbody.innerHTML = "";

  if (!stats.length) {
    summary.textContent = "No calls yet.";
    return;
  }

  // Newest first.
  const rows = [...stats].reverse();

  // Aggregate over successful calls.
  const ok = rows.filter((s) => s.ok);
  if (ok.length) {
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const ttfts = ok.map((s) => s.ttft).filter((v) => v != null);
    const tps = ok
      .filter((s) => s.completionTokens && s.total)
      .map((s) => s.completionTokens / (s.total / 1000));
    const model = ok[0].model || "?";
    summary.innerHTML =
      `<b>${model}</b> · ` +
      `avg TTFT <b>${ttfts.length ? fmtMs(avg(ttfts)) : "—"}</b> · ` +
      `avg <b>${tps.length ? avg(tps).toFixed(1) : "—"}</b> tok/s · ` +
      `${ok.length}/${rows.length} ok`;
  } else {
    summary.textContent = `${rows.length} call(s), all failed.`;
  }

  for (const s of rows) {
    const tr = document.createElement("tr");
    if (!s.ok) tr.className = "err";

    // TBT = avg ms between tokens after the first one.
    let tbt = null;
    if (s.ok && s.ttft != null && s.total != null && s.completionTokens > 1) {
      tbt = (s.total - s.ttft) / (s.completionTokens - 1);
    }

    let tps = null;
    if (s.ok && s.completionTokens && s.total) {
      tps = s.completionTokens / (s.total / 1000);
    }

    const cells = [
      `<span class="kind">${s.kind}</span>`,
      fmtMs(s.ttft),
      fmtMs(s.total),
      tbt != null ? `${tbt.toFixed(1)}ms` : "—",
      tps != null ? tps.toFixed(1) : "—",
      s.ok
        ? `${s.promptTokens ?? "?"}/${s.completionTokens ?? "?"}`
        : (s.error ?? "error").slice(0, 20)
    ];

    for (const c of cells) {
      const td = document.createElement("td");
      td.innerHTML = c;
      tr.appendChild(td);
    }
    if (!s.ok && s.error) tr.title = s.error;
    tbody.appendChild(tr);
  }
}

async function loadStats() {
  const { stats = [] } = await chrome.storage.local.get("stats");
  renderStats(stats);
}

// Live-update while popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) {
    renderStats(changes.stats.newValue || []);
  }
});

document.getElementById("clear-stats").addEventListener("click", async () => {
  await chrome.storage.local.set({ stats: [] });
});

loadStats();
