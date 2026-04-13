// LM Translate — background service worker (MV3)

const DEFAULTS = {
  endpoint: "http://localhost:1234/v1/chat/completions",
  model: "", // empty = let LM Studio pick the loaded model
  targetLang: "English",
  systemPrompt:
    "You are a translation engine. Translate the user's content into {LANG}. " +
    "Output ONLY the translation — no preamble, no notes, no quotes.",
  // Gemma-style grounding prompt. Expects [{box_2d:[ymin,xmin,ymax,xmax], label:"..."}]
  // with coords normalized to 0-1000.
  detectPrompt:
    "Identify all text blobs in this image. Return a JSON array where each " +
    "element is {\"box_2d\": [ymin, xmin, ymax, xmax], \"label\": \"<the text>\"}. " +
    "Coordinates are normalized to 0-1000. Return ONLY the JSON array."
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ─── Context menus ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Retro-inject content.js into already-open tabs. Manifest content_scripts
  // only fire on navigation, so without this the extension is dead on every
  // tab that was open before install/reload.
  for (const tab of await chrome.tabs.query({})) {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"]
      })
      .catch(() => {
        /* chrome://, web store, file:// without perms, etc. — fine to skip */
      });
  }

  chrome.contextMenus.create({
    id: "lm-translate-text",
    title: "Translate selection with local LM",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "lm-translate-element",
    title: "Translate this element",
    contexts: ["page", "link", "editable", "frame"]
  });
  chrome.contextMenus.create({
    id: "lm-translate-image",
    title: "Translate image with local LM",
    contexts: ["image"]
  });
  chrome.contextMenus.create({
    id: "lm-translate-image-overlay",
    title: "Translate image (hover boxes)",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // Show "loading" overlay immediately
  await injectOverlay(tab.id, { loading: true });

  try {
    let result;
    if (info.menuItemId === "lm-translate-text" && info.selectionText) {
      result = await translateText(info.selectionText);
    } else if (info.menuItemId === "lm-translate-element") {
      // Ask the content script what was under the cursor at right-click time.
      // frameId matters for iframes (e.g. embedded tweets).
      let resp;
      try {
        resp = await chrome.tabs.sendMessage(
          tab.id,
          { cmd: "lmt:extractElement" },
          { frameId: info.frameId ?? 0 }
        );
      } catch (e) {
        // "Receiving end does not exist" — content script never loaded in this
        // frame (restricted page, or a race we couldn't retro-inject around).
        throw new Error(
          "Content script not loaded here. Try refreshing the page, " +
            "or this may be a restricted page (chrome://, PDF viewer, etc.)."
        );
      }
      if (!resp?.ok) throw new Error(resp?.error || "Could not read element.");
      result = await translateText(resp.text);
    } else if (info.menuItemId === "lm-translate-image" && info.srcUrl) {
      result = await translateImage(info.srcUrl);
    } else if (info.menuItemId === "lm-translate-image-overlay" && info.srcUrl) {
      const regions = await detectAndTranslate(info.srcUrl);
      await injectBoxOverlay(tab.id, info.srcUrl, regions);
      await injectOverlay(tab.id, { text: `${regions.length} region(s) — hover to read.` });
      return;
    } else {
      throw new Error("Nothing to translate.");
    }
    await injectOverlay(tab.id, { text: result });
  } catch (err) {
    console.error("[LM Translate]", err);
    await injectOverlay(tab.id, {
      error: err.message || String(err)
    });
  }
});

// ─── LM Studio API ────────────────────────────────────────────────────────────
// Streams internally so we can measure TTFT. Returns the assembled string.
// opts.kind tags the stat record ("text" | "image" | "detect" | "batch").
async function callLM(messages, opts = {}) {
  const cfg = await getSettings();
  const body = {
    messages,
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (cfg.model) body.model = cfg.model;

  const t0 = performance.now();
  const stat = {
    ts: Date.now(),
    kind: opts.kind ?? "?",
    ttft: null,
    total: null,
    promptTokens: null,
    completionTokens: null,
    model: null,
    ok: false,
    error: null
  };

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`LM Studio HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const { content, ttft, usage, model } = await readSSE(res.body, t0);

    stat.ttft = ttft;
    stat.total = performance.now() - t0;
    stat.promptTokens = usage?.prompt_tokens ?? null;
    stat.completionTokens = usage?.completion_tokens ?? null;
    stat.model = model;
    stat.ok = true;

    if (!content) throw new Error("Empty response from model.");
    return content.trim();
  } catch (err) {
    stat.total = performance.now() - t0;
    stat.error = err.message || String(err);
    throw err;
  } finally {
    recordStat(stat);
  }
}

// Parse an OpenAI-style SSE stream. Returns { content, ttft, usage, model }.
async function readSSE(stream, t0) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let ttft = null;
  let usage = null;
  let model = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);

      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;

      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }

      if (obj.model && !model) model = obj.model;
      if (obj.usage) usage = obj.usage;

      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        if (ttft === null) ttft = performance.now() - t0;
        content += delta;
      }
    }
  }

  return { content, ttft, usage, model };
}

// Ring buffer of the last 20 calls in chrome.storage.local.
async function recordStat(stat) {
  try {
    const { stats = [] } = await chrome.storage.local.get("stats");
    stats.push(stat);
    while (stats.length > 20) stats.shift();
    await chrome.storage.local.set({ stats });
  } catch (e) {
    console.warn("[LM Translate] failed to record stat", e);
  }
}

async function translateText(text) {
  const cfg = await getSettings();
  const sys = cfg.systemPrompt.replace("{LANG}", cfg.targetLang);
  return callLM(
    [
      { role: "system", content: sys },
      { role: "user", content: text }
    ],
    { kind: "text" }
  );
}

async function translateImage(srcUrl) {
  const cfg = await getSettings();
  const sys = cfg.systemPrompt.replace("{LANG}", cfg.targetLang);

  // Fetch image → base64 data URL.
  // Fetching from the SW avoids page CSP and works for cross-origin images
  // thanks to <all_urls> host permission.
  const dataUrl = await fetchImageAsDataUrl(srcUrl);

  return callLM([
    { role: "system", content: sys },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Extract all text from this image and translate it."
        },
        {
          type: "image_url",
          image_url: { url: dataUrl }
        }
      ]
    }
  ], { kind: "image" });
}

// ─── Grounded image translation (Gemma-style box_2d) ─────────────────────────
async function detectAndTranslate(srcUrl) {
  const cfg = await getSettings();
  const dataUrl = await fetchImageAsDataUrl(srcUrl);

  // 1. Detection pass — vision call, returns JSON with boxes.
  const rawDetect = await callLM(
    [
      {
        role: "user",
        content: [
          { type: "text", text: cfg.detectPrompt },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    { kind: "detect" }
  );

  const detected = extractJsonArray(rawDetect);
  if (!detected.length) throw new Error("Model found no text regions.");

  const labels = detected.map((d) => String(d.label ?? ""));

  // 2. Translation pass — text-only, batched with a hard delimiter.
  const translations = await translateBatch(labels, cfg);

  return detected.map((d, i) => ({
    box: d.box_2d, // [ymin, xmin, ymax, xmax] in 0-1000
    original: labels[i],
    translated: translations[i] ?? "(translation missing)"
  }));
}

function extractJsonArray(text) {
  // Tolerate ```json fences, preamble, trailing prose.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON array in detection response.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Detection response was not an array.");
  return parsed;
}

const SEG = "<<<SEG>>>";

async function translateBatch(labels, cfg) {
  if (labels.length === 0) return [];
  if (labels.length === 1) return [await translateText(labels[0])];

  const sys =
    `You are a translation engine. The user will send text segments separated ` +
    `by the exact marker "${SEG}". Translate each segment into ${cfg.targetLang}. ` +
    `Return ONLY the translations, separated by the same "${SEG}" marker, in the ` +
    `same order. Do not number, do not add commentary, do not merge segments.`;

  const raw = await callLM(
    [
      { role: "system", content: sys },
      { role: "user", content: labels.join(`\n${SEG}\n`) }
    ],
    { kind: "batch" }
  );

  const parts = raw.split(SEG).map((s) => s.trim());

  // If the model dropped/added segments, pad so the UI still functions.
  if (parts.length !== labels.length) {
    console.warn(
      `[LM Translate] segment mismatch: expected ${labels.length}, got ${parts.length}`
    );
    while (parts.length < labels.length) parts.push("(?)");
    parts.length = labels.length;
  }
  return parts;
}

async function injectBoxOverlay(tabId, srcUrl, regions) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: renderBoxOverlay,
    args: [srcUrl, regions]
  });
}

async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
  const blob = await res.blob();

  // FileReader isn't available in MV3 service workers — encode manually.
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // Chunked btoa to avoid call-stack limits on large images.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const mime = blob.type || "image/png";
  return `data:${mime};base64,${b64}`;
}

// ─── Overlay injection ────────────────────────────────────────────────────────
async function injectOverlay(tabId, payload) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: showOverlay,
    args: [payload]
  });
}

// Runs in the page context. Self-contained.
// regions: [{ box: [ymin,xmin,ymax,xmax] (0-1000), original, translated }]
function renderBoxOverlay(srcUrl, regions) {
  // Locate the image. info.srcUrl is resolved; img.src/currentSrc are too.
  const img = [...document.images].find(
    (i) => i.src === srcUrl || i.currentSrc === srcUrl
  );
  if (!img) {
    console.warn("[LM Translate] could not locate <img> for", srcUrl);
    return;
  }

  // Wipe any prior overlay for this image.
  document
    .querySelectorAll(`[data-lmt-overlay-for="${CSS.escape(srcUrl)}"]`)
    .forEach((n) => n.remove());

  const rect = img.getBoundingClientRect();

  // Container sits in document coords so it survives scrolling without a listener.
  const container = document.createElement("div");
  container.dataset.lmtOverlayFor = srcUrl;
  Object.assign(container.style, {
    position: "absolute",
    left: rect.left + window.scrollX + "px",
    top: rect.top + window.scrollY + "px",
    width: rect.width + "px",
    height: rect.height + "px",
    pointerEvents: "none",
    zIndex: 2147483646
  });

  // Single shared tooltip, repositioned on mousemove.
  const tip = document.createElement("div");
  tip.dataset.lmtOverlayFor = srcUrl;
  Object.assign(tip.style, {
    position: "fixed",
    display: "none",
    maxWidth: "320px",
    background: "#1e1e1e",
    color: "#e8e8e8",
    font: "13px/1.45 -apple-system, Segoe UI, sans-serif",
    padding: "8px 10px",
    borderRadius: "6px",
    boxShadow: "0 6px 24px rgba(0,0,0,.45)",
    zIndex: 2147483647,
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word"
  });

  // Close button (top-right of container).
  const close = document.createElement("button");
  close.textContent = "✕";
  Object.assign(close.style, {
    position: "absolute",
    top: "-10px",
    right: "-10px",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: "none",
    background: "#1e1e1e",
    color: "#e8e8e8",
    cursor: "pointer",
    fontSize: "12px",
    pointerEvents: "auto",
    boxShadow: "0 2px 8px rgba(0,0,0,.4)"
  });
  close.onclick = () => {
    container.remove();
    tip.remove();
  };
  container.appendChild(close);

  // Boxes. Gemma box_2d is [ymin, xmin, ymax, xmax] normalized 0-1000,
  // so /10 → CSS percent. Image aspect is already baked into the container
  // dimensions, so percentages map correctly.
  for (const r of regions) {
    const [ymin, xmin, ymax, xmax] = r.box;
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      left: xmin / 10 + "%",
      top: ymin / 10 + "%",
      width: (xmax - xmin) / 10 + "%",
      height: (ymax - ymin) / 10 + "%",
      border: "2px solid rgba(80, 170, 255, .9)",
      background: "rgba(80, 170, 255, .12)",
      borderRadius: "3px",
      boxSizing: "border-box",
      pointerEvents: "auto",
      cursor: "help",
      transition: "background .12s"
    });

    box.addEventListener("mouseenter", () => {
      box.style.background = "rgba(80, 170, 255, .28)";
      tip.innerHTML = "";
      const orig = document.createElement("div");
      orig.textContent = r.original;
      Object.assign(orig.style, {
        color: "#999",
        fontSize: "11px",
        marginBottom: "4px",
        borderBottom: "1px solid #333",
        paddingBottom: "4px"
      });
      const tr = document.createElement("div");
      tr.textContent = r.translated;
      tip.appendChild(orig);
      tip.appendChild(tr);
      tip.style.display = "block";
    });

    box.addEventListener("mousemove", (e) => {
      // Offset so the tooltip doesn't sit under the cursor.
      const x = e.clientX + 14;
      const y = e.clientY + 14;
      // Keep on-screen.
      const tw = tip.offsetWidth || 320;
      const th = tip.offsetHeight || 60;
      tip.style.left = Math.min(x, window.innerWidth - tw - 8) + "px";
      tip.style.top = Math.min(y, window.innerHeight - th - 8) + "px";
    });

    box.addEventListener("mouseleave", () => {
      box.style.background = "rgba(80, 170, 255, .12)";
      tip.style.display = "none";
    });

    container.appendChild(box);
  }

  document.body.appendChild(container);
  document.body.appendChild(tip);

  // Re-anchor on resize (cheap; no scroll listener needed since we use doc coords).
  const reanchor = () => {
    if (!document.contains(img)) {
      container.remove();
      tip.remove();
      window.removeEventListener("resize", reanchor);
      return;
    }
    const r = img.getBoundingClientRect();
    container.style.left = r.left + window.scrollX + "px";
    container.style.top = r.top + window.scrollY + "px";
    container.style.width = r.width + "px";
    container.style.height = r.height + "px";
  };
  window.addEventListener("resize", reanchor);
}

// Runs in the page context. Keep self-contained — no closures over SW scope.
function showOverlay(payload) {
  const ID = "__lm_translate_overlay__";
  let el = document.getElementById(ID);

  if (!el) {
    el = document.createElement("div");
    el.id = ID;
    Object.assign(el.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      maxWidth: "420px",
      maxHeight: "60vh",
      overflow: "auto",
      background: "#1e1e1e",
      color: "#e8e8e8",
      font: "14px/1.5 -apple-system, Segoe UI, sans-serif",
      padding: "14px 16px",
      borderRadius: "8px",
      boxShadow: "0 8px 32px rgba(0,0,0,.4)",
      zIndex: 2147483647,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word"
    });

    const close = document.createElement("button");
    close.textContent = "✕";
    Object.assign(close.style, {
      position: "absolute",
      top: "6px",
      right: "8px",
      background: "transparent",
      border: "none",
      color: "#aaa",
      fontSize: "16px",
      cursor: "pointer",
      padding: "2px 6px"
    });
    close.onclick = () => el.remove();

    const body = document.createElement("div");
    body.className = "lmt-body";
    body.style.marginTop = "8px";

    el.appendChild(close);
    el.appendChild(body);
    document.documentElement.appendChild(el);
  }

  const body = el.querySelector(".lmt-body");

  if (payload.loading) {
    body.textContent = "Translating…";
    body.style.color = "#aaa";
  } else if (payload.error) {
    body.textContent = "Error: " + payload.error;
    body.style.color = "#ff6b6b";
  } else {
    body.textContent = payload.text;
    body.style.color = "#e8e8e8";
  }
}
