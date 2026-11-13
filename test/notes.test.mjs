import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentNotes, layoutFold, scoreNote, createPassScorer } from '../notes.js';

const STEP = 16.7;

function frames(spec) {
  const out = [];
  let t = 0;
  for (const [m, ms, db] of spec) {
    const n = Math.round(ms / STEP);
    for (let i = 0; i < n; i++) {
      const level = typeof db === 'function' ? db(i * STEP) : db ?? -25;
      out.push({ t, m: m == null ? NaN : typeof m === 'function' ? m(i * STEP) : m, db: level });
      t += STEP;
    }
  }
  return out;
}

test('melody is split into notes with timing', () => {
  const notes = segmentNotes(frames([[null, 300], [60, 400], [null, 60], [62, 400], [64, 500], [null, 400], [67, 300]]));
  assert.deepEqual(notes.map((n) => n.midi), [60, 62, 64, 67]);
  assert.ok(Math.abs(notes[0].t0 - 300) < 30 && Math.abs(notes[0].t1 - 700) < 40);
  assert.ok(Math.abs(notes[2].t1 - notes[2].t0 - 500) < 40);
});

test('short blips are dropped and brief dropouts are bridged', () => {
  const notes = segmentNotes(frames([[57, 300], [null, 50], [57, 300], [71, 50], [null, 200], [59, 400]]));
  assert.deepEqual(notes.map((n) => n.midi), [57, 59]);
  assert.ok(notes[0].t1 - notes[0].t0 > 600);
});

test('octave slips inside a note and across notes are repaired', () => {
  const inside = segmentNotes(frames([[50, 200], [62, 80], [50, 300]]));
  assert.deepEqual(inside.map((n) => n.midi), [50]);
  const across = segmentNotes(frames([[48, 400], [null, 60], [62, 400], [null, 60], [52, 400], [null, 60], [53, 400]]));
  assert.deepEqual(across.map((n) => n.midi), [48, 50, 52, 53]);
});

test('a real leap of a fifth is kept', () => {
  const notes = segmentNotes(frames([[48, 400], [null, 60], [55, 400], [null, 60], [57, 400]]));
  assert.deepEqual(notes.map((n) => n.midi), [48, 55, 57]);
});

test('a re-struck key becomes two notes', () => {
  const decay = (t) => -20 - t / 25;
  const notes = segmentNotes(frames([[60, 500, decay], [60, 500, decay], [62, 400, decay]]));
  assert.deepEqual(notes.map((n) => n.midi), [60, 60, 62]);
});

test('C goes to the lane nearest its neighbours', () => {
  const up = layoutFold([{ midi: 57 }, { midi: 59 }, { midi: 60 }, { midi: 62 }]);
  assert.deepEqual(up.map((n) => n.pos), [9, 11, 12, 2]);
  const low = layoutFold([{ midi: 48 }, { midi: 50 }, { midi: 52 }]);
  assert.deepEqual(low.map((n) => n.pos), [0, 2, 4]);
});

test('scoop shows up in onset but not in the body', () => {
  const glide = (t) => 60 - 0.6 * Math.exp(-t / 60);
  const f = frames([[glide, 1200]]).map((x) => ({ t: x.t, m: x.m }));
  const r = scoreNote(f, 60);
  assert.ok(r.onset < -25, `onset ${r.onset}`);
  assert.ok(r.err < 6 && Math.abs(r.bias) < 6, `body ${r.err}`);
  assert.ok(r.settle > 40 && r.settle < 250, `settle ${r.settle}`);
});

test('octave does not matter and drift is measured', () => {
  const sag = (t) => 72 - 0.4 * (t / 3000);
  const r = scoreNote(frames([[sag, 3000]]).map((x) => ({ t: x.t, m: x.m })), 48);
  assert.ok(r.drift < -20 && r.drift > -40, `drift ${r.drift}`);
  assert.ok(Math.abs(r.onset) < 5);
});

test('pass scorer grades each note', () => {
  const notes = [{ midi: 60 }, { midi: 62 }, { midi: 64 }];
  const s = createPassScorer(notes);
  for (let i = 0; i < 30; i++) {
    s.feed(0, 60.05);
    s.feed(1, 61.6);
    s.feed(2, i < 25 ? NaN : 64);
  }
  assert.equal(s.result(0).cls, 'good');
  assert.equal(s.result(1).cls, 'warn');
  assert.equal(s.result(2).cls, 'miss');
  assert.ok(Math.abs(s.total() - 35 / 90) < 1e-9);
});
