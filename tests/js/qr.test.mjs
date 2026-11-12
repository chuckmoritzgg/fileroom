// Run: node tests/js/qr.test.mjs [out.json]   - then decode with: python tests/js/verify_qr.py out.json
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

globalThis.window = globalThis;
(0, eval)(readFileSync(new URL('../../static/js/qr.js', import.meta.url), 'utf8'));
const QR = globalThis.FileRoomQR;

const samples = [
  'A',
  'https://fileroom.example/room/ABC234#k=Zm9vYmFyYmF6cXV1eGFiY2Q',
  'https://files.example.org/room/M%C3%9CNCHEN-TEAM_2026#k=0123456789abcdefghijkl',
];
// One sample per version 1..13 (largest payload that still fits)
const capacity = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331];
for (let v = 1; v <= 13; v++) samples.push(Array.from({ length: capacity[v] }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789/#=%'[(i * 7 + v) % 40]).join(''));

const out = [];
for (const text of samples) {
  const m = QR.matrix(text);
  assert.ok(m, `fits: ${text.length}`);
  assert.equal(m.length % 4, 1);
  assert.ok(QR.svg(text).startsWith('<svg'));
  out.push({ text, rows: m.map((row) => Array.from(row).join('')) });
}
for (let v = 1; v <= 13; v++) assert.equal(QR.matrix('x'.repeat(capacity[v])).length, v * 4 + 17, `version ${v}`);
assert.equal(QR.matrix('x'.repeat(332)), null); // too long: the caller shows the link only
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`qr tests passed (${out.length} codes)`);
