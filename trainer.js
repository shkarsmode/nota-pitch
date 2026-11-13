export const HIT = 25;
export const GREAT = 12;
export const SKILL_ORDER = ['match', 'attack', 'hold', 'interval', 'phrase'];

export const SKILLS = {
  match: {
    name: 'Попадание',
    title: 'Попади в ноту',
    hint: 'Прозвучит нота. Спой её и потяни, пока полоска не заполнится.',
    count: 10,
    sec: 5.5,
  },
  attack: {
    name: 'Точный вход',
    title: 'Точный вход',
    hint: 'Спой ноту три раза коротко: «та · та · та». Бей в неё сразу, без подъезда снизу.',
    count: 8,
    sec: 8,
  },
  hold: {
    name: 'Ровная нота',
    title: 'Ровная нота',
    hint: 'Тяни ноту ровно до конца полоски. Не давай ей просесть или уплыть.',
    count: 6,
    sec: 8,
  },
  interval: {
    name: 'Интервалы',
    title: 'Интервалы',
    hint: 'Сначала звучит опорная нота. Спой ту, что подсвечена, без подсказки звуком. Потом услышишь правильный ответ.',
    count: 10,
    sec: 7.5,
  },
  phrase: {
    name: 'Фразы',
    title: 'Фраза',
    hint: 'Послушай фразу, потом спой её вместе с бегущими полосками.',
    count: 6,
    sec: 9,
  },
};

export const IV_NAMES = {
  1: 'малая секунда',
  2: 'большая секунда',
  3: 'малая терция',
  4: 'большая терция',
  5: 'кварта',
  6: 'тритон',
  7: 'квинта',
  8: 'малая секста',
  9: 'большая секста',
  10: 'малая септима',
  11: 'большая септима',
};

const INTERVALS = [
  [2, 4, 7, -2, 5],
  [3, -3, -4, -5, 9, -7],
  [1, -1, 6, 8, 10, 11, -9],
];
const PHRASES = [
  [[0, 2, 4], [4, 2, 0], [0, 2, 0], [2, 4, 5], [5, 4, 2]],
  [[0, 4, 7, 4], [0, 2, 4, 5], [7, 5, 4, 2], [0, 4, 2, 5], [5, 2, 4, 0]],
  [[0, 4, 7, 9, 7], [9, 7, 4, 2, 0], [0, 5, 4, 7, 2], [0, 3, 7, 5, 2], [7, 3, 5, 2, 0]],
];
const NOTE_MS = [700, 600, 520];
const HOLD_MS = [3000, 4500, 6000];
const WARMUP = 4;
const INTRO_SEC = 6;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ema = (old, v, k) => (old == null ? v : old + (v - old) * k);
export const scoreOf = (err) => clamp(Math.round(100 - err * 1.6), 0, 100);

export function dayNum(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayKey(num) {
  return new Date(num * 86400000).toISOString().slice(0, 10);
}

export function newProfile() {
  return {
    v: 1,
    range: null,
    level: { match: 1, attack: 1, hold: 1, interval: 1, phrase: 1 },
    noteErr: {},
    ivErr: {},
    skill: {},
    days: [],
    sessions: 0,
    last: null,
  };
}

export function normalize(raw) {
  const p = newProfile();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return p;
  if (raw.range && Number.isFinite(raw.range.lo) && Number.isFinite(raw.range.hi)) p.range = fitRange(raw.range.lo, raw.range.hi);
  for (const s of SKILL_ORDER) {
    const l = raw.level && raw.level[s];
    if (l === 1 || l === 2 || l === 3) p.level[s] = l;
    const k = raw.skill && raw.skill[s];
    if (k && Number.isFinite(k.err)) p.skill[s] = { err: k.err, n: k.n | 0 };
  }
  for (const key of ['noteErr', 'ivErr']) {
    for (const [n, v] of Object.entries(raw[key] || {})) if (Number.isFinite(v)) p[key][n] = v;
  }
  if (Array.isArray(raw.days)) p.days = raw.days.filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.d) && d.n > 0).slice(-400);
  p.sessions = raw.sessions | 0;
  p.last = raw.last || null;
  return p;
}

export function fitRange(a, b) {
  let lo = Math.round(Math.min(a, b));
  let hi = Math.round(Math.max(a, b));
  if (hi - lo < 9) {
    lo = Math.round((lo + hi) / 2 - 4.5);
    hi = lo + 9;
  }
  if (hi - lo > 19) {
    lo = Math.round((lo + hi) / 2 - 9.5);
    hi = lo + 19;
  }
  return { lo, hi };
}

function weighted(items, weights, rng) {
  let total = 0;
  for (const w of weights) total += w;
  let x = rng() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pool(p, narrow) {
  const { lo, hi } = p.range;
  const pad = narrow ? Math.round((hi - lo) * 0.2) : 0;
  const out = [];
  for (let n = lo + pad; n <= hi - pad; n++) out.push(n);
  return out;
}

function pickNote(p, notes, prev, maxJump, rng) {
  let c = notes.filter((n) => n !== prev && (prev == null || maxJump == null || Math.abs(n - prev) <= maxJump));
  if (!c.length) c = notes.filter((n) => n !== prev);
  if (!c.length) c = notes;
  return weighted(c, c.map((n) => 1 + Math.min(3, (p.noteErr[n] ?? 25) / 20)), rng);
}

function makeTrials(p, skill, level, count, rng) {
  const out = [];
  const { lo, hi } = p.range;
  let prev = null;
  for (let i = 0; i < count; i++) {
    if (skill === 'interval') {
      const ivs = INTERVALS.slice(0, level).flat();
      let trial = null;
      for (let tries = 0; tries < 12 && !trial; tries++) {
        const iv = weighted(ivs, ivs.map((v) => 1 + Math.min(3, (p.ivErr[v] ?? 25) / 20)), rng);
        const tonics = [];
        for (let n = lo; n <= hi; n++) if (n + iv >= lo && n + iv <= hi && n !== prev) tonics.push(n);
        if (!tonics.length) continue;
        const tonic = tonics[Math.floor(rng() * tonics.length)];
        trial = { skill, tonic, iv, target: tonic + iv, cue: [tonic], holdMs: 1300, hide: level >= 3, check: true };
        prev = tonic;
      }
      if (trial) out.push(trial);
    } else if (skill === 'phrase') {
      const set = PHRASES[level - 1];
      const shape = set[Math.floor(rng() * set.length)];
      const span = Math.max(...shape);
      const roots = [];
      for (let n = lo; n + span <= hi; n++) roots.push(n);
      const root = roots.length ? roots[Math.floor(rng() * roots.length)] : lo;
      const ms = NOTE_MS[level - 1];
      out.push({
        skill,
        target: null,
        ms,
        notes: shape.map((s, k) => ({ t0: k * (ms + 80), t1: k * (ms + 80) + ms, midi: root + s })),
      });
    } else {
      const target = pickNote(p, pool(p, level === 1), prev, level === 1 ? 5 : null, rng);
      prev = target;
      if (skill === 'match') out.push({ skill, target, cue: [target], holdMs: 1400, hide: level >= 3 });
      else if (skill === 'attack') out.push({ skill, target, cue: [target], hits: 3, hide: level >= 3 });
      else out.push({ skill, target, cue: [target], holdMs: HOLD_MS[level - 1] });
    }
  }
  return out;
}

export function scoopOf(p) {
  let n = 0;
  let s = 0;
  for (const d of p.days.slice(-5)) {
    n += d.onN;
    s += d.onS;
  }
  return n >= 6 ? s / n : 0;
}

export function needOrder(p, rng = Math.random) {
  const practiced = SKILL_ORDER.some((s) => p.skill[s]);
  if (!practiced) return SKILL_ORDER.slice();
  const scoop = scoopOf(p) < -15 ? 0.25 : 0;
  return SKILL_ORDER.map((s) => {
    const k = p.skill[s];
    return { s, need: (k ? 1 - scoreOf(k.err) / 100 : 0.7) + (s === 'attack' ? scoop : 0) + rng() * 0.08 };
  })
    .sort((a, b) => b.need - a.need)
    .map((x) => x.s);
}

export function planSession(p, rng = Math.random, minutes = 9, order = needOrder(p, rng)) {
  const blocks = [];
  let est = 0;
  const add = (skill, level, count, extra) => {
    const trials = makeTrials(p, skill, level, count, rng);
    if (!trials.length) return;
    const sec = trials.length * (skill === 'hold' ? 4 + HOLD_MS[level - 1] / 1000 : SKILLS[skill].sec) + INTRO_SEC;
    est += sec;
    blocks.push({ skill, level, trials, ...extra });
  };
  add('match', 1, WARMUP, { warmup: true });
  const first = !SKILL_ORDER.some((s) => p.skill[s]);
  for (const s of order) add(s, p.level[s], SKILLS[s].count);
  const focus = first ? ['attack', 'match'] : order.slice(0, 2);
  for (const s of focus) {
    if (est >= minutes * 60 - 45) break;
    add(s, p.level[s], SKILLS[s].count, { focus: true });
  }
  return { blocks, est, focus: order[0] };
}

const sign = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}¢`;

export function judge(skill, r) {
  if (skill === 'phrase') {
    const sung = r.filter((x) => x && x.cls !== 'miss');
    const good = r.filter((x) => x && x.cls === 'good').length;
    const main = r.reduce((s, x) => s + (x && x.cls !== 'miss' ? Math.min(100, x.err) : 60), 0) / r.length;
    const bias = sung.length ? sung.reduce((s, x) => s + x.bias, 0) / sung.length : null;
    const hit = good / r.length >= 0.66;
    return {
      hit,
      cls: hit ? 'good' : good / r.length >= 0.34 ? 'warn' : 'bad',
      text: `${good} из ${r.length} нот в точку`,
      sub: sung.length < r.length ? 'часть нот не спета' : bias == null ? '' : `в среднем ${sign(bias)}`,
      main,
      err: main,
      bias,
    };
  }
  const wrong = Math.abs(r.bias) > 60;
  const steps = Math.round(Math.abs(r.bias) / 100);
  const off = wrong
    ? { text: 'Мимо ноты', sub: steps >= 1 ? `спел на ${steps} ${steps === 1 ? 'полутон' : steps < 5 ? 'полутона' : 'полутонов'} ${r.bias < 0 ? 'ниже' : 'выше'}` : `${sign(r.bias)}` }
    : null;

  if (skill === 'attack') {
    const hit = !wrong && Math.abs(r.onset) <= 30 && r.err <= 40;
    const base = { hit, main: Math.min(150, Math.abs(r.onset)), err: r.err, onset: r.onset, bias: r.bias };
    if (off) return { ...base, cls: 'bad', ...off };
    if (r.onset < -30) return { ...base, cls: r.onset < -60 ? 'bad' : 'warn', text: 'Подъезд снизу', sub: `на входе ${sign(r.onset)}` };
    if (r.onset > 30) return { ...base, cls: r.onset > 60 ? 'bad' : 'warn', text: 'Вход сверху', sub: `на входе ${sign(r.onset)}` };
    if (!hit) return { ...base, cls: 'warn', text: r.bias < 0 ? 'Низковато' : 'Высоковато', sub: sign(r.bias) };
    return { ...base, cls: 'good', text: 'Сразу в ноту', sub: `на входе ${sign(r.onset)}` };
  }

  if (skill === 'hold') {
    const hit = !wrong && r.inTol >= 0.8 && Math.abs(r.drift) <= 20;
    const base = { hit, main: Math.min(100, r.err + Math.abs(r.drift) / 2), err: r.err, onset: r.onset, bias: r.bias };
    const pct = `${Math.round(r.inTol * 100)}% в ноте`;
    if (off) return { ...base, cls: 'bad', ...off };
    if (hit) return { ...base, cls: 'good', text: 'Ровно', sub: pct };
    if (r.drift < -20) return { ...base, cls: 'warn', text: 'Просела к концу', sub: `${sign(r.drift)} · ${pct}` };
    if (r.drift > 20) return { ...base, cls: 'warn', text: 'Уплыла вверх', sub: `${sign(r.drift)} · ${pct}` };
    if (r.wobble > 30) return { ...base, cls: 'warn', text: 'Плавает', sub: `±${Math.round(r.wobble)}¢ · ${pct}` };
    return { ...base, cls: r.err > 50 ? 'bad' : 'warn', text: r.bias < 0 ? 'Низковато' : 'Высоковато', sub: `${sign(r.bias)} · ${pct}` };
  }

  const hit = !wrong && r.err <= HIT && Math.abs(r.bias) <= HIT;
  const base = { hit, main: Math.min(100, r.err), err: r.err, onset: r.onset, bias: r.bias };
  if (off) return { ...base, cls: 'bad', ...off };
  const scoop = r.onset < -35 ? ' · вошёл снизу' : '';
  if (hit) return { ...base, cls: 'good', text: r.err <= GREAT ? 'Точно в ноту' : 'В ноту', sub: sign(r.bias) + scoop };
  return {
    ...base,
    cls: r.err > 50 ? 'bad' : 'warn',
    text: r.bias < 0 ? 'Низковато' : 'Высоковато',
    sub: `${sign(r.bias)} · ${r.bias < 0 ? 'тянись выше' : 'опусти'}`,
  };
}

function dayOf(p, key) {
  let d = p.days[p.days.length - 1];
  if (!d || d.d !== key) {
    d = { d: key, t: 0, n: 0, err: 0, hit: 0, on: 0, onS: 0, onN: 0, bias: 0, biasN: 0, sk: {} };
    p.days.push(d);
  }
  return d;
}

export function record(p, key, trial, j, notes) {
  if (trial.skill === 'phrase') {
    (notes || []).forEach((x, i) => {
      if (!x || x.cls === 'miss') return;
      const n = trial.notes[i].midi;
      p.noteErr[n] = ema(p.noteErr[n], Math.min(100, x.err), 0.3);
    });
  } else {
    p.noteErr[trial.target] = ema(p.noteErr[trial.target], Math.min(100, j.err), 0.3);
    if (trial.skill === 'interval') p.ivErr[trial.iv] = ema(p.ivErr[trial.iv], Math.min(100, j.err), 0.3);
  }
  const s = p.skill[trial.skill] || (p.skill[trial.skill] = { err: null, n: 0 });
  s.err = ema(s.err, j.main, 0.15);
  s.n++;
  const d = dayOf(p, key);
  d.n++;
  d.err += Math.min(100, j.err);
  if (j.hit) d.hit++;
  if (j.onset != null && trial.skill !== 'phrase') {
    d.on += Math.min(150, Math.abs(j.onset));
    d.onS += clamp(j.onset, -150, 150);
    d.onN++;
  }
  if (j.bias != null) {
    d.bias += clamp(j.bias, -100, 100);
    d.biasN++;
  }
  const k = d.sk[trial.skill] || (d.sk[trial.skill] = { n: 0, err: 0, hit: 0 });
  k.n++;
  k.err += j.main;
  if (j.hit) k.hit++;
}

export function finishBlock(p, block, hits, total) {
  const rate = total ? hits / total : 0;
  let change = 0;
  if (!block.warmup && total >= 4) {
    if (rate >= 0.8 && p.level[block.skill] < 3) change = 1;
    else if (rate <= 0.4 && p.level[block.skill] > 1) change = -1;
    p.level[block.skill] += change;
  }
  return { rate, change };
}

export function addTime(p, key, seconds) {
  dayOf(p, key).t += Math.round(seconds);
}

const meanErr = (days) => {
  let n = 0;
  let e = 0;
  for (const d of days) {
    n += d.n;
    e += d.err;
  }
  return n ? e / n : null;
};

const meanOn = (days) => {
  let n = 0;
  let e = 0;
  for (const d of days) {
    n += d.onN;
    e += d.on;
  }
  return n ? e / n : null;
};

export function summary(p, todayKey) {
  const today = dayNum(todayKey);
  const byNum = new Map(p.days.map((d) => [dayNum(d.d), d]));
  const done = (n) => byNum.has(n);

  let streak = 0;
  for (let n = done(today) ? today : today - 1; done(n); n--) streak++;

  const weekday = (new Date(today * 86400000).getUTCDay() + 6) % 7;
  const week = Array.from({ length: 7 }, (_, i) => {
    const n = today - weekday + i;
    return { done: done(n), today: n === today, future: n > today };
  });

  const chart = Array.from({ length: 14 }, (_, i) => {
    const n = today - 13 + i;
    const d = byNum.get(n);
    return { d: dayKey(n), score: d ? scoreOf(d.err / d.n) : null, today: n === today };
  });

  const solid = p.days.filter((d) => d.n >= 5);
  let compare = null;
  if (solid.length >= 2) {
    const cur = solid.filter((d) => dayNum(d.d) > today - 7);
    const old = solid.filter((d) => dayNum(d.d) <= today - 7 && dayNum(d.d) > today - 14);
    const [a, b, kind] = cur.length && old.length ? [old, cur, 'week'] : [[solid[0]], [solid[solid.length - 1]], 'start'];
    compare = { kind, days: solid.length, err: [meanErr(a), meanErr(b)], on: [meanOn(a), meanOn(b)] };
  }

  const recent = p.days.slice(-5);
  const sum = (f) => recent.reduce((s, d) => s + f(d), 0);
  const insights = [];
  const biasN = sum((d) => d.biasN);
  if (scoopOf(p) < -15) insights.push({ kind: 'scoop', v: scoopOf(p) });
  if (biasN >= 10) {
    const b = sum((d) => d.bias) / biasN;
    if (b < -10) insights.push({ kind: 'flat', v: b });
    else if (b > 10) insights.push({ kind: 'sharp', v: b });
  }
  const hard = Object.entries(p.noteErr)
    .filter(([, v]) => v > 28)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 2)
    .map(([n]) => Number(n));
  if (hard.length) insights.push({ kind: 'notes', notes: hard });
  const iv = Object.entries(p.ivErr)
    .filter(([, v]) => v > 28)
    .sort((x, y) => y[1] - x[1])[0];
  if (iv) insights.push({ kind: 'iv', iv: Number(iv[0]) });

  const skills = SKILL_ORDER.map((id) => ({
    id,
    name: SKILLS[id].name,
    level: p.level[id],
    score: p.skill[id] ? scoreOf(p.skill[id].err) : null,
  }));
  const rated = skills.filter((s) => s.score != null);
  const weakest = rated.length >= 2 ? rated.reduce((a, b) => (b.score < a.score ? b : a)).id : null;

  const t = byNum.get(today);
  return {
    streak,
    week,
    chart,
    compare,
    insights,
    skills,
    weakest,
    total: p.days.length,
    today: t ? { n: t.n, err: t.err / t.n, hit: t.hit / t.n, t: t.t, score: scoreOf(t.err / t.n) } : null,
  };
}
