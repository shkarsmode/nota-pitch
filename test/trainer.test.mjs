import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProfile, normalize, fitRange, planSession, needOrder, judge, record, finishBlock, summary, dayKey, dayNum, SKILL_ORDER } from '../trainer.js';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const fresh = () => {
  const p = newProfile();
  p.range = fitRange(48, 62);
  return p;
};

const good = { onset: 3, err: 8, bias: 2, inTol: 0.97, drift: 2, wobble: 6, settle: 0, dur: 1400 };

test('range is widened or narrowed to something singable', () => {
  assert.deepEqual(fitRange(55, 57), { lo: 52, hi: 61 });
  assert.deepEqual(fitRange(64, 50), { lo: 50, hi: 64 });
  const wide = fitRange(40, 76);
  assert.equal(wide.hi - wide.lo, 19);
});

test('first session covers every skill inside the range', () => {
  for (let seed = 1; seed < 40; seed++) {
    const p = fresh();
    const plan = planSession(p, rng(seed));
    assert.ok(plan.blocks[0].warmup);
    for (const s of SKILL_ORDER) assert.ok(plan.blocks.some((b) => b.skill === s && !b.warmup), s);
    assert.ok(plan.est > 6 * 60 && plan.est < 11 * 60, `est ${plan.est}`);
    for (const b of plan.blocks) {
      for (const t of b.trials) {
        const all = t.notes ? t.notes.map((n) => n.midi) : [t.target, ...(t.cue || [])];
        for (const n of all) assert.ok(n >= p.range.lo && n <= p.range.hi, `${b.skill} ${n}`);
      }
    }
  }
});

test('judgements name the actual problem', () => {
  assert.equal(judge('match', good).text, 'Точно в ноту');
  assert.equal(judge('match', { ...good, err: 34, bias: -34 }).text, 'Низковато');
  assert.equal(judge('match', { ...good, err: 210, bias: 210 }).text, 'Мимо ноты');
  assert.match(judge('match', { ...good, err: 210, bias: 210 }).sub, /2 полутона выше/);
  const scoop = judge('attack', { ...good, onset: -48 });
  assert.equal(scoop.text, 'Подъезд снизу');
  assert.equal(scoop.hit, false);
  assert.equal(judge('attack', good).text, 'Сразу в ноту');
  assert.equal(judge('hold', { ...good, inTol: 0.6, drift: -31 }).text, 'Просела к концу');
  assert.equal(judge('hold', good).hit, true);
  const phrase = judge('phrase', [{ cls: 'good', err: 8, bias: 3 }, { cls: 'good', err: 10, bias: -4 }, { cls: 'bad', err: 70, bias: -70 }]);
  assert.equal(phrase.hit, true);
  assert.match(phrase.text, /2 из 3/);
});

test('weak skill and weak notes get more practice', () => {
  const p = fresh();
  const key = '2026-11-13';
  const plan = planSession(p, rng(3));
  for (const b of plan.blocks) {
    for (const t of b.trials) {
      if (t.skill === 'phrase') {
        const r = t.notes.map(() => ({ cls: 'good', err: 9, bias: 1, cover: 1 }));
        record(p, key, t, judge('phrase', r), r);
      } else {
        const r = t.skill === 'attack' ? { ...good, onset: -70 } : t.target === 55 ? { ...good, err: 60, bias: -60 } : good;
        record(p, key, t, judge(t.skill, r));
      }
    }
  }
  assert.equal(needOrder(p, rng(1))[0], 'attack');
  assert.ok(p.noteErr[55] > 30);
  let count55 = 0;
  let total = 0;
  for (let seed = 1; seed <= 60; seed++) {
    for (const b of planSession(p, rng(seed)).blocks.filter((x) => x.skill === 'match' && !x.warmup)) {
      for (const t of b.trials) {
        total++;
        if (t.target === 55) count55++;
      }
    }
  }
  const uniform = total / (p.range.hi - p.range.lo + 1);
  assert.ok(count55 > uniform * 1.3, `${count55} vs ${uniform}`);
  const next = planSession(p, rng(9));
  assert.ok(next.blocks.filter((b) => b.skill === 'attack').length >= 2);
  const s = summary(p, key);
  assert.ok(s.insights.some((i) => i.kind === 'scoop'));
  assert.equal(s.weakest, 'attack');
});

test('levels move with the hit rate', () => {
  const p = fresh();
  assert.equal(finishBlock(p, { skill: 'match' }, 9, 10).change, 1);
  assert.equal(p.level.match, 2);
  assert.equal(finishBlock(p, { skill: 'match' }, 3, 10).change, -1);
  assert.equal(finishBlock(p, { skill: 'match', warmup: true }, 4, 4).change, 0);
  assert.equal(p.level.match, 1);
});

test('summary tracks streak, week and improvement', () => {
  const p = fresh();
  const today = dayNum('2026-11-13');
  const errs = [40, 36, 30, null, 26, 22];
  errs.forEach((e, i) => {
    if (e == null) return;
    const key = dayKey(today - (errs.length - 1 - i));
    for (let k = 0; k < 20; k++) record(p, key, { skill: 'match', target: 55 }, judge('match', { ...good, err: e, bias: -e }));
  });
  const s = summary(p, '2026-11-13');
  assert.equal(s.streak, 2);
  assert.equal(s.total, 5);
  assert.equal(s.week.filter((d) => d.done).length, 4);
  assert.equal(s.week[4].today, true);
  assert.equal(s.compare.kind, 'start');
  assert.ok(Math.abs(s.compare.err[0] - 40) < 1e-6 && Math.abs(s.compare.err[1] - 22) < 1e-6);
  assert.equal(s.chart.length, 14);
  assert.ok(s.chart[13].score > s.chart[8].score);
  assert.ok(s.insights.some((i) => i.kind === 'flat'));
  const copy = normalize(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(summary(copy, '2026-11-13'), s);
});
