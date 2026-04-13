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
    "Coordinates are normalized to 0-1000. Return ONLY the JSON array.",
  // If true, the batch-translate pass also receives the image so the model
  // can use visual context (e.g. "売" on a button vs a sign). Costs more
  // prompt tokens; quality gain depends on the model.
  imageInTranslatePass: false,
  // Experiment: structure both detect and batch calls as [image, text] with
  // no system prompt, so they share an identical image prefix. If llama.cpp
  // recognizes it, batch TTFT should collapse. Implies imageInTranslatePass.
  tryPrefixCache: false
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ─── Pipeline tracker ─────────────────────────────────────────────────────────
// Pre-declared stages per menu item so the overlay can show what's coming.
const STAGES = {
  "lm-translate-text": ["Translate"],
  "lm-translate-element": ["Extract element", "Translate"],
  "lm-translate-image": ["Grab image", "Translate"],
  "lm-translate-image-overlay": ["Grab image", "Detect regions", "Translate batch"]
};

function makePipeline(tabId, labels) {
  const stages = labels.map((label) => ({ label, state: "pending" }));
  let idx = -1;
  let t0 = null;

  const snapshot = (extra = {}) => ({
    stages: stages.map((s) => ({ ...s })), // deep-ish copy for safe injection
    elapsed: t0 != null ? performance.now() - t0 : 0,
    ...extra
  });

  const push = (extra) =>
    injectOverlay(tabId, { pipeline: snapshot(extra) }).catch(() => {});

  // Close out whichever stage is active so we can advance or finish.
  const closeActive = () => {
    const cur = stages[idx];
    if (cur?.state === "active") {
      cur.state = "done";
      cur.elapsed = performance.now() - cur.t0;
    }
  };

  // Push immediately so the user sees the pending list before any work starts.
  push();

  return {
    // Advance to the next stage. Auto-closes the previous one.
    next() {
      if (t0 == null) t0 = performance.now();
      closeActive();
      idx++;
      const cur = stages[idx];
      if (cur) {
        cur.state = "active";
        cur.t0 = performance.now();
      }
      push();
    },
    // Live numbers for the active stage (called by callLM's 150ms interval).
    progress(p) {
      const cur = stages[idx];
      if (cur) {
        cur.tokens = p.tokens;
        cur.ttft = p.ttft;
        cur.elapsed = performance.now() - cur.t0;
      }
      push();
    },
    // Annotate the active stage with extra info (e.g. "6 regions").
    note(text) {
      const cur = stages[idx];
      if (cur) cur.note = text;
    },
    // Mark the active stage as failed and render the error.
    fail(err) {
      const cur = stages[idx];
      if (cur) {
        cur.state = "error";
        cur.elapsed = cur.t0 ? performance.now() - cur.t0 : null;
      }
      return push({ done: true, error: err });
    },
    // Close the last stage and render the final result + summary.
    finish(payload) {
      closeActive();
      const totalTokens = stages.reduce((n, s) => n + (s.tokens || 0), 0);
      return push({ done: true, totalTokens, ...payload });
    }
  };
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

  const ctx = { tabId: tab.id, frameId: info.frameId ?? 0 };
  const pipe = makePipeline(tab.id, STAGES[info.menuItemId] ?? ["Process"]);

  // onProgress is throttled inside callLM (150ms). onStage fires at transitions.
  const opts = {
    ctx,
    onProgress: pipe.progress,
    onStage: pipe.next,
    onNote: pipe.note
  };

  try {
    let result;

    if (info.menuItemId === "lm-translate-text" && info.selectionText) {
      pipe.next(); // → Translate
      result = await translateText(info.selectionText, opts);

    } else if (info.menuItemId === "lm-translate-element") {
      pipe.next(); // → Extract element
      let resp;
      try {
        resp = await chrome.tabs.sendMessage(
          tab.id,
          { cmd: "lmt:extractElement" },
          { frameId: ctx.frameId }
        );
      } catch {
        throw new Error(
          "Content script not loaded here. Try refreshing the page, " +
            "or this may be a restricted page (chrome://, PDF viewer, etc.)."
        );
      }
      if (!resp?.ok) throw new Error(resp?.error || "Could not read element.");
      pipe.note(`<${resp.tag}> ${resp.chars} chars`);

      pipe.next(); // → Translate
      result = await translateText(resp.text, opts);

    } else if (info.menuItemId === "lm-translate-image" && info.srcUrl) {
      // translateImage drives its own stages via onStage.
      result = await translateImage(info.srcUrl, opts);

    } else if (info.menuItemId === "lm-translate-image-overlay" && info.srcUrl) {
      // detectAndTranslate drives its own stages via onStage.
      const regions = await detectAndTranslate(info.srcUrl, opts);
      await injectBoxOverlay(tab.id, info.srcUrl, regions);
      await pipe.finish({ text: `${regions.length} region(s) — hover to read.` });
      return;

    } else {
      throw new Error("Nothing to translate.");
    }

    await pipe.finish({ text: result });
  } catch (err) {
    console.error("[LM Translate]", err);
    await pipe.fail(err.message || String(err));
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
  if (opts.responseFormat) body.response_format = opts.responseFormat;

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

  // Live progress: tracked here, pushed by interval. We approximate token
  // count by counting non-empty content deltas — accurate enough for a live
  // indicator; the real count lands in `usage` at stream end.
  const live = { tokens: 0, ttft: null };
  let progressTimer = null;
  if (opts.onProgress) {
    progressTimer = setInterval(() => {
      opts.onProgress({
        elapsed: performance.now() - t0,
        tokens: live.tokens,
        ttft: live.ttft,
        kind: stat.kind
      });
    }, 150);
  }

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

    const { content, ttft, usage, model } = await readSSE(res.body, t0, live);

    stat.ttft = ttft;
    stat.total = performance.now() - t0;
    stat.promptTokens = usage?.prompt_tokens ?? null;
    stat.completionTokens = usage?.completion_tokens ?? null;
    stat.model = model;
    stat.ok = true;

    // Final progress tick with the real usage count, so completed stages
    // show exact numbers instead of the delta-count approximation.
    if (opts.onProgress) {
      opts.onProgress({
        elapsed: stat.total,
        tokens: stat.completionTokens ?? live.tokens,
        ttft: stat.ttft,
        kind: stat.kind
      });
    }

    if (!content) throw new Error("Empty response from model.");
    return content.trim();
  } catch (err) {
    stat.total = performance.now() - t0;
    stat.error = err.message || String(err);
    throw err;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    recordStat(stat);
  }
}

// Parse an OpenAI-style SSE stream. Returns { content, ttft, usage, model }.
// `live` is an optional out-param mutated as chunks arrive (for progress UI).
async function readSSE(stream, t0, live) {
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
        if (ttft === null) {
          ttft = performance.now() - t0;
          if (live) live.ttft = ttft;
        }
        content += delta;
        if (live) live.tokens++;
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

async function translateText(text, opts = {}) {
  const cfg = await getSettings();
  const sys = cfg.systemPrompt.replace("{LANG}", cfg.targetLang);
  return callLM(
    [
      { role: "system", content: sys },
      { role: "user", content: text }
    ],
    { kind: "text", onProgress: opts.onProgress }
  );
}

async function translateImage(srcUrl, opts = {}) {
  const cfg = await getSettings();
  const sys = cfg.systemPrompt.replace("{LANG}", cfg.targetLang);

  opts.onStage?.(); // → Grab image
  const { dataUrl, method } = await grabImage(srcUrl, opts.ctx);
  opts.onNote?.(method);

  opts.onStage?.(); // → Translate
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
  ], { kind: "image", onProgress: opts.onProgress });
}

// ─── Grounded image translation (Gemma-style box_2d) ─────────────────────────

// JSON schema for the detection output. Compiled to a GBNF grammar by
// llama.cpp — the sampler masks tokens that would produce invalid JSON,
// so unescaped quotes in OCR'd labels become impossible by construction.
const DETECT_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "text_regions",
    strict: true,
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4
          },
          label: { type: "string" }
        },
        required: ["box_2d", "label"],
        additionalProperties: false
      }
    }
  }
};

async function detectAndTranslate(srcUrl, opts = {}) {
  const cfg = await getSettings();

  opts.onStage?.(); // → Grab image
  const { dataUrl, method } = await grabImage(srcUrl, opts.ctx);
  opts.onNote?.(method);

  opts.onStage?.(); // → Detect regions
  // Image-first when testing prefix cache so the image tokens sit at position 0.
  const detectContent = cfg.tryPrefixCache
    ? [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: cfg.detectPrompt }
      ]
    : [
        { type: "text", text: cfg.detectPrompt },
        { type: "image_url", image_url: { url: dataUrl } }
      ];
  const rawDetect = await callLM(
    [{ role: "user", content: detectContent }],
    {
      kind: "detect",
      onProgress: opts.onProgress,
      responseFormat: DETECT_SCHEMA
    }
  );

  const detected = extractJsonArray(rawDetect);
  if (!detected.length) throw new Error("Model found no text regions.");

  const labels = detected.map((d) => String(d.label ?? ""));

  opts.onStage?.(); // → Translate batch
  const translations = await translateBatch(labels, cfg, dataUrl, opts);

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

async function translateBatch(labels, cfg, dataUrl, opts = {}) {
  if (labels.length === 0) return [];

  const segText = labels.join(`\n${SEG}\n`);
  const baseInstr =
    `Translate each segment below into ${cfg.targetLang}. Segments are ` +
    `separated by the exact marker "${SEG}". Return ONLY the translations, ` +
    `separated by the same "${SEG}" marker, in the same order. Do not number, ` +
    `do not add commentary, do not merge segments.`;

  let messages, kind;

  if (cfg.tryPrefixCache && dataUrl) {
    // Prefix-cache experiment: no system message, image as the very first
    // content block. This call's prefix is now bit-identical to the detect
    // call's prefix (just the image tokens). If llama.cpp's prompt cache
    // survives between requests and recognizes the match, TTFT here should
    // drop to near the cost of encoding the text suffix alone.
    messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          {
            type: "text",
            text:
              baseInstr +
              ` The image above is the source these segments came from — ` +
              `use it for context.\n\n` +
              segText
          }
        ]
      }
    ];
    kind = "batch+pfx";
  } else if (cfg.imageInTranslatePass && dataUrl) {
    messages = [
      {
        role: "system",
        content:
          `You are a translation engine. ` +
          baseInstr +
          ` The source image is attached for visual context — use it to ` +
          `resolve ambiguity, but still output only the translated segments.`
      },
      {
        role: "user",
        content: [
          { type: "text", text: segText },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ];
    kind = "batch+img";
  } else {
    messages = [
      { role: "system", content: `You are a translation engine. ` + baseInstr },
      { role: "user", content: segText }
    ];
    kind = "batch";
  }

  const raw = await callLM(messages, { kind, onProgress: opts.onProgress });

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

// ─── Image acquisition chain ─────────────────────────────────────────────────
// 1. Canvas in content script — no network, immune to Referer/auth/anti-bot.
//    Fails on cross-origin images without CORS headers (tainted canvas).
// 2. fetch() in content script — page origin → Referer + cookies automatic.
//    Fails on CORS-blocking CDNs.
// 3. SW fetch — host permissions bypass CORS, but no Referer. credentials:
//    'include' covers auth-gated content; pure Referer-checkers still fail.
async function grabImage(srcUrl, ctx) {
  if (ctx?.tabId != null) {
    try {
      const resp = await chrome.tabs.sendMessage(
        ctx.tabId,
        { cmd: "lmt:grabImage", srcUrl },
        { frameId: ctx.frameId ?? 0 }
      );
      if (resp?.ok && resp.dataUrl) {
        return { dataUrl: resp.dataUrl, method: resp.method };
      }
      console.debug(`[LM Translate] page grab failed: ${resp?.error}`);
    } catch (e) {
      // Content script not present (restricted page) — fall through.
    }
  }

  const dataUrl = await swFetchImage(srcUrl);
  return { dataUrl, method: "sw-fetch" };
}

async function swFetchImage(url) {
  const res = await fetch(url, { credentials: "include" });
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

  body.innerHTML = "";
  body.style.color = "#e8e8e8";

  // ── Pipeline stepper ────────────────────────────────────────────────
  const pl = payload.pipeline;
  if (pl?.stages) {
    const fmt = (ms) =>
      ms == null ? "" : ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(2) + "s";

    const ICON = { pending: "○", active: "◐", done: "✓", error: "✕" };
    const COLOR = {
      pending: "#555",
      active: "#5af",
      done: "#6a9955",
      error: "#ff6b6b"
    };

    const list = document.createElement("div");
    list.style.cssText =
      "font:11px/1.6 ui-monospace,Consolas,monospace;margin-bottom:8px";

    for (const s of pl.stages) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;gap:8px;align-items:baseline;padding:1px 0";

      const ic = document.createElement("span");
      ic.textContent = ICON[s.state] || "○";
      ic.style.cssText = `color:${COLOR[s.state]};width:12px;flex:none`;

      const lbl = document.createElement("span");
      lbl.textContent = s.label + (s.note ? ` · ${s.note}` : "");
      lbl.style.cssText = `flex:1;color:${s.state === "pending" ? "#666" : "#ccc"}`;

      const stat = document.createElement("span");
      stat.style.cssText = `color:${COLOR[s.state]};text-align:right`;
      if (s.state === "active") {
        const el = fmt(s.elapsed);
        if (s.ttft == null) {
          stat.textContent = s.elapsed != null ? `${el} prefill…` : "…";
        } else {
          const gen = s.elapsed - s.ttft;
          const tps = gen > 0 ? (s.tokens / (gen / 1000)).toFixed(0) : "—";
          stat.textContent = `${el} · ${s.tokens}tok · ${tps}/s`;
        }
      } else if (s.state === "done") {
        const parts = [fmt(s.elapsed)];
        if (s.tokens) {
          const gen = s.ttft != null ? s.elapsed - s.ttft : s.elapsed;
          const tps = gen > 0 ? (s.tokens / (gen / 1000)).toFixed(0) : "—";
          parts.push(`${s.tokens}tok`, `${tps}/s`);
          if (s.ttft != null) parts.push(`TTFT ${fmt(s.ttft)}`);
        }
        stat.textContent = parts.join(" · ");
      } else if (s.state === "error") {
        stat.textContent = fmt(s.elapsed);
      }

      row.appendChild(ic);
      row.appendChild(lbl);
      row.appendChild(stat);
      list.appendChild(row);
    }
    body.appendChild(list);

    // Summary line
    const sum = document.createElement("div");
    sum.style.cssText =
      "font:11px ui-monospace,Consolas,monospace;color:#888;" +
      "border-top:1px solid #333;padding-top:6px;margin-bottom:8px";
    if (pl.done) {
      const tt = pl.totalTokens ? ` · ${pl.totalTokens} tok total` : "";
      sum.textContent = `Total ${fmt(pl.elapsed)}${tt}`;
    } else {
      sum.textContent = `${fmt(pl.elapsed)} elapsed`;
    }
    body.appendChild(sum);
  }

  // ── Result / error ──────────────────────────────────────────────────
  if (pl?.error) {
    const err = document.createElement("div");
    err.textContent = "Error: " + pl.error;
    err.style.color = "#ff6b6b";
    body.appendChild(err);
  } else if (pl?.text) {
    const out = document.createElement("div");
    out.textContent = pl.text;
    body.appendChild(out);
  }
}
