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

// ─── Message handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
