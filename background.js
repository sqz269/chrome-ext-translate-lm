// LM Translate — background service worker (MV3)

const DEFAULTS = {
  provider: "custom",
  endpoint: "http://127.0.0.1:8000/v1/chat/completions",
  model: "gemma-translation", // empty = let LM Studio pick the loaded model
  targetLang: "English",
  systemPrompt:
    "You are a translation engine. Translate the user's content into {LANG}. " +
    "Output ONLY the translation — no preamble, no notes, no quotes.",
  // Gemma-style grounding prompt. Expects [{box_2d:[ymin,xmin,ymax,xmax], label:"..."}]
  // with coords normalized to 0-1000.
  detectPrompt: "Locate and transcribe all visible text in this Japanese manga page. Return one region per complete speech bubble, caption block, title block, or sound effect. Keep all columns in the same speech bubble together in Japanese reading order (right to left). Do not split a bubble into individual columns or characters. Use tight rectangular bounds around the text, not the balloon border. Transcribe exactly; do not translate, complete obscured text, or invent characters. Return ONLY a JSON array of objects with box_2d: [ymin, xmin, ymax, xmax] in coordinates normalized to 0-1000, and label: the complete text for that region.",
  gemmaVllm: true,
  gemmaImageVerification: true,
  // If true, the batch-translate pass also receives the image so the model
  // can use visual context (e.g. "売" on a button vs a sign). Costs more
  // prompt tokens; quality gain depends on the model.
  imageInTranslatePass: false,
  // Experiment: structure both detect and batch calls as [image, text] with
  // no system prompt, so they share an identical image prefix. If llama.cpp
  // recognizes it, batch TTFT should collapse. Implies imageInTranslatePass.
  tryPrefixCache: false,
  // Preemptively tag cross-origin <img> tags with crossOrigin="anonymous" so
  // canvas extraction works without a fallback fetch. Doubles bandwidth on
  // sites whose image servers don't return CORS headers (the upgrade fails
  // and we have to reload without crossorigin). Off by default.
  preemptiveCors: false
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  if (stored.gemmaProfileVersion !== 2) {
    await chrome.storage.local.set({ beforeGemmaImageVerification512: stored });
    const profile = {
      endpoint: DEFAULTS.endpoint, model: DEFAULTS.model,
      detectPrompt: DEFAULTS.detectPrompt, gemmaVllm: true,
      tryPrefixCache: false, imageInTranslatePass: false,
      gemmaImageVerification: true, gemmaProfileVersion: 2
    };
    await chrome.storage.sync.set(profile);
    return { ...DEFAULTS, ...stored, ...profile };
  }
  return { ...DEFAULTS, ...stored };
}

// ─── Pipeline tracker ─────────────────────────────────────────────────────────
// Pre-declared stages per menu item so the overlay can show what's coming.
const STAGES = {
  "lm-translate-text": ["Translate"],
  "lm-translate-element": ["Extract element", "Translate"],
  "lm-translate-image": ["Grab image", "Detect regions", "Verify and translate"],
  "lm-translate-image-overlay": ["Grab image", "Detect regions", "Verify and translate"]
};

function makePipeline(tabId, labels) {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  let revision = 0;
  const stages = labels.map((label) => ({ label, state: "pending" }));
  let idx = -1;
  let t0 = null;

  const snapshot = (extra = {}) => ({
    id, startedAt, revision: ++revision,
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
    identity: { id, startedAt },
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
        cur.phase = p.phase;
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
  await getSettings();
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
  chrome.contextMenus.create({
    id: "lm-reader-page",
    title: "Open this gallery in the translated reader",
    contexts: ["page", "image"],
    documentUrlPatterns: ["https://e-hentai.org/g/*", "https://e-hentai.org/s/*"]
  });
  chrome.contextMenus.create({
    id: "lm-reader-link",
    title: "Open linked gallery in the translated reader",
    contexts: ["link"],
    documentUrlPatterns: ["https://e-hentai.org/*"],
    targetUrlPatterns: ["https://e-hentai.org/g/*", "https://e-hentai.org/s/*"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "lm-reader-page") return openReader(info.pageUrl, tab);
  if (info.menuItemId === "lm-reader-link") return openReader(info.linkUrl, tab);

  const ctx = { tabId: tab.id, frameId: info.frameId ?? 0 };
  let stages = STAGES[info.menuItemId] ?? ["Process"];
  if (info.menuItemId === "lm-translate-image") {
    const cfg = await getSettings();
    if (!usesImageVerification(cfg)) stages = ["Grab image", "Translate"];
  }
  const pipe = makePipeline(tab.id, stages);

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
      await injectBoxOverlay(tab.id, info.srcUrl, regions, ctx.frameId, pipe.identity);
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
// Presets that translate with a different model from the one that detects.
const TRANSLATE_MODEL = {
  vertexhybrid: 'gemini-3.8-flash-low',
  vertexargonflash: 'gemini-3.6-flash-minimal'
};

function usesImageVerification(cfg) {
  return !!((cfg.gemmaVllm || cfg.provider?.startsWith('vertex')) && cfg.gemmaImageVerification);
}

function describeConfig(cfg) {
  const detect = cfg.model || 'server default';
  const translate = usesImageVerification(cfg) ? (TRANSLATE_MODEL[cfg.provider] || detect) : detect;
  return {
    provider: cfg.provider, endpoint: cfg.endpoint, detect, translate,
    cloud: !!cfg.provider?.startsWith('vertex'), verify: usesImageVerification(cfg),
    targetLang: cfg.targetLang,
    label: detect === translate ? detect : `${detect} → ${translate}`
  };
}

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
  if (cfg.gemmaVllm) {
    const thinking = opts.kind === "detect" || opts.kind === "verify-image";
    body.chat_template_kwargs = { enable_thinking: thinking };
    body.thinking_token_budget = thinking ? 512 : 0;
    body.max_tokens = thinking ? 4096 : 2048;
    body.top_p = 1;
    body.top_k = -1;
    body.seed = 0;
    body.mm_processor_kwargs = { max_soft_tokens: 1120 };
  }
  if (cfg.model) body.model = cfg.model;
  if (TRANSLATE_MODEL[cfg.provider] && opts.kind !== 'detect') body.model = TRANSLATE_MODEL[cfg.provider];
  if (cfg.provider?.startsWith('vertex')) body.max_tokens = opts.kind === 'text' ? 2048 : 4096;
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
  const live = { tokens: 0, ttft: null, phase: "Waiting for model…" };
  let progressTimer = null;
  if (opts.onProgress) {
    progressTimer = setInterval(() => {
      opts.onProgress({
        elapsed: performance.now() - t0,
        tokens: live.tokens,
        ttft: live.ttft,
        kind: stat.kind,
        phase: live.phase
      });
    }, 150);
  }

  try {
    const headers = { "Content-Type": "application/json" };
    // A remote Vertex bridge requires its token; it is only ever sent with the Vertex presets.
    if (cfg.provider?.startsWith('vertex')) {
      const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
      if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Inference server HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const { content, ttft, usage, model, finishReason } = await readSSE(res.body, t0, live);

    stat.ttft = ttft;
    stat.total = performance.now() - t0;
    stat.promptTokens = usage?.prompt_tokens ?? null;
    stat.completionTokens = usage?.completion_tokens ?? null;
    stat.model = model;
    stat.reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? null;
    if (finishReason === 'length') throw new Error('The response reached its output limit. Try a smaller image or selection.');
    if (!content) throw new Error('The model returned no translation.');
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
    opts.onStat?.(stat);
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
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);

      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (payload === "[DONE]") continue;

      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }

      if (obj.model && !model) model = obj.model;
      if (obj.usage) usage = obj.usage;
      if (obj.error) throw new Error(obj.error.message || 'Inference stream failed.');
      if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason;

      const part = obj.choices?.[0]?.delta;
      const delta = part?.content;
      const thinking = part?.reasoning || part?.reasoning_content;
      if (delta || thinking) {
        if (ttft === null) ttft = performance.now() - t0;
        if (live) { live.ttft = ttft; live.phase = delta ? 'Writing answer…' : 'Thinking…'; }
      }
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

  return { content, ttft, usage, model, finishReason };
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
  if (usesImageVerification(cfg)) {
    const regions = await detectAndTranslate(srcUrl, opts);
    return regions.map(r => r.translated).join("\n\n");
  }
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
          label: { type: "string" },
          box_2d: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4
          }
        },
        required: ["label", "box_2d"],
        additionalProperties: false
      }
    }
  }
};

async function detectAndTranslate(srcUrl, opts = {}) {
  opts.onStage?.(); // → Grab image
  const { dataUrl, method } = await grabImage(srcUrl, opts.ctx);
  opts.onNote?.(method);
  return detectAndTranslateImage(dataUrl, opts);
}

// Errors worth retrying: provider capacity (429 / Resource exhausted / 503) and the bridge's upstream timeout.
// An unreachable server ("Failed to fetch") is not retried: the user has to start it.
const TRANSIENT_LM_ERROR = /HTTP 429|HTTP 50[234]|Resource exhausted|UNAVAILABLE|timed out/i;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled.')); }, { once: true });
  });
}

async function withTransientRetry(fn, opts) {
  let reconnected = false;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (opts.signal?.aborted) throw err;
      // One quick retry for a dropped local connection; a server that is really down fails again at once.
      if (!reconnected && /Failed to fetch|NetworkError/i.test(err.message || '')) {
        reconnected = true;
        attempt--;
        opts.onNote?.('Connection to the model server failed; retrying once');
        await abortableSleep(2000, opts.signal);
        continue;
      }
      if (attempt >= 3 || !TRANSIENT_LM_ERROR.test(err.message || '')) throw err;
      const wait = 15000 * (attempt + 1);
      opts.onNote?.(`Provider busy; retry ${attempt + 1} of 3 in ${wait / 1000} s`);
      await abortableSleep(wait, opts.signal);
    }
  }
}

// Detect, then verify and translate, for an image already encoded as a data URL.
// opts: onStage/onProgress/onNote/onStat (UI), signal (cancel), context (book hints, see contextBlock),
// retryTransient (retry capacity errors with backoff), allowEmpty (a page without text returns []).
async function detectAndTranslateImage(dataUrl, opts = {}) {
  const cfg = await getSettings();
  opts.onStage?.(); // → Detect regions
  const detected = await detectRegions(dataUrl, cfg, opts);
  if (!detected.length) {
    if (opts.allowEmpty) return [];
    throw new Error("Model found no text regions.");
  }
  opts.onStage?.(); // → Translate batch
  return translateDetected(detected, cfg, dataUrl, opts);
}

const retrying = (opts) => (opts.retryTransient ? (fn) => withTransientRetry(fn, opts) : (fn) => fn());

// Stage 1: text regions as [{label, box_2d}] (box in 0-1000 page coordinates).
async function detectRegions(dataUrl, cfg, opts = {}) {
  // Image-first when testing prefix cache so the image tokens sit at position 0.
  const detectContent = (cfg.gemmaVllm || cfg.provider?.startsWith('vertex') || cfg.tryPrefixCache)
    ? [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: cfg.detectPrompt }
      ]
    : [
        { type: "text", text: cfg.detectPrompt },
        { type: "image_url", image_url: { url: dataUrl } }
      ];
  const rawDetect = await retrying(opts)(() => callLM(
    [{ role: "user", content: detectContent }],
    {
      kind: "detect",
      onProgress: opts.onProgress,
      onStat: opts.onStat,
      signal: opts.signal,
      responseFormat: DETECT_SCHEMA
    }
  ));
  return extractJsonArray(rawDetect);
}

// Stage 2: verify the OCR against the image and translate, one result per detected region.
async function translateDetected(detected, cfg, dataUrl, opts = {}) {
  const attempt = retrying(opts);
  const labels = detected.map((d) => String(d.label ?? ""));
  if (usesImageVerification(cfg)) {
    let verified;
    try {
      verified = await attempt(() => verifyImageRegions(detected, cfg, dataUrl, opts));
    } catch (err) {
      // The validator rejected 2 of 125 pages at random in eval-v2; one retry recovered both.
      if (opts.signal?.aborted || !/Please retry the image/.test(err.message || '')) throw err;
      opts.onNote?.('Output failed validation; retrying once');
      verified = await attempt(() => verifyImageRegions(detected, cfg, dataUrl, opts));
    }
    return detected.map((d, i) => ({
      box: d.box_2d, original: labels[i],
      verifiedSource: verified[i].source, translated: verified[i].translation
    }));
  }
  const translations = await attempt(() => translateBatch(labels, cfg, dataUrl, opts));

  return detected.map((d, i) => ({
    box: d.box_2d, // [ymin, xmin, ymax, xmax] in 0-1000
    original: labels[i],
    translated: translations[i] ?? "(translation missing)"
  }));
}

// Book-level hints from the reader: title, tagged series and characters, and a user glossary. With no
// context the prompts are unchanged, so the eval harness (which calls verifyImageRegions without it)
// still measures the same text.
function contextBlock(context) {
  if (!context) return '';
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = [];
  if (context.title) lines.push(`Book title: ${clip(context.title, 300)}`);
  if (context.series?.length) lines.push(`Series: ${context.series.slice(0, 5).map(v => clip(v, 80)).join(', ')}`);
  if (context.characters?.length) lines.push(`Characters tagged on this book (romanized names): ${context.characters.slice(0, 30).map(v => clip(v, 60)).join(', ')}`);
  const glossary = (context.glossary || [])
    .map(g => [clip(g.source, 80), clip(g.target, 120)])
    .filter(([a, b]) => a && b).slice(0, 100);
  if (glossary.length) lines.push('Glossary (Japanese = preferred translation):\n' + glossary.map(([a, b]) => `${a} = ${b}`).join('\n'));
  let out = lines.length
    ? '\nBook context. Use it only to spell names and terms that appear in a region; never add names, people or text that a region does not contain.\n' + lines.join('\n')
    : '';
  // Text-only memory of earlier pages (context.previous: [{page, lines: [{source, translation}]}], oldest first).
  // Images of earlier pages are never resent. Trimmed from the oldest page to about 2,500 characters.
  const pages = (context.previous || []).slice(-4)
    .map(pg => ({ page: pg.page, body: (pg.lines || []).map(l => `${clip(l.source, 160)} → ${clip(l.translation, 240)}`).filter(s => s.length > 3).join('\n') }))
    .filter(pg => pg.body)
    .map(pg => `Page ${clip(pg.page, 10)}:\n${pg.body}`);
  let memory = pages.join('\n');
  while (memory.length > 2500 && pages.length > 1) { pages.shift(); memory = pages.join('\n'); }
  if (memory) {
    out += '\nEarlier pages of this book, already translated (Japanese → English). Use them only for continuity: keep names, terms, honorifics and each character\'s voice consistent, and work out who is speaking. Do not translate them again or copy their lines into these regions.\n' + memory.slice(-2500);
  }
  return out;
}

const VERIFY_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "checked_translations", strict: true,
    schema: {
      type: "object",
      properties: { regions: { type: "array", items: {
        type: "object",
        properties: { id: { type: "integer" }, source: { type: "string" }, translation: { type: "string" } },
        required: ["id", "source", "translation"], additionalProperties: false
      } } },
      required: ["regions"], additionalProperties: false
    }
  }
};

function validateVerifiedRegions(raw, count) {
  let regions;
  try { regions = JSON.parse(raw).regions; }
  catch { throw new Error("Image verification returned incomplete or invalid JSON. Please retry the image."); }
  if (!Array.isArray(regions) || regions.length !== count ||
      new Set(regions.map(r => r?.id)).size !== count ||
      regions.some(r => !r || !Number.isInteger(r.id) || r.id < 1 || r.id > count ||
        typeof r.source !== "string" || typeof r.translation !== "string" || !r.translation.trim())) {
    throw new Error("Image verification returned missing, duplicate, or invalid region IDs/translations. Please retry the image.");
  }
  return [...regions].sort((a, b) => a.id - b.id);
}

async function verifyImageRegions(detected, cfg, dataUrl, opts = {}) {
  const prompt = `Translate the supplied Japanese manga OCR regions into natural ${cfg.targetLang}. Return exactly one object per supplied id, preserving id, with source (your best supported Japanese reading) and translation. Preserve complete meaning, negation, questions, names, time span and speaker intent. Treat OCR as fallible. If an image is supplied, verify suspicious text against pixels and use visual context for sound effects, but do not invent obscured text or replace dialogue with scene descriptions. Without an image, do not guess new names or absent characters. Preserve uncertainty. Do not merge, omit or add region IDs. Coordinates are [ymin,xmin,ymax,xmax] in 0-1000. Return only the schema object.`;
  const raw = await callLM([{ role: "user", content: [
    { type: "image_url", image_url: { url: dataUrl } },
    { type: "text", text: prompt + contextBlock(opts.context) + "\nRegions: " + JSON.stringify(detected.map((r, i) => ({ id: i + 1, box_2d: r.box_2d, ocr: r.label }))) }
  ] }], { kind: "verify-image", responseFormat: VERIFY_SCHEMA, onProgress: opts.onProgress, onStat: opts.onStat, signal: opts.signal });
  return validateVerifiedRegions(raw, detected.length);
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
    `do not add commentary, do not merge segments.` + contextBlock(opts.context);

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

  const raw = await callLM(messages, { kind, onProgress: opts.onProgress, onStat: opts.onStat, signal: opts.signal });

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

async function injectBoxOverlay(tabId, srcUrl, regions, frameId = 0, job = {}) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: showOverlay,
    args: [{ image: { srcUrl, regions, job } }]
  });
}

// ─── Image acquisition chain ─────────────────────────────────────────────────
// 1. Canvas in content script — no network, immune to Referer/auth/anti-bot.
//    Fails on cross-origin images without CORS headers (tainted canvas).
// 2. Canvas-reload in content script — new Image() with crossOrigin=anonymous.
//    Hits HTTP cache when the server returns CORS headers (most CDNs do).
// 3. fetch() in content script — page origin → Referer + cookies automatic.
//    Fails on CORS-blocking CDNs.
// 4. SW fetch — host permissions bypass CORS, no built-in Referer. We use a
//    session-scoped declarativeNetRequest rule to spoof Referer with the
//    page's origin so Referer-checking CDNs see what they expect.
async function grabImage(srcUrl, ctx) {
  let pageOrigin = null;
  if (ctx?.tabId != null) {
    try {
      const resp = await chrome.tabs.sendMessage(
        ctx.tabId,
        { cmd: "lmt:grabImage", srcUrl },
        { frameId: ctx.frameId ?? 0 }
      );
      if (resp?.pageOrigin) pageOrigin = resp.pageOrigin;
      if (resp?.ok && resp.dataUrl) {
        return { dataUrl: resp.dataUrl, method: resp.method };
      }
      console.debug(`[LM Translate] page grab failed: ${resp?.error}`);
    } catch (e) {
      // Content script not present (restricted page) — fall through.
    }
  }

  // Last resort: SW fetch with synthetic Referer if we have a page origin.
  const dataUrl = await swFetchImage(srcUrl, { pageOrigin });
  return { dataUrl, method: pageOrigin ? "sw-fetch+referer" : "sw-fetch" };
}

// Generated rule IDs live in this range. Session rules don't survive a
// browser restart, but they do survive SW restarts within a session, so a
// crash mid-fetch could leak rules — bounded ID space keeps that contained.
const DNR_REFERER_RULE_MIN = 1_000_000;
const DNR_REFERER_RULE_MAX = 1_999_999;

function nextRefererRuleId() {
  // Random ID inside the reserved range. Collisions are astronomically
  // unlikely (1M IDs, a few concurrent grabs at most).
  const span = DNR_REFERER_RULE_MAX - DNR_REFERER_RULE_MIN + 1;
  return DNR_REFERER_RULE_MIN + Math.floor(Math.random() * span);
}

// Escape regex meta-chars so the literal URL can be used as a regexFilter.
// urlFilter's glob syntax mishandles literal '*' (wildcard) and '^' (separator)
// that can appear in URLs; regexFilter with anchors gives us a precise match.
function escapeRegex(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stripFragment(url) {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

async function withSpoofedReferer(url, pageOrigin, fn) {
  if (!pageOrigin) return fn();

  const ruleId = nextRefererRuleId();
  const pattern = "^" + escapeRegex(stripFragment(url)) + "$";
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: pageOrigin + "/" }
            ]
          },
          condition: {
            regexFilter: pattern,
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    });
  } catch (e) {
    console.warn("[LM Translate] failed to install Referer rule", e);
    return fn();
  }

  try {
    return await fn();
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId]
      });
    } catch (e) {
      console.warn("[LM Translate] failed to remove Referer rule", e);
    }
  }
}

async function swFetchImage(url, opts = {}) {
  return withSpoofedReferer(url, opts.pageOrigin, async () => {
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
  });
}

// SW restarts within a browser session leave our session rules orphaned. Wipe
// any stale Referer-spoof rules from the reserved ID range at startup so they
// don't pile up over time.
(async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const stale = rules
      .filter(
        (r) => r.id >= DNR_REFERER_RULE_MIN && r.id <= DNR_REFERER_RULE_MAX
      )
      .map((r) => r.id);
    if (stale.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: stale
      });
    }
  } catch (e) {
    console.warn("[LM Translate] could not clean stale DNR rules", e);
  }
})();

// ─── Batch reader (reader.html) ──────────────────────────────────────────────
// The reader is an extension page. It fetches e-hentai pages into its own memory and sends each page here as
// a data URL over a long-lived port; this worker runs the same detect → verify pipeline as the context menu.
const READER_SOURCE = /^https:\/\/e-hentai\.org\/(g\/\d+\/[0-9a-f]{10}|s\/[0-9a-f]{10}\/\d+-\d+)/;

function openReader(url, tab) {
  if (!url || !READER_SOURCE.test(url)) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL('reader.html') + '?url=' + encodeURIComponent(url),
    index: tab ? tab.index + 1 : undefined,
    openerTabId: tab?.id
  });
}

chrome.runtime.onMessage?.addListener((msg, sender) => {
  if (msg?.cmd === 'lmt:openReader' && sender.tab) openReader(msg.url, sender.tab);
});

// Regions the reader sends back for verify: what detectRegions returned for that page.
function validDetected(d) {
  return Array.isArray(d) && d.length > 0 && d.length <= 300 && d.every((r) => r && typeof r.label === 'string' && r.label.length <= 4000 &&
    Array.isArray(r.box_2d) && r.box_2d.length === 4 && r.box_2d.every(Number.isFinite));
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'lmt-reader') return;
  if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL('reader.html'))) {
    port.disconnect();
    return;
  }
  const jobs = new Map();
  const post = (msg) => { try { port.postMessage(msg); } catch { /* reader closed */ } };
  port.onDisconnect.addListener(() => {
    // Closing the reader stops paying for its pages.
    for (const job of jobs.values()) job.abort();
    jobs.clear();
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'ping') return; // keeps this worker alive during long provider calls and retry waits
    if (msg?.type === 'cancel') { jobs.get(msg.id)?.abort(); return; }
    if (msg?.type === 'config') { post({ id: msg.id, type: 'config', config: describeConfig(await getSettings()) }); return; }
    // translate = detect + verify in one request. detect and verify run the two stages separately, so the reader
    // can detect pages in parallel but translate them in page order with the previous pages as context.
    if (!['translate', 'detect', 'verify'].includes(msg?.type) || typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) return;
    if (msg.type === 'verify' && !validDetected(msg.detected)) { post({ id: msg.id, type: 'error', error: 'Invalid detected regions.' }); return; }
    const job = new AbortController();
    jobs.set(msg.id, job);
    const send = (m) => post({ id: msg.id, ...m });
    const stageNames = msg.type === 'verify' ? ['Translating'] : ['Detecting', 'Translating'];
    let stage = msg.type === 'translate' ? -1 : 0;
    if (msg.type !== 'translate') send({ type: 'stage', stage: stageNames[0] });
    const usage = { prompt: 0, completion: 0, calls: [] };
    const t0 = performance.now();
    try {
      const cfg = await getSettings();
      const config = describeConfig(cfg);
      const opts = {
        signal: job.signal,
        context: msg.context,
        retryTransient: true,
        allowEmpty: true,
        onStage: () => send({ type: 'stage', stage: stageNames[++stage] }),
        onProgress: (p) => send({ type: 'progress', stage: stageNames[stage], phase: p.phase, tokens: p.tokens, elapsed: p.elapsed }),
        onNote: (note) => send({ type: 'note', note }),
        onStat: (s) => {
          usage.prompt += s.promptTokens || 0;
          usage.completion += s.completionTokens || 0;
          usage.calls.push({ kind: s.kind, model: s.model, ms: Math.round(s.total || 0), ok: s.ok, prompt: s.promptTokens, completion: s.completionTokens });
        }
      };
      const ms = () => Math.round(performance.now() - t0);
      if (msg.type === 'detect') {
        const detected = await detectRegions(msg.dataUrl, cfg, opts);
        send({ type: 'result', detected, config, usage, ms: ms() });
      } else if (msg.type === 'verify') {
        const regions = await translateDetected(msg.detected, cfg, msg.dataUrl, opts);
        send({ type: 'result', regions, config, usage, ms: ms() });
      } else {
        const regions = await detectAndTranslateImage(msg.dataUrl, opts);
        send({ type: 'result', regions, config, usage, ms: ms() });
      }
    } catch (err) {
      send({ type: 'error', error: job.signal.aborted ? 'Cancelled.' : (err.message || String(err)), usage });
    } finally {
      jobs.delete(msg.id);
    }
  });
});

// ─── Overlay injection ────────────────────────────────────────────────────────
async function injectOverlay(tabId, payload) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: showOverlay,
    args: [payload]
  });
}

// Self-contained because Chrome serializes this function into the page.
function showOverlay(payload) {
  const KEY = '__lmTranslateUI4';
  let ui = globalThis[KEY];
  if (!ui || !ui.host.isConnected) {
    ui?.destroy();
    document.getElementById('__lm_translate_overlay__')?.remove();
    document.querySelectorAll('[data-lmt-overlay-for]').forEach(n => n.remove());
    const host = document.createElement('div');
    host.id = '__lm_translate_overlay__';
    const reset = { all: 'initial', position: 'fixed', inset: '0', width: 'auto', direction: 'ltr', height: '100dvh', margin: '0', padding: '0', border: '0', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647', transform: 'none', opacity: '1', visibility: 'visible', display: 'block', 'color-scheme': 'dark' };
    for (const [k,v] of Object.entries(reset)) host.style.setProperty(k,v,'important');
    const root = host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial;color-scheme:dark}*{box-sizing:border-box} [hidden]{display:none!important}
      .ui{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#edf2fa;letter-spacing:normal;text-align:left;direction:ltr;text-transform:none;text-shadow:none;word-spacing:normal;white-space:normal}
      button{appearance:none;font:600 12px/1.3 system-ui;color:#edf2fa;background:#27364b;border:1px solid #486079;border-radius:7px;min-height:34px;padding:7px 11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
      button:hover{background:#364b66}button:focus-visible,summary:focus-visible{outline:3px solid #8bc8ff;outline-offset:2px}button:disabled{opacity:.5;cursor:default}
      .panel{position:fixed;right:12px;top:12px;width:min(440px,calc(100% - 24px));max-height:calc(100dvh - 84px);display:flex;flex-direction:column;pointer-events:auto;background:#172131;border:1px solid #486079;border-radius:12px;box-shadow:0 12px 48px #0008;overflow:hidden}
      header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#202e41;flex-shrink:0}strong{font-weight:650}header strong{flex:1;min-width:0}.body{padding:14px;overflow:auto;overscroll-behavior:contain;min-height:0}.panel.mini .body{display:none}
      .muted{font-size:12px;color:#b5c4d7}.result{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;margin:10px 0}.error{color:#ffb8b8}.steps{display:grid;gap:7px;margin-bottom:12px}.step{display:flex;gap:8px;justify-content:space-between;font-size:12px}.active{color:#87c8ff}.pending{color:#9aaac0}.done{color:#a4dfb2}
      .toolbar{position:fixed;bottom:12px;left:12px;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 24px);padding:8px;background:#172131;border:1px solid #486079;border-radius:10px;pointer-events:auto;box-shadow:0 4px 20px #0006;flex-wrap:wrap}
      .layer{position:fixed;pointer-events:none;overflow:hidden}.region{position:absolute;min-height:0;padding:0;border:2px solid #69b5ff;background:#58aaff22;border-radius:3px;pointer-events:auto;cursor:pointer;overflow:hidden}.region:hover,.region:focus-visible{background:#58aaff55}.number{position:absolute;top:0;left:0;font:11px/15px system-ui;background:#173d65;color:white;padding:0 3px}
      .tip{position:fixed;max-width:min(340px,calc(100vw - 20px));max-height:45vh;overflow:hidden;pointer-events:none;background:#142136;color:white;border:1px solid #75b9f1;border-radius:8px;padding:10px;box-shadow:0 5px 25px #0007;white-space:pre-wrap;overflow-wrap:anywhere}
      details{margin:8px 0;color:#b5c4d7;font-size:12px}summary{cursor:pointer}hr{border:0;border-top:1px solid #3a4b61;margin:14px 0}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
    `;
    root.append(style);
    const make = (tag, cls, text, parent) => {const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;parent?.append(n);return n;};
    const panel=make('section','ui panel',null,root);panel.setAttribute('role','region');panel.setAttribute('aria-label','LM Translate');panel.hidden=true;
    const header=make('header','',null,panel);make('strong','','LM Translate',header);
    const copy=make('button','','Copy',header);copy.type='button';copy.disabled=true;
    const minimize=make('button','','−',header);minimize.type='button';minimize.setAttribute('aria-label','Minimize translation');
    const close=make('button','','×',header);close.type='button';close.setAttribute('aria-label','Close translation');close.title='Close translation (Esc). Inference continues in the background.';
    const body=make('div','body',null,panel);
    const layers=make('div','',null,root);
    const tip=make('div','ui tip',null,root);tip.hidden=true;tip.setAttribute('role','tooltip');
    const toolbar=make('div','ui toolbar',null,root);toolbar.hidden=true;
    const count=make('span','muted','',toolbar);
    const all=make('button','','All translations',toolbar);all.type='button';
    const hide=make('button','','Hide boxes',toolbar);hide.type='button';
    const clear=make('button','','Close boxes',toolbar);clear.type='button';
    const abort=new AbortController();
    ui={host,root,panel,body,tip,toolbar,layers,groups:new Map(),dismissed:new Set(),revisions:new Map(),job:null,text:'',hiddenBoxes:false};
    globalThis[KEY]=ui;
    const fmt=ms=>ms==null?'':(ms/1000).toFixed(1)+' s';
    const entries=()=>[...ui.groups.values()].flatMap(g=>g.regions);
    ui.dismiss=()=>{if(ui.job){ui.dismissed.add(ui.job);if(ui.dismissed.size>100)ui.dismissed.delete(ui.dismissed.values().next().value);}panel.hidden=true;tip.hidden=true;};
    close.onclick=ui.dismiss;
    minimize.onclick=()=>{const mini=panel.classList.toggle('mini');minimize.textContent=mini?'+':'−';minimize.setAttribute('aria-label',mini?'Expand translation':'Minimize translation');};
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(ui.text);copy.textContent='Copied';}catch{copy.textContent='Select text to copy';}setTimeout(()=>{if(copy.isConnected)copy.textContent='Copy';},1800);};
    const openText=(regions)=>{panel.hidden=false;panel.classList.remove('mini');minimize.textContent='−';minimize.setAttribute('aria-label','Minimize translation');body.replaceChildren();ui.text=regions.map(r=>r.translated).join('\n\n');copy.disabled=!ui.text;
      make('div','muted',`${regions.length} translation${regions.length===1?'':'s'} · Select or copy the text below`,body);
      regions.forEach((r,i)=>{if(i)make('hr','',null,body);make('div','result',r.translated,body);const d=make('details','',null,body);make('summary','','Original / checked reading',d);make('div','result',r.original,d);if(r.verifiedSource&&r.verifiedSource!==r.original){make('div','muted','Model-checked reading (may contain mistakes)',d);make('div','result',r.verifiedSource,d);}});
    };
    all.onclick=()=>openText(entries());
    hide.onclick=()=>{ui.hiddenBoxes=!ui.hiddenBoxes;layers.hidden=ui.hiddenBoxes;hide.textContent=ui.hiddenBoxes?'Show boxes':'Hide boxes';tip.hidden=true;};
    ui.clearBoxes=()=>{ui.groups.clear();layers.replaceChildren();layers.hidden=false;ui.hiddenBoxes=false;hide.textContent='Hide boxes';toolbar.hidden=true;tip.hidden=true;};
    clear.onclick=ui.clearBoxes;
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!panel.hidden)ui.dismiss();else ui.clearBoxes();}}, {signal:abort.signal});
    document.addEventListener('lmt-dismiss',e=>{if(e.detail==='boxes')ui.clearBoxes();else ui.dismiss();},{signal:abort.signal});
    let timer;
    const anchor=()=>{for(const [src,g] of ui.groups){if(!g.img.isConnected){g.layer.remove();ui.groups.delete(src);continue;}const r=g.img.getBoundingClientRect();Object.assign(g.layer.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});}toolbar.hidden=!ui.groups.size;count.textContent=`${entries().length} regions`;};
    document.addEventListener('scroll',()=>{anchor();tip.hidden=true;},{capture:true,passive:true,signal:abort.signal});
    window.addEventListener('resize',anchor,{passive:true,signal:abort.signal});
    // Catch layout shifts and animated reader resizing, without a permanent frame loop.
    timer=setInterval(()=>{if(ui.groups.size)anchor();},250);
    ui.destroy=()=>{clearInterval(timer);abort.abort();host.remove();};
    ui.showImage=({srcUrl,regions,job={}})=>{
      if(ui.dismissed.has(job.id)||(job.startedAt!=null&&job.startedAt<(ui.latestStarted??0)))return;
      const img=[...document.images].find(i=>i.src===srcUrl||i.currentSrc===srcUrl);
      if(!img)throw new Error('The translated image is no longer on this page. Try again on the visible image.');
      ui.groups.get(srcUrl)?.layer.remove();
      const layer=make('div','layer',null,layers);
      const valid=regions.filter(r=>Array.isArray(r.box)&&r.box.length===4&&r.box.every(Number.isFinite)&&r.box[2]>r.box[0]&&r.box[3]>r.box[1]);
      ui.groups.set(srcUrl,{img,layer,regions:valid});
      if(ui.groups.size>8){const [key,g]=ui.groups.entries().next().value;g.layer.remove();ui.groups.delete(key);}
      const positionTip=(x,y)=>{const b=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(x+14,innerWidth-b.width-8))+'px';tip.style.top=Math.max(8,Math.min(y+14,innerHeight-b.height-8))+'px';};
      valid.forEach((r,i)=>{const b=r.box.map(v=>Math.max(0,Math.min(1000,v)));const button=make('button','region',null,layer);button.type='button';button.setAttribute('aria-label',`Region ${i+1}: ${r.translated}`);Object.assign(button.style,{top:b[0]/10+'%',left:b[1]/10+'%',height:(b[2]-b[0])/10+'%',width:(b[3]-b[1])/10+'%'});make('span','number',String(i+1),button);
        const preview=(x,y)=>{tip.textContent=r.translated+'\n\nClick to read, select or copy';tip.hidden=false;positionTip(x,y);};
        button.onmouseenter=e=>preview(e.clientX,e.clientY);button.onmousemove=e=>positionTip(e.clientX,e.clientY);button.onmouseleave=()=>tip.hidden=true;button.onfocus=()=>{const b=button.getBoundingClientRect();preview(b.left,b.bottom);};button.onblur=()=>tip.hidden=true;button.onclick=e=>{e.preventDefault();e.stopPropagation();tip.hidden=true;openText([r]);};
      });anchor();
    };
    ui.update=pl=>{
      if((pl.startedAt??0)<(ui.latestStarted??0))return;
      ui.latestStarted=pl.startedAt??0;
      const id=pl.id||'legacy';if(ui.dismissed.has(id))return;
      if(pl.revision!=null&&pl.revision<=(ui.revisions.get(id)??-1))return;
      ui.revisions.set(id,pl.revision??0);if(ui.revisions.size>100)ui.revisions.delete(ui.revisions.keys().next().value);
      if(ui.job!==id){panel.classList.remove('mini');minimize.textContent='−';minimize.setAttribute('aria-label','Minimize translation');}
      ui.job=id;panel.hidden=false;
      const savedScroll=body.scrollTop;body.replaceChildren();
      const steps=make('div','steps',null,body);
      for(const s of pl.stages||[]){const row=make('div',`step ${s.state}`,null,steps);make('span','',`${({done:'✓',active:'◐',error:'×',pending:'○'})[s.state]||'○'} ${s.label}`,row);make('span','',`${fmt(s.elapsed)}${s.state==='active'?' · '+(s.phase||'Working…'):''}`,row);if(s.note)row.title=s.note;}
      make('div','muted',`${pl.done?'Finished':'Elapsed'} ${fmt(pl.elapsed)}${pl.totalTokens?' · '+pl.totalTokens+' output tokens (including thinking)':''}`,body);
      if(pl.error){make('div','result error',pl.error,body);make('div','muted','Try again from the page’s context menu. Check the local server if the connection failed.',body);}
      if(pl.text)make('div','result',pl.text,body);
      ui.text=pl.text||'';copy.disabled=!ui.text;body.scrollTop=savedScroll;
    };
    document.documentElement.append(host);
    // Top layer avoids site stacking contexts and transformed ancestors.
    try{host.popover='manual';host.showPopover();}catch{/* Fixed-position fallback for older browsers. */}
  }
  if(payload.image)ui.showImage(payload.image);
  else if(payload.pipeline)ui.update(payload.pipeline);
}
