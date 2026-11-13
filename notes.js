import { foldDev, mean, pcOf } from './music.js';

export function segmentNotes(frames, { minDur = 110, bridge = 130, splitDb = 7 } = {}) {
  const runs = [];
  let run = null;
  let recent = [];
  const close = () => {
    if (run && run.t1 - run.t0 >= minDur - 20) runs.push(run);
    run = null;
  };
  for (const f of frames) {
    if (Number.isNaN(f.m)) {
      if (run && f.t - run.t1 > bridge) close();
      continue;
    }
    if (run) {
      const same = Math.abs(foldDev(f.m, run.base + run.sum / run.n)) < 0.65;
      let strike = false;
      if (f.db != null && f.t - run.t0 > 180) {
        let lo = Infinity;
        let cnt = 0;
        for (const r of recent) {
          const age = f.t - r.t;
          if (age >= 30 && age <= 150) {
            lo = Math.min(lo, r.db);
            cnt++;
          }
        }
        strike = cnt >= 2 && f.db - lo >= splitDb;
      }
      if (!same || f.t - run.t1 > bridge || strike) close();
    }
    if (!run) {
      run = { t0: f.t, t1: f.t, base: f.m, sum: 0, n: 0, oct: new Map() };
      recent = [];
    }
    const d = foldDev(f.m, run.base);
    run.sum += d;
    run.n++;
    const o = Math.round((f.m - run.base - d) / 12);
    run.oct.set(o, (run.oct.get(o) || 0) + 1);
    run.t1 = f.t;
    if (f.db != null) {
      recent.push({ t: f.t, db: f.db });
      if (recent.length > 24) recent.shift();
    }
  }
  close();

  const notes = runs.map((r) => {
    let best = 0;
    let votes = -1;
    for (const [o, c] of r.oct) {
      if (c > votes) {
        votes = c;
        best = o;
      }
    }
    return { t0: r.t0, t1: r.t1 + 17, midi: Math.round(r.base + r.sum / r.n + 12 * best) };
  });

  for (let i = 1; i + 1 < notes.length; i++) {
    const prev = notes[i - 1].midi;
    const next = notes[i + 1].midi;
    const c = notes[i].midi;
    if (Math.abs(c - prev) <= 7 || Math.abs(c - next) <= 7) continue;
    for (const k of [-12, 12]) {
      if (Math.abs(c + k - prev) <= 7 && Math.abs(c + k - next) <= 7) {
        notes[i].midi = c + k;
        break;
      }
    }
  }
  return notes;
}

export function layoutFold(notes) {
  let prev = null;
  notes.forEach((n, i) => {
    const pc = pcOf(n.midi);
    if (pc !== 0) n.pos = pc;
    else {
      let ref = prev;
      if (ref == null) {
        const nx = notes.slice(i + 1).find((x) => pcOf(x.midi) !== 0);
        ref = nx ? pcOf(nx.midi) : 0;
      }
      n.pos = ref > 6 ? 12 : 0;
    }
    prev = n.pos;
  });
  return notes;
}

export function scoreNote(frames, target, tol = 25) {
  if (!frames || frames.length < 3) return null;
  const t0 = frames[0].t;
  const dur = frames[frames.length - 1].t - t0;
  const dev = frames.map((f) => foldDev(f.m, target) * 100);
  const head = dev.filter((_, i) => frames[i].t - t0 <= 80);
  const onset = mean(head.length >= 3 ? head : dev.slice(0, 3));
  const from = Math.min(250, dur * 0.4);
  let body = dev.filter((_, i) => frames[i].t - t0 >= from);
  if (body.length < 2) body = dev;
  const err = mean(body.map(Math.abs));
  const bias = mean(body);
  const inTol = body.filter((d) => Math.abs(d) <= tol).length / body.length;
  const third = Math.max(1, Math.floor(body.length / 3));
  const drift = body.length >= 6 ? mean(body.slice(-third)) - mean(body.slice(0, third)) : 0;
  const wobble = Math.sqrt(mean(body.map((d) => (d - bias) ** 2)));
  let settle = null;
  for (let i = 0; i < frames.length && settle == null; i++) {
    let ok = true;
    let seen = 0;
    for (let j = i; j < frames.length && frames[j].t - frames[i].t <= 100; j++) {
      seen++;
      if (Math.abs(dev[j]) > tol * 1.2) {
        ok = false;
        break;
      }
    }
    if (ok && seen >= 2) settle = frames[i].t - t0;
  }
  return { onset, err, bias, inTol, drift, wobble, settle, dur };
}

export function activeTarget(notes, lt, m, linger = 130) {
  let best = null;
  let bestDev = Infinity;
  const blind = m == null || Number.isNaN(m);
  for (const n of notes) {
    if (lt < n.t0 || lt >= n.t1 + linger) continue;
    if (blind) {
      if (lt < n.t1) return n;
      if (!best) best = n;
      continue;
    }
    const d = Math.abs(foldDev(m, n.midi));
    if (d < bestDev) {
      bestDev = d;
      best = n;
    }
  }
  return best;
}

export function createPassScorer(notes, tol = 25) {
  const acc = notes.map(() => ({ frames: 0, voiced: 0, good: 0, sum: 0, abs: 0 }));
  return {
    feed(i, m) {
      const a = acc[i];
      a.frames++;
      if (Number.isNaN(m)) return;
      const d = foldDev(m, notes[i].midi) * 100;
      a.voiced++;
      a.sum += d;
      a.abs += Math.abs(d);
      if (Math.abs(d) <= tol) a.good++;
    },
    result(i) {
      const a = acc[i];
      if (!a.frames) return null;
      const cover = a.voiced / a.frames;
      const err = a.voiced ? a.abs / a.voiced : null;
      const cls = cover < 0.35 ? 'miss' : err <= tol ? 'good' : err <= tol * 2 ? 'warn' : 'bad';
      return { cover, err, bias: a.voiced ? a.sum / a.voiced : 0, hit: a.good / a.frames, cls };
    },
    total() {
      let f = 0;
      let g = 0;
      for (const a of acc) {
        f += a.frames;
        g += a.good;
      }
      return f ? g / f : 0;
    },
  };
}
