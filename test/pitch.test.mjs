import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPitchDetector } from '../pitch.js';

const cents = (a, b) => 1200 * Math.log2(a / b);

function tone(f, amps, sr, size, { start = 0, vib = 0, rate = 5.5 } = {}) {
  const buf = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const t = (start + i) / sr;
    const ph = 2 * Math.PI * f * t - ((vib * f) / rate) * Math.cos(2 * Math.PI * rate * t);
    for (let k = 0; k < amps.length; k++) buf[i] += amps[k] * Math.sin((k + 1) * ph + 0.4 * k);
  }
  return buf;
}

for (const sr of [44100, 48000]) {
  test(`sine accuracy at ${sr} Hz`, () => {
    const detect = createPitchDetector(sr, 2048);
    for (const f of [82.41, 110, 146.83, 196, 261.63, 349.23, 440, 659.25, 880, 1046.5]) {
      const r = detect(tone(f, [0.4], sr, 2048));
      assert.ok(Math.abs(cents(r.freq, f)) < 1.5, `${f} Hz -> ${r.freq}`);
      assert.ok(r.clarity > 0.95, `${f} Hz clarity ${r.clarity}`);
    }
  });

  test(`voice-like tone with weak fundamental keeps the octave at ${sr} Hz`, () => {
    const detect = createPitchDetector(sr, 2048);
    for (const f of [98, 130.81, 196, 293.66, 392]) {
      const r = detect(tone(f, [0.15, 1, 0.7, 0.5, 0.35, 0.2, 0.1], sr, 2048));
      assert.ok(Math.abs(cents(r.freq, f)) < 3, `${f} Hz -> ${r.freq}`);
    }
  });
}

test('vibrato of ±30 cents is tracked without jumps', () => {
  const sr = 48000;
  const detect = createPitchDetector(sr, 2048);
  for (let s = 0; s < 40; s++) {
    const r = detect(tone(220, [1, 0.6, 0.4, 0.2], sr, 2048, { start: s * 800, vib: 0.0175 }));
    assert.ok(Math.abs(cents(r.freq, 220)) < 40, `frame ${s}: ${r.freq}`);
  }
});

test('noise is not confident and silence is empty', () => {
  const detect = createPitchDetector(48000, 2048);
  let seed = 7;
  const noise = new Float32Array(2048).map(() => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  });
  assert.ok(detect(noise).clarity < 0.7);
  const silence = detect(new Float32Array(2048));
  assert.equal(silence.freq, 0);
  assert.equal(silence.rms, 0);
});

test('dc offset does not change the result', () => {
  const detect = createPitchDetector(48000, 2048);
  const buf = tone(330, [0.5, 0.2], 48000, 2048).map((v) => v + 0.3);
  assert.ok(Math.abs(cents(detect(buf).freq, 330)) < 1.5);
});
