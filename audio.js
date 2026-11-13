import { createPitchDetector } from './pitch.js';
import { createTracker } from './tracker.js';
import { settings } from './settings.js';

const GATE_DB = { low: -45, mid: -55, high: -65 };
const MIN_CLARITY = 0.86;

export const audio = { ctx: null, running: false, starting: false, level: -100, drone: false };

let waves = null;
let master = null;
let stream = null;
let nodes = null;
let buf = null;
let bytes = null;
let detect = null;
let droneNodes = null;
let wake = null;
const live = new Set();
const tracker = createTracker();

export const toMidi = (f) => 69 + 12 * Math.log2(f / settings.a4);
export const toFreq = (m) => settings.a4 * 2 ** ((m - 69) / 12);

function wave(ctx, amps) {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => {
    imag[i + 1] = a;
  });
  return ctx.createPeriodicWave(real, imag);
}

export function ensureCtx() {
  if (!audio.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AC({ latencyHint: 'interactive' });
    master = audio.ctx.createGain();
    master.connect(audio.ctx.destination);
    waves = {
      drone: wave(audio.ctx, [1, 0.5, 0.33, 0.24, 0.16, 0.11, 0.07, 0.05, 0.03]),
      key: wave(audio.ctx, [1, 0.45, 0.25, 0.14, 0.08, 0.05, 0.03]),
    };
  }
  if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
  return audio.ctx;
}

export async function startMic(onEnded) {
  if (audio.running || audio.starting) return;
  audio.starting = true;
  const ctx = ensureCtx();
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('unsupported');
      err.name = window.isSecureContext ? 'NotSupportedError' : 'InsecureError';
      throw err;
    }
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(s);
    const an = ctx.createAnalyser();
    an.fftSize = ctx.sampleRate > 60000 ? 4096 : 2048;
    an.smoothingTimeConstant = 0;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(an);
    an.connect(sink);
    sink.connect(ctx.destination);
    stream = s;
    nodes = { src, an, sink };
    buf = new Float32Array(an.fftSize);
    bytes = typeof an.getFloatTimeDomainData === 'function' ? null : new Uint8Array(an.fftSize);
    detect = createPitchDetector(ctx.sampleRate, an.fftSize);
    tracker.reset();
    audio.running = true;
    s.getAudioTracks().forEach((t) => t.addEventListener('ended', () => onEnded && onEnded()));
    keepAwake();
  } finally {
    audio.starting = false;
  }
}

export function stopMic() {
  if (!audio.running) return;
  audio.running = false;
  stream.getTracks().forEach((t) => t.stop());
  try {
    nodes.src.disconnect();
    nodes.an.disconnect();
    nodes.sink.disconnect();
  } catch {}
  stream = null;
  nodes = null;
  audio.level = -100;
  releaseAwake();
}

export function sample(now) {
  const an = nodes.an;
  if (bytes) {
    an.getByteTimeDomainData(bytes);
    for (let i = 0; i < bytes.length; i++) buf[i] = (bytes[i] - 128) / 128;
  } else {
    an.getFloatTimeDomainData(buf);
  }
  const r = detect(buf);
  const db = 20 * Math.log10(r.rms + 1e-9);
  audio.level = db;
  const ok = r.freq > 0 && r.clarity >= MIN_CLARITY && db >= GATE_DB[settings.sens];
  return tracker.push(now, ok ? toMidi(r.freq) : NaN);
}

export function tone(midi, { dur = 1.1, hold = false, gain = 0.6, delay = 0 } = {}) {
  const ctx = ensureCtx();
  const t = ctx.currentTime + 0.02 + Math.max(0, delay);
  const o = ctx.createOscillator();
  o.setPeriodicWave(waves.key);
  o.frequency.value = toFreq(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  if (hold) {
    g.gain.setTargetAtTime(gain * 0.75, t + 0.012, 0.3);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.025);
  } else {
    g.gain.setTargetAtTime(0.0001, t + 0.09, dur * 0.29);
  }
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.5);
  const h = { o, g };
  live.add(h);
  o.onended = () => {
    live.delete(h);
    g.disconnect();
  };
  return h;
}

export function stopTones() {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  for (const h of live) {
    try {
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setTargetAtTime(0.0001, t, 0.015);
      h.o.stop(t + 0.12);
    } catch {}
  }
}

export function startDrone() {
  stopDrone();
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
  out.connect(master);
  const f = toFreq(12 * (settings.droneOct + 1) + settings.droneNote);
  const oscs = [];
  const voice = (freq, gain) => {
    const o = ctx.createOscillator();
    o.setPeriodicWave(waves.drone);
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
  droneNodes = { out, oscs };
  audio.drone = true;
}

export function stopDrone() {
  const d = droneNodes;
  if (!d) return;
  droneNodes = null;
  audio.drone = false;
  const t = audio.ctx.currentTime;
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
}

export function setDroneVol() {
  if (droneNodes) droneNodes.out.gain.setTargetAtTime(settings.droneVol * 0.5, audio.ctx.currentTime, 0.05);
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => {
        wake = null;
      });
    }
  } catch {}
}

function releaseAwake() {
  try {
    if (wake) wake.release();
  } catch {}
  wake = null;
}
