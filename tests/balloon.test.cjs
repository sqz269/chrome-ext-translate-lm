// Balloon fitting on synthetic pages: node --test tests/balloon.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Balloon = require('../balloon.js');

// A W×H page: white background, an oval balloon outline (black, 3 px), optional gap in the outline,
// optional noise background, and dark "glyph" blocks inside the given text boxes (page pixels).
function page({ W = 600, H = 900, cx = 300, cy = 450, rx = 120, ry = 90, gap = false, noise = false, glyphs = [] } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const inner = ((x - cx) / (rx - 3)) ** 2 + ((y - cy) / (ry - 3)) ** 2;
      let v = noise && e > 1 ? Math.floor(rnd() * 255) : 255;
      const onOutline = e <= 1 && inner > 1 && !(gap && y > cy - 15 && y < cy + 15 && x > cx);
      if (onOutline) v = 0;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  for (const [y0, x0, y1, x1] of glyphs) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((x + y) % 4 < 2) { const k = (y * W + x) * 4; data[k] = data[k + 1] = data[k + 2] = 20; }
  }
  return { W, H, data };
}
const norm = (b, W, H) => [b[0] / H * 1000, b[1] / W * 1000, b[2] / H * 1000, b[3] / W * 1000];
const toPx = (b, W, H) => [b[0] / 1000 * H, b[1] / 1000 * W, b[2] / 1000 * H, b[3] / 1000 * W];
const insideOval = ([y0, x0, y1, x1], { cx = 300, cy = 450, rx = 120, ry = 90 } = {}) =>
  [[y0, x0], [y0, x1], [y1, x0], [y1, x1]].every(([y, x]) => ((x - cx) / (rx - 3)) ** 2 + ((y - cy) / (ry - 3)) ** 2 < 1);

test('closed balloon: a vertical text column gets a much larger rectangle inside the oval', () => {
  const col = [390, 290, 510, 312];   // y0, x0, y1, x1 in page pixels: a narrow vertical column
  const px = page({ glyphs: [col] });
  const [res] = Balloon.fit(px, [norm(col, 600, 900)]);
  assert.ok(res && res.text, JSON.stringify(res));
  const rect = toPx(res.text, 600, 900);
  assert.ok(insideOval(rect), `rectangle ${rect} must stay inside the oval`);
  assert.ok(res.gain > 3, `gain ${res.gain}`);
  const [ey0, ex0, ey1, ex1] = toPx(res.erase, 600, 900);
  assert.ok(ey0 <= col[0] && ex0 <= col[1] && ey1 >= col[2] && ex1 >= col[3], 'eraser covers the Japanese');
});

test('tiny text in a big balloon gets most of the balloon', () => {
  const word = [440, 295, 460, 305];
  const [res] = Balloon.fit(page({ glyphs: [word] }), [norm(word, 600, 900)]);
  assert.ok(res && res.text && res.gain > 20, JSON.stringify(res));
});

test('open balloon that leaks into the page background falls back', () => {
  const col = [390, 290, 510, 312];
  const [res] = Balloon.fit(page({ gap: true, glyphs: [col] }), [norm(col, 600, 900)]);
  assert.ok(res && res.fail, JSON.stringify(res));
});

test('two text boxes in one balloon split it without overlapping', () => {
  const a = [400, 240, 500, 260], b = [400, 340, 500, 360];
  const [ra, rb] = Balloon.fit(page({ glyphs: [a, b] }), [norm(a, 600, 900), norm(b, 600, 900)]);
  assert.ok(ra.text && rb.text, JSON.stringify([ra, rb]));
  const [, ax0, , ax1] = toPx(ra.text, 600, 900), [, bx0, , bx1] = toPx(rb.text, 600, 900);
  assert.ok(ax1 <= bx0 + 1 || bx1 <= ax0 + 1, `rectangles overlap: ${ra.text} vs ${rb.text}`);
  assert.ok(ax0 < 300 && bx1 > 300, 'each stays on its own side');
});

test('text on busy art is skipped', () => {
  const box = [100, 20, 140, 60];   // outside the oval, on noise
  const [res] = Balloon.fit(page({ noise: true }), [norm(box, 600, 900)]);
  assert.ok(res && res.fail, JSON.stringify(res));
});

test('null boxes are passed through', () => {
  assert.deepStrictEqual(Balloon.fit(page(), [null]), [null]);
});
