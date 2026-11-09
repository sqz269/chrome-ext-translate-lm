// Balloon fitting for the reader's Text mode: find the interior of the speech balloon around a detected text box
// and the largest rectangle inside it, so English can use the balloon instead of the narrow column the Japanese
// occupied. Pure functions over RGBA pixel data ({W, H, data}), so they run in the reader and in Node tests.
//
// 1. Fill: one breadth-first flood fill per page, grown from the centre of every requested text box at once.
//    A pixel joins a box's balloon if its colour is close to that balloon's fill colour, so the dark outline
//    stops it. Growing all boxes together splits a balloon shared by two text boxes between them.
// 2. Guards: a fill that reaches the page edge or grows past 15% of the page has leaked out of an open
//    balloon; that box gets no layout and the reader keeps its padded text box. A fill also stops growing
//    beyond a generous distance limit around its box. A real balloon ends at a dark outline: if less than
//    60% of the fill's border is dark (looking up to 2 px out, for anti-aliased outlines), the fill has
//    spread into a light background instead, and is rejected too.
// 3. Fit: fill in the text box's own pixels (the glyphs are dark, so the flood leaves holes there), shrink the
//    balloon by a margin (chessboard distance transform), then take the largest rectangle that contains the
//    text box's centre, so the English stays where the Japanese was.
'use strict';

const Balloon = (() => {
  const SIM = 45;            // max L1 RGB distance from the fill colour that still counts as balloon interior
  const OUTLINE_SHARE = 0.6; // share of a balloon's border that must be dark outline (or a neighbouring box)
  const LEAK_SHARE = 0.15;   // a balloon bigger than this share of the page has leaked into the background

  const lum = (d, k) => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];

  // The fill colour around the lettering: the brighter half of the light pixels in the box. Null when the box
  // isn't mostly light (not on a plain balloon fill).
  function groundColour(px, x0, y0, x1, y1) {
    const { W, data } = px;
    const light = [];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = (y * W + x) * 4;
        n++;
        const l = lum(data, k);
        if (l > 200) light.push([l, k]);
      }
    }
    if (!n || light.length / n < 0.45) return null;
    light.sort((a, b) => b[0] - a[0]);
    const top = light.slice(0, Math.max(1, light.length >> 1));
    return [0, 1, 2].map((c) => top.reduce((s, [, k]) => s + data[k + c], 0) / top.length);
  }

  // boxes: one entry per region, [ymin, xmin, ymax, xmax] in 0-1000 page coordinates, or null to skip.
  // Returns one entry per box: {text, erase, gain} (boxes in 0-1000) or {fail: reason}.
  function fit(px, boxes) {
    const { W, H, data } = px;
    const N = W * H;
    const label = new Int32Array(N).fill(-1);
    const dist = new Uint16Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    const toPx = (b) => [
      Math.max(0, Math.min(H - 1, Math.floor((b[0] / 1000) * H))), Math.max(0, Math.min(W - 1, Math.floor((b[1] / 1000) * W))),
      Math.max(1, Math.min(H, Math.ceil((b[2] / 1000) * H))), Math.max(1, Math.min(W, Math.ceil((b[3] / 1000) * W)))
    ];
    const seeds = boxes.map((box, i) => {
      if (!box) return null;
      const [y0, x0, y1, x1] = toPx(box);
      if (y1 - y0 < 2 || x1 - x0 < 2) return { fail: 'box too small' };
      const g = groundColour(px, x0, y0, x1, y1);
      if (!g) return { fail: 'not on a plain fill' };
      const s = { i, g, box: [y0, x0, y1, x1], area: 0, leaked: false, minX: x1, maxX: x0, minY: y1, maxY: y0,
                  reach: Math.max(5 * Math.max(x1 - x0, y1 - y0), Math.round(0.35 * W)) };
      // Seed from the box's central 70%; the box edge can overlap the balloon outline.
      const sy0 = y0 + Math.floor((y1 - y0) * 0.15), sy1 = y1 - Math.floor((y1 - y0) * 0.15);
      const sx0 = x0 + Math.floor((x1 - x0) * 0.15), sx1 = x1 - Math.floor((x1 - x0) * 0.15);
      for (let y = sy0; y < Math.max(sy1, sy0 + 1); y++) {
        for (let x = sx0; x < Math.max(sx1, sx0 + 1); x++) {
          const p = y * W + x;
          if (label[p] !== -1) continue;
          label[p] = i;
          queue[tail++] = p;
          s.area++;
        }
      }
      return s;
    });

    const cap = LEAK_SHARE * N;
    while (head < tail) {
      const p = queue[head++];
      const s = seeds[label[p]];
      if (s.leaked) continue;
      const x = p % W, y = (p / W) | 0;
      if (x < s.minX) s.minX = x; if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y; if (y > s.maxY) s.maxY = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { s.leaked = 'reached the page edge'; continue; }
      if (dist[p] >= s.reach) continue;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (label[q] !== -1) continue;
        const k = q * 4;
        if (Math.abs(data[k] - s.g[0]) + Math.abs(data[k + 1] - s.g[1]) + Math.abs(data[k + 2] - s.g[2]) > SIM) continue;
        label[q] = s.i;
        dist[q] = dist[p] + 1;
        queue[tail++] = q;
        if (++s.area > cap) { s.leaked = 'larger than 15% of the page'; break; }
      }
    }

    // Fill the holes the glyphs left inside each box, so the box counts as balloon interior.
    for (const s of seeds) {
      if (!s || s.fail || s.leaked) continue;
      const [y0, x0, y1, x1] = s.box;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (label[y * W + x] === -1) label[y * W + x] = s.i;
      s.minX = Math.min(s.minX, x0); s.maxX = Math.max(s.maxX, x1 - 1);
      s.minY = Math.min(s.minY, y0); s.maxY = Math.max(s.maxY, y1 - 1);
    }
    return seeds.map((s) => {
      if (!s) return null;
      if (s.fail) return { fail: s.fail };
      if (s.leaked) return { fail: s.leaked };
      return layout(s, label, W, H, px.data);
    });
  }

  function layout(s, label, W, H, data) {
    const bx = s.minX, by = s.minY, bw = s.maxX - s.minX + 1, bh = s.maxY - s.minY + 1;
    // Chessboard distance to the nearest pixel outside this balloon (two raster passes).
    // Balloon mask with holes filled: dark pixels inside the balloon that don't connect to its edge (glyph
    // strokes spilling past the detected box, ♡ or !!, screentone specks) count as interior. The outline,
    // and the other half of a shared balloon, connect to the edge of this extent, so they stay outside.
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) mask[y * bw + x] = label[(by + y) * W + bx + x] === s.i ? 1 : 0;
    const outside = new Uint8Array(bw * bh);
    const stack = [];
    const push = (x, y) => { const k = y * bw + x; if (!mask[k] && !outside[k]) { outside[k] = 1; stack.push(k); } };
    for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
    for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
    while (stack.length) {
      const k = stack.pop(), x = k % bw, y = (k / bw) | 0;
      if (x > 0) push(x - 1, y); if (x < bw - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1); if (y < bh - 1) push(x, y + 1);
    }
    for (let k = 0; k < mask.length; k++) if (!outside[k]) mask[k] = 1;

    // Outline test: walk the border of the filled balloon and look 1-2 px outward.
    let edge = 0, dark = 0;
    const darkAt = (gx, gy) => {
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false;
      const q = gy * W + gx;
      if (label[q] >= 0 && label[q] !== s.i) return true;   // a neighbouring text box's share of the balloon
      return lum(data, q * 4) < 140;
    };
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!mask[y * bw + x]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < bw && ny < bh && mask[ny * bw + nx]) continue;
          edge++;
          if (darkAt(bx + nx, by + ny) || darkAt(bx + nx + dx, by + ny + dy)) dark++;
        }
      }
    }
    if (!edge || dark / edge < OUTLINE_SHARE) return { fail: 'no outline around the fill' };

    const d = new Uint16Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!mask[y * bw + x]) continue;
        const up = y ? d[(y - 1) * bw + x] : 0, left = x ? d[y * bw + x - 1] : 0;
        const ul = x && y ? d[(y - 1) * bw + x - 1] : 0, ur = y && x < bw - 1 ? d[(y - 1) * bw + x + 1] : 0;
        d[y * bw + x] = Math.min(up, left, ul, ur) + 1;
      }
    }
    let deepest = 0;
    for (let y = bh - 1; y >= 0; y--) {
      for (let x = bw - 1; x >= 0; x--) {
        const k = y * bw + x;
        if (!d[k]) continue;
        const down = y < bh - 1 ? d[k + bw] : 0, right = x < bw - 1 ? d[k + 1] : 0;
        const dl = y < bh - 1 && x ? d[k + bw - 1] : 0, dr = y < bh - 1 && x < bw - 1 ? d[k + bw + 1] : 0;
        d[k] = Math.min(d[k], Math.min(down, right, dl, dr) + 1);
        if (d[k] > deepest) deepest = d[k];
      }
    }
    // Margin from the outline, so English never touches it.
    const margin = Math.max(2, Math.round(0.06 * Math.min(bw, bh)));
    if (deepest <= margin) return { fail: 'balloon too thin' };
    const inside = (x, y) => d[y * bw + x] > margin;
    // Anchor: the text box's centre, or the nearest point that is far enough inside the balloon.
    const [cy0, cx0, cy1, cx1] = s.box;
    let ax = Math.round((cx0 + cx1) / 2) - bx, ay = Math.round((cy0 + cy1) / 2) - by;
    if (!inside(ax, ay)) {
      let bestD = Infinity, bxx = -1, byy = -1;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        if (!inside(x, y)) continue;
        const dd = (x - ax) ** 2 + (y - ay) ** 2;
        if (dd < bestD) { bestD = dd; bxx = x; byy = y; }
      }
      if (bxx < 0) return { fail: 'balloon too thin' };
      ax = bxx; ay = byy;
    }
    // Horizontal run through the anchor column in each row; rows without one end the rectangle.
    const run = (y) => {
      if (!inside(ax, y)) return null;
      let l = ax, r = ax;
      while (l > 0 && inside(l - 1, y)) l--;
      while (r < bw - 1 && inside(r + 1, y)) r++;
      return [l, r];
    };
    const top = [], bottom = [];   // cumulative [maxLeft, minRight] from the anchor row upward / downward
    for (let y = ay, L = -Infinity, R = Infinity; y >= 0; y--) { const r = run(y); if (!r) break; L = Math.max(L, r[0]); R = Math.min(R, r[1]); top.push([L, R]); }
    for (let y = ay, L = -Infinity, R = Infinity; y < bh; y++) { const r = run(y); if (!r) break; L = Math.max(L, r[0]); R = Math.min(R, r[1]); bottom.push([L, R]); }
    let best = null;
    for (let t = 0; t < top.length; t++) {
      for (let b = 0; b < bottom.length; b++) {
        const L = Math.max(top[t][0], bottom[b][0]), R = Math.min(top[t][1], bottom[b][1]);
        const area = (R - L + 1) * (t + b + 1);
        if (R >= L && (!best || area > best.area)) best = { area, L, R, T: ay - t, B: ay + b };
      }
    }
    const [y0, x0, y1, x1] = s.box;
    const boxArea = (y1 - y0) * (x1 - x0);
    if (!best || best.area < boxArea * 1.1) return { fail: 'no more room than the text box' };
    const norm = (v, n) => Math.round((v / n) * 1000);
    const text = [norm(by + best.T, H), norm(bx + best.L, W), norm(by + best.B + 1, H), norm(bx + best.R + 1, W)];
    // The eraser covers the Japanese: the part of the text box that lies inside the balloon (detected boxes
    // often run past the outline), padded by a pixel, so it never paints over the outline or the art outside.
    let ey0 = Infinity, ex0 = Infinity, ey1 = -1, ex1 = -1;
    for (let y = Math.max(0, y0 - by); y < Math.min(bh, y1 - by); y++) {
      for (let x = Math.max(0, x0 - bx); x < Math.min(bw, x1 - bx); x++) {
        if (!mask[y * bw + x]) continue;
        if (y < ey0) ey0 = y; if (y > ey1) ey1 = y; if (x < ex0) ex0 = x; if (x > ex1) ex1 = x;
      }
    }
    if (ex1 < 0) return { fail: 'text box outside its balloon' };
    const erase = [
      norm(by + Math.max(0, ey0 - 1), H), norm(bx + Math.max(0, ex0 - 1), W),
      norm(by + Math.min(bh, ey1 + 2), H), norm(bx + Math.min(bw, ex1 + 2), W)
    ];
    return { text, erase, gain: +(best.area / boxArea).toFixed(2) };
  }

  return { fit, groundColour };
})();

if (typeof module !== 'undefined') module.exports = Balloon;
