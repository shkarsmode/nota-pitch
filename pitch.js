export function createPitchDetector(sampleRate, size, opts = {}) {
  const minFreq = opts.minFreq ?? 60;
  const maxFreq = opts.maxFreq ?? 1400;
  const k = opts.k ?? 0.9;
  const n = 1 << Math.ceil(Math.log2(size * 2));
  const bits = Math.log2(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const x = new Float64Array(size);
  const nsdf = new Float64Array(size + 1);
  const rev = new Uint32Array(n);
  const peakT = new Int32Array(512);
  const peakV = new Float64Array(512);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(size - 2, Math.ceil(sampleRate / minFreq));
  const out = { freq: 0, clarity: 0, rms: 0 };

  function fft(sign) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step];
          const wi = sign * sin[j * step];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  return function detect(buf) {
    let mean = 0;
    for (let i = 0; i < size; i++) mean += buf[i];
    mean /= size;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const v = buf[i] - mean;
      x[i] = v;
      re[i] = v;
      im[i] = 0;
      energy += v * v;
    }
    re.fill(0, size);
    im.fill(0, size);
    out.rms = Math.sqrt(energy / size);
    out.freq = 0;
    out.clarity = 0;
    if (energy < 1e-10) return out;

    fft(-1);
    for (let i = 0; i < n; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    fft(1);

    let m = 2 * energy;
    for (let t = 1; t <= tauMax + 1; t++) {
      m -= x[t - 1] * x[t - 1] + x[size - t] * x[size - t];
      nsdf[t] = m > 1e-12 ? (2 * re[t]) / n / m : 0;
    }

    let t = 1;
    while (t < tauMax && nsdf[t] > 0) t++;
    let count = 0;
    let inside = false;
    let curT = 0;
    let curV = 0;
    for (; t <= tauMax; t++) {
      const v = nsdf[t];
      if (v > 0) {
        if (!inside) {
          inside = true;
          curT = t;
          curV = v;
        } else if (v > curV) {
          curT = t;
          curV = v;
        }
      } else if (inside) {
        inside = false;
        if (count < peakT.length) {
          peakT[count] = curT;
          peakV[count++] = curV;
        }
      }
    }
    if (inside && curT < tauMax && count < peakT.length) {
      peakT[count] = curT;
      peakV[count++] = curV;
    }
    if (!count) return out;

    let vmax = 0;
    for (let i = 0; i < count; i++) if (peakV[i] > vmax) vmax = peakV[i];
    const threshold = k * vmax;
    let p = -1;
    for (let i = 0; i < count; i++) {
      if (peakV[i] >= threshold && peakT[i] >= tauMin) {
        p = peakT[i];
        break;
      }
    }
    if (p < 1) return out;

    const a = nsdf[p - 1];
    const b = nsdf[p];
    const c = nsdf[p + 1];
    const den = a - 2 * b + c;
    let shift = den < 0 ? (0.5 * (a - c)) / den : 0;
    if (shift > 0.5 || shift < -0.5) shift = 0;
    out.freq = sampleRate / (p + shift);
    out.clarity = Math.min(1, b - 0.25 * (a - c) * shift);
    return out;
  };
}
