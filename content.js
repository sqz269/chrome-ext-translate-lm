// LM Translate — content script
// Tracks the last right-clicked element so the background can ask for it
// when a context menu item fires.

// Guard against double-injection (manifest auto-inject + onInstalled retro-inject
// can both fire on the same page). Content scripts from the same extension share
// an isolated world, so this flag is visible across injections.
if (!globalThis.__lmtContentLoaded) {
globalThis.__lmtContentLoaded = true;

let lastTarget = null;

document.addEventListener(
  "contextmenu",
  (e) => {
    lastTarget = e.target;
  },
  true // capture phase — runs before page handlers can stopPropagation
);

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

function tryCanvas(img) {
  // Image must be fully loaded with real dimensions.
  if (!img.complete || !img.naturalWidth || !img.naturalHeight) return null;

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
  const img = findImage(srcUrl);

  if (img) {
    const viaCanvas = tryCanvas(img);
    if (viaCanvas) return { ok: true, dataUrl: viaCanvas, method: "canvas" };
  }

  const viaFetch = await tryPageFetch(srcUrl);
  if (viaFetch) return { ok: true, dataUrl: viaFetch, method: "page-fetch" };

  return {
    ok: false,
    error: img
      ? "Canvas tainted (cross-origin) and page fetch CORS-blocked."
      : "Image element not found in this frame."
  };
}

// ─── Message handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
});

} // end double-injection guard
