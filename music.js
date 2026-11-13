export const NAMES = {
  letters: {
    sharp: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    flat: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'],
  },
  solfege: {
    sharp: ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'],
    flat: ['До', 'Ре♭', 'Ре', 'Ми♭', 'Ми', 'Фа', 'Соль♭', 'Соль', 'Ля♭', 'Ля', 'Си♭', 'Си'],
  },
};
export const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
export const FONT = 'system-ui, -apple-system, Roboto, sans-serif';

export const pcOf = (n) => ((Math.round(n) % 12) + 12) % 12;
export const octOf = (n) => Math.floor(n / 12) - 1;

export function foldDev(m, target) {
  const d = m - target;
  return d - 12 * Math.round(d / 12);
}

export function foldPos(m, anchor = 6) {
  const f = ((m % 12) + 12) % 12;
  if (f > 11.5 && Math.abs(f - 12 - anchor) < Math.abs(f - anchor)) return f - 12;
  if (f < 0.5 && Math.abs(f + 12 - anchor) < Math.abs(f - anchor)) return f + 12;
  return f;
}

export function median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  return s[s.length >> 1];
}

export function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length ? sum / values.length : 0;
}
