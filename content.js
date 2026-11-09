// LM Translate — content script
// Tracks the last right-clicked element so the background can ask for it
// when a context menu item fires.

// Hot-reload support: tear down any prior version of this script before
// installing fresh listeners. Content scripts from the same extension share
// an isolated world, so the teardown hook from a previous injection is visible
// here. This handles both the manifest/retro-inject race AND extension reloads
// during development (where the old boolean-guard pattern would block updates).
globalThis.__lmtTeardown?.();
{

let lastTarget = null;

const onContextMenu = (e) => {
  lastTarget = e.target;
};
// Capture phase — runs before page handlers can stopPropagation.
document.addEventListener("contextmenu", onContextMenu, true);

// ─── Element resolution ──────────────────────────────────────────────────────
// Common "post-like" containers across social sites. Editable via settings
// later if needed; for now this covers Twitter/X, Reddit, Mastodon, HN,
// Discourse, and generic <article>/<li> patterns.
const CONTAINER_SELECTOR = [
  "article",
  '[role="article"]',
  '[data-testid="tweet"]',
  '[data-testid="tweetText"]',
  ".tweet",
  ".comment",
  ".post",
  "shreddit-comment",
  "shreddit-post",
  "li"
].join(", ");

function resolveContainer(node) {
  if (!node) return null;
  // nodeType 3 = text node; climb to its element.
  if (node.nodeType === 3) node = node.parentElement;
  if (!(node instanceof Element)) return null;

  // Try known container patterns first.
  const known = node.closest(CONTAINER_SELECTOR);
  if (known && known !== document.body && known !== document.documentElement) {
    return known;
  }

  // Fallback: walk up until we find a block with non-trivial text.
  let el = node;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    const isBlock =
      style.display !== "inline" && style.display !== "inline-block";
    const text = el.innerText?.trim() ?? "";
    if (isBlock && text.length >= 40) return el;
    el = el.parentElement;
  }
  return node; // Last resort: return what was clicked.
}

// Strip obvious UI noise from extracted text. Crude but the LM tolerates
// leftovers — this just trims the most common junk.
function extractText(el) {
  // Clone so we can mutate without touching the live DOM.
  const clone = el.cloneNode(true);
  clone
    .querySelectorAll(
      "button, [role='button'], svg, time, [aria-hidden='true'], script, style"
    )
    .forEach((n) => n.remove());
  return (clone.innerText ?? "").trim();
}

// Brief visual feedback so the user knows which block we grabbed.
function flash(el) {
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "2px solid rgba(80, 170, 255, .9)";
  el.style.outlineOffset = "2px";
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, 600);
}

// ─── Image grabbing ──────────────────────────────────────────────────────────
// Pull pixels from the already-decoded <img> instead of refetching. Avoids
// Referer checks, auth gates, anti-bot, and a redundant network round-trip.

function findImage(srcUrl) {
  return [...document.images].find(
    (i) => i.src === srcUrl || i.currentSrc === srcUrl
  );
}

function canvasToJpeg(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  try {
    // JPEG @ 0.92 — near-lossless, far smaller than PNG for photos.
    // Vision models don't need alpha for OCR.
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    // SecurityError: cross-origin image without CORS headers tainted the canvas.
    return null;
  }
}

function tryCanvas(img) {
  // Image must be fully loaded with real dimensions.
  if (!img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  return canvasToJpeg(img);
}

// Re-issue the image load with crossOrigin="anonymous". If the server returns
// CORS headers (most public CDNs do, even when the page didn't ask), we get an
// untainted canvas. Browser HTTP cache usually serves the response without a
// real network round-trip. Returns null if the server refuses CORS or the
// load fails.
async function tryCanvasReload(srcUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.referrerPolicy = "no-referrer-when-downgrade";
  img.src = srcUrl;
  try {
    await img.decode();
  } catch {
    return null;
  }
  if (!img.naturalWidth || !img.naturalHeight) return null;
  return canvasToJpeg(img);
}

async function tryPageFetch(url) {
  // Runs with the page's origin → Referer + cookies are automatic.
  // CORS still applies; non-cooperating CDNs will reject this.
  try {
    const res = await fetch(url, { credentials: "include", mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function grabImageFromPage(srcUrl) {
  const pageOrigin = location.origin;
  const img = findImage(srcUrl);

  if (img) {
    const viaCanvas = tryCanvas(img);
    if (viaCanvas) {
      return { ok: true, dataUrl: viaCanvas, method: "canvas", pageOrigin };
    }
  }

  // Re-fetch with crossOrigin set. Often returns from HTTP cache when the
  // server supports CORS — no real round-trip, untainted canvas.
  const viaReload = await tryCanvasReload(srcUrl);
  if (viaReload) {
    return { ok: true, dataUrl: viaReload, method: "canvas-reload", pageOrigin };
  }

  const viaFetch = await tryPageFetch(srcUrl);
  if (viaFetch) {
    return { ok: true, dataUrl: viaFetch, method: "page-fetch", pageOrigin };
  }

  return {
    ok: false,
    pageOrigin,
    error: img
      ? "Canvas tainted, CORS reload refused, page fetch CORS-blocked."
      : "Image element not found in this frame."
  };
}

// ─── Preemptive CORS upgrade (opt-in) ────────────────────────────────────────
// Tag cross-origin <img> elements with crossOrigin="anonymous" *before* the
// browser sends the request, so the response carries Access-Control-Allow-*
// headers and the resulting canvas is not tainted. Cost: any server that
// doesn't return CORS headers will fail the upgraded load — we listen for
// 'error' and reload without crossOrigin to recover.
//
// Bandwidth impact: on a CORS-supporting server, the first (page-initiated)
// fetch is cancelled and replaced by our CORS fetch — net 1 request. On a
// non-CORS server we issue the CORS fetch (fails), then re-fetch without
// crossOrigin — net ~2 requests. That's why this is off by default.

let preemptiveCorsObserver = null;

function upgradeImg(img) {
  const src = img.getAttribute("src");
  if (!src) return;

  // We've already handled this exact src (or we set it ourselves below).
  if (img.dataset.lmtCorsSrc === src) return;

  // Author-set crossOrigin — leave their CORS contract intact.
  if (img.crossOrigin && !img.dataset.lmtCorsSrc) return;

  // Already-clean schemes — canvas works without CORS.
  if (/^(data|blob):/i.test(src)) return;

  // Same-origin doesn't need CORS at all.
  let url;
  try { url = new URL(src, location.href); } catch { return; }
  if (url.origin === location.origin) return;

  img.dataset.lmtCorsSrc = src;
  img.dataset.lmtCors = "pending";

  const cleanup = () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
  };
  const onLoad = () => {
    cleanup();
    if (img.dataset.lmtCors === "pending") img.dataset.lmtCors = "ok";
  };
  const onError = () => {
    cleanup();
    if (img.dataset.lmtCors !== "pending") return;
    img.dataset.lmtCors = "reverted";
    // Server refused CORS. Strip the attribute and re-fetch normally so the
    // page's image still shows. The MutationObserver will fire on the
    // attribute change but bail because lmtCorsSrc === src.
    img.removeAttribute("crossorigin");
    img.src = src;
  };

  img.addEventListener("load", onLoad);
  img.addEventListener("error", onError);

  img.crossOrigin = "anonymous";
  img.src = src; // Re-issue with CORS. Cancels the page's in-flight fetch.
}

function startPreemptiveCors() {
  if (preemptiveCorsObserver) return;

  for (const img of document.images) upgradeImg(img);

  preemptiveCorsObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IMG") {
            upgradeImg(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll("img").forEach(upgradeImg);
          }
        }
      } else if (
        m.type === "attributes" &&
        m.target.tagName === "IMG" &&
        m.attributeName === "src"
      ) {
        upgradeImg(m.target);
      }
    }
  });
  preemptiveCorsObserver.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });
}

chrome.storage.sync.get({ preemptiveCors: false }).then((cfg) => {
  if (cfg.preemptiveCors) startPreemptiveCors();
});

// React to live setting changes without forcing a page reload to start
// observing. (To *stop* still requires a reload, since we can't recover
// pages where we already double-fetched.)
const onStorageChange = (changes, area) => {
  if (area !== "sync" || !changes.preemptiveCors) return;
  if (changes.preemptiveCors.newValue && !preemptiveCorsObserver) {
    startPreemptiveCors();
  }
};
chrome.storage.onChanged.addListener(onStorageChange);

// ─── Message handler ─────────────────────────────────────────────────────────
const onMessage = (msg, _sender, sendResponse) => {
  if (msg?.cmd === "lmt:grabImage") {
    grabImageFromPage(msg.srcUrl).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (msg?.cmd !== "lmt:extractElement") return;

  const container = resolveContainer(lastTarget);
  if (!container) {
    sendResponse({ ok: false, error: "No element captured." });
    return;
  }

  const text = extractText(container);
  if (!text) {
    sendResponse({ ok: false, error: "Element has no readable text." });
    return;
  }

  flash(container);
  sendResponse({
    ok: true,
    text,
    tag: container.tagName.toLowerCase(),
    chars: text.length
  });
};
chrome.runtime.onMessage.addListener(onMessage);

// ─── e-hentai gallery pages: entry point for the translated reader ───────────
// Adds one link to the gallery's action list (next to "Archive Download"). The reader runs in an extension
// tab; nothing on this page changes otherwise.
let readerLink = null;
function addReaderLink() {
  if (location.origin !== "https://e-hentai.org" || !/^\/g\/\d+\/[0-9a-f]{10}\/?$/.test(location.pathname)) return;
  const list = document.getElementById("gd5");
  if (!list || readerLink?.isConnected) return;
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = "Translated reader (LM Translate)";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ cmd: "lmt:openReader", url: location.href }).catch(() => {});
  });
  readerLink = document.createElement("p");
  readerLink.className = "g2 gsp";
  readerLink.append(a);
  list.prepend(readerLink);
}
if (window === window.top) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addReaderLink, { once: true });
  else addReaderLink();
}

// Register teardown so the next injection can cleanly replace this one.
globalThis.__lmtTeardown = () => {
  readerLink?.remove();
  readerLink = null;
  document.removeEventListener("DOMContentLoaded", addReaderLink);
  document.removeEventListener("contextmenu", onContextMenu, true);
  chrome.runtime.onMessage.removeListener(onMessage);
  chrome.storage.onChanged.removeListener(onStorageChange);
  preemptiveCorsObserver?.disconnect();
  preemptiveCorsObserver = null;
};

console.debug("[LM Translate] content script loaded");

} // end block scope
