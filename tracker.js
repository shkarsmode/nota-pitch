import { median } from './music.js';

export function createTracker({ size = 5, agree = 3, spread = 0.8, octaveHoldMs = 140 } = {}) {
  const buf = [];
  let lastRaw = -1e9;
  let stable = NaN;
  let stableAt = -1e9;
  let jumpOct = 0;
  let jumpAt = 0;

  return {
    reset() {
      buf.length = 0;
      stable = NaN;
      jumpOct = 0;
    },
    push(t, raw) {
      if (Number.isNaN(raw)) return NaN;
      if (t - lastRaw > 120) buf.length = 0;
      lastRaw = t;
      let m = raw;
      if (!Number.isNaN(stable) && t - stableAt < 250) {
        const d = m - stable;
        const o = Math.round(d / 12);
        if (o !== 0 && Math.abs(d - 12 * o) < 0.8) {
          if (jumpOct !== o) {
            jumpOct = o;
            jumpAt = t;
          }
          if (t - jumpAt < octaveHoldMs) m -= 12 * o;
        } else {
          jumpOct = 0;
        }
      } else {
        jumpOct = 0;
      }
      buf.push(m);
      if (buf.length > size) buf.shift();
      if (buf.length < agree) return NaN;
      const v = median(buf);
      let n = 0;
      for (const x of buf) if (Math.abs(x - v) < spread) n++;
      if (n < agree) return NaN;
      stable = v;
      stableAt = t;
      return v;
    },
  };
}
