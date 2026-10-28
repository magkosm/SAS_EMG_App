// Light processing: moving-average smoothing, rest/MVC calibration, unit conversion, per-step stats.
// The M40 already sends a processed EMG level (0–1000, 0.1 % full scale) at 10 Hz, so no filtering of raw EMG is needed here.

import { state, emit } from './state.js';

const LIVE_KEEP_SEC = 300; // live buffer length per sensor
export const ACTIVE_SD = 3; // "active" = above rest mean + 3 SD

export function newBuffers() {
  return { t: [], raw: [], sm: [] };
}

// Called for every notification from a sensor.
export function ingest(s, raw, t) {
  raw = Math.min(Math.max(raw, 0), 1023);
  const b = s.buf;
  // Rate estimate (EMA of the interval between packets).
  if (s.lastT != null) {
    const dt = t - s.lastT;
    if (dt > 0 && dt < 2) s.dtAvg = s.dtAvg ? s.dtAvg * 0.9 + dt * 0.1 : dt;
  }
  s.lastT = t;
  s.lastRaw = raw;
  b.t.push(t);
  b.raw.push(raw);
  const n = Math.min(state.smoothN, b.raw.length);
  let sum = 0;
  for (let i = b.raw.length - n; i < b.raw.length; i++) sum += b.raw[i];
  const sm = sum / n;
  b.sm.push(sm);
  s.lastSm = sm;
  s.satCount = raw >= 1000 ? (s.satCount || 0) + 1 : 0;

  // Trim the live buffer in chunks.
  if (b.t.length > LIVE_KEEP_SEC * 12 && t - b.t[0] > LIVE_KEEP_SEC) {
    const cut = b.t.findIndex((x) => x > t - LIVE_KEEP_SEC);
    b.t.splice(0, cut); b.raw.splice(0, cut); b.sm.splice(0, cut);
  }

  // Calibration capture in progress?
  const c = state.calib;
  if (c && c.keys.includes(s.key) && t >= c.t0) c.data[s.key].push(raw);

  emit('sample', { s, raw, sm, t });
}

// ---- Units -------------------------------------------------------------

export function unitFor(s, mode = state.displayMode) {
  if (mode === 'mvc' && s.calib.mvc > 0) return 'mvc';
  if (mode === 'rest' && s.calib.restMean > 0) return 'rest';
  return 'raw';
}
export const UNIT_LABEL = { raw: '', mvc: '% MVC', rest: '× rest' };
export const UNIT_DIGITS = { raw: 0, mvc: 0, rest: 1 };

export function convert(s, v, unit) {
  if (v == null) return null;
  if (unit === 'mvc') return (v / s.calib.mvc) * 100;
  if (unit === 'rest') return v / s.calib.restMean;
  return v;
}

export function activeThreshold(s) {
  const c = s.calib;
  return c.restMean != null ? c.restMean + ACTIVE_SD * (c.restSd || 0) : null;
}

// ---- Calibration -------------------------------------------------------

export function summarizeRest(values) {
  if (values.length < 5) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Drop the top 5 % so one swallow or twitch does not inflate the baseline.
  const kept = sorted.slice(0, Math.max(5, Math.floor(sorted.length * 0.95)));
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  const sd = Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, kept.length - 1));
  return { mean, sd, n: values.length };
}

// MVC = highest 1-second moving average within the capture window.
export function summarizeMvc(values) {
  const w = 10;
  if (values.length < w) return null;
  let sum = 0, best = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    if (i >= w - 1) best = Math.max(best, sum / w);
  }
  return best;
}

// ---- Per-step stats ----------------------------------------------------

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
export { lowerBound };

// data: { t:[], raw:[], sm:[] } in the same timebase as t0/t1.
export function windowStats(s, data, t0, t1) {
  const i0 = lowerBound(data.t, t0);
  const i1 = lowerBound(data.t, t1);
  const n = i1 - i0;
  if (n < 2) return null;
  let sum = 0, sumSq = 0, peak = 0, above = 0;
  const thr = activeThreshold(s);
  for (let i = i0; i < i1; i++) {
    const r = data.raw[i];
    sum += r; sumSq += r * r;
    if (data.sm[i] > peak) peak = data.sm[i];
    if (thr != null && r > thr) above++;
  }
  const mean = sum / n;
  const st = {
    n,
    mean,
    sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    peak,
    iemg: mean * (t1 - t0), // level × seconds
    pctActive: thr != null ? (100 * above) / n : null,
    meanMvc: s.calib.mvc > 0 ? (mean / s.calib.mvc) * 100 : null,
    peakMvc: s.calib.mvc > 0 ? (peak / s.calib.mvc) * 100 : null,
    meanRest: s.calib.restMean > 0 ? mean / s.calib.restMean : null,
    peakRest: s.calib.restMean > 0 ? peak / s.calib.restMean : null,
  };
  return st;
}

// Pick the value of a stats object that matches a display unit.
export function statIn(st, metric, unit) {
  if (!st) return null;
  if (metric === 'pctActive') return st.pctActive;
  if (metric === 'mean') return unit === 'mvc' ? st.meanMvc : unit === 'rest' ? st.meanRest : st.mean;
  if (metric === 'peak') return unit === 'mvc' ? st.peakMvc : unit === 'rest' ? st.peakRest : st.peak;
  return null;
}
