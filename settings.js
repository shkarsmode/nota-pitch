import { NAMES, pcOf, octOf } from './music.js';

export const DEFAULTS = {
  fold: true,
  compact: true,
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
  loopSound: false,
  loopTempo: 1,
};

export const OPTIONS = {
  fold: [[true, 'До–До'], [false, 'С октавами']],
  compact: [[true, 'Компактная'], [false, 'Большая']],
  names: [['letters', 'C D E'], ['solfege', 'До Ре Ми']],
  acc: [['sharp', '♯ диезы'], ['flat', '♭ бемоли']],
  tol: [[8, '±8 строго'], [15, '±15'], [25, '±25 мягко']],
  span: [[12, '1 окт'], [18, '1,5 окт'], [24, '2 окт']],
  win: [[4, '4 с'], [6, '6 с'], [10, '10 с']],
  sens: [['low', 'Низкая'], ['mid', 'Средняя'], ['high', 'Высокая']],
  droneOct: [[2, '2'], [3, '3'], [4, '4']],
  droneFifth: [[false, 'Нет'], [true, '+ квинта']],
  loopSound: [[false, 'Выкл'], [true, 'Вкл']],
  loopTempo: [[1, '100%'], [0.75, '75%'], [0.5, '50%']],
};

function load() {
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

export const settings = load();

export function saveSettings() {
  try {
    localStorage.setItem('nota.settings', JSON.stringify(settings));
  } catch {}
}

export function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const nameOf = (n) => NAMES[settings.names][settings.acc][pcOf(n)];

export function parts(n, withOct = true) {
  const name = nameOf(n);
  const last = name.slice(-1);
  const acc = last === '♯' || last === '♭' ? last : '';
  return { base: acc ? name.slice(0, -1) : name, acc, oct: withOct ? String(octOf(n)) : '' };
}

export function noteHTML(n, withOct = true) {
  const p = parts(n, withOct);
  return `${p.base}${p.acc ? `<span class="acc">${p.acc}</span>` : ''}${p.oct}`;
}

export const noteText = (n, withOct = true) => nameOf(n) + (withOct ? octOf(n) : '');

export function grade(devCents, tol = settings.tol) {
  const a = Math.abs(devCents);
  if (a <= tol) return 'good';
  if (a <= tol * 2) return 'warn';
  return 'bad';
}

export const decimal = (v, digits = 1) => v.toFixed(digits).replace('.', ',');
