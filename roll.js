import { BLACK, FONT, pcOf } from './music.js';

export const KEY_W = 58;

const C = {
  bg: '#0b0f14',
  lane: '#111924',
  laneDark: '#0c121a',
  mid: 'rgba(255,255,255,0.07)',
  octave: 'rgba(255,255,255,0.18)',
  grid: 'rgba(255,255,255,0.035)',
  keyWhite: '#1d2736',
  keyBlack: '#10161f',
  label: '#c6d1e0',
  labelDim: '#74839a',
  ink: '#0b0f14',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  ref: '#60a5fa',
  accent: '#a78bfa',
  todo: '#a78bfa',
};
const RGB = {
  good: '52,211,153',
  warn: '251,191,36',
  bad: '248,113,113',
  ref: '96,165,250',
  accent: '167,139,250',
  todo: '167,139,250',
};

export function createRoll(canvas) {
  const g = canvas.getContext('2d');
  const size = { w: 0, h: 0, dpr: 1 };

  function resize() {
    const r = canvas.getBoundingClientRect();
    size.dpr = Math.min(3, window.devicePixelRatio || 1);
    size.w = r.width;
    size.h = r.height;
    canvas.width = Math.max(1, Math.round(r.width * size.dpr));
    canvas.height = Math.max(1, Math.round(r.height * size.dpr));
  }

  function geom(s) {
    const span = s.fold ? 13 : s.span;
    const lo = s.fold ? -0.5 : s.center - s.span / 2;
    return { span, lo, lh: size.h / span };
  }

  function laneAt(y, s) {
    const { lo, lh } = geom(s);
    const n = Math.round(lo + (size.h - y) / lh);
    return s.fold ? Math.max(0, Math.min(12, n)) : n;
  }

  function rounded(x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }

  function draw(s) {
    const { w, h, dpr } = size;
    if (!w || !h) return;
    const { span, lo, lh } = geom(s);
    const Y = (p) => h - (p - lo) * lh;
    const area = w - KEY_W;
    const sweep = s.nowFrac < 1;
    const nowX = sweep ? KEY_W + area * s.nowFrac : w - 26;
    const pxMs = (sweep ? area : nowX - KEY_W) / s.winMs;
    const X = (t) => nowX + (t - s.now) * pxMs;
    const first = s.fold ? 0 : Math.floor(lo - 0.5);
    const last = s.fold ? 12 : Math.ceil(lo + span + 0.5);
    const curN = s.cur ? Math.round(s.cur.m) : null;
    const isCur = (n) => curN != null && (s.fold ? pcOf(n) === pcOf(curN) : n === curN);
    const isTarget = (n) => s.target != null && (s.fold ? pcOf(n) === pcOf(s.target) : n === s.target);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);

    for (let n = first; n <= last; n++) {
      const top = Y(n + 0.5);
      const pc = pcOf(n);
      g.fillStyle = BLACK[pc] ? C.laneDark : C.lane;
      g.fillRect(KEY_W, top, area, lh);
      if (isTarget(n)) {
        g.fillStyle = `rgba(${RGB.accent},0.16)`;
        g.fillRect(KEY_W, top, area, lh);
      }
      if (isCur(n)) {
        g.fillStyle = `rgba(${RGB[s.cur.g]},0.14)`;
        g.fillRect(KEY_W, top, area, lh);
      }
      g.fillStyle = C.mid;
      g.fillRect(KEY_W, top + lh / 2 - 0.5, area, 1);
      if (!s.fold && pc === 0) {
        g.fillStyle = C.octave;
        g.fillRect(0, top + lh - 0.5, w, 1);
      }
      if (s.dronePc != null && pc === s.dronePc) {
        g.fillStyle = C.accent;
        g.beginPath();
        g.moveTo(KEY_W + 2, top + lh / 2 - 5);
        g.lineTo(KEY_W + 8, top + lh / 2);
        g.lineTo(KEY_W + 2, top + lh / 2 + 5);
        g.fill();
      }
    }

    g.fillStyle = C.grid;
    const stepMs = 1000;
    let gt = Math.floor((s.now + (w - nowX) / pxMs) / stepMs) * stepMs;
    for (; X(gt) > KEY_W; gt -= stepMs) g.fillRect(Math.round(X(gt)), 0, 1, h);

    if (s.target != null) {
      g.strokeStyle = C.accent;
      g.lineWidth = 1.5;
      g.setLineDash([6, 6]);
      for (let n = first; n <= last; n++) {
        if (!isTarget(n)) continue;
        g.beginPath();
        g.moveTo(KEY_W, Y(n));
        g.lineTo(w, Y(n));
        g.stroke();
      }
      g.setLineDash([]);
    }

    g.save();
    g.beginPath();
    g.rect(KEY_W, 0, area, h);
    g.clip();
    if (s.bars) drawBars(s, X, Y, lh, w);
    if (sweep) {
      g.fillStyle = 'rgba(255,255,255,0.32)';
      g.fillRect(nowX - 1, 0, 2, h);
    }
    drawTrace(s, X, Y, lh);
    g.restore();

    if (s.cur) {
      const color = C[s.cur.g];
      const r = Math.max(7, Math.min(11, lh * 0.3));
      g.save();
      g.shadowColor = color;
      g.shadowBlur = 16;
      g.fillStyle = color;
      g.beginPath();
      g.arc(nowX, Y(s.fold ? s.cur.d : s.cur.m), r, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    drawKeys(s, first, last, Y, lh, isCur, isTarget);
  }

  function drawBars(s, X, Y, lh, w) {
    const bh = Math.max(8, lh * 0.72);
    for (const b of s.bars) {
      const x0 = X(b.t0);
      const x1 = X(b.t1);
      if (x1 < KEY_W || x0 > w) continue;
      const active = s.now >= b.t0 && s.now < b.t1;
      const rgb = RGB[b.cls] || RGB.todo;
      const y = Y(b.pos) - bh / 2;
      const bw = Math.max(6, x1 - x0 - 2);
      rounded(x0 + 1, y, bw, bh, Math.min(9, bh / 2, bw / 2));
      g.fillStyle = `rgba(${rgb},${active ? 0.5 : 0.26})`;
      g.fill();
      g.strokeStyle = `rgba(${rgb},${active ? 1 : 0.75})`;
      g.lineWidth = active ? 2.5 : 1.5;
      g.stroke();
    }
  }

  function drawTrace(s, X, Y, lh) {
    const hist = s.hist;
    if (!hist || !hist.length) return;
    const t0 = s.now - s.winMs - 400;
    let i = hist.length - 1;
    while (i > 0 && hist[i - 1].t >= t0) i--;
    const thick = Math.max(4, Math.min(6, lh * 0.16));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let px = 0;
    let py = 0;
    let pv = 0;
    let has = false;
    let color = null;
    for (; i < hist.length; i++) {
      const p = hist[i];
      if (Number.isNaN(p.m)) {
        if (color) g.stroke();
        color = null;
        has = false;
        continue;
      }
      const v = s.fold ? p.d : p.m;
      const x = X(p.t);
      const y = Y(v);
      const jump = Math.abs(v - pv);
      if (has && jump > 0.6) {
        if (color) g.stroke();
        color = null;
        if (!s.fold || jump < 6.5) {
          g.strokeStyle = 'rgba(255,255,255,0.18)';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(x, y);
          g.stroke();
        }
      } else if (has) {
        const c = C[p.g] || C.bad;
        if (c !== color) {
          if (color) g.stroke();
          g.strokeStyle = c;
          g.lineWidth = thick;
          color = c;
          g.beginPath();
          g.moveTo(px, py);
        }
        g.lineTo(x, y);
      }
      px = x;
      py = y;
      pv = v;
      has = true;
    }
    if (color) g.stroke();
  }

  function drawKeys(s, first, last, Y, lh, isCur, isTarget) {
    g.fillStyle = C.bg;
    g.fillRect(0, 0, KEY_W, size.h);
    const showAll = lh >= 15;
    const fs = Math.min(s.fold ? 17 : 13.5, Math.max(10, lh * 0.45));
    g.textBaseline = 'middle';
    for (let n = first; n <= last; n++) {
      const top = Y(n + 0.5);
      const pc = pcOf(n);
      const black = BLACK[pc];
      const flash = s.flash && s.flash.n === n && s.now < s.flash.until;
      const cur = isCur(n);
      const tgt = isTarget(n);
      let fill = black ? C.keyBlack : C.keyWhite;
      if (tgt) fill = C.accent;
      if (cur) fill = C[s.cur.g];
      if (flash) fill = '#ffffff';
      g.fillStyle = fill;
      rounded(2, top + 1, KEY_W - 7, Math.max(1, lh - 2), Math.min(8, lh / 3));
      g.fill();
      if (showAll || pc === 0 || cur || tgt) {
        const strong = cur || tgt || flash;
        const color = strong ? C.ink : black ? C.labelDim : C.label;
        drawLabel(s.label(n), 9, top + lh / 2 + 0.5, KEY_W - 18, fs, strong || (!s.fold && pc === 0) ? 800 : 600, color);
      }
    }
  }

  function drawLabel(p, x, y, maxW, size0, weight, color) {
    let fs = size0;
    let wb;
    let wa;
    for (;;) {
      g.font = `${weight} ${fs}px ${FONT}`;
      wb = g.measureText(p.base).width;
      const wo = p.oct ? g.measureText(p.oct).width : 0;
      g.font = `${weight} ${fs * 0.78}px ${FONT}`;
      wa = p.acc ? g.measureText(p.acc).width + 1 : 0;
      if (wb + wa + wo <= maxW || fs <= 8) break;
      fs -= 0.5;
    }
    g.fillStyle = color;
    g.font = `${weight} ${fs}px ${FONT}`;
    g.fillText(p.base, x, y);
    if (p.oct) g.fillText(p.oct, x + wb + wa, y);
    if (p.acc) {
      g.font = `${weight} ${fs * 0.78}px ${FONT}`;
      g.fillText(p.acc, x + wb + 0.5, y - fs * 0.32);
    }
  }

  return { resize, draw, laneAt, size };
}
