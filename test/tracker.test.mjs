import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../tracker.js';
import { foldDev, foldPos } from '../music.js';

const run = (values, step = 16.7) => {
  const tr = createTracker();
  return values.map((v, i) => tr.push(i * step, v));
};

test('steady note passes through after three frames', () => {
  const out = run(Array(10).fill(57.1));
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.ok(out.slice(2).every((v) => Math.abs(v - 57.1) < 1e-9));
});

test('a short octave blip is held at the previous octave', () => {
  const out = run([...Array(8).fill(53), 65, 65, 65, ...Array(6).fill(53)]);
  assert.ok(out.slice(2).every((v) => Math.abs(v - 53) < 1e-9), out.join(','));
});

test('a sustained octave leap is accepted', () => {
  const out = run([...Array(8).fill(48), ...Array(30).fill(60)]);
  assert.equal(out[out.length - 1], 60);
  const firstHigh = out.findIndex((v) => v === 60);
  assert.ok(firstHigh > 8 && firstHigh < 24, `switched at ${firstHigh}`);
});

test('scattered garbage between notes is rejected', () => {
  const out = run([...Array(6).fill(50), 61.3, 44.2, 70.9, 38.5, 66.6, ...Array(6).fill(52)]);
  const seen = out.filter((v) => !Number.isNaN(v)).map((v) => Math.round(v));
  assert.deepEqual([...new Set(seen)], [50, 52]);
});

test('a scoop is still tracked', () => {
  const glide = Array.from({ length: 12 }, (_, i) => 59 + i / 11);
  const out = run([...glide, ...Array(6).fill(60)]);
  const voiced = out.filter((v) => !Number.isNaN(v));
  assert.ok(voiced[0] < 59.4 && voiced[voiced.length - 1] === 60);
  for (let i = 1; i < voiced.length; i++) assert.ok(voiced[i] >= voiced[i - 1] - 1e-9);
});

test('fold helpers wrap around the octave', () => {
  assert.ok(Math.abs(foldDev(72.2, 48) - 0.2) < 1e-9);
  assert.ok(Math.abs(foldDev(59.9, 48) + 0.1) < 1e-9);
  assert.ok(Math.abs(foldPos(59.8, 11) - 11.8) < 1e-9);
  assert.ok(Math.abs(foldPos(59.8, 1) + 0.2) < 1e-9);
  assert.ok(Math.abs(foldPos(60.2, 11) - 12.2) < 1e-9);
  assert.ok(Math.abs(foldPos(60.2, 2) - 0.2) < 1e-9);
  assert.ok(Math.abs(foldPos(64.3, 12) - 4.3) < 1e-9);
});
