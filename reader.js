// LM Translate — batch reader for e-hentai galleries.
//
// Images: each page is fetched into this tab's memory (a Blob shown through a blob: URL), re-encoded as
// JPEG q0.92 like the context-menu capture, and sent to the background worker, which forwards it only to
// the configured model endpoint. Nothing writes image data to disk or extension storage, and it is gone
// when the tab closes.
// Text: translations, the series glossary and per-region feedback are kept in this extension's IndexedDB.
'use strict';

const READER_PROTOCOL = 3;      // must match background.js; see the comment there
const SITE_GAP_MS = 3000;          // minimum spacing between e-hentai HTML requests (one reader at human pace)
const LISTING_GAP_MS = 1500;       // gallery listing pages, fetched once when the reader opens
// Third-party reports of Google's list prices per 1M input/output tokens (intro), unverified with Google.
const PRICES = { 'gemini-3.6-flash': [0.75, 3.75], 'gemini-3.8-flash': [0.75, 3.75], 'gemini-4-argon': [2, 10] };

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});
const isAbort = (e) => e?.name === 'AbortError' || /^Cancelled/.test(e?.message || '');
const titleCase = (s) => s.replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const regionCount = (n) => n ? `${n} region${n === 1 ? '' : 's'}` : 'No text found';
const fmtS = (ms) => ms == null ? '' : `${(ms / 1000).toFixed(1)} s`;

class SiteStop extends Error {}  // the site asked us to stop (quota, ban, rate limit): halt the whole run

// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  source: null,
  gid: 0, token: '', galleryUrl: '',
  meta: null,
  pages: [],            // PageState, index n-1
  config: null,
  mode: 'typeset',
  sfxMode: 'label',     // how Text mode shows sound effects: label | outline | hide
  script: false,
  glossary: { scope: '', text: '', useTags: true },
  feedback: new Map(),  // "n/i" → feedback record
  run: null,
  usage: { prompt: 0, completion: 0, cost: 0, priced: true },
  inspector: null
};
try {
  S.mode = localStorage.getItem('lmt-reader-mode') || 'typeset';
  S.script = localStorage.getItem('lmt-reader-script') === '1';
  S.sfxMode = localStorage.getItem('lmt-reader-sfx') || 'label';
  const w = localStorage.getItem('lmt-reader-width');
  if (w) $('width').value = w;
} catch { /* storage unavailable: defaults */ }

// ─── IndexedDB (text only) ───────────────────────────────────────────────────
let dbPromise;
function db() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('lmt-reader', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('pages', { keyPath: 'key' });       // `${gid}/${n}` → regions, config, ptoken
      d.createObjectStore('books', { keyPath: 'gid' });
      d.createObjectStore('glossaries', { keyPath: 'scope' }); // "parody:<name>" or "gallery:<gid>"
      d.createObjectStore('feedback', { keyPath: 'key' });     // `${gid}/${n}/${i}`
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const dbGet = (store, key) => idb(store, 'readonly', (o) => o.get(key));
const dbPut = (store, value) => idb(store, 'readwrite', (o) => o.put(value));
const dbPrefix = (store, prefix) => idb(store, 'readonly', (o) => o.getAll(IDBKeyRange.bound(prefix, prefix + '￿')));

// ─── Background port ─────────────────────────────────────────────────────────
let port = null;
let seq = 0;
const pending = new Map();
function bgPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'lmt-reader' });
  port.onMessage.addListener((m) => pending.get(m.id)?.(m));
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [id, handler] of pending) handler({ id, type: 'error', error: 'Lost the connection to the extension. Reload this tab.' });
    pending.clear();
  });
  return port;
}
// Long provider calls and retry waits can be quiet for a while; a ping keeps the background worker alive.
setInterval(() => { if (pending.size) try { bgPort().postMessage({ type: 'ping' }); } catch { /* reconnects on next call */ } }, 10000);

function bgRequest(msg, onEvent, signal) {
  return new Promise((resolve, reject) => {
    const id = `r${++seq}`;
    const p = bgPort();
    let heard = false;
    const finish = (fn, value) => { clearTimeout(watchdog); pending.delete(id); signal?.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => {
      try { p.postMessage({ type: 'cancel', id }); } catch { /* port gone */ }
      finish(reject, new DOMException('Cancelled', 'AbortError'));
    };
    // The background acknowledges every request immediately; silence means it is stale or broken.
    const watchdog = setTimeout(() => {
      if (heard) return;
      try { p.postMessage({ type: 'cancel', id }); } catch { /* port gone */ }
      finish(reject, new Error(STALE_MESSAGE));
    }, 20000);
    pending.set(id, (m) => {
      heard = true;
      if (m.type === 'result' || m.type === 'config') finish(resolve, m);
      else if (m.type === 'error') finish(reject, Object.assign(new Error(m.error), { usage: m.usage }));
      else onEvent?.(m);
    });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.postMessage({ ...msg, id });
  });
}

const STALE_MESSAGE = 'The extension’s background script is out of date with this page. Chrome keeps running the old one until the extension is reloaded: open chrome://extensions, press Reload on LM Translate, then reload this tab.';

async function loadConfig() {
  const { config } = await bgRequest({ type: 'config' });
  S.config = config;
  S.stale = config.protocol !== READER_PROTOCOL;
  if (S.stale) { alertBox(STALE_MESSAGE, true); $('start').disabled = true; }
  $('model').textContent = `Model: ${config.label}`;
  const notes = [];
  if (config.cloud) notes.push('Paid Google Vertex via the local bridge; pages are sent to Google.');
  else notes.push(`Endpoint: ${config.endpoint}`);
  if (!config.verify) notes.push('Image verification is off, so translation uses the older text-only pass.');
  $('model-note').textContent = notes.join(' ');
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync') loadConfig().catch(() => {}); });

// ─── Site access (paced, same-origin cookies) ────────────────────────────────
let siteChain = Promise.resolve();
let lastSite = 0;
function siteHtml(url, signal, gap = SITE_GAP_MS) {
  // Serialized: concurrent callers queue so requests stay `gap` apart.
  const run = siteChain.then(async () => {
    const wait = lastSite + gap - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastSite = Date.now();
    const res = await fetch(url, { credentials: 'include', signal });
    if ([403, 429, 503, 509].includes(res.status)) throw new SiteStop(`e-hentai returned HTTP ${res.status}. Stopped to respect the site's limits; try again later.`);
    if (!res.ok) throw new Error(`e-hentai returned HTTP ${res.status} for ${url}`);
    const html = await res.text();
    if (EH.isBanPage(html)) throw new SiteStop('e-hentai reports a temporary ban for excessive page loads. Stopped; wait before trying again.');
    return new DOMParser().parseFromString(html, 'text/html');
  });
  siteChain = run.catch(() => {});
  return run;
}

async function fetchImage(src, signal) {
  const res = await fetch(src, { credentials: 'omit', signal });
  if (!res.ok) throw new Error(`Image server returned HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size < 1024 || !/^image\//.test(blob.type || 'image/')) throw new Error('Image server returned something other than an image.');
  return blob;
}

// Match the extension's canvas capture (content.js): JPEG at quality 0.92, natural size.
async function toJpegDataUrl(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';  // transparent PNGs would otherwise turn black
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.92);
}

// ─── Opening a gallery ───────────────────────────────────────────────────────
async function open() {
  const url = new URLSearchParams(location.search).get('url') || '';
  S.source = EH.parseSource(url);
  if (!S.source) throw new Error('Open the reader from an e-hentai gallery or page (right-click → “Open this gallery in the translated reader”).');

  await loadConfig().catch((e) => { $('model').textContent = 'Model: unavailable'; $('model-note').textContent = e.message; });

  let galleryUrl = S.source.galleryUrl;
  if (S.source.kind === 'viewer') {
    status('Finding the gallery for this page…');
    galleryUrl = EH.parseViewer(await siteHtml(S.source.viewerUrl, null, LISTING_GAP_MS)).galleryUrl;
    if (!galleryUrl) throw new Error('Could not find the gallery link on this page.');
  }
  const g = EH.parseSource(galleryUrl);
  Object.assign(S, { gid: g.gid, token: g.token, galleryUrl: g.galleryUrl });

  status('Reading gallery…');
  const first = EH.parseGallery(await siteHtml(S.galleryUrl, null, LISTING_GAP_MS), S.gid);
  if (first.contentWarning) throw new Error('This gallery shows a content warning. Open it in a normal tab, choose “View Gallery”, then open the reader again.');
  if (!first.hasThumbs) throw new Error('Could not read this gallery page. The site layout may have changed, or the gallery is unavailable.');
  const entries = new Map(first.entries.map((e) => [e.n, e]));
  for (let p = 1; p <= first.lastListing; p++) {
    status(`Reading gallery… page list ${p + 1} of ${first.lastListing + 1}`);
    const more = EH.parseGallery(await siteHtml(`${S.galleryUrl}?p=${p}`, null, LISTING_GAP_MS), S.gid);
    for (const e of more.entries) entries.set(e.n, e);
  }
  S.meta = { ...first, entries: undefined };
  const count = Math.max(first.pageCount, ...entries.keys());

  showBook();
  await loadSaved();

  S.pages = [];
  const main = $('pages');
  main.replaceChildren();
  for (let n = 1; n <= count; n++) {
    const p = makePage(n, entries.get(n));
    S.pages.push(p);
    main.append(p.el.root);
  }
  const cached = await dbPrefix('pages', `${S.gid}/`);
  for (const rec of cached) {
    const p = S.pages[rec.n - 1];
    if (!p || (p.entry && rec.ptoken !== p.entry.ptoken)) continue;  // gallery changed since: ignore
    p.regions = rec.regions;
    p.saved = rec;
    setState(p, 'done', regionCount(rec.regions.length) + ' · translated earlier');
  }
  await loadFeedback();
  for (const p of S.pages) { io.observe(p.el.root); if (p.regions) renderScript(p); }
  const missing = S.pages.filter((p) => !p.entry).length;
  if (missing) alertBox(`${missing} page(s) could not be listed and will be skipped.`);

  $('from').max = $('to').max = count;
  $('from').value = Math.min(S.source.page || 1, count);
  $('to').value = count;
  $('start').disabled = !!S.stale;
  $('export').disabled = false;
  refreshStatus();
  dbPut('books', { gid: S.gid, token: S.token, url: S.galleryUrl, title: S.meta.title, titleJp: S.meta.titleJp, tags: S.meta.tags, pageCount: count, opened: Date.now() }).catch(() => {});
  if (S.source.page > 1) S.pages[S.source.page - 1]?.el.root.scrollIntoView();
}

function showBook() {
  const m = S.meta;
  document.title = `${m.title || m.titleJp} · LM Translate reader`;
  $('title').textContent = m.title || m.titleJp || `Gallery ${S.gid}`;
  $('title-jp').textContent = m.titleJp && m.titleJp !== m.title ? m.titleJp : '';
  const series = m.tags.filter((t) => t.startsWith('parody:')).map((t) => t.slice(7));
  const lang = m.tags.filter((t) => t.startsWith('language:')).map((t) => t.slice(9));
  $('meta').textContent = [`${m.pageCount} pages`, m.category, series.join(', '), lang.join(', ')].filter(Boolean).join(' · ');
  if (lang.includes('translated') || (lang.length && !lang.includes('japanese'))) {
    alertBox(`This gallery is tagged ${lang.join(', ')}; it may not be Japanese, or may already be translated.`);
  }
}

// Glossary scope: shared by every gallery of the same series (parody tag), so names stay consistent across books.
function glossaryScope() {
  const parody = S.meta.tags.find((t) => t.startsWith('parody:') && t !== 'parody:original');
  return parody ? parody.replace(/ /g, '_') : `gallery:${S.gid}`;
}

async function loadSaved() {
  const scope = glossaryScope();
  const g = await dbGet('glossaries', scope).catch(() => null);
  S.glossary = { scope, text: g?.text || '', useTags: g?.useTags ?? true };
}

// Feedback is tied to one translation of a page (its timestamp), so retranslating starts clean; old records stay.
async function loadFeedback() {
  for (const fb of await dbPrefix('feedback', `${S.gid}/`).catch(() => [])) {
    if (S.pages[fb.n - 1]?.saved?.ts === fb.pageTs) S.feedback.set(`${fb.n}/${fb.i}`, fb);
  }
}

function parseGlossary(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(.+?)\s*(?:=|＝|→|->|\t|:|：)\s*(.+)$/.exec(line.trim());
    if (m) out.push({ source: m[1].trim(), target: m[2].trim() });
  }
  return out;
}

function bookContext() {
  const tags = S.glossary.useTags ? S.meta.tags : [];
  const ctx = {
    glossary: parseGlossary(S.glossary.text),
    characters: tags.filter((t) => t.startsWith('character:')).map((t) => titleCase(t.slice(10))),
    series: tags.filter((t) => t.startsWith('parody:') && t !== 'parody:original').map((t) => titleCase(t.slice(7)))
  };
  if (S.glossary.useTags) ctx.title = S.meta.titleJp || S.meta.title;
  return ctx;
}

// ─── Page cards ──────────────────────────────────────────────────────────────
function makePage(n, entry) {
  const p = { n, entry, blob: null, imgUrl: null, aspect: null, regions: null, saved: null, state: 'idle', fitWidth: 0 };
  const state = h('span', { class: 'state', text: entry ? 'Not loaded' : 'Not listed' });
  const timing = h('span', { class: 'muted small' });
  const redo = h('button', { type: 'button', text: 'Translate', disabled: !entry, title: 'Load and translate only this page', onclick: () => single(p) });
  const frame = h('div', { class: 'frame' });
  const layer = h('div', { class: 'layer' });
  const script = h('ol', { class: 'script', hidden: true });
  const root = h('section', { class: 'page', id: `p${n}`, 'aria-label': `Page ${n}` },
    h('div', { class: 'page-head' }, h('span', { class: 'pno', text: `Page ${n}` }), state, timing, h('span', { class: 'spacer' }), redo),
    frame, script);
  p.el = { root, state, timing, redo, frame, layer, script };
  frame.append(placeholder(entry));
  return p;
}

// Before a page loads, show its gallery thumbnail (already fetched by the gallery page) scaled to the frame.
// Thumbnails come as a horizontal sprite; percentage background sizing keeps one tile filling the box.
function placeholder(entry) {
  const box = h('div', { class: 'placeholder' });
  const t = entry?.thumb;
  if (t?.url && t.w && t.h) {
    box.style.aspectRatio = `${t.w} / ${t.h}`;
    const sprite = new Image();
    sprite.onload = () => {
      const sw = sprite.naturalWidth;
      if (!sw) return;
      box.style.backgroundImage = `url("${t.url.replace(/"/g, '%22')}")`;
      box.style.backgroundSize = `${(100 * sw) / t.w}% auto`;
      box.style.backgroundPosition = `${sw > t.w ? (100 * t.x) / (sw - t.w) : 0}% 0`;
    };
    sprite.src = t.url;
  }
  box.append(h('span', { class: 'ph-note', text: entry ? 'Not loaded yet' : 'This page was not in the gallery listing' }));
  return box;
}

function setState(p, state, text) {
  p.state = state;
  p.el.state.className = `state ${state === 'done' ? 'done' : state === 'error' ? 'error' : ['idle', 'loaded'].includes(state) ? '' : 'busy'}`;
  p.el.state.textContent = text;
  p.el.redo.disabled = !p.entry || ['fetching', 'translating', 'encoding'].includes(state);
  p.el.redo.textContent = p.regions ? 'Retranslate' : 'Translate';
  refreshStatus();
}

function showImage(p) {
  const img = h('img', { class: 'page-img', alt: `Page ${p.n}`, src: p.imgUrl, draggable: 'false' });
  img.addEventListener('load', () => {
    p.aspect = img.naturalHeight / img.naturalWidth;
    p.fitWidth = 0;
    p.looks = p.layouts = null;
    renderRegions(p);
  }, { once: true });
  p.el.frame.replaceChildren(img, p.el.layer);
}

// ─── Rendering translations ──────────────────────────────────────────────────
const fbKey = (p, i) => `${p.n}/${i}`;
const shownText = (p, i) => S.feedback.get(fbKey(p, i))?.correction || p.regions[i].translated;

// Japanese text boxes hug vertical columns; English needs width, so grow tall narrow boxes sideways.
function typesetBox(box, aspect) {
  const c = (v) => Math.max(0, Math.min(1000, v));
  let [y0, x0, y1, x1] = box.map(Number);
  const w = x1 - x0, hgt = y1 - y0;
  const physH = hgt * (aspect || 1.41);  // compare in page pixels, not normalized units
  let padX = Math.max(6, w * 0.12), padY = Math.max(5, hgt * 0.05);
  if (physH > w * 1.3) padX = Math.max(padX, Math.min(physH * 0.85 - w, w * 0.9) / 2);
  return [c(y0 - padY), c(x0 - padX), c(y1 + padY), c(x1 + padX)];
}
// A reduced copy of the page's pixels (400 px wide for the region check, 640 for balloon fitting), used once
// per translation and then dropped.
function samplePixels(img, W = 400) {
  try {
    const H = Math.max(1, Math.round((W * img.naturalHeight) / img.naturalWidth));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    return { W, H, data: g.getImageData(0, 0, W, H).data };
  } catch { return null; }
}

// What lies under a region: `plain` when it is dark lettering on a mostly light, even ground (a balloon or a
// caption box), with that ground's colour as `fill`; `big` when it covers more than ~6% of the page.
function regionLook(px, box) {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  const big = area > 60000;
  if (!px) return { plain: false, big, fill: null };
  const { W, H, data } = px;
  const xa = Math.max(0, Math.floor((box[1] / 1000) * W)), xb = Math.min(W, Math.ceil((box[3] / 1000) * W));
  const ya = Math.max(0, Math.floor((box[0] / 1000) * H)), yb = Math.min(H, Math.ceil((box[2] / 1000) * H));
  let n = 0, dark = 0;
  const light = [];
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
      if (lum > 200) light.push([lum, i]); else if (lum < 150) dark++;
    }
  }
  if (!n || light.length / n < 0.55 || dark / n < 0.02) return { plain: false, big, fill: null };
  // Ground colour: the brighter half of the light pixels, which leaves out anti-aliased lettering edges.
  light.sort((a, b) => b[0] - a[0]);
  const top = light.slice(0, Math.max(1, light.length >> 1));
  const avg = (k) => Math.round(top.reduce((s, [, i]) => s + data[i + k], 0) / top.length);
  return { plain: true, big, fill: `rgb(${avg(0)}, ${avg(1)}, ${avg(2)})` };
}

// How Text mode letters a region. The model's placement decides; the pixel check is a safety net so art is
// never painted over: a "bubble" that isn't on a plain ground gets outlined text instead of an eraser.
//   erase    cover the Japanese in the ground colour and letter on top (balloons, caption boxes)
//   outline  dark text with a white outline straight over the art, nothing erased
//   label    a small rounded label; the original stays visible around it
// Pages saved before placement existed keep the pixel-only rule (plain and small: erase, otherwise label).
function letterStyle(r, look) {
  look ||= { plain: false, big: false, fill: null };
  switch (r.placement) {
    case 'bubble': return look.plain ? { cls: 'erase', fill: look.fill } : { cls: 'outline' };
    case 'art': return { cls: 'outline' };
    case 'sfx': return S.sfxMode === 'hide' ? null : { cls: S.sfxMode === 'outline' ? 'outline sfx' : 'label sfx' };
    case 'sign': return { cls: 'label sign' };
    default: return look.plain && !look.big ? { cls: 'erase', fill: look.fill } : { cls: 'label' };
  }
}
const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
const place = (node, [y0, x0, y1, x1]) => Object.assign(node.style, { top: `${y0 / 10}%`, left: `${x0 / 10}%`, height: `${(y1 - y0) / 10}%`, width: `${(x1 - x0) / 10}%` });

function renderRegions(p) {
  const layer = p.el.layer;
  layer.replaceChildren();
  renderScript(p);
  if (!p.regions || !p.imgUrl || S.mode === 'original') return;
  const img = p.el.frame.querySelector('img');
  if (!p.looks && img?.complete && img.naturalWidth) {
    const px = samplePixels(img);
    p.looks = p.regions.map((r) => (validBox(r.box) ? regionLook(px, r.box) : null));
  }
  // Balloon fitting (balloon.js) for regions Text mode erases: English gets the balloon's interior.
  if (S.mode === 'typeset' && !p.layouts && p.looks && img?.complete) {
    const want = p.regions.map((r, i) => (validBox(r.box) && letterStyle(r, p.looks[i])?.cls === 'erase' ? r.box : null));
    try { p.layouts = want.some(Boolean) ? Balloon.fit(samplePixels(img, 640), want) : []; }
    catch { p.layouts = []; }
  }
  p.regions.forEach((r, i) => {
    if (!validBox(r.box)) return;
    const text = shownText(p, i);
    const fb = S.feedback.get(fbKey(p, i));
    if (S.mode === 'typeset') {
      const style = letterStyle(r, p.looks?.[i]);
      if (!style) return;   // sound effects hidden by the reader's SFX setting
      const cls = `tl ${style.cls}${fb?.correction ? ' edited' : fb?.rating === 'bad' ? ' flagged' : ''}`;
      const node = h('button', { type: 'button', class: cls, 'aria-label': `Region ${i + 1}: ${text}`, lang: 'en', 'data-i': i }, h('span', { text }));
      if (style.fill) node.style.background = style.fill;
      node.addEventListener('click', (e) => { e.stopPropagation(); inspect(p, i, node); });
      const fit = style.cls === 'erase' ? p.layouts?.[i] : null;
      if (fit?.text) {
        // Cover the Japanese, then letter in the largest rectangle inside the balloon.
        const eraser = h('div', { class: 'eraser' });
        eraser.style.background = style.fill;
        place(eraser, fit.erase);
        layer.append(eraser);
        node.classList.add('fitted');
        place(node, fit.text);
      } else {
        place(node, typesetBox(r.box, p.aspect));
      }
      layer.append(node);
    } else {
      const node = h('button', { type: 'button', class: `region${r.placement ? ' pl-' + r.placement : ''}`, 'aria-label': `Region ${i + 1}${r.placement ? ' (' + r.placement + ')' : ''}: ${text}`, 'data-i': i, title: r.placement || null }, h('span', { class: 'num', text: String(i + 1) }));
      node.addEventListener('mouseenter', (e) => tip(text, e.clientX, e.clientY));
      node.addEventListener('mousemove', (e) => tip(null, e.clientX, e.clientY));
      node.addEventListener('mouseleave', () => { $('tip').hidden = true; });
      node.addEventListener('click', (e) => { e.stopPropagation(); $('tip').hidden = true; inspect(p, i, node); });
      place(node, r.box.map((v) => Math.max(0, Math.min(1000, v))));
      layer.append(node);
    }
  });
  p.fitWidth = 0;
  fitIfVisible(p);
}

// Largest font size (6–30 px) at which the text fits its box without splitting words; words are split only
// if nothing fits at 6 px. Runs only for pages near the viewport.
function fitPage(p) {
  const width = p.el.frame.clientWidth;
  if (S.mode !== 'typeset' || !width || p.fitWidth === width) return;
  p.fitWidth = width;
  for (const node of p.el.layer.querySelectorAll('.tl')) {
    const span = node.firstChild;
    const fits = () => span.offsetHeight <= node.clientHeight - 4 && span.scrollWidth <= span.clientWidth + 1;
    // Sound effects stay smaller so the drawn original remains the main thing on the page.
    const cap = node.classList.contains('sfx') ? 20 : 30;
    const search = () => {
      let lo = 6, hi = Math.min(cap, Math.max(8, node.clientHeight));
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        node.style.fontSize = `${mid}px`;
        if (fits()) lo = mid; else hi = mid;
      }
      node.style.fontSize = `${lo}px`;
    };
    node.classList.remove('tight');
    search();
    if (!fits()) { node.classList.add('tight'); search(); }
  }
}
const visible = new Set();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = S.pages[+e.target.id.slice(1) - 1];
    if (!p) continue;
    if (e.isIntersecting) { visible.add(p); fitPage(p); } else visible.delete(p);
  }
}, { rootMargin: '100% 0px' });
const fitIfVisible = (p) => { if (visible.has(p)) requestAnimationFrame(() => fitPage(p)); };
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => visible.forEach(fitPage), 150); });

function renderScript(p) {
  const ol = p.el.script;
  ol.replaceChildren();
  ol.hidden = !S.script || !p.regions?.length;
  if (ol.hidden) return;
  p.regions.forEach((r, i) => {
    const fb = S.feedback.get(fbKey(p, i));
    const mark = fb?.correction ? h('span', { class: 'mark', text: 'edited' }) : fb?.rating ? h('span', { class: `mark${fb.rating === 'bad' ? ' bad' : ''}`, text: fb.rating === 'bad' ? 'flagged' : 'good' }) : null;
    const li = h('li', { tabindex: '0' }, h('span', { class: 'en', text: shownText(p, i) }), mark, h('span', { class: 'ja', lang: 'ja', text: r.verifiedSource || r.original }));
    li.addEventListener('click', (e) => { e.stopPropagation(); inspect(p, i, li); });
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') inspect(p, i, li); });
    ol.append(li);
  });
}

function rerenderAll() {
  for (const p of S.pages) renderRegions(p);
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)));
}

function tip(text, x, y) {
  const t = $('tip');
  if (text != null) { t.textContent = `${text}\n\nClick for details`; t.hidden = false; }
  const b = t.getBoundingClientRect();
  t.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - b.width - 8))}px`;
  t.style.top = `${Math.max(8, Math.min(y + 14, innerHeight - b.height - 8))}px`;
}

// ─── Inspector and feedback ──────────────────────────────────────────────────
function inspect(p, i, anchor) {
  S.inspector = { p, i };
  const r = p.regions[i];
  const fb = S.feedback.get(fbKey(p, i));
  $('ins-title').textContent = `Page ${p.n} · region ${i + 1}`;
  $('ins-text').textContent = shownText(p, i);
  $('ins-ocr').textContent = r.original || '';
  $('ins-checked').textContent = r.verifiedSource || '';
  $('ins-checked-wrap').hidden = !r.verifiedSource || r.verifiedSource === r.original;
  $('ins-good').setAttribute('aria-pressed', String(fb?.rating === 'good'));
  $('ins-bad').setAttribute('aria-pressed', String(fb?.rating === 'bad'));
  $('ins-revert').hidden = !fb?.correction;
  editing(false);
  const cfg = p.saved?.config?.label || '';
  const ctx = p.saved?.context?.length ? `Context: p${p.saved.context.join(', p')}.` : '';
  const pl = r.placement ? `Placement: ${r.placement}.` : '';
  $('ins-meta').textContent = [fb?.correction ? 'Showing your correction.' : '', pl, cfg ? `Model: ${cfg}.` : '', ctx].filter(Boolean).join(' ');
  const ins = $('inspector');
  ins.hidden = false;
  const a = anchor.getBoundingClientRect(), b = ins.getBoundingClientRect();
  const below = a.bottom + 8 + b.height < innerHeight;
  ins.style.top = `${Math.max(8, below ? a.bottom + 8 : a.top - b.height - 8)}px`;
  ins.style.left = `${Math.max(8, Math.min(a.left, innerWidth - b.width - 8))}px`;
}
function editing(on) {
  $('ins-edit').hidden = !on;
  $('ins-text').hidden = on;
  $('ins-save').hidden = !on;
  $('ins-editbtn').textContent = on ? 'Cancel' : 'Edit';
  if (on) { $('ins-edit').value = $('ins-text').textContent; $('ins-edit').focus(); }
}
async function saveFeedback(change) {
  const { p, i } = S.inspector;
  const r = p.regions[i];
  const key = fbKey(p, i);
  const prev = S.feedback.get(key) || {};
  const rec = {
    key: `${S.gid}/${p.n}/${p.saved?.ts}/${i}`, gid: S.gid, n: p.n, i, pageTs: p.saved?.ts, ptoken: p.entry?.ptoken, box: r.box,
    ocr: r.original, source: r.verifiedSource ?? r.original, translation: r.translated,
    config: p.saved?.config?.label || null, rating: prev.rating ?? null, correction: prev.correction ?? null,
    ...change, ts: Date.now()
  };
  if (!rec.rating && !rec.correction) {
    S.feedback.delete(key);
    await idb('feedback', 'readwrite', (o) => o.delete(rec.key));
  } else {
    S.feedback.set(key, rec);
    await dbPut('feedback', rec);
  }
  renderRegions(p);
  inspect(p, i, p.el.layer.querySelector(`[data-i="${i}"]`) || p.el.script.children[i] || p.el.frame);
}
$('ins-close').onclick = () => { $('inspector').hidden = true; };
$('ins-good').onclick = () => saveFeedback({ rating: S.feedback.get(fbKey(S.inspector.p, S.inspector.i))?.rating === 'good' ? null : 'good' });
$('ins-bad').onclick = () => saveFeedback({ rating: S.feedback.get(fbKey(S.inspector.p, S.inspector.i))?.rating === 'bad' ? null : 'bad' });
$('ins-editbtn').onclick = () => editing($('ins-edit').hidden);
$('ins-save').onclick = () => {
  const v = $('ins-edit').value.trim();
  const { p, i } = S.inspector;
  saveFeedback({ correction: v && v !== p.regions[i].translated ? v : null });
};
$('ins-revert').onclick = () => saveFeedback({ correction: null });
document.addEventListener('click', (e) => { if (!$('inspector').contains(e.target)) $('inspector').hidden = true; });
// The inspector and tooltip are fixed-position; close them when the page scrolls away from their region.
addEventListener('scroll', () => { $('inspector').hidden = true; $('tip').hidden = true; }, { passive: true });

// ─── Running a batch ─────────────────────────────────────────────────────────
// One loader fetches pages in order (paced by siteHtml), staying at most `parallel + 2` unfinished pages ahead,
// so cancelling never leaves a long tail of downloaded but unused pages.
// Without memory, `parallel` workers each detect and translate a page in one request.
// With memory ("Use previous pages"), the workers only detect. One translator then takes the pages in order and
// gives each the previous two translated pages' Japanese and English as context (text only, no images).
// In eval-v2 this made books read more consistently at the same per-line accuracy, for about 4.5% more cost.
const useMemory = () => $('memory').checked;

// The two nearest earlier pages with a translation, from this run or saved. Your corrections replace model text.
function memoryFor(p) {
  const out = [];
  for (let n = p.n - 1; n >= 1 && out.length < 2; n--) {
    const q = S.pages[n - 1];
    if (q?.regions?.length) out.unshift({ page: n, lines: q.regions.map((r, i) => ({ source: r.verifiedSource || r.original, translation: shownText(q, i) })) });
  }
  return out;
}

async function start() {
  const from = Math.max(1, +$('from').value || 1);
  const to = Math.min(S.pages.length, +$('to').value || S.pages.length);
  const redo = $('redo').checked;
  const targets = S.pages.slice(from - 1, to).filter((p) => p.entry && (redo || !p.regions || !p.imgUrl));
  if (!targets.length) { status('Nothing to do in that range.'); return; }
  const parallel = +$('parallel').value || 1;
  const memory = useMemory();
  const ctl = new AbortController();
  const run = S.run = { ctl, paused: false, waiters: [], total: targets.length, finished: 0, failed: 0, stop: null };
  const wake = () => { const w = run.waiters.splice(0); w.forEach((f) => f()); };
  const until = async (cond) => { while (!cond()) { if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); await new Promise((r) => run.waiters.push(r)); } };
  ctl.signal.addEventListener('abort', wake);
  run.wake = wake;
  controls(true);
  alertBox(null);

  // Job states: pending → loaded → (detected →) done, or skipped if loading stopped first.
  const jobs = targets.map((p) => ({ p, state: 'pending' }));
  const ready = [];
  let loading = true, open = 0;   // open: loaded jobs not yet done
  const finish = (job, failed = false) => {
    if (job.state === 'done') return;
    job.state = 'done';
    open--;
    run.finished++;
    if (failed) run.failed++;
    wake();
    refreshStatus();
  };

  const loader = (async () => {
    for (const job of jobs) {
      const p = job.p;
      try { await until(() => !run.paused && open < parallel + 2); } catch { break; }
      try {
        await loadPage(p, ctl.signal);
      } catch (err) {
        if (err instanceof SiteStop) {
          // Pages already downloaded still get translated; nothing more is fetched.
          setState(p, 'error', 'Not loaded');
          run.stop = err.message;
          alertBox(err.message, true);
          break;
        }
        if (isAbort(err)) break;
        setState(p, 'error', `Could not load: ${err.message}`);
        job.state = 'done'; run.failed++; run.finished++; wake();
        continue;
      }
      if (p.regions && !redo) {
        setState(p, 'done', regionCount(p.regions.length) + ' · translated earlier');
        job.state = 'done'; run.finished++; wake();
        continue;
      }
      job.state = 'loaded';
      open++;
      setState(p, 'queued', memory ? 'Waiting to detect' : 'Waiting to translate');
      ready.push(job);
      wake();
    }
    loading = false;
    for (const job of jobs) if (job.state === 'pending') job.state = 'skipped';
    wake();
  })();

  const worker = async () => {
    while (true) {
      try { await until(() => (!run.paused && ready.length) || (!loading && !ready.length)); } catch { return; }
      const job = ready.shift();
      if (!job) return;
      try {
        if (!memory) { await translatePage(job.p, ctl.signal); finish(job); continue; }
        if (await detectPage(job.p, ctl.signal)) finish(job);   // no text on the page: nothing to translate
        else { job.state = 'detected'; wake(); }
      } catch (err) {
        finish(job, !isAbort(err));
      }
    }
  };

  const translator = memory && (async () => {
    for (const job of jobs) {
      try { await until(() => ['done', 'skipped'].includes(job.state) || (job.state === 'detected' && !run.paused)); } catch { return; }
      if (job.state !== 'detected') continue;
      try {
        await verifyPage(job.p, ctl.signal);
        finish(job);
      } catch (err) {
        finish(job, !isAbort(err));
        if (isAbort(err)) return;
      }
    }
  })();

  await Promise.all([loader, ...Array.from({ length: parallel }, worker), translator].filter(Boolean));
  for (const job of jobs) {
    if (!['loaded', 'detected'].includes(job.state)) continue;   // left mid-way by a cancel or a site stop
    const p = job.p;
    p.dataUrl = p.detected = p.pending = null;
    setState(p, p.regions ? 'done' : 'loaded', p.regions ? regionCount(p.regions.length) : 'Loaded · not translated');
  }
  S.run = null;
  controls(false);
  refreshStatus();
  if (run.stop !== 'unreachable') status(ctl.signal.aborted ? 'Cancelled.' : `Finished ${run.finished - run.failed} of ${run.total} page(s)${run.failed ? `, ${run.failed} failed` : ''}.`);
}

async function loadPage(p, signal) {
  if (p.blob) return;
  setState(p, 'fetching', 'Loading page…');
  try {
    await fetchPage(p, signal);
  } catch (err) {
    // A cancelled load returns the card to how it was; other errors are reported by the caller.
    if (isAbort(err)) setState(p, p.regions ? 'done' : 'idle', p.regions ? regionCount(p.regions.length) + ' · translated earlier' : 'Not loaded');
    throw err;
  }
}

async function fetchPage(p, signal) {
  let doc = await siteHtml(p.entry.url, signal);
  let v = EH.parseViewer(doc);
  for (let attempt = 0; ; attempt++) {
    if (EH.isQuotaImage(v.src)) throw new SiteStop('e-hentai’s image viewing limit is used up (509). Stopped; it resets over time.');
    if (!v.src) throw new Error('no image on the page');
    try {
      p.blob = await fetchImage(v.src, signal);
      break;
    } catch (err) {
      if (isAbort(err) || attempt || !v.nl) throw err;
      // Same as the site's "Reload broken image" link: ask for the page from another image server.
      doc = await siteHtml(`${p.entry.url}?nl=${encodeURIComponent(v.nl)}`, signal);
      v = EH.parseViewer(doc);
    }
  }
  p.imgUrl = URL.createObjectURL(p.blob);
  showImage(p);
  setState(p, 'loaded', 'Loaded');
}

// Card text while the background works on a page: stage, retry notes, and which pages give it context.
function progressFor(p, previous = []) {
  let label = '', note = '';
  return (ev) => {
    if (ev.type === 'stage') { label = ev.stage; note = ''; }
    if (ev.type === 'note') note = ev.note;
    if (ev.type !== 'stage' && ev.type !== 'note') return;
    const ctx = label === 'Translating' && previous.length ? ` with p${previous.map((x) => x.page).join(', p')} as context` : '';
    setState(p, 'translating', `${label}…${ctx}${note ? ' ' + note : ''}`);
  };
}
async function timed(p, fn) {
  const t0 = performance.now();
  const tick = setInterval(() => { p.el.timing.textContent = fmtS(performance.now() - t0); }, 500);
  try { return await fn(); } finally { clearInterval(tick); }
}
const mergeUsage = (a, b) => ({ prompt: (a?.prompt || 0) + (b?.prompt || 0), completion: (a?.completion || 0) + (b?.completion || 0), calls: [...(a?.calls || []), ...(b?.calls || [])] });

async function savePage(p, regions, config, usage, ms, context) {
  p.regions = regions;
  p.looks = p.layouts = null;
  p.saved = { key: `${S.gid}/${p.n}`, gid: S.gid, n: p.n, ptoken: p.entry.ptoken, regions, config, usage, ms, context, ts: Date.now() };
  await dbPut('pages', p.saved).catch(() => {});
  for (const k of [...S.feedback.keys()]) if (k.startsWith(`${p.n}/`)) S.feedback.delete(k);  // they were for the old text
  p.el.timing.textContent = fmtS(ms);
  setState(p, 'done', regionCount(regions.length) + (context.length ? ` · context p${context.join(', p')}` : ''));
  renderRegions(p);
}

function pageFailed(p, err) {
  addUsage(err.usage);
  if (isAbort(err)) { setState(p, p.regions ? 'done' : 'loaded', p.regions ? regionCount(p.regions.length) : 'Cancelled'); return; }
  const unreachable = /Failed to fetch|NetworkError|ECONNREFUSED/i.test(err.message);
  setState(p, 'error', friendlyError(err.message) + (p.regions ? ' · showing the earlier translation' : ''));
  p.el.state.title = err.message;
  if (unreachable && S.run) { alertBox('Cannot reach the model server. Start it (for Vertex: Start-VertexBridge.ps1), then press Start again.', true); S.run.stop = 'unreachable'; S.run.ctl.abort(); }
}

// Without memory: detect and translate in one background request.
async function translatePage(p, signal) {
  try {
    setState(p, 'encoding', 'Preparing image…');
    const dataUrl = await toJpegDataUrl(p.blob);
    setState(p, 'translating', 'Detecting…');
    const res = await timed(p, () => bgRequest({ type: 'translate', dataUrl, context: bookContext(), placement: true }, progressFor(p), signal));
    addUsage(res.usage);
    await savePage(p, res.regions, res.config, res.usage, res.ms, []);
  } catch (err) {
    pageFailed(p, err);
    throw err;
  }
}

// With memory, stage 1. Returns true when the page has no text (finished, nothing to translate).
async function detectPage(p, signal) {
  try {
    setState(p, 'encoding', 'Preparing image…');
    p.dataUrl = await toJpegDataUrl(p.blob);
    const res = await timed(p, () => bgRequest({ type: 'detect', dataUrl: p.dataUrl }, progressFor(p), signal));
    addUsage(res.usage);
    if (!res.detected.length) {
      p.dataUrl = null;
      await savePage(p, [], res.config, res.usage, res.ms, []);
      return true;
    }
    p.detected = res.detected;
    p.pending = { usage: res.usage, ms: res.ms };
    setState(p, 'queued', 'Detected · waiting for earlier pages');
    return false;
  } catch (err) {
    p.dataUrl = null;
    pageFailed(p, err);
    throw err;
  }
}

// With memory, stage 2: translate with the previous pages' text as context. Called in page order.
async function verifyPage(p, signal) {
  const previous = memoryFor(p);
  try {
    const res = await timed(p, () => bgRequest({ type: 'verify', dataUrl: p.dataUrl, detected: p.detected, context: { ...bookContext(), previous }, placement: true }, progressFor(p, previous), signal));
    addUsage(res.usage);
    await savePage(p, res.regions, res.config, mergeUsage(p.pending?.usage, res.usage), (p.pending?.ms || 0) + res.ms, previous.map((x) => x.page));
  } catch (err) {
    pageFailed(p, err);
    throw err;
  } finally {
    p.dataUrl = p.detected = p.pending = null;
  }
}

// Short card text for a failed page; the full message stays in the card's tooltip.
function friendlyError(message) {
  if (/Blocked by Google content policy|PROHIBITED_CONTENT|SAFETY/i.test(message)) return 'Blocked by the provider’s content policy';
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(message)) return 'Model server unreachable';
  if (/HTTP 401/.test(message)) return 'The bridge rejected the token; set it in the LM Translate popup';
  if (/HTTP 429|Resource exhausted/i.test(message)) return 'Provider out of capacity (429) after 3 retries; try later, lower Parallel, or use a Flash preset';
  if (/HTTP 50[234]|UNAVAILABLE|timed out/i.test(message)) return 'Provider unavailable or timed out after 3 retries; try again later';
  if (/output limit/i.test(message)) return 'Output limit reached; the page has too much text for one call';
  if (/Please retry the image/i.test(message)) return 'Model output failed validation twice; press Retranslate';
  return message.replace(/\s+/g, ' ').slice(0, 160);
}

async function single(p) {
  if (S.stale) { alertBox(STALE_MESSAGE, true); return; }
  if (S.run) { status('Wait for the current run to finish, or cancel it, before retranslating a single page.'); return; }
  const ctl = new AbortController();
  S.run = { ctl, paused: false, total: 1, finished: 0, failed: 0, wake() {} };
  controls(true);
  try {
    await loadPage(p, ctl.signal);
    if (!useMemory()) await translatePage(p, ctl.signal);
    else if (!(await detectPage(p, ctl.signal))) await verifyPage(p, ctl.signal);
  } catch (err) {
    if (err instanceof SiteStop) alertBox(err.message, true);
    else if (!isAbort(err) && p.state !== 'error') setState(p, 'error', err.message.slice(0, 160));
  } finally {
    S.run = null;
    controls(false);
    refreshStatus();
  }
}

function addUsage(u) {
  if (!u) return;
  for (const c of u.calls || []) {
    S.usage.prompt += c.prompt || 0;
    S.usage.completion += c.completion || 0;
    const price = Object.entries(PRICES).find(([k]) => (c.model || '').startsWith(k))?.[1];
    if (price) S.usage.cost += ((c.prompt || 0) * price[0] + (c.completion || 0) * price[1]) / 1e6;
    else if (c.completion) S.usage.priced = false;
  }
  refreshStatus();
}

function controls(running) {
  $('start').disabled = running || !!S.stale;
  $('pause').disabled = !running;
  $('cancel').disabled = !running;
  $('pause').textContent = 'Pause';
  for (const id of ['from', 'to', 'parallel', 'redo', 'memory']) $(id).disabled = running;
}

function refreshStatus() {
  const pages = S.pages;
  if (!pages.length) return;
  const done = pages.filter((p) => p.state === 'done').length;
  const failed = pages.filter((p) => p.state === 'error').length;
  const busy = pages.filter((p) => ['translating', 'encoding'].includes(p.state)).length;
  $('bar-fill').style.width = `${(100 * done) / pages.length}%`;
  const parts = [`${done} of ${pages.length} pages translated`];
  if (busy) parts.push(`${busy} in progress`);
  if (failed) parts.push(`${failed} failed`);
  if (S.run?.paused) parts.push('paused; running pages will finish');
  status(parts.join(' · '));
  const u = S.usage;
  $('status-cost').textContent = u.prompt || u.completion
    ? `This session: ${(u.prompt / 1000).toFixed(0)}k in / ${(u.completion / 1000).toFixed(0)}k out tokens${u.cost ? ` · est. $${u.cost.toFixed(3)}${u.priced ? '' : '+'}` : ''}`
    : '';
  $('status-cost').title = 'Estimated from reported tokens and third-party list prices (intro), unverified with Google.';
}
const status = (text) => { $('status-text').textContent = text; };
function alertBox(text, error = false) {
  const a = $('alert');
  a.hidden = !text;
  a.textContent = text || '';
  a.className = `alert${error ? ' error' : ''}`;
}

// ─── Export (text only) ──────────────────────────────────────────────────────
function exportJson() {
  const pages = S.pages.filter((p) => p.regions).map((p) => ({
    page: p.n, ptoken: p.entry?.ptoken, model: p.saved?.config?.label || null, translated_at: p.saved?.ts ? new Date(p.saved.ts).toISOString() : null,
    context_pages: p.saved?.context || [],
    regions: p.regions.map((r, i) => {
      const fb = S.feedback.get(fbKey(p, i));
      return { id: i + 1, box_2d: r.box, ocr: r.original, source: r.verifiedSource ?? r.original, translation: r.translated, placement: r.placement ?? null,
        ...(fb?.rating ? { rating: fb.rating } : {}), ...(fb?.correction ? { correction: fb.correction } : {}) };
    })
  }));
  const data = {
    format: 'lm-translate-reader/1', exported: new Date().toISOString(),
    gallery: { gid: S.gid, token: S.token, url: S.galleryUrl, title: S.meta.title, title_jp: S.meta.titleJp, tags: S.meta.tags },
    glossary: parseGlossary(S.glossary.text), pages
  };
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `lm-translate-${S.gid}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─── Glossary dialog ─────────────────────────────────────────────────────────
$('glossary-open').onclick = () => {
  if (!S.meta) return;
  const scope = S.glossary.scope;
  $('glossary-scope').textContent = scope.startsWith('parody:')
    ? `Shared by every gallery tagged ${scope.slice(7).replace(/_/g, ' ')}.`
    : 'For this gallery only (it has no series tag).';
  $('glossary-text').value = S.glossary.text;
  $('use-tags').checked = S.glossary.useTags;
  const ctx = { ...bookContext(), glossary: [] };
  $('tag-hints').textContent = [ctx.series?.length ? `Series: ${ctx.series.join(', ')}` : '', ctx.characters?.length ? `Characters: ${ctx.characters.join(', ')}` : 'No character tags on this gallery.'].filter(Boolean).join(' · ');
  $('glossary').showModal();
};
$('glossary').addEventListener('close', async () => {
  if ($('glossary').returnValue !== 'save') return;
  S.glossary.text = $('glossary-text').value;
  S.glossary.useTags = $('use-tags').checked;
  await dbPut('glossaries', { scope: S.glossary.scope, text: S.glossary.text, useTags: S.glossary.useTags, updated: Date.now() }).catch((e) => alertBox(`Could not save the glossary: ${e.message}`, true));
  status(`Glossary saved (${parseGlossary(S.glossary.text).length} entries).`);
});

// ─── Wiring ──────────────────────────────────────────────────────────────────
$('start').onclick = () => start().catch((e) => { alertBox(e.message, true); S.run = null; controls(false); });
$('pause').onclick = () => {
  if (!S.run) return;
  S.run.paused = !S.run.paused;
  $('pause').textContent = S.run.paused ? 'Resume' : 'Pause';
  S.run.wake();
  refreshStatus();
};
$('cancel').onclick = () => S.run?.ctl.abort();
$('export').onclick = exportJson;
try { $('memory').checked = localStorage.getItem('lmt-reader-memory') !== '0'; } catch { /* default on */ }
$('memory').onchange = () => { try { localStorage.setItem('lmt-reader-memory', $('memory').checked ? '1' : '0'); } catch {} };
$('sfx').value = S.sfxMode;
$('sfx').onchange = () => { S.sfxMode = $('sfx').value; try { localStorage.setItem('lmt-reader-sfx', S.sfxMode); } catch {} rerenderAll(); };
$('script').checked = S.script;
$('script').onchange = () => { S.script = $('script').checked; try { localStorage.setItem('lmt-reader-script', S.script ? '1' : '0'); } catch {} S.pages.forEach(renderScript); };
$('width').onchange = () => {
  document.documentElement.style.setProperty('--page-width', `${$('width').value}px`);
  try { localStorage.setItem('lmt-reader-width', $('width').value); } catch {}
};
document.documentElement.style.setProperty('--page-width', `${$('width').value}px`);
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  try { localStorage.setItem('lmt-reader-mode', S.mode); } catch {}
  rerenderAll();
}));
rerenderAll();
addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) document.body.classList.add('peek');
  if (e.key === 'Escape') $('inspector').hidden = true;
});
addEventListener('keyup', (e) => { if (e.key === 'Shift') document.body.classList.remove('peek'); });
addEventListener('blur', () => document.body.classList.remove('peek'));

open().catch((e) => {
  $('title').textContent = 'Could not open this gallery';
  alertBox(e.message, true);
  status('');
});
