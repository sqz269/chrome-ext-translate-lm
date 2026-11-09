// Live end-to-end check of the batch reader (reader.html) in a throwaway headless Chrome profile.
//
//   node tests/reader-e2e.cjs --go [--gallery URL] [--pages 2-5] [--preset vertex36|vertexargonflash]
//                               [--endpoint https://host:8443/v1/chat/completions]   (token in LMT_BRIDGE_TOKEN)
//
// Paid and online: it reads a real e-hentai gallery (anonymously, at the reader's normal pace) and translates
// the chosen pages through the local Vertex bridge, which must be running. Chrome loads the unpacked
// extension through the DevTools protocol (Extensions.loadUnpacked over --remote-debugging-pipe), because
// branded Chrome ignores --load-extension. The profile, including its HTTP cache, is deleted afterwards.
//
// Checks: the gallery-page link opens the reader; the batch finishes; IndexedDB and extension storage hold
// text only (no data:/blob: URLs or base64 runs); reopening reuses cached translations with zero tokens.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
if (!args.includes('--go')) {
  console.log('Paid live test: translates a few pages through the Vertex bridge. Re-run with --go.');
  process.exit(0);
}
const CHROME = opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const GALLERY = opt('gallery', 'https://e-hentai.org/g/3872169/83c76e2306/');
const [FROM, TO] = opt('pages', '2-5').split('-').map(Number);
const PRESETS = {
  vertex36: { provider: 'vertex36', model: 'gemini-3.6-flash-minimal' },
  vertexargonflash: { provider: 'vertexargonflash', model: 'gemini-4-argon-low' }
};
const PRESET = PRESETS[opt('preset', 'vertex36')];
const ENDPOINT = opt('endpoint', 'http://127.0.0.1:8001/v1/chat/completions');
const TOKEN = process.env.LMT_BRIDGE_TOKEN || '';
if (!PRESET) throw new Error('Unknown preset');

function launch(profile) {
  const proc = spawn(CHROME, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--headless', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0), seq = 0;
  const calls = new Map();
  proc.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let i; (i = buf.indexOf(0)) >= 0; buf = buf.subarray(i + 1)) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
      const call = calls.get(msg.id);
      if (!call) continue;
      calls.delete(msg.id);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`)); else call.resolve(msg.result);
    }
  });
  proc.stderr.resume();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject, method });
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { proc, send };
}

async function session(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
      try { const v = await ev(expression); if (v) return v; } catch { /* still loading */ }
    }
    throw new Error('Timed out waiting for: ' + expression);
  };
  return { sessionId, ev, waitFor };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' · ' + detail : ''}`); if (!ok) process.exitCode = 1; };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lmt-reader-e2e-'));
  const cdp = launch(profile);
  try {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve(__dirname, '..') });
    const ext = `chrome-extension://${id}/`;
    const { targetId: setT } = await cdp.send('Target.createTarget', { url: ext + 'popup.html' });
    const settings = await session(cdp, setT);
    await settings.waitFor(`chrome.storage.sync.get('gemmaProfileVersion').then(v => v.gemmaProfileVersion === 2)`, 15000);
    await sleep(1000);  // let the first-run settings migration finish before overriding it
    await settings.ev(`chrome.storage.sync.set(${JSON.stringify({ ...PRESET, endpoint: ENDPOINT, gemmaVllm: false, gemmaImageVerification: true, gemmaProfileVersion: 2 })}).then(() => true)`);
    await settings.ev(`chrome.storage.local.set({ bridgeToken: ${JSON.stringify(TOKEN)} }).then(() => true)`);

    const { targetId: galT } = await cdp.send('Target.createTarget', { url: GALLERY });
    const gallery = await session(cdp, galT);
    const link = `[...document.querySelectorAll('#gd5 a')].find(a => /Translated reader/.test(a.textContent))`;
    await gallery.waitFor(`!!${link}`, 60000);
    await gallery.ev(`${link}.click(), true`);
    let readerT;
    for (let i = 0; i < 40 && !readerT; i++, await sleep(250)) {
      readerT = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.url.startsWith(ext + 'reader.html'))?.targetId;
    }
    check(!!readerT, 'gallery link opens the reader');
    if (!readerT) return;
    const reader = await session(cdp, readerT);
    await reader.waitFor(`!document.getElementById('start').disabled || !document.getElementById('alert').hidden`, 90000);
    const info = await reader.ev(`({ pages: S.pages.length, listed: S.pages.filter(p => p.entry).length, title: S.meta?.title, model: S.config?.label })`);
    check(info.pages > 0 && info.listed === info.pages, 'gallery listing parsed', `${info.listed}/${info.pages} pages · ${info.title} · ${info.model}`);

    await reader.ev(`document.getElementById('from').value = ${FROM}; document.getElementById('to').value = ${TO}; document.getElementById('start').click(); true`);
    await sleep(1500);
    await reader.waitFor('!S.run', 15 * 60000);
    const pages = await reader.ev(`S.pages.slice(${FROM - 1}, ${TO}).map(p => ({ n: p.n, state: p.state, text: p.el.state.textContent, regions: p.regions?.length ?? null, ms: p.saved?.ms }))`);
    for (const p of pages) console.log(`      page ${p.n}: ${p.state} · ${p.text}${p.ms ? ` · ${(p.ms / 1000).toFixed(1)} s` : ''}`);
    check(pages.every((p) => p.state === 'done'), 'batch translated every page in range');
    console.log('      ' + await reader.ev(`document.getElementById('status-cost').textContent`));

    // "Use previous pages" (on by default): each page's context is the two nearest earlier translated pages.
    const ctx = await reader.ev(`S.pages.slice(0, ${TO}).map(p => ({ n: p.n, has: !!p.regions?.length, context: p.saved?.context ?? null, kinds: (p.saved?.usage?.calls || []).map(c => c.kind) }))`);
    const expected = (n) => ctx.filter((q) => q.n < n && q.has).slice(-2).map((q) => q.n);
    const translated = ctx.filter((q) => q.n >= FROM && q.has);
    check(translated.length > 0 && translated.every((q) => JSON.stringify(q.context) === JSON.stringify(expected(q.n))),
      'memory: each page used the previous translated pages as context', translated.map((q) => `p${q.n}←[${q.context}]`).join(' '));
    check(translated.every((q) => q.kinds.includes('detect') && q.kinds.includes('verify-image')), 'memory: detect and verify ran as separate requests');

    // Single-page retranslate with memory off, then on again.
    const last = translated[translated.length - 1]?.n;
    if (last) {
      for (const on of [false, true]) {
        await reader.ev(`document.getElementById('memory').checked = ${on}; document.getElementById('memory').dispatchEvent(new Event('change')); S.pages[${last - 1}].el.redo.click(); true`);
        await sleep(1500);
        await reader.waitFor('!S.run', 5 * 60000);
        const got = await reader.ev(`({ state: S.pages[${last - 1}].state, context: S.pages[${last - 1}].saved?.context })`);
        check(got.state === 'done' && JSON.stringify(got.context) === JSON.stringify(on ? expected(last) : []),
          `retranslate p${last} with memory ${on ? 'on' : 'off'}`, `context [${got.context}]`);
      }
    }

    const audit = await reader.ev(`(async () => {
      const d = await db(), out = [];
      for (const store of d.objectStoreNames) out.push(JSON.stringify(await idb(store, 'readonly', o => o.getAll())));
      out.push(JSON.stringify(await chrome.storage.local.get(null)));
      const all = out.join('');
      return { bytes: all.length, dataUrl: all.includes('data:image'), blobUrl: all.includes('blob:'), base64: /[A-Za-z0-9+/]{2000,}/.test(all) };
    })()`);
    check(!audit.dataUrl && !audit.blobUrl && !audit.base64, 'stored data is text only', `${audit.bytes} bytes`);

    await cdp.send('Page.reload', {}, reader.sessionId);
    await sleep(1000);
    await reader.waitFor(`typeof S !== 'undefined' && !document.getElementById('start').disabled`, 90000);
    await reader.ev(`document.getElementById('from').value = ${FROM}; document.getElementById('to').value = ${Math.min(TO, FROM + 1)}; document.getElementById('start').click(); true`);
    await sleep(1500);
    await reader.waitFor('!S.run', 5 * 60000);
    const reuse = await reader.ev(`({ tokens: S.usage.prompt + S.usage.completion, done: S.pages.slice(${FROM - 1}, ${Math.min(TO, FROM + 1)}).every(p => p.state === 'done' && p.imgUrl) })`);
    check(reuse.done && reuse.tokens === 0, 'reopened reader reuses cached translations', `${reuse.tokens} tokens`);
  } catch (err) {
    check(false, 'run', err.message);
  } finally {
    cdp.proc.kill();
    await sleep(1500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
})();
