const DEFAULTS = {
  provider: "custom",
  endpoint: "http://127.0.0.1:8000/v1/chat/completions",
  model: "gemma-translation",
  targetLang: "English",
  systemPrompt:
    "You are a translation engine. Translate the user's content into {LANG}. " +
    "Output ONLY the translation — no preamble, no notes, no quotes.",
  detectPrompt: "Locate and transcribe all visible text in this Japanese manga page. Return one region per complete speech bubble, caption block, title block, or sound effect. Keep all columns in the same speech bubble together in Japanese reading order (right to left). Do not split a bubble into individual columns or characters. Use tight rectangular bounds around the text, not the balloon border. Transcribe exactly; do not translate, complete obscured text, or invent characters. Return ONLY a JSON array of objects with box_2d: [ymin, xmin, ymax, xmax] in coordinates normalized to 0-1000, and label: the complete text for that region.",
  gemmaVllm: true,
  gemmaImageVerification: true,
  imageInTranslatePass: false,
  tryPrefixCache: false,
  preemptiveCors: false
};

const textFields = ["endpoint", "model", "targetLang", "systemPrompt", "detectPrompt"];
const boolFields = ["gemmaVllm", "gemmaImageVerification", "imageInTranslatePass", "tryPrefixCache", "preemptiveCors"];

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById('provider').value = cfg.provider || 'custom';
  updateProviderNote();
  for (const f of textFields) {
    document.getElementById(f).value = cfg[f] ?? DEFAULTS[f];
  }
  for (const f of boolFields) {
    document.getElementById(f).checked = cfg[f] ?? DEFAULTS[f];
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const out = {};
  out.provider = document.getElementById('provider').value;
  out.gemmaProfileVersion = 2;
  for (const f of textFields) out[f] = document.getElementById(f).value;
  for (const f of boolFields) out[f] = document.getElementById(f).checked;
  const s = document.getElementById("status");
  try {
    const url = new URL(out.endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (!out.targetLang.trim()) throw new Error();
  } catch { s.textContent = 'Enter an HTTP(S) endpoint and a target language.'; return; }
  try { await chrome.storage.sync.set(out); }
  catch (e) { s.textContent = 'Could not save: ' + e.message; return; }
  s.textContent = "Saved.";
  setTimeout(() => (s.textContent = ""), 1500);
});

load();

function updateProviderNote() {
  const vertex = document.getElementById('provider').value.startsWith('vertex');
  document.getElementById('provider-note').textContent = vertex
    ? 'Paid Google Vertex API. Selected text and images are sent to Google through the local bridge. Start Start-VertexBridge.ps1 first. Project: buoyant-program-477612-e3 · location: us.' + (document.getElementById('provider').value === 'vertexhybrid' ? ' Model field controls detection; translation uses 3.8 Flash Low.' : document.getElementById('provider').value === 'vertexargonflash' ? ' Model field controls detection; translation uses 3.6 Flash Minimal. Best quality per second in eval-v2 (about 27 s per page).' : '')
    : 'Local/custom endpoint. Select a preset to fill connection settings, then Save.';
}
document.getElementById('provider').addEventListener('change', event => {
  const id = event.target.value;
  if (id !== 'custom') {
    const vertex = id.startsWith('vertex');
    document.getElementById('endpoint').value = vertex ? 'http://127.0.0.1:8001/v1/chat/completions' : DEFAULTS.endpoint;
    document.getElementById('model').value = id === 'vertex36' || id === 'vertexhybrid' ? 'gemini-3.6-flash-minimal' : id === 'vertex38' ? 'gemini-3.8-flash-low' : id === 'vertexargon' || id === 'vertexargonflash' ? 'gemini-4-argon-low' : DEFAULTS.model;
    document.getElementById('gemmaVllm').checked = !vertex;
    document.getElementById('gemmaImageVerification').checked = true;
    document.getElementById('tryPrefixCache').checked = false;
    document.getElementById('imageInTranslatePass').checked = false;
    document.getElementById('detectPrompt').value = DEFAULTS.detectPrompt;
  }
  updateProviderNote();
});

document.getElementById('test-connection').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById('status');
  button.disabled = true;
  status.textContent = 'Checking server…';
  try {
    const url = new URL(document.getElementById('endpoint').value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) endpoint.');
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
    if (!url.pathname.endsWith('/models')) throw new Error('Expected a /chat/completions endpoint.');
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
    const data = await response.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean);
    const selected = document.getElementById('model').value.trim();
    status.textContent = models.length
      ? `Connected · ${models.join(', ')}${selected && !models.includes(selected) ? ' · Selected model was not listed.' : ''}`
      : 'Connected, but no models are listed. Load a model on the server.';
  } catch (e) { status.textContent = `Connection check failed: ${e.message}`; }
  finally { button.disabled = false; }
});

// ─── Overlay dismiss ─────────────────────────────────────────────────────────
async function dismissInActiveTab(func) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func }); }
  catch { document.getElementById('status').textContent = 'Overlays cannot be accessed on this browser page.'; }
}

document.getElementById("dismiss-result").addEventListener("click", () => {
  dismissInActiveTab(() => {
    const el = document.getElementById("__lm_translate_overlay__");
    document.dispatchEvent(new CustomEvent('lmt-dismiss', {detail:'panel'}));
    if (el && !el.shadowRoot) el.remove();
  });
});

document.getElementById("dismiss-boxes").addEventListener("click", () => {
  dismissInActiveTab(() => {
    document.querySelectorAll("[data-lmt-overlay-for]").forEach((n) => n.remove());
    document.dispatchEvent(new CustomEvent('lmt-dismiss', {detail:'boxes'}));
  });
});

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
    summary.textContent =
      `${model} · ` +
      `avg first token ${ttfts.length ? fmtMs(avg(ttfts)) : "—"} · ` +
      `avg ${tps.length ? avg(tps).toFixed(1) : "—"} tok/s · ` +
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
      s.kind,
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
      td.textContent = c;
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
