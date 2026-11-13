import { createPitchDetector } from './pitch.js';

const NAMES = {
  letters: {
    sharp: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    flat: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'],
  },
  solfege: {
    sharp: ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'],
    flat: ['До', 'Ре♭', 'Ре', 'Ми♭', 'Ми', 'Фа', 'Соль♭', 'Соль', 'Ля♭', 'Ля', 'Си♭', 'Си'],
  },
};
const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const GATE_DB = { low: -45, mid: -55, high: -65 };
const MIN_CLARITY = 0.86;
const KEY_W = 56;
const DEFAULTS = {
  names: 'letters',
  acc: 'sharp',
  tol: 15,
  span: 18,
  win: 6,
  sens: 'mid',
  a4: 440,
  droneNote: 0,
  droneOct: 3,
  droneFifth: false,
  droneVol: 0.6,
};
const OPTIONS = {
  names: [['letters', 'C D E'], ['solfege', 'До Ре Ми']],
  acc: [['sharp', '♯ диезы'], ['flat', '♭ бемоли']],
  tol: [[8, '±8 строго'], [15, '±15'], [25, '±25 мягко']],
  span: [[12, '1 окт'], [18, '1,5 окт'], [24, '2 окт']],
  win: [[4, '4 с'], [6, '6 с'], [10, '10 с']],
  sens: [['low', 'Низкая'], ['mid', 'Средняя'], ['high', 'Высокая']],
  droneOct: [[2, '2'], [3, '3'], [4, '4']],
  droneFifth: [[false, 'Нет'], [true, '+ квинта']],
};
const COLOR = {
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
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  ref: '#60a5fa',
  accent: '#a78bfa',
};
const RGB = { good: '52,211,153', warn: '251,191,36', bad: '248,113,113', ref: '96,165,250' };

const $ = (id) => document.getElementById(id);

const settings = loadSettings();

const state = {
  ctx: null,
  waves: null,
  running: false,
  starting: false,
  stream: null,
  nodes: null,
  buf: null,
  bytes: null,
  detect: null,
  hist: [],
  med: [],
  lastRaw: 0,
  lastVoiced: 0,
  smooth: NaN,
  level: -100,
  center: 57,
  centerTarget: 57,
  target: null,
  refUntil: 0,
  refNote: null,
  flash: null,
  seg: null,
  lastSeg: null,
  drone: null,
  wake: null,
  suspendedSince: 0,
};

function loadSettings() {
  let s = { ...DEFAULTS };
  try {
    s = { ...s, ...JSON.parse(localStorage.getItem('nota.settings') || '{}') };
  } catch {}
  for (const [key, opts] of Object.entries(OPTIONS)) {
    if (!opts.some(([v]) => v === s[key])) s[key] = DEFAULTS[key];
  }
  s.a4 = Math.min(466, Math.max(415, Math.round(Number(s.a4)) || 440));
  s.droneNote = Number.isInteger(s.droneNote) && s.droneNote >= 0 && s.droneNote < 12 ? s.droneNote : 0;
  s.droneVol = Number.isFinite(Number(s.droneVol)) ? Math.min(1, Math.max(0, Number(s.droneVol))) : DEFAULTS.droneVol;
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem('nota.settings', JSON.stringify(settings));
  } catch {}
}

const pcOf = (n) => ((n % 12) + 12) % 12;
const octOf = (n) => Math.floor(n / 12) - 1;
const nameOf = (n) => NAMES[settings.names][settings.acc][pcOf(n)];
const fullName = (n) => nameOf(n) + octOf(n);
const FONT = 'system-ui, -apple-system, Roboto, sans-serif';

function parts(n) {
  const name = nameOf(n);
  const last = name.slice(-1);
  const acc = last === '♯' || last === '♭' ? last : '';
  return { base: acc ? name.slice(0, -1) : name, acc, oct: String(octOf(n)) };
}

function noteHTML(n, withOct = true) {
  const p = parts(n);
  return `${p.base}${p.acc ? `<span class="acc">${p.acc}</span>` : ''}${withOct ? p.oct : ''}`;
}
const toMidi = (f) => 69 + 12 * Math.log2(f / settings.a4);
const toFreq = (m) => settings.a4 * 2 ** ((m - 69) / 12);
const droneMidi = () => 12 * (settings.droneOct + 1) + settings.droneNote;

function grade(dev) {
  const a = Math.abs(dev);
  if (a <= settings.tol) return 'good';
  if (a <= settings.tol * 2) return 'warn';
  return 'bad';
}

const decimal = (v) => v.toFixed(1).replace('.', ',');

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function periodicWave(ctx, amps) {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => {
    imag[i + 1] = a;
  });
  return ctx.createPeriodicWave(real, imag);
}

function ensureCtx() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC({ latencyHint: 'interactive' });
    state.waves = {
      drone: periodicWave(state.ctx, [1, 0.5, 0.33, 0.24, 0.16, 0.11, 0.07, 0.05, 0.03]),
      key: periodicWave(state.ctx, [1, 0.45, 0.25, 0.14, 0.08, 0.05, 0.03]),
    };
  }
  if (state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
  return state.ctx;
}

async function startMic() {
  if (state.running || state.starting) return;
  state.starting = true;
  $('startBtn').disabled = true;
  $('startLabel').textContent = 'Жду доступ…';
  const ctx = ensureCtx();
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('unsupported');
      err.name = window.isSecureContext ? 'NotSupportedError' : 'InsecureError';
      throw err;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = ctx.sampleRate > 60000 ? 4096 : 2048;
    an.smoothingTimeConstant = 0;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(an);
    an.connect(sink);
    sink.connect(ctx.destination);
    state.stream = stream;
    state.nodes = { src, an, sink };
    state.buf = new Float32Array(an.fftSize);
    state.bytes = typeof an.getFloatTimeDomainData === 'function' ? null : new Uint8Array(an.fftSize);
    state.detect = createPitchDetector(ctx.sampleRate, an.fftSize);
    state.med = [];
    state.lastVoiced = 0;
    state.running = true;
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => stopMic('Микрофон отключился. Нажми, чтобы включить снова.')),
    );
    $('overlay').hidden = true;
    keepAwake();
  } catch (err) {
    const messages = {
      NotAllowedError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
      SecurityError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
      NotFoundError: 'Микрофон не найден.',
      NotReadableError: 'Микрофон занят другим приложением. Закрой его и попробуй снова.',
      InsecureError: 'Микрофон работает только по https.',
      NotSupportedError: 'Этот браузер не даёт доступ к микрофону.',
    };
    showOverlay(messages[err.name] || 'Не получилось включить микрофон. Попробуй ещё раз.');
  } finally {
    state.starting = false;
    renderDock();
  }
}

function stopMic(message) {
  if (!state.running) return;
  state.running = false;
  state.stream.getTracks().forEach((t) => t.stop());
  try {
    state.nodes.src.disconnect();
    state.nodes.an.disconnect();
    state.nodes.sink.disconnect();
  } catch {}
  state.stream = null;
  state.nodes = null;
  state.smooth = NaN;
  state.level = -100;
  closeSeg();
  releaseAwake();
  showOverlay(message || 'Микрофон на паузе.');
  renderDock();
}

function showOverlay(message) {
  $('overlayMsg').textContent = message;
  $('startLabel').textContent = 'Включить микрофон';
  $('startBtn').disabled = false;
  $('overlay').hidden = false;
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && !state.wake) {
      state.wake = await navigator.wakeLock.request('screen');
      state.wake.addEventListener('release', () => {
        state.wake = null;
      });
    }
  } catch {}
}

function releaseAwake() {
  try {
    if (state.wake) state.wake.release();
  } catch {}
  state.wake = null;
}

function startDrone() {
  const ctx = ensureCtx();
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.setTargetAtTime(settings.droneVol * 0.5, t, 0.12);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  lp.Q.value = 0.4;
  lp.connect(out);
  out.connect(ctx.destination);
  const f = toFreq(droneMidi());
  const oscs = [];
  const voice = (freq, gain) => {
    const o = ctx.createOscillator();
    o.setPeriodicWave(state.waves.drone);
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g);
    g.connect(lp);
    o.start(t);
    oscs.push(o);
  };
  voice(f, 0.6);
  voice(f * 2, 0.16);
  if (settings.droneFifth) voice(f * 1.5, 0.3);
  state.drone = { out, oscs };
  renderDock();
}

function stopDrone() {
  const d = state.drone;
  if (!d) return;
  state.drone = null;
  const t = state.ctx.currentTime;
  d.out.gain.cancelScheduledValues(t);
  d.out.gain.setTargetAtTime(0, t, 0.06);
  setTimeout(() => {
    d.oscs.forEach((o) => {
      try {
        o.stop();
      } catch {}
    });
    d.out.disconnect();
  }, 500);
  renderDock();
}

function restartDrone() {
  if (!state.drone) return;
  stopDrone();
  startDrone();
}

function playKey(n) {
  const ctx = ensureCtx();
  const t = ctx.currentTime + 0.01;
  const o = ctx.createOscillator();
  o.setPeriodicWave(state.waves.key);
  o.frequency.value = toFreq(n);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.012);
  g.gain.setTargetAtTime(0.0001, t + 0.09, 0.32);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + 1.9);
  const now = performance.now();
  state.refUntil = now + 1150;
  state.refNote = n;
  state.flash = { note: n, until: now + 220 };
}

function isReference(now, m) {
  if (now >= state.refUntil || state.refNote == null) return false;
  const d = m - state.refNote;
  return Math.abs(d - 12 * Math.round(d / 12)) < 0.6;
}

function setTarget(n) {
  state.target = n;
  const half = settings.span / 2 - 1.5;
  if (n > state.centerTarget + half) state.centerTarget = n - half;
  if (n < state.centerTarget - half) state.centerTarget = n + half;
  renderTarget();
}

function sample(now, dt) {
  const an = state.nodes.an;
  if (state.bytes) {
    an.getByteTimeDomainData(state.bytes);
    for (let i = 0; i < state.bytes.length; i++) state.buf[i] = (state.bytes[i] - 128) / 128;
  } else {
    an.getFloatTimeDomainData(state.buf);
  }
  const r = state.detect(state.buf);
  const db = 20 * Math.log10(r.rms + 1e-9);
  state.level = db;
  if (r.freq > 0 && r.clarity >= MIN_CLARITY && db >= GATE_DB[settings.sens]) accept(now, dt, toMidi(r.freq));
  else idle(now);
}

function accept(now, dt, m) {
  if (now - state.lastRaw > 120) state.med.length = 0;
  state.lastRaw = now;
  state.med.push(m);
  if (state.med.length > 5) state.med.shift();
  if (state.med.length < 3) return;
  const v = median(state.med);
  state.lastVoiced = now;
  const ref = isReference(now, v);
  state.hist.push({ t: now, m: v, ref, tgt: state.target });
  if (state.hist.length > 6000) state.hist.splice(0, 1500);
  if (Number.isNaN(state.smooth) || Math.abs(v - state.smooth) > 0.6) state.smooth = v;
  else state.smooth += (v - state.smooth) * (1 - Math.exp(-dt / 80));
  if (!ref) track(now, state.smooth);
  follow(v);
}

function idle(now) {
  const h = state.hist;
  if (now - state.lastVoiced > 90 && h.length && !Number.isNaN(h[h.length - 1].m)) h.push({ t: now, m: NaN, ref: false });
  if (now - state.lastVoiced > 220) state.smooth = NaN;
  if (state.seg && now - state.seg.last > 250) closeSeg();
}

function track(now, m) {
  const near = Math.round(m);
  const note = state.target != null && Math.abs(m - state.target) < 0.5 ? state.target : near;
  const dev = (m - note) * 100;
  let s = state.seg;
  if (!s || s.note !== note || s.tgt !== state.target || now - s.last > 250) {
    closeSeg();
    s = state.seg = { note, tgt: state.target, start: now, last: now, frames: 0, good: 0 };
  }
  s.last = now;
  s.frames++;
  if (Math.abs(dev) <= settings.tol) s.good++;
}

function closeSeg() {
  const s = state.seg;
  if (s && s.last - s.start >= 400) state.lastSeg = { ...s, at: s.last };
  state.seg = null;
}

function follow(m) {
  const half = settings.span / 2;
  const edge = Math.min(3, half * 0.3);
  const c = state.centerTarget;
  if (m > c + half - edge) state.centerTarget = m - half + edge;
  else if (m < c - half + edge) state.centerTarget = m + half - edge;
}

const canvas = $('roll');
const g = canvas.getContext('2d');
const view = { w: 0, h: 0, dpr: 1 };

function resize() {
  const r = canvas.getBoundingClientRect();
  view.dpr = Math.min(3, window.devicePixelRatio || 1);
  view.w = r.width;
  view.h = r.height;
  canvas.width = Math.max(1, Math.round(r.width * view.dpr));
  canvas.height = Math.max(1, Math.round(r.height * view.dpr));
}

function rounded(x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function draw(now, dt) {
  const { w, h, dpr } = view;
  if (!w || !h) return;
  state.center += (state.centerTarget - state.center) * (1 - Math.exp(-dt / 200));
  const span = settings.span;
  const lo = state.center - span / 2;
  const lh = h / span;
  const Y = (m) => h - (m - lo) * lh;
  const nowX = w - 24;
  const winMs = settings.win * 1000;
  const X = (t) => nowX - ((now - t) / winMs) * (nowX - KEY_W);
  const voiced = !Number.isNaN(state.smooth);
  const cur = voiced ? Math.round(state.smooth) : null;
  const curGrade = voiced
    ? isReference(now, state.smooth)
      ? 'ref'
      : grade((state.smooth - (state.target ?? cur)) * 100)
    : null;
  const nLo = Math.floor(lo - 0.5);
  const nHi = Math.ceil(lo + span + 0.5);

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = COLOR.bg;
  g.fillRect(0, 0, w, h);

  for (let n = nLo; n <= nHi; n++) {
    const top = Y(n + 0.5);
    const pc = pcOf(n);
    g.fillStyle = BLACK[pc] ? COLOR.laneDark : COLOR.lane;
    g.fillRect(KEY_W, top, w - KEY_W, lh);
    if (n === state.target) {
      g.fillStyle = 'rgba(167,139,250,0.16)';
      g.fillRect(KEY_W, top, w - KEY_W, lh);
    }
    if (n === cur) {
      g.fillStyle = `rgba(${RGB[curGrade]},0.14)`;
      g.fillRect(KEY_W, top, w - KEY_W, lh);
    }
    g.fillStyle = COLOR.mid;
    g.fillRect(KEY_W, top + lh / 2 - 0.5, w - KEY_W, 1);
    if (pc === 0) {
      g.fillStyle = COLOR.octave;
      g.fillRect(0, top + lh - 0.5, w, 1);
    }
    if (state.drone && pc === settings.droneNote) {
      g.fillStyle = COLOR.accent;
      g.beginPath();
      g.moveTo(KEY_W + 2, top + lh / 2 - 5);
      g.lineTo(KEY_W + 8, top + lh / 2);
      g.lineTo(KEY_W + 2, top + lh / 2 + 5);
      g.fill();
    }
  }

  g.fillStyle = COLOR.grid;
  for (let t = Math.floor(now / 1000) * 1000; X(t) > KEY_W; t -= 1000) g.fillRect(Math.round(X(t)), 0, 1, h);

  if (state.target != null) {
    const ty = Y(state.target);
    g.strokeStyle = COLOR.accent;
    g.lineWidth = 1.5;
    g.setLineDash([6, 6]);
    g.beginPath();
    g.moveTo(KEY_W, ty);
    g.lineTo(w, ty);
    g.stroke();
    g.setLineDash([]);
  }

  drawTrace(now, X, Y, w, h);

  if (voiced) {
    const color = COLOR[curGrade];
    const y = Y(state.smooth);
    g.save();
    g.shadowColor = color;
    g.shadowBlur = 16;
    g.fillStyle = color;
    g.beginPath();
    g.arc(nowX, y, 8, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  drawKeys(nLo, nHi, Y, lh, cur, curGrade, now);
}

function drawTrace(now, X, Y, w, h) {
  const hist = state.hist;
  if (!hist.length) return;
  const t0 = now - settings.win * 1000 - 300;
  let i = hist.length - 1;
  while (i > 0 && hist[i - 1].t >= t0) i--;
  g.save();
  g.beginPath();
  g.rect(KEY_W, 0, w - KEY_W, h);
  g.clip();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  let px = 0;
  let py = 0;
  let pm = 0;
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
    const x = X(p.t);
    const y = Y(p.m);
    if (has && Math.abs(p.m - pm) > 0.6) {
      if (color) g.stroke();
      color = null;
      g.strokeStyle = 'rgba(255,255,255,0.2)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(x, y);
      g.stroke();
    } else if (has) {
      const c = p.ref ? COLOR.ref : COLOR[grade((p.m - (p.tgt ?? Math.round(p.m))) * 100)];
      if (c !== color) {
        if (color) g.stroke();
        g.strokeStyle = c;
        g.lineWidth = 4;
        color = c;
        g.beginPath();
        g.moveTo(px, py);
      }
      g.lineTo(x, y);
    }
    px = x;
    py = y;
    pm = p.m;
    has = true;
  }
  if (color) g.stroke();
  g.restore();
}

function drawKeys(nLo, nHi, Y, lh, cur, curGrade, now) {
  g.fillStyle = COLOR.bg;
  g.fillRect(0, 0, KEY_W, view.h);
  const showAll = lh >= 15;
  const size = Math.min(13.5, Math.max(10, lh * 0.47));
  g.textBaseline = 'middle';
  for (let n = nLo; n <= nHi; n++) {
    const top = Y(n + 0.5);
    const pc = pcOf(n);
    const black = BLACK[pc];
    const flash = state.flash && state.flash.note === n && now < state.flash.until;
    const isCur = n === cur;
    const isTarget = n === state.target;
    let fill = black ? COLOR.keyBlack : COLOR.keyWhite;
    if (isTarget) fill = COLOR.accent;
    if (isCur) fill = COLOR[curGrade];
    if (flash) fill = '#ffffff';
    g.fillStyle = fill;
    rounded(2, top + 1, KEY_W - 7, Math.max(1, lh - 2), Math.min(6, lh / 3));
    g.fill();
    if (showAll || pc === 0 || isCur || isTarget) {
      const strong = isCur || isTarget || flash;
      drawLabel(n, 8, top + lh / 2 + 0.5, KEY_W - 16, size, strong || pc === 0 ? 800 : 600, strong ? '#0b0f14' : black ? COLOR.labelDim : COLOR.label);
    }
  }
}

function drawLabel(n, x, y, maxW, size, weight, color) {
  const p = parts(n);
  let fs = size;
  let wb;
  let wa;
  let wo;
  for (;;) {
    g.font = `${weight} ${fs}px ${FONT}`;
    wb = g.measureText(p.base).width;
    wo = g.measureText(p.oct).width;
    g.font = `${weight} ${fs * 0.78}px ${FONT}`;
    wa = p.acc ? g.measureText(p.acc).width + 1 : 0;
    if (wb + wa + wo <= maxW || fs <= 8) break;
    fs -= 0.5;
  }
  g.fillStyle = color;
  g.font = `${weight} ${fs}px ${FONT}`;
  g.fillText(p.base, x, y);
  g.fillText(p.oct, x + wb + wa, y);
  if (p.acc) {
    g.font = `${weight} ${fs * 0.78}px ${FONT}`;
    g.fillText(p.acc, x + wb + 0.5, y - fs * 0.32);
  }
}

const els = {
  readout: $('readout'),
  name: $('noteName'),
  oct: $('noteOct'),
  cents: $('cents'),
  hz: $('hz'),
  needle: $('needle'),
  zone: $('meterZone'),
  status: $('status'),
  hold: $('hold'),
  mic: $('micBtn'),
};
const shown = {};

function put(key, el, value) {
  if (shown[key] === value) return false;
  shown[key] = value;
  el.textContent = value;
  return true;
}

function readout(now) {
  const voiced = !Number.isNaN(state.smooth);
  const hasTarget = state.target != null;
  let mode = 'idle';
  let status;
  let name = '—';
  let nameHTML = '—';
  let oct = '';
  let cents = '';
  let hz = '';
  let pos = 50;

  if (!state.running) {
    status = 'Включи микрофон';
  } else if (!voiced) {
    status = hasTarget ? `Спой ${fullName(state.target)}` : 'Спой ноту';
  } else {
    const m = state.smooth;
    const n = Math.round(m);
    const dev = (m - (hasTarget ? state.target : n)) * 100;
    const r = Math.round(dev);
    name = nameOf(n);
    nameHTML = noteHTML(n, false);
    oct = String(octOf(n));
    cents = `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}¢`;
    hz = `${decimal(toFreq(m))} Гц`;
    pos = 50 + Math.max(-50, Math.min(50, dev));
    if (isReference(now, m)) {
      mode = 'ref';
      status = 'Звучит эталон';
    } else {
      mode = grade(dev);
      if (Math.abs(dev) <= settings.tol) {
        status = hasTarget ? 'Попал в цель ✓' : 'В ноте ✓';
      } else if (hasTarget && Math.abs(dev) >= 50) {
        status = dev < 0 ? 'Ниже цели ↑' : 'Выше цели ↓';
      } else {
        status = dev < 0 ? 'Занижаешь ↑' : 'Завышаешь ↓';
      }
    }
  }

  let hold = '';
  const s = state.seg;
  const counts = (x) => x.tgt == null || x.note === x.tgt;
  if (state.running && s && counts(s) && now - s.last < 250 && s.last - s.start >= 400) {
    hold = `Держишь ${decimal((s.last - s.start) / 1000)} с · ${Math.round((100 * s.good) / s.frames)}% точно`;
  } else if (state.lastSeg && counts(state.lastSeg) && now - state.lastSeg.at < 5000) {
    const L = state.lastSeg;
    hold = `${fullName(L.note)}: ${decimal((L.last - L.start) / 1000)} с · ${Math.round((100 * L.good) / L.frames)}%`;
  }

  if (shown.mode !== mode) {
    shown.mode = mode;
    els.readout.dataset.state = mode;
  }
  if (shown.name !== nameHTML) {
    shown.name = nameHTML;
    els.name.innerHTML = nameHTML;
    els.name.parentElement.toggleAttribute('data-long', name.length > 3);
  }
  put('oct', els.oct, oct);
  put('cents', els.cents, cents);
  put('hz', els.hz, hz);
  put('status', els.status, status);
  put('hold', els.hold, hold);
  const p = pos.toFixed(1);
  if (shown.pos !== p) {
    shown.pos = p;
    els.needle.style.left = `${p}%`;
  }
  const lvl = state.running ? Math.max(0, Math.min(1, (state.level + 70) / 50)).toFixed(2) : '0';
  if (shown.lvl !== lvl) {
    shown.lvl = lvl;
    els.mic.style.setProperty('--lvl', lvl);
  }
}

function renderZone() {
  els.zone.style.left = `${50 - settings.tol}%`;
  els.zone.style.width = `${2 * settings.tol}%`;
}

function renderDock() {
  els.mic.classList.toggle('on', state.running);
  els.mic.setAttribute('aria-label', state.running ? 'Пауза' : 'Включить микрофон');
  $('droneBtn').classList.toggle('on', !!state.drone);
  $('droneLabel').innerHTML = `Бурдон ${noteHTML(droneMidi())}`;
  $('droneState').textContent = state.drone ? 'вкл' : 'выкл';
  $('droneToggle').textContent = state.drone ? 'Выключить бурдон' : 'Включить бурдон';
}

function renderTarget() {
  $('targetChip').hidden = state.target == null;
  if (state.target != null) $('targetName').innerHTML = noteHTML(state.target);
}

function buildSeg(el, key, onChange) {
  el.innerHTML = '';
  for (const [value, label] of OPTIONS[key]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      settings[key] = value;
      saveSettings();
      syncSeg(el, key);
      if (onChange) onChange();
    });
    el.appendChild(b);
  }
  syncSeg(el, key);
}

function syncSeg(el, key) {
  OPTIONS[key].forEach(([value], i) => el.children[i].classList.toggle('on', value === settings[key]));
}

function buildDroneNotes() {
  const el = $('droneNotes');
  el.innerHTML = '';
  NAMES[settings.names][settings.acc].forEach((label, pc) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = noteHTML(60 + pc, false);
    b.classList.toggle('black', !!BLACK[pc]);
    b.classList.toggle('on', pc === settings.droneNote);
    b.addEventListener('click', () => {
      settings.droneNote = pc;
      saveSettings();
      buildDroneNotes();
      restartDrone();
      renderDock();
    });
    el.appendChild(b);
  });
}

function renderA4() {
  $('a4Val').textContent = `${settings.a4} Гц`;
}

function openSheet(id) {
  closeSheets();
  $(id).classList.add('open');
  $('backdrop').classList.add('open');
}

function closeSheets() {
  document.querySelectorAll('.sheet.open').forEach((s) => s.classList.remove('open'));
  $('backdrop').classList.remove('open');
}

let installEvent = null;

function renderInstall() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('installBox').hidden = standalone;
  $('installBtn').hidden = !installEvent;
  $('installHint').textContent = installEvent
    ? 'Поставь «Ноту» на экран телефона: откроется как приложение и будет работать без интернета.'
    : ios
      ? 'Чтобы поставить на iPhone: в Safari нажми «Поделиться» → «На экран „Домой“».'
      : 'Чтобы поставить на телефон: в меню браузера выбери «Установить приложение» или «Добавить на главный экран».';
}

function bind() {
  $('startBtn').addEventListener('click', startMic);
  els.mic.addEventListener('click', () => (state.running ? stopMic() : startMic()));
  $('droneBtn').addEventListener('click', () => (state.drone ? stopDrone() : startDrone()));
  $('droneToggle').addEventListener('click', () => (state.drone ? stopDrone() : startDrone()));
  $('openDrone').addEventListener('click', () => openSheet('droneSheet'));
  $('openSettings').addEventListener('click', () => openSheet('settingsSheet'));
  $('backdrop').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
  });
  $('targetPlay').addEventListener('click', () => {
    if (state.target != null) playKey(state.target);
  });
  $('targetClear').addEventListener('click', () => {
    state.target = null;
    closeSeg();
    renderTarget();
  });

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x > KEY_W + 8) return;
    const lo = state.center - settings.span / 2;
    const n = Math.round(lo + (view.h - y) / (view.h / settings.span));
    setTarget(n);
    playKey(n);
  });

  const relabel = () => {
    buildDroneNotes();
    renderDock();
    renderTarget();
  };
  buildSeg($('segNames'), 'names', relabel);
  buildSeg($('segAcc'), 'acc', relabel);
  buildSeg($('segTol'), 'tol', renderZone);
  buildSeg($('segSpan'), 'span');
  buildSeg($('segWin'), 'win');
  buildSeg($('segSens'), 'sens');
  buildSeg($('segDroneOct'), 'droneOct', () => {
    restartDrone();
    renderDock();
  });
  buildSeg($('segDroneFifth'), 'droneFifth', restartDrone);
  buildDroneNotes();

  const vol = $('droneVol');
  vol.value = settings.droneVol;
  vol.addEventListener('input', () => {
    settings.droneVol = Number(vol.value);
    saveSettings();
    if (state.drone) state.drone.out.gain.setTargetAtTime(settings.droneVol * 0.5, state.ctx.currentTime, 0.05);
  });

  const stepA4 = (d) => {
    settings.a4 = Math.min(466, Math.max(415, settings.a4 + d));
    saveSettings();
    renderA4();
    restartDrone();
  };
  $('a4Minus').addEventListener('click', () => stepA4(-1));
  $('a4Plus').addEventListener('click', () => stepA4(1));

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    renderInstall();
  });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    try {
      await installEvent.userChoice;
    } catch {}
    installEvent = null;
    renderInstall();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.running) stopMic('Пауза: приложение было свёрнуто.');
      stopDrone();
    }
  });

  setInterval(() => {
    if (!state.running || !state.ctx) return;
    if (state.ctx.state === 'running') {
      state.suspendedSince = 0;
      return;
    }
    state.ctx.resume().catch(() => {});
    if (!state.suspendedSince) state.suspendedSince = performance.now();
    else if (performance.now() - state.suspendedSince > 2500) {
      state.suspendedSince = 0;
      stopMic('Звук прервался. Нажми, чтобы продолжить.');
    }
  }, 1000);

  new ResizeObserver(resize).observe(canvas);
}

let prevT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, Math.max(0, now - prevT));
  prevT = now;
  if (state.running) sample(now, dt);
  draw(now, dt);
  readout(now);
}

bind();
renderZone();
renderDock();
renderTarget();
renderA4();
renderInstall();
resize();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
