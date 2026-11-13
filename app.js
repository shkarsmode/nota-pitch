import { BLACK, NAMES, foldDev, foldPos } from './music.js';
import { settings, saveSettings, OPTIONS, readJSON, writeJSON, nameOf, parts, noteHTML, noteText, grade, decimal } from './settings.js';
import { audio, ensureCtx, startMic, stopMic, sample, tone, startDrone, stopDrone, setDroneVol, toFreq } from './audio.js';
import { createRoll, KEY_W } from './roll.js';

const $ = (id) => document.getElementById(id);

const voice = {
  hist: [],
  smooth: NaN,
  lastVoiced: 0,
  prevD: 6,
  center: Number(readJSON('nota.voice', 55)) || 55,
  seg: null,
  lastSeg: null,
};

const state = {
  target: null,
  refUntil: 0,
  refNote: null,
  flash: null,
  center: 57,
  centerTarget: 57,
  suspendedSince: 0,
};

const roll = createRoll($('roll'));
const droneMidi = () => 12 * (settings.droneOct + 1) + settings.droneNote;
const foldBase = () => 12 * Math.round((voice.center - 6) / 12);
const label = (n) => parts(n, !settings.fold);

function devOf(m) {
  if (state.target == null) return (m - Math.round(m)) * 100;
  return (settings.fold ? foldDev(m, state.target) : m - state.target) * 100;
}

function isReference(now, m) {
  if (now >= state.refUntil || state.refNote == null) return false;
  return Math.abs(foldDev(m, state.refNote)) < 0.6;
}

const MIC_ERRORS = {
  NotAllowedError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
  SecurityError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
  NotFoundError: 'Микрофон не найден.',
  NotReadableError: 'Микрофон занят другим приложением. Закрой его и попробуй снова.',
  InsecureError: 'Микрофон работает только по https.',
  NotSupportedError: 'Этот браузер не даёт доступ к микрофону.',
};

async function micOn() {
  if (audio.running || audio.starting) return;
  $('startBtn').disabled = true;
  $('startLabel').textContent = 'Жду доступ…';
  try {
    await startMic(() => micOff('Микрофон отключился. Нажми, чтобы включить снова.'));
    voice.smooth = NaN;
    $('overlay').hidden = true;
  } catch (err) {
    showOverlay(MIC_ERRORS[err.name] || 'Не получилось включить микрофон. Попробуй ещё раз.');
  }
  renderDock();
}

function micOff(message) {
  if (!audio.running) return;
  stopMic();
  voice.smooth = NaN;
  closeSeg();
  writeJSON('nota.voice', Math.round(voice.center * 10) / 10);
  showOverlay(message || 'Микрофон на паузе.');
  renderDock();
}

function showOverlay(message) {
  $('overlayMsg').textContent = message;
  $('startLabel').textContent = 'Включить микрофон';
  $('startBtn').disabled = false;
  $('overlay').hidden = false;
}

function playKey(midi, lane) {
  tone(midi);
  const now = performance.now();
  state.refUntil = now + 1150;
  state.refNote = midi;
  state.flash = { n: lane, until: now + 220 };
}

function setTarget(midi) {
  state.target = midi;
  closeSeg();
  if (!settings.fold) {
    const half = settings.span / 2 - 1.5;
    if (midi > state.centerTarget + half) state.centerTarget = midi - half;
    if (midi < state.centerTarget - half) state.centerTarget = midi + half;
  }
  renderTarget();
}

function accept(now, dt, v) {
  voice.lastVoiced = now;
  voice.center += (v - voice.center) * (1 - Math.exp(-dt / 12000));
  const ref = isReference(now, v);
  const d = foldPos(v, voice.prevD);
  voice.prevD = d;
  voice.hist.push({ t: now, m: v, d, g: ref ? 'ref' : grade(devOf(v)) });
  if (voice.hist.length > 6000) voice.hist.splice(0, 1500);
  if (Number.isNaN(voice.smooth) || Math.abs(v - voice.smooth) > 0.6) voice.smooth = v;
  else voice.smooth += (v - voice.smooth) * (1 - Math.exp(-dt / 80));
  if (!ref) track(now, voice.smooth);
  if (!settings.fold) follow(v);
}

function idle(now) {
  const h = voice.hist;
  if (now - voice.lastVoiced > 90 && h.length && !Number.isNaN(h[h.length - 1].m)) h.push({ t: now, m: NaN });
  if (now - voice.lastVoiced > 220) voice.smooth = NaN;
  if (voice.seg && now - voice.seg.last > 250) closeSeg();
}

function track(now, m) {
  const dev = devOf(m);
  const onTarget = state.target != null && Math.abs(dev) < 50;
  const note = onTarget ? state.target : Math.round(m);
  let s = voice.seg;
  if (!s || s.note !== note || s.tgt !== state.target || now - s.last > 250) {
    closeSeg();
    s = voice.seg = { note, tgt: state.target, onTarget, start: now, last: now, frames: 0, good: 0 };
  }
  s.last = now;
  s.frames++;
  if (Math.abs(onTarget ? dev : (m - note) * 100) <= settings.tol) s.good++;
}

function closeSeg() {
  const s = voice.seg;
  if (s && s.last - s.start >= 400) voice.lastSeg = { ...s, at: s.last };
  voice.seg = null;
}

function follow(m) {
  const half = settings.span / 2;
  const edge = Math.min(3, half * 0.3);
  const c = state.centerTarget;
  if (m > c + half - edge) state.centerTarget = m - half + edge;
  else if (m < c - half + edge) state.centerTarget = m + half - edge;
}

function scene(now) {
  const voiced = !Number.isNaN(voice.smooth);
  return {
    now,
    fold: settings.fold,
    span: settings.span,
    center: state.center,
    winMs: settings.win * 1000,
    nowFrac: 1,
    hist: voice.hist,
    cur: voiced
      ? {
          m: voice.smooth,
          d: foldPos(voice.smooth, voice.prevD),
          g: isReference(now, voice.smooth) ? 'ref' : grade(devOf(voice.smooth)),
        }
      : null,
    target: state.target,
    flash: state.flash,
    dronePc: audio.drone ? settings.droneNote : null,
    label,
  };
}

const els = {
  top: $('top'),
  note: $('note'),
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
  if (shown[key] === value) return;
  shown[key] = value;
  el.textContent = value;
}

function readout(now) {
  const voiced = !Number.isNaN(voice.smooth);
  const hasTarget = state.target != null;
  const withOct = !settings.fold;
  let mode = 'idle';
  let status;
  let name = '—';
  let nameHTML = '—';
  let oct = '';
  let cents = '';
  let hz = '';
  let pos = 50;

  if (!audio.running) {
    status = 'Включи микрофон';
  } else if (!voiced) {
    status = hasTarget ? `Спой ${noteText(state.target, withOct)}` : 'Спой ноту';
  } else {
    const m = voice.smooth;
    const n = Math.round(m);
    const dev = devOf(m);
    const r = Math.round(dev);
    name = nameOf(n);
    nameHTML = noteHTML(n, false);
    oct = withOct ? parts(n).oct : '';
    cents = `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}¢`;
    hz = `${decimal(toFreq(m))} Гц`;
    pos = 50 + Math.max(-50, Math.min(50, dev));
    if (isReference(now, m)) {
      mode = 'ref';
      status = 'Звучит эталон';
    } else {
      mode = grade(dev);
      if (Math.abs(dev) <= settings.tol) status = hasTarget ? 'Попал в цель ✓' : 'В ноте ✓';
      else if (hasTarget && Math.abs(dev) >= 50) status = dev < 0 ? 'Ниже цели ↑' : 'Выше цели ↓';
      else status = dev < 0 ? 'Занижаешь ↑' : 'Завышаешь ↓';
    }
  }

  let hold = '';
  const s = voice.seg;
  const counts = (x) => x.tgt == null || x.onTarget;
  const pct = (x) => Math.round((100 * x.good) / x.frames);
  if (audio.running && s && counts(s) && now - s.last < 250 && s.last - s.start >= 400) {
    hold = `Держишь ${decimal((s.last - s.start) / 1000)} с · ${pct(s)}% точно`;
  } else if (voice.lastSeg && counts(voice.lastSeg) && now - voice.lastSeg.at < 5000) {
    const L = voice.lastSeg;
    hold = `${noteText(L.note, withOct)}: ${decimal((L.last - L.start) / 1000)} с · ${pct(L)}% точно`;
  }

  if (shown.mode !== mode) {
    shown.mode = mode;
    els.top.dataset.state = mode;
  }
  if (shown.name !== nameHTML) {
    shown.name = nameHTML;
    els.name.innerHTML = nameHTML;
    els.note.toggleAttribute('data-long', name.length > 2);
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
  const lvl = audio.running ? Math.max(0, Math.min(1, (audio.level + 70) / 50)).toFixed(2) : '0';
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
  els.mic.classList.toggle('on', audio.running);
  els.mic.setAttribute('aria-label', audio.running ? 'Пауза' : 'Включить микрофон');
  $('droneBtn').classList.toggle('on', audio.drone);
  $('droneState').innerHTML = `${noteHTML(droneMidi())} · ${audio.drone ? 'звучит' : 'выкл'}`;
  $('droneToggle').textContent = audio.drone ? 'Выключить фоновую ноту' : 'Включить фоновую ноту';
}

function renderTarget() {
  $('targetChip').hidden = state.target == null;
  if (state.target != null) $('targetName').innerHTML = noteHTML(state.target, !settings.fold);
}

function renderLayout() {
  els.top.classList.toggle('big', !settings.compact);
  $('rowSpan').hidden = settings.fold;
}

function toggleDrone() {
  if (audio.drone) stopDrone();
  else startDrone();
  renderDock();
}

function restartDrone() {
  if (audio.drone) startDrone();
  renderDock();
}

function buildSeg(el, key, onChange) {
  el.innerHTML = '';
  for (const [value, text] of OPTIONS[key]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
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
  NAMES[settings.names][settings.acc].forEach((_, pc) => {
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
  $('startBtn').addEventListener('click', micOn);
  els.mic.addEventListener('click', () => (audio.running ? micOff() : micOn()));
  $('droneBtn').addEventListener('click', toggleDrone);
  $('droneToggle').addEventListener('click', toggleDrone);
  $('openDrone').addEventListener('click', () => openSheet('droneSheet'));
  $('openSettings').addEventListener('click', () => openSheet('settingsSheet'));
  $('backdrop').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
  });
  $('targetPlay').addEventListener('click', () => {
    if (state.target == null) return;
    playKey(state.target, settings.fold ? state.target - foldBase() : state.target);
  });
  $('targetClear').addEventListener('click', () => {
    state.target = null;
    closeSeg();
    renderTarget();
  });

  $('roll').addEventListener('pointerdown', (e) => {
    const r = $('roll').getBoundingClientRect();
    if (e.clientX - r.left > KEY_W + 8) return;
    ensureCtx();
    const lane = roll.laneAt(e.clientY - r.top, scene(performance.now()));
    const midi = settings.fold ? foldBase() + lane : lane;
    setTarget(midi);
    playKey(midi, lane);
  });

  const relabel = () => {
    buildDroneNotes();
    renderDock();
    renderTarget();
  };
  buildSeg($('segFold'), 'fold', () => {
    renderLayout();
    renderTarget();
  });
  buildSeg($('segCompact'), 'compact', renderLayout);
  buildSeg($('segNames'), 'names', relabel);
  buildSeg($('segAcc'), 'acc', relabel);
  buildSeg($('segTol'), 'tol', renderZone);
  buildSeg($('segSpan'), 'span');
  buildSeg($('segWin'), 'win');
  buildSeg($('segSens'), 'sens');
  buildSeg($('segDroneOct'), 'droneOct', restartDrone);
  buildSeg($('segDroneFifth'), 'droneFifth', restartDrone);
  buildDroneNotes();

  const vol = $('droneVol');
  vol.value = settings.droneVol;
  vol.addEventListener('input', () => {
    settings.droneVol = Number(vol.value);
    saveSettings();
    setDroneVol();
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
    if (!document.hidden) return;
    micOff('Пауза: приложение было свёрнуто.');
    if (audio.drone) toggleDrone();
  });

  setInterval(() => {
    if (!audio.running || !audio.ctx) return;
    if (audio.ctx.state === 'running') {
      state.suspendedSince = 0;
      return;
    }
    audio.ctx.resume().catch(() => {});
    if (!state.suspendedSince) state.suspendedSince = performance.now();
    else if (performance.now() - state.suspendedSince > 2500) {
      state.suspendedSince = 0;
      micOff('Звук прервался. Нажми, чтобы продолжить.');
    }
  }, 1000);

  new ResizeObserver(() => roll.resize()).observe($('roll'));
}

let prevT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, Math.max(0, now - prevT));
  prevT = now;
  if (audio.running) {
    const v = sample(now);
    if (Number.isNaN(v)) idle(now);
    else accept(now, dt, v);
  }
  state.center += (state.centerTarget - state.center) * (1 - Math.exp(-dt / 200));
  roll.draw(scene(now));
  readout(now);
}

bind();
renderLayout();
renderZone();
renderDock();
renderTarget();
renderA4();
renderInstall();
roll.resize();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
