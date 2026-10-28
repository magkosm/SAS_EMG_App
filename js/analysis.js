// Session analysis (pure computation, no DOM): samples grouped per exercise vs rest, activation
// (burst) detection, rep-locked stacking, and clustering of 1-second activation patterns.
//
// Input `sess` (built from a loaded session, see replay.js getSessionForAnalysis):
//   sensors:  [{ key, label, name, colorIdx, calib, t: Float64Array, raw: Float64Array, phase: string[] }]
//   steps:    [{ step, title, attempt, superseded, t0, t1, repTimes: number[], target }]
//   calib:    [{ kind: 'rest' | 'mvc', t0, t1 }]
//   duration: seconds
// All times are seconds since session start.

export const DEFAULTS = {
  unit: 'rest',        // 'rest' (× rest) | 'mvc' (% MVC) | 'raw'
  restSource: 'auto',  // 'auto' | 'calib' | 'between' | 'both'
  k: 3,                // activation threshold: rest mean + k·SD
  minDur: 0.3,         // shortest burst, s
  clusters: 4,
  win: 1,              // clustering window, s
  features: 'level',   // 'level' | 'level+var'
  align: 'rep',        // stacks aligned on 'rep' presses or activation 'onset'
  pre: 1,
  post: 2,
};

const DT = 0.1;          // M40 sample interval
const GAP = 0.5;         // data gap that breaks a burst or an interval
const REP_TOL = 0.75;    // a rep "has an activation" if a burst lies within ±0.75 s of the press
const LAT_WIN = 1.5;     // onset latency search window around a rep, s

// ---- small helpers -----------------------------------------------------------------------

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function median(a) {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function meanSd(vals) {
  const n = vals.length;
  if (!n) return { mean: null, sd: null, n: 0 };
  let s = 0;
  for (const v of vals) s += v;
  const mean = s / n;
  let q = 0;
  for (const v of vals) q += (v - mean) ** 2;
  return { mean, sd: Math.sqrt(q / Math.max(1, n - 1)), n };
}
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Centred 3-sample moving average that does not reach across data gaps (0.3 s at 10 Hz).
function smooth3(t, raw) {
  const n = raw.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = raw[i], c = 1;
    if (i > 0 && t[i] - t[i - 1] < 0.25) { s += raw[i - 1]; c++; }
    if (i < n - 1 && t[i + 1] - t[i] < 0.25) { s += raw[i + 1]; c++; }
    out[i] = s / c;
  }
  return out;
}

function inAny(t, intervals) {
  for (const [a, b] of intervals) if (t >= a && t <= b) return true;
  return false;
}

// Contiguous runs of samples whose phase is in `wanted`, as [t0, t1] intervals.
function phaseIntervals(t, phase, wanted, minLen) {
  const out = [];
  let start = null, last = null;
  for (let i = 0; i < t.length; i++) {
    const on = wanted.has(phase[i]);
    if (on && start != null && t[i] - last > GAP) { if (last - start >= minLen) out.push([start, last]); start = null; }
    if (on) { if (start == null) start = t[i]; last = t[i]; }
    else if (start != null) { if (last - start >= minLen) out.push([start, last]); start = null; }
  }
  if (start != null && last - start >= minLen) out.push([start, last]);
  return out;
}

// Histogram of integer device values (0..1023): fast quantiles and AUC.
function hist(vals) {
  const h = new Uint32Array(1025);
  for (const v of vals) h[Math.max(0, Math.min(1024, Math.round(v)))]++;
  return h;
}
function histQuantiles(h, n, qs) {
  const out = [];
  let acc = 0, qi = 0;
  for (let v = 0; v < h.length && qi < qs.length; v++) {
    acc += h[v];
    while (qi < qs.length && acc >= qs[qi] * n) { out.push(v); qi++; }
  }
  while (out.length < qs.length) out.push(h.length - 1);
  return out;
}
// P(step sample > rest sample) + ½·P(equal). 0.5 = same as rest, 1 = always higher.
function histAuc(hA, nA, hB, nB) {
  if (!nA || !nB) return null;
  let below = 0, u = 0;
  for (let v = 0; v < hA.length; v++) {
    u += hA[v] * (below + 0.5 * hB[v]);
    below += hB[v];
  }
  return u / (nA * nB);
}

// ---- rest reference ------------------------------------------------------------------------

export function restIntervals(sess, source) {
  const calib = sess.calib.filter((c) => c.kind === 'rest').map((c) => [c.t0, c.t1]);
  const ref = sess.sensors.find((s) => s.phase?.length) || null;
  const between = ref ? phaseIntervals(ref.t, ref.phase, new Set(['rest']), 3) : [];
  let used = source, intervals;
  if (source === 'calib') intervals = calib;
  else if (source === 'between') intervals = between;
  else if (source === 'both') intervals = [...calib, ...between];
  else { intervals = calib.length ? calib : between; used = calib.length ? 'calib' : 'between'; }
  if (!intervals.length) used = 'quietest';
  return { intervals: intervals.sort((a, b) => a[0] - b[0]), source: used, calibCount: calib.length, betweenCount: between.length };
}

// ---- main ------------------------------------------------------------------------------------

export function analyse(sess, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rest = restIntervals(sess, o.restSource);
  const steps = sess.steps.filter((a) => !a.superseded).sort((a, b) => a.step - b.step || a.t0 - b.t0);
  const notes = [];
  if (rest.source === 'quietest') notes.push('No rest recording found: the quietest 20 % of each sensor’s samples is used as rest.');

  const sensors = sess.sensors.map((s) => prepSensor(s, rest, o, notes));
  const groups = buildGroups(sensors, steps, rest);
  const activations = buildActivations(sensors, steps, rest, o);
  const stacks = buildStacks(sensors, steps, activations, o);
  const clusters = buildClusters(sensors, steps, rest, o, sess.duration);
  return { opts: o, rest, steps, sensors: sensors.map(publicSensor), groups, activations, stacks, clusters, notes };
}

function prepSensor(s, rest, o, notes) {
  const t = s.t, raw = s.raw;
  const s3 = smooth3(t, raw);
  let restIdx = [];
  if (rest.intervals.length) {
    for (let i = 0; i < t.length; i++) if (inAny(t[i], rest.intervals)) restIdx.push(i);
  }
  if (restIdx.length < 20) {
    // Fallback: quietest 20 % of this sensor's samples.
    const order = Array.from(raw, (_, i) => i).sort((a, b) => s3[a] - s3[b]);
    restIdx = order.slice(0, Math.max(20, Math.floor(order.length * 0.2))).sort((a, b) => a - b);
  }
  const rRaw = meanSd(restIdx.map((i) => raw[i]));
  const rS3 = meanSd(restIdx.map((i) => s3[i]));
  let unit = o.unit, factor = 1;
  if (unit === 'rest' && rRaw.mean > 0) factor = 1 / rRaw.mean;
  else if (unit === 'mvc' && s.calib?.mvc > 0) factor = 100 / s.calib.mvc;
  else {
    if (unit !== 'raw') notes.push(`${s.label}: no ${unit === 'mvc' ? 'MVC' : 'rest'} value, shown in raw units.`);
    unit = 'raw';
  }
  const sdFloor = Math.max(rS3.sd || 0, 0.5); // a perfectly flat rest would make any wiggle "active"
  return {
    ...s, s3, restIdx, unit, factor,
    restRaw: rRaw, restS3: rS3,
    thrOn: rS3.mean + o.k * sdFloor,
    thrOff: rS3.mean + Math.max(0.5, o.k - 1) * sdFloor,
  };
}

function publicSensor(p) {
  return {
    key: p.key, label: p.label, name: p.name, colorIdx: p.colorIdx, unit: p.unit, factor: p.factor,
    restMean: p.restRaw.mean, restSd: p.restRaw.sd, restN: p.restRaw.n,
    thrOn: p.thrOn, thrOff: p.thrOff, thrOnUnit: p.thrOn * p.factor, restMeanUnit: p.restS3.mean * p.factor, restSdUnit: (p.restS3.sd || 0) * p.factor,
  };
}

// ---- 1. groups: all samples per exercise vs rest --------------------------------------------

function buildGroups(sensors, steps, rest) {
  const groups = [{ id: 'rest', label: rest.source === 'quietest' ? 'Rest (quietest 20 %)' : 'Rest', kind: 'rest', bySensor: {} }];
  for (const a of steps) groups.push({ id: 'S' + a.step, step: a.step, label: `${a.step}. ${a.title}`, kind: 'step', t0: a.t0, t1: a.t1, bySensor: {} });
  for (const p of sensors) {
    const restVals = p.restIdx.map((i) => p.raw[i]);
    const hR = hist(restVals);
    const qsR = histQuantiles(hR, restVals.length, [0.05, 0.25, 0.5, 0.75, 0.95]);
    groups[0].bySensor[p.key] = statsFrom(restVals, qsR, p.factor, null);
    for (const g of groups.slice(1)) {
      const i0 = lowerBound(p.t, g.t0), i1 = lowerBound(p.t, g.t1);
      const vals = Array.prototype.slice.call(p.raw, i0, i1);
      if (vals.length < 5) continue;
      const hS = hist(vals);
      const qs = histQuantiles(hS, vals.length, [0.05, 0.25, 0.5, 0.75, 0.95]);
      const st = statsFrom(vals, qs, p.factor, histAuc(hS, vals.length, hR, restVals.length));
      st.ratio = qsR[2] > 0 ? qs[2] / qsR[2] : null;
      g.bySensor[p.key] = st;
    }
  }
  return groups;
}

function statsFrom(vals, qs, f, auc) {
  const m = meanSd(vals);
  return { n: vals.length, p5: qs[0] * f, q1: qs[1] * f, median: qs[2] * f, q3: qs[3] * f, p95: qs[4] * f, mean: m.mean * f, sd: m.sd * f, auc };
}

// ---- 2. activation detection ----------------------------------------------------------------

function detectBursts(p, o) {
  const { t, s3 } = p;
  const minN = Math.max(1, Math.round(o.minDur / DT));
  const runs = [];
  let on = false, start = -1;
  for (let i = 0; i < t.length; i++) {
    const gap = i > 0 && t[i] - t[i - 1] > GAP;
    if (gap && on) { runs.push([start, i - 1]); on = false; }
    if (!on && s3[i] > p.thrOn) { on = true; start = i; }
    else if (on && s3[i] < p.thrOff) { runs.push([start, i - 1]); on = false; }
  }
  if (on) runs.push([start, t.length - 1]);
  // Merge bursts separated by < 0.2 s, then drop the short ones.
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && t[r[0]] - t[last[1]] < 0.2 + 1e-9 && t[r[0]] - t[last[1]] < GAP) last[1] = r[1];
    else merged.push([...r]);
  }
  const active = new Uint8Array(t.length);
  const bursts = [];
  for (const [a, b] of merged) {
    if (b - a + 1 < minN) continue;
    let peak = 0, area = 0;
    for (let i = a; i <= b; i++) { active[i] = 1; peak = Math.max(peak, s3[i]); area += (s3[i] - p.restS3.mean) * DT; }
    bursts.push({ t0: t[a], t1: t[b] + DT, dur: t[b] + DT - t[a], peak: peak * p.factor, area: area * p.factor });
  }
  return { bursts, active };
}

function buildActivations(sensors, steps, rest, o) {
  const bySensor = {}, perStep = [], restStats = {};
  const actFlags = {};
  for (const p of sensors) {
    const { bursts, active } = detectBursts(p, o);
    bySensor[p.key] = bursts;
    actFlags[p.key] = active;
    // False alarms: activity detected during rest.
    let n = 0, a = 0, dur = 0;
    for (const i of p.restIdx) { n++; a += active[i]; }
    for (const [t0, t1] of rest.intervals) dur += t1 - t0;
    const inRest = bursts.filter((b) => inAny((b.t0 + b.t1) / 2, rest.intervals)).length;
    restStats[p.key] = { duty: n ? (100 * a) / n : null, burstsPerMin: dur > 0 ? inRest / (dur / 60) : null };
  }
  for (const a of steps) {
    const row = { step: a.step, title: a.title, reps: a.repTimes.length, target: a.target, dur: a.t1 - a.t0, bySensor: {} };
    for (const p of sensors) {
      const i0 = lowerBound(p.t, a.t0), i1 = lowerBound(p.t, a.t1);
      let act = 0;
      for (let i = i0; i < i1; i++) act += actFlags[p.key][i];
      const bs = bySensor[p.key].filter((b) => b.t1 > a.t0 && b.t0 < a.t1);
      const withAct = a.repTimes.filter((r) => bs.some((b) => b.t0 <= r + REP_TOL && b.t1 >= r - REP_TOL)).length;
      const lats = [];
      for (const r of a.repTimes) {
        let best = null;
        for (const b of bs) { const d = b.t0 - r; if (Math.abs(d) <= LAT_WIN && (best == null || Math.abs(d) < Math.abs(best))) best = d; }
        if (best != null) lats.push(best);
      }
      row.bySensor[p.key] = {
        duty: i1 > i0 ? (100 * act) / (i1 - i0) : null,
        bursts: bs.length,
        burstsPerMin: row.dur > 0 ? bs.length / (row.dur / 60) : null,
        repsWithAct: a.repTimes.length ? (100 * withAct) / a.repTimes.length : null,
        onsetLatencyMs: lats.length ? median(lats) * 1000 : null,
        meanBurstDur: bs.length ? bs.reduce((s, b) => s + b.dur, 0) / bs.length : null,
        meanBurstPeak: bs.length ? bs.reduce((s, b) => s + b.peak, 0) / bs.length : null,
      };
    }
    perStep.push(row);
  }
  return { bySensor, perStep, rest: restStats };
}

// ---- 3. stacking (event-locked averages) -------------------------------------------------------

function interpAt(t, v, x) {
  const j = lowerBound(t, x);
  if (j <= 0 || j >= t.length) return NaN;
  const a = t[j - 1], b = t[j];
  if (b - a > 0.3) return NaN;
  return v[j - 1] + ((v[j] - v[j - 1]) * (x - a)) / (b - a);
}

function buildStacks(sensors, steps, activations, o) {
  const n = Math.round((o.pre + o.post) / DT) + 1;
  const tau = Array.from({ length: n }, (_, i) => +(-o.pre + i * DT).toFixed(2));
  const perStep = [];
  for (const a of steps) {
    const entry = { step: a.step, title: a.title, bySensor: {} };
    for (const p of sensors) {
      const events = o.align === 'onset'
        ? activations.bySensor[p.key].filter((b) => b.t0 >= a.t0 && b.t0 <= a.t1).map((b) => b.t0)
        : a.repTimes;
      const segs = [];
      for (const e of events) {
        const seg = tau.map((d) => interpAt(p.t, p.s3, e + d) * p.factor);
        if (seg.filter(Number.isFinite).length >= n * 0.7) segs.push(seg);
      }
      const mean = [], sd = [], cnt = [];
      for (let i = 0; i < n; i++) {
        const col = segs.map((s) => s[i]).filter(Number.isFinite);
        const m = meanSd(col);
        mean.push(m.mean); sd.push(m.sd); cnt.push(col.length);
      }
      // Peak of the average and its timing relative to the event.
      let pk = -Infinity, pkT = null;
      mean.forEach((v, i) => { if (v != null && v > pk) { pk = v; pkT = tau[i]; } });
      entry.bySensor[p.key] = { n: segs.length, mean, sd, segments: segs.slice(0, 60), peak: segs.length ? pk : null, peakAt: pkT };
    }
    perStep.push(entry);
  }
  return { tau, align: o.align, perStep };
}

// ---- 4. clustering of activation patterns ---------------------------------------------------------

function kmeans(X, k, seed = 42, restarts = 8) {
  const rnd = mulberry32(seed);
  const d = X[0].length, n = X.length;
  const dist2 = (a, b) => { let s = 0; for (let i = 0; i < d; i++) s += (a[i] - b[i]) ** 2; return s; };
  let best = null;
  for (let r = 0; r < restarts; r++) {
    // k-means++ seeding
    const C = [X[Math.floor(rnd() * n)].slice()];
    const D = new Float64Array(n);
    while (C.length < k) {
      let sum = 0;
      for (let i = 0; i < n; i++) { D[i] = Math.min(...C.map((c) => dist2(X[i], c))); sum += D[i]; }
      let x = rnd() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { x -= D[i]; if (x <= 0) { pick = i; break; } }
      C.push(X[pick].slice());
    }
    const lab = new Int32Array(n).fill(-1);
    for (let it = 0; it < 100; it++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const dd = dist2(X[i], C[c]); if (dd < bd) { bd = dd; bi = c; } }
        if (lab[i] !== bi) { lab[i] = bi; moved++; }
      }
      for (let c = 0; c < k; c++) {
        const acc = new Float64Array(d); let m = 0;
        for (let i = 0; i < n; i++) if (lab[i] === c) { for (let j = 0; j < d; j++) acc[j] += X[i][j]; m++; }
        if (m) for (let j = 0; j < d; j++) C[c][j] = acc[j] / m;
      }
      if (!moved) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(X[i], C[lab[i]]);
    if (!best || inertia < best.inertia) best = { C: C.map((c) => c.slice()), lab: Int32Array.from(lab), inertia };
  }
  return best;
}

// First two principal components of standardised data (power iteration with deflation).
function pca2(Z) {
  const n = Z.length, d = Z[0].length;
  const cov = Array.from({ length: d }, () => new Float64Array(d));
  for (const z of Z) for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) cov[a][b] += (z[a] * z[b]) / Math.max(1, n - 1);
  const comps = [], vars = [];
  const total = cov.reduce((s, r, i) => s + r[i], 0);
  for (let c = 0; c < Math.min(2, d); c++) {
    let v = Float64Array.from({ length: d }, (_, i) => 1 / Math.sqrt(d) + i * 1e-3);
    let lam = 0;
    for (let it = 0; it < 200; it++) {
      const w = new Float64Array(d);
      for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) w[a] += cov[a][b] * v[b];
      lam = Math.hypot(...w);
      if (!lam) break;
      v = w.map((x) => x / lam);
    }
    comps.push(v); vars.push(total ? lam / total : 0);
    for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) cov[a][b] -= lam * v[a] * v[b];
  }
  const proj = Z.map((z) => comps.map((v) => v.reduce((s, x, i) => s + x * z[i], 0)));
  return { proj, explained: vars, comps };
}

function buildClusters(sensors, steps, rest, o, duration) {
  const W = o.win;
  const useVar = o.features === 'level+var';
  const minCount = Math.max(2, Math.floor((W / DT) * 0.6));
  const ptr = sensors.map(() => 0);
  const windows = [];
  for (let w0 = 0; w0 + W <= duration + 1e-9; w0 += W) {
    const c = w0 + W / 2;
    let group = null;
    if (inAny(c, rest.intervals)) group = 'rest';
    else {
      const a = steps.find((x) => c >= x.t0 && c <= x.t1);
      if (a) group = 'S' + a.step;
    }
    if (!group) continue;
    const feat = [], levels = [];
    let ok = true;
    sensors.forEach((p, si) => {
      let i = ptr[si];
      while (i < p.t.length && p.t[i] < w0) i++;
      ptr[si] = i;
      const vals = [];
      for (let j = i; j < p.t.length && p.t[j] < w0 + W; j++) vals.push(p.raw[j]);
      if (vals.length < minCount) { ok = false; return; }
      const m = meanSd(vals);
      const ref = p.restRaw.mean > 0 ? p.restRaw.mean : 1;
      const lvl = Math.log2(Math.max(m.mean, ref * 0.05) / ref);
      feat.push(lvl);
      levels.push(2 ** lvl);
      if (useVar) feat.push(Math.log2(((m.sd || 0) + 1) / ((p.restRaw.sd || 0) + 1)));
    });
    if (ok) windows.push({ t0: w0, t1: w0 + W, group, feat, levels });
  }
  const featureNames = sensors.flatMap((p) => (useVar ? [`${p.label} level`, `${p.label} variability`] : [`${p.label} level`]));
  if (windows.length < 4) return { k: 0, windows, featureNames, centroids: [], occupancy: {}, counts: {}, activeShare: {}, explained: [], groupsOrder: [], note: 'Too little data in steps and rest for clustering.' };

  const d = windows[0].feat.length;
  const mu = new Float64Array(d), sg = new Float64Array(d);
  for (const w of windows) w.feat.forEach((v, j) => { mu[j] += v / windows.length; });
  for (const w of windows) w.feat.forEach((v, j) => { sg[j] += (v - mu[j]) ** 2 / Math.max(1, windows.length - 1); });
  for (let j = 0; j < d; j++) sg[j] = Math.sqrt(sg[j]) || 1;
  const Z = windows.map((w) => w.feat.map((v, j) => (v - mu[j]) / sg[j]));

  const k = Math.max(1, Math.min(o.clusters, windows.length - 1));
  const km = kmeans(Z, k);
  // Centroids back in "× rest" per sensor, ordered from quietest to most active.
  let cents = km.C.map((c, idx) => {
    const lv = sensors.map((p, si) => 2 ** (c[useVar ? si * 2 : si] * sg[useVar ? si * 2 : si] + mu[useVar ? si * 2 : si]));
    return { idx, levels: lv, score: lv.reduce((s, v) => s + Math.log2(v), 0) };
  }).sort((a, b) => a.score - b.score);
  const remap = new Map(cents.map((c, i) => [c.idx, i]));
  windows.forEach((w, i) => { w.cluster = remap.get(km.lab[i]); });

  // Names from which sensors sit above their activation threshold (in × rest terms).
  const thrX = sensors.map((p) => (p.restRaw.mean > 0 ? p.thrOn / p.restRaw.mean : 1.5));
  const used = new Map();
  cents = cents.map((c, i) => {
    const active = sensors.filter((p, si) => c.levels[si] >= thrX[si]).map((p) => p.label);
    let name = !active.length ? 'Rest-like' : active.length === sensors.length && sensors.length > 1 ? 'Co-activation (all)' : `${active.join(' + ')} active`;
    const dup = used.get(name) || 0;
    used.set(name, dup + 1);
    if (dup) name += ` · level ${dup + 1}`;
    return { id: i, name, levels: c.levels, active, count: windows.filter((w) => w.cluster === i).length };
  });

  const groupsOrder = ['rest', ...steps.map((a) => 'S' + a.step)];
  const occupancy = {}, counts = {};
  for (const g of groupsOrder) {
    const ws = windows.filter((w) => w.group === g);
    counts[g] = ws.length;
    occupancy[g] = cents.map((c) => (ws.length ? ws.filter((w) => w.cluster === c.id).length / ws.length : 0));
  }
  // Share of each group's windows that fall in a pattern with at least one sensor above threshold.
  const activeShare = {};
  for (const g of groupsOrder) {
    activeShare[g] = counts[g] ? 100 * occupancy[g].reduce((s, p, i) => s + (cents[i].active.length ? p : 0), 0) : null;
  }
  const pc = pca2(Z);
  windows.forEach((w, i) => { w.pc = pc.proj[i]; });
  return { k, windows, featureNames, centroids: cents, occupancy, counts, activeShare, explained: pc.explained, groupsOrder };
}
