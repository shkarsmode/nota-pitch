import { BLACK, NAMES, foldDev, foldPos } from './music.js';
import { settings, saveSettings, OPTIONS, readJSON, writeJSON, nameOf, parts, noteHTML, noteText, grade, decimal } from './settings.js';
import { audio, ensureCtx, startMic, stopMic, sample, tone, stopTones, startDrone, stopDrone, setDroneVol, toFreq } from './audio.js';
import { createRoll, KEY_W } from './roll.js';
import { createLoop } from './loop.js';
import { createTrain } from './train.js';

const $ = (id) => document.getElementById(id);

const ICONS = {
  mic: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  rec: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/></svg>',
};
const MIC_INTRO = 'Пой, и «Нота» покажет, в какую ноту ты попадаешь. Тапни ноту слева: она прозвучит и станет целью.';
const MIC_ERRORS = {
  NotAllowedError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
  SecurityError: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и нажми ещё раз.',
  NotFoundError: 'Микрофон не найден.',
  NotReadableError: 'Микрофон занят другим приложением. Закрой его и попробуй снова.',
  InsecureError: 'Микрофон работает только по https.',
  NotSupportedError: 'Этот браузер не даёт доступ к микрофону.',
};

const voice = {
  hist: [],
  smooth: NaN,
  now: NaN,
  lastVoiced: 0,
  prevD: 6,
  center: Number(readJSON('nota.voice', 55)) || 55,
  seg: null,
  lastSeg: null,
};

const state = {
  tab: 'free',
  target: null,
  refUntil: 0,
  refNote: null,
  flash: null,
  center: 57,
  centerTarget: 57,
  micMsg: null,
  suspendedSince: 0,
};

const roll = createRoll($('roll'));
const droneMidi = () => 12 * (settings.droneOct + 1) + settings.droneNote;
const foldBase = () => 12 * Math.round((voice.center - 6) / 12);

const free = {
  view: () => 'free',
  fold: () => settings.fold,
  target: () => state.target,
  pill: holdText,
  keyTap(lane, midi) {
    setTarget(midi);
    playKey(midi, lane);
  },
  leave() {
    if (audio.drone) toggleDrone();
  },
};

const ctx = {
  $,
  voice,
  state,
  micOn,
  micOff,
  refresh,
  foldBase,
  openSheet,
  closeSheets,
  markRef(midi, ms) {
    state.refUntil = performance.now() + ms;
    state.refNote = midi;
  },
};

const modes = { free, loop: createLoop(ctx), train: createTrain(ctx) };
let mode = free;

const fold = () => (mode.fold ? mode.fold() : true);
const targetNow = (now, m) => (mode.target ? mode.target(now, m) : null);
const label = (n) => parts(n, !fold());

function devOf(m, now) {
  const t = targetNow(now, m);
  if (t == null) return (m - Math.round(m)) * 100;
  return (fold() ? foldDev(m, t) : m - t) * 100;
}

function isReference(now, m) {
  if (mode.isRef && mode.isRef(now)) return true;
  if (now >= state.refUntil || state.refNote == null) return false;
  return Math.abs(foldDev(m, state.refNote)) < 0.6;
}

async function micOn() {
  if (audio.running) return true;
  if (audio.starting) return false;
  state.micMsg = null;
  const pending = startMic(() => micOff('Микрофон отключился. Нажми, чтобы включить снова.'));
  refresh();
  try {
    await pending;
    voice.smooth = NaN;
  } catch (err) {
    state.micMsg = MIC_ERRORS[err.name] || 'Не получилось включить микрофон. Попробуй ещё раз.';
  }
  refresh();
  return audio.running;
}

function micOff(message) {
  if (!audio.running) return;
  stopMic();
  stopTones();
  voice.smooth = NaN;
  voice.now = NaN;
  closeSeg();
  writeJSON('nota.voice', Math.round(voice.center * 10) / 10);
  state.micMsg = message || 'Микрофон на паузе.';
  if (mode.micLost) mode.micLost();
  refresh();
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
  const anchor = mode.anchor ? mode.anchor(now) : null;
  const d = foldPos(v, anchor ?? voice.prevD);
  voice.prevD = d;
  voice.hist.push({ t: now, m: v, d, g: ref ? 'ref' : grade(devOf(v, now)) });
  if (voice.hist.length > 6000) voice.hist.splice(0, 1500);
  if (Number.isNaN(voice.smooth) || Math.abs(v - voice.smooth) > 0.6) voice.smooth = v;
  else voice.smooth += (v - voice.smooth) * (1 - Math.exp(-dt / 80));
  if (mode === free) {
    if (!ref) track(now, voice.smooth);
    if (!settings.fold) follow(v);
  }
  if (mode.voiced) mode.voiced(now, v, dt);
}

function idle(now) {
  const h = voice.hist;
  if (now - voice.lastVoiced > 90 && h.length && !Number.isNaN(h[h.length - 1].m)) h.push({ t: now, m: NaN });
  if (now - voice.lastVoiced > 220) voice.smooth = NaN;
  if (voice.seg && now - voice.seg.last > 250) closeSeg();
  if (mode.idle) mode.idle(now);
}

function track(now, m) {
  const dev = devOf(m, now);
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

function holdText(now) {
  const withOct = !settings.fold;
  const s = voice.seg;
  const counts = (x) => x.tgt == null || x.onTarget;
  const pct = (x) => Math.round((100 * x.good) / x.frames);
  if (audio.running && s && counts(s) && now - s.last < 250 && s.last - s.start >= 400) {
    return `Держишь ${decimal((s.last - s.start) / 1000)} с · ${pct(s)}% точно`;
  }
  if (voice.lastSeg && counts(voice.lastSeg) && now - voice.lastSeg.at < 5000) {
    const L = voice.lastSeg;
    return `${noteText(L.note, withOct)}: ${decimal((L.last - L.start) / 1000)} с · ${pct(L)}% точно`;
  }
  return '';
}

function scene(now) {
  const voiced = !Number.isNaN(voice.smooth);
  const s = {
    now,
    fold: fold(),
    span: settings.span,
    center: state.center,
    winMs: settings.win * 1000,
    nowFrac: 1,
    hist: voice.hist,
    cur: voiced
      ? {
          m: voice.smooth,
          d: foldPos(voice.smooth, voice.prevD),
          g: isReference(now, voice.smooth) ? 'ref' : grade(devOf(voice.smooth, now)),
        }
      : null,
    target: targetNow(now, voice.smooth),
    flash: state.flash,
    dronePc: audio.drone ? settings.droneNote : null,
    label,
  };
  if (mode.scene) mode.scene(s, now);
  return s;
}

const els = {
  top: $('top'),
  stage: $('stage'),
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
  const target = targetNow(now, voice.smooth);
  const hasTarget = target != null;
  const withOct = !fold();
  let st = 'idle';
  let status;
  let name = '—';
  let nameHTML = '—';
  let oct = '';
  let cents = '';
  let hz = '';
  let pos = 50;

  if (!audio.running) {
    status = 'Микрофон выключен';
  } else if (!voiced) {
    status = hasTarget ? `Спой ${noteText(target, withOct)}` : 'Спой ноту';
  } else {
    const m = voice.smooth;
    const n = Math.round(m);
    const dev = devOf(m, now);
    const r = Math.round(dev);
    name = nameOf(n);
    nameHTML = noteHTML(n, false);
    oct = withOct ? parts(n).oct : '';
    cents = `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}¢`;
    hz = `${decimal(toFreq(m))} Гц`;
    pos = 50 + Math.max(-50, Math.min(50, dev));
    if (isReference(now, m)) {
      st = 'ref';
      status = 'Звучит эталон';
    } else {
      st = grade(dev);
      if (Math.abs(dev) <= settings.tol) status = hasTarget ? 'Попал в цель ✓' : 'В ноте ✓';
      else if (hasTarget && Math.abs(dev) >= 50) status = dev < 0 ? 'Ниже цели ↑' : 'Выше цели ↓';
      else status = dev < 0 ? 'Занижаешь ↑' : 'Завышаешь ↓';
    }
  }

  if (shown.st !== st) {
    shown.st = st;
    els.top.dataset.state = st;
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

let ov = null;

function renderOverlay() {
  let spec = mode.overlay ? mode.overlay() : null;
  const needMic = mode.needsMic ? mode.needsMic() : true;
  if (!spec && needMic && !audio.running) {
    spec = {
      msg: state.micMsg || MIC_INTRO,
      btn: audio.starting ? 'Жду доступ…' : 'Включить микрофон',
      icon: 'mic',
      busy: audio.starting,
      onBtn: micOn,
    };
  }
  ov = spec;
  $('overlay').hidden = !spec;
  if (!spec) return;
  $('ovTitle').textContent = spec.title || '';
  $('ovTitle').hidden = !spec.title;
  $('ovMsg').textContent = spec.msg || '';
  $('ovMsg').hidden = !spec.msg;
  $('ovLabel').textContent = spec.btn;
  $('ovIcon').innerHTML = ICONS[spec.icon] || '';
  $('ovBtn').disabled = !!spec.busy;
  $('ovBtn').classList.toggle('rec', spec.icon === 'rec');
  $('ovAlt').textContent = spec.alt || '';
  $('ovAlt').hidden = !spec.alt;
}

function refresh() {
  const view = mode.view();
  for (const el of document.querySelectorAll('[data-show]')) {
    el.hidden = !el.dataset.show.split(' ').some((t) => view === t || view.startsWith(`${t}-`));
  }
  const focus = !!(mode.focus && mode.focus());
  $('tabs').hidden = focus;
  $('app').classList.toggle('focus', focus);
  renderOverlay();
  renderDock();
  renderTarget();
  if (mode.render) mode.render();
  roll.resize();
}

function setTab(name) {
  if (state.tab === name || !modes[name]) return;
  if (mode.leave) mode.leave();
  stopTones();
  state.tab = name;
  mode = modes[name];
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === name);
  closeSeg();
  voice.lastSeg = null;
  voice.hist.length = 0;
  if (mode.enter) mode.enter();
  refresh();
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
  const on = mode === free && state.target != null;
  $('targetChip').hidden = !on;
  if (on) $('targetName').innerHTML = noteHTML(state.target, !settings.fold);
}

function renderLayout() {
  els.top.classList.toggle('big', !settings.compact);
  $('rowSpan').hidden = settings.fold;
  roll.resize();
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
      ? 'Чтобы поставить на iPhone: в Safari нажми «Поделиться» → «На экран „Домой“». Прогресс тренировок хранится на этом устройстве, так что лучше поставить сразу.'
      : 'Чтобы поставить на телефон: в меню браузера выбери «Установить приложение» или «Добавить на главный экран».';
}

function bind() {
  $('ovBtn').addEventListener('click', () => ov && ov.onBtn && ov.onBtn());
  $('ovAlt').addEventListener('click', () => ov && ov.onAlt && ov.onAlt());
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
  for (const b of $('tabs').children) b.addEventListener('click', () => setTab(b.dataset.tab));

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
    if (e.clientX - r.left > KEY_W + 8 || !mode.keyTap) return;
    ensureCtx();
    const lane = roll.laneAt(e.clientY - r.top, scene(performance.now()));
    mode.keyTap(lane, fold() ? foldBase() + lane : lane);
  });

  const relabel = () => {
    buildDroneNotes();
    renderDock();
    renderTarget();
    if (mode.relabel) mode.relabel();
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
  const elapsed = Math.max(0, now - prevT);
  const dt = Math.min(100, elapsed);
  prevT = now;
  const v = audio.running ? sample(now) : NaN;
  voice.now = v;
  if (Number.isNaN(v)) idle(now);
  else accept(now, dt, v);
  if (mode.tick) mode.tick(now, Math.min(1000, elapsed));
  if (!els.stage.hidden) {
    state.center += (state.centerTarget - state.center) * (1 - Math.exp(-dt / 200));
    roll.draw(scene(now));
    put('hold', els.hold, mode.pill ? mode.pill(now) : '');
  }
  if (!els.top.hidden) readout(now);
}

bind();
renderLayout();
renderZone();
renderA4();
renderInstall();
refresh();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
