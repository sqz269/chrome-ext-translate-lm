// e-hentai page parsing for the batch reader (reader.html).
// Pure functions over a parsed Document, so they can be checked against saved HTML without a network.
'use strict';

const EH = (() => {
  const GALLERY = /^https:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]{10})\/?/;
  const VIEWER = /^https:\/\/e-hentai\.org\/s\/([0-9a-f]{10})\/(\d+)-(\d+)/;

  // A gallery or viewer URL → what the reader should open.
  function parseSource(url) {
    let m = GALLERY.exec(url || '');
    if (m) return { kind: 'gallery', gid: +m[1], token: m[2], galleryUrl: `https://e-hentai.org/g/${m[1]}/${m[2]}/`, page: 1 };
    m = VIEWER.exec(url || '');
    if (m) return { kind: 'viewer', gid: +m[2], page: +m[3], viewerUrl: m[0] };
    return null;
  }

  const text = (doc, sel) => (doc.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

  // Thumbnail sprite: "width:200px;height:292px;background:transparent url(https://…/123-0.webp) -200px 0 no-repeat"
  function parseSprite(style) {
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(style || '')?.[1];
    if (!url) return null;
    return {
      url,
      w: +(/width:\s*(\d+)px/.exec(style)?.[1] || 0),
      h: +(/height:\s*(\d+)px/.exec(style)?.[1] || 0),
      x: +(/\)\s*-?(\d+)px/.exec(style)?.[1] || 0)
    };
  }

  function parseThumbs(doc, gid) {
    const out = [];
    for (const a of doc.querySelectorAll('#gdt a[href]')) {
      const m = VIEWER.exec(a.getAttribute('href') || '');
      if (!m || +m[2] !== gid) continue;
      const tile = a.querySelector('[title]');
      const img = a.querySelector('img');
      const title = tile?.getAttribute('title') || img?.getAttribute('title') || img?.getAttribute('alt') || '';
      const thumb = parseSprite(tile?.getAttribute('style')) || (img ? { url: img.getAttribute('src'), w: 0, h: 0, x: 0 } : null);
      out.push({ n: +m[3], url: m[0], ptoken: m[1], name: title.replace(/^Page \d+:\s*/, ''), thumb });
    }
    return out;
  }

  // One gallery listing page (?p=N). Page 0 also carries the metadata.
  function parseGallery(doc, gid) {
    const tags = [...doc.querySelectorAll('#taglist div[id^="td_"]')].map(d => d.id.slice(3).replace(/_/g, ' '));
    let pageCount = 0;
    for (const row of doc.querySelectorAll('#gdd tr')) {
      if (/^\s*Length/i.test(row.cells[0]?.textContent || '')) pageCount = parseInt(row.cells[1]?.textContent || '', 10) || 0;
    }
    let lastListing = 0;
    for (const a of doc.querySelectorAll('.ptt a[href]')) {
      const p = /[?&]p=(\d+)/.exec(a.getAttribute('href') || '');
      if (p) lastListing = Math.max(lastListing, +p[1]);
    }
    const hasThumbs = !!doc.querySelector('#gdt');
    return {
      title: text(doc, '#gn'), titleJp: text(doc, '#gj'), category: text(doc, '#gdc'),
      tags, pageCount, lastListing, entries: parseThumbs(doc, gid),
      contentWarning: !hasThumbs && /Content Warning/i.test(doc.body?.textContent || ''),
      hasThumbs
    };
  }

  // A viewer page (/s/<ptoken>/<gid>-<n>): the full image, the "reload broken image" key and the gallery link.
  function parseViewer(doc) {
    const src = doc.querySelector('#img')?.getAttribute('src') || '';
    const nl = /nl\('([^']+)'\)/.exec(doc.querySelector('#loadfail')?.getAttribute('onclick') || '')?.[1] || null;
    const link = [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).find(href => GALLERY.test(href));
    const g = link && GALLERY.exec(link);
    return { src, nl, galleryUrl: g ? `https://e-hentai.org/g/${g[1]}/${g[2]}/` : null };
  }

  // e-hentai serves a placeholder image instead of the page when the viewing limit is exhausted.
  const isQuotaImage = (src) => /\/509s?\.gif(\?|$)/i.test(src || '');
  const isBanPage = (html) => /temporarily banned|IP address has been temporarily/i.test(html || '');

  return { GALLERY, VIEWER, parseSource, parseGallery, parseViewer, parseSprite, isQuotaImage, isBanPage };
})();

if (typeof module !== 'undefined') module.exports = EH;
