// Timestamp clean-up ("de-jitter") and lost-sample detection.
//
// The M40 measures and sends one value every 100 ms on its own clock, but the browser only sees when
// each packet arrives. Bluetooth adds a variable delay, and sometimes holds several packets and
// delivers them together. Here we recover the sensor's steady rhythm from the arrival times:
//   1. fit arrival ≈ offset + seq × T (T ≈ 0.1 s, the sensor's real interval incl. clock drift)
//   2. put "offset" on the lower edge of the arrivals (a packet cannot arrive before it was sent)
//   3. give each packet the latest sequence number it can have, packing bursts backwards
// The result: t = offset + seq × T for every sample, plus a count of samples that never arrived.
// Segments separated by more than 2 s (reconnects) are fitted on their own.

const SEGMENT_GAP_S = 2;

function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

function linreg(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const slope = (n * sxy - sx * sy) / den;
  return { slope, icpt: (sy - slope * sx) / n };
}

// Phase (0..T) of the earliest arrivals in a[i0..i1), measured on the grid A + k·T.
// Packets cluster just after the moment they were sent; the start of that cluster is the "edge".
// Returns null when there is no clear cluster (delays spread over a whole interval).
function edgePhase(a, i0, i1, T, A) {
  const B = 50, bin = T / B;
  const h = new Float64Array(B);
  for (let i = i0; i < i1; i++) {
    const p = (((a[i] - A) % T) + T) % T;
    h[Math.min(B - 1, Math.floor(p / bin))]++;
  }
  const sm = Array.from(h, (_, b) => h[(b + B - 1) % B] + h[b] + h[(b + 1) % B]);
  // The emptiest stretch of the circle lies just before the edge. Try a wide stretch first and
  // narrower ones when delays fill most of the interval.
  const smMax = Math.max(...sm), hMax = Math.max(...h);
  let from = -1;
  for (const W of [15, 8, 4]) {
    let best = Infinity, bestStart = 0;
    for (let b = 0; b < B; b++) {
      let c = 0;
      for (let k = 0; k < W; k++) c += sm[(b + k) % B];
      if (c < best) { best = c; bestStart = b; }
    }
    if (best / W <= smMax * 0.3) { from = (bestStart + Math.floor(W / 2)) % B; break; }
  }
  if (from < 0) return null;
  for (let k = 0; k < B; k++) {
    const b = (from + k) % B;
    if (h[b] >= 0.25 * hMax) {
      let lo = Infinity;
      for (let i = i0; i < i1; i++) {
        const p = (((a[i] - A) % T) + T) % T;
        if (Math.min(B - 1, Math.floor(p / bin)) === b) lo = Math.min(lo, p);
      }
      return lo;
    }
  }
  return null;
}

// Sensor interval incl. clock drift: track the edge phase in ~30 s windows; it drifts linearly when
// the true interval differs from the assumed one.
function estimateInterval(a, nominal) {
  const N = a.length, WIN = Math.max(80, Math.min(300, Math.floor(N / 6)));
  let T = nominal;
  for (let iter = 0; iter < 3; iter++) {
    const xs = [], ys = [];
    let prev = null, unwrap = 0;
    for (let i0 = 0; i0 + WIN / 2 < N; i0 += WIN) {
      const i1 = Math.min(N, i0 + WIN);
      const e = edgePhase(a, i0, i1, T, a[0]);
      if (e == null) continue;
      let y = e + unwrap;
      if (prev != null) {
        while (y - prev > T / 2) { y -= T; unwrap -= T; }
        while (prev - y > T / 2) { y += T; unwrap += T; }
      }
      prev = y;
      xs.push((a[i0] + a[i1 - 1]) / 2);
      ys.push(y);
    }
    if (xs.length < 3) break;
    const fit = linreg(xs, ys);
    if (!fit || Math.abs(fit.slope) > 0.01) break;
    T = T / (1 - fit.slope);
    if (Math.abs(fit.slope) < 1e-7) break;
  }
  return T;
}

// a: arrival times of one segment (seconds, increasing). Returns { seq, t, T }.
function fitSegment(a, nominal) {
  const N = a.length;
  const seq = new Int32Array(N);
  const t = new Float64Array(N);
  const T = N >= 240 ? estimateInterval(a, nominal) : nominal;
  let edge = N >= 20 ? edgePhase(a, 0, N, T, a[0]) : null;
  if (edge == null) {
    // No clear cluster: fall back to the 2 % lowest delay relative to the first packet.
    const r = [];
    for (let i = 0; i < N; i++) { const p = (((a[i] - a[0]) % T) + T) % T; r.push(p > T * 0.75 ? p - T : p); }
    edge = quantile(r, 0.02);
  }
  // Send times are off + k·T. Give each packet the latest k it can have (sent at or before arrival,
  // small tolerance), then pack backwards so bursts of held-back packets get consecutive numbers.
  const off = a[0] + edge - T;
  const m = new Float64Array(N);
  for (let i = 0; i < N; i++) m[i] = Math.floor((a[i] - off) / T + 0.25);
  seq[N - 1] = m[N - 1];
  for (let i = N - 2; i >= 0; i--) seq[i] = Math.min(m[i], seq[i + 1] - 1);
  const shift = seq[0];
  for (let i = 0; i < N; i++) { seq[i] -= shift; t[i] = off + (seq[i] + shift) * T; }
  return { seq, t, T };
}

// tArr: arrival times (any timebase, seconds). Returns per-sample arrays + a quality summary.
export function dejitter(tArr, nominal = 0.1) {
  const N = tArr.length;
  const out = {
    t: new Float64Array(N),
    seq: new Int32Array(N),
    lostBefore: new Int32Array(N),
    quality: null,
  };
  if (!N) { out.quality = { samples: 0 }; return out; }

  const segs = [];
  let s0 = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || tArr[i] - tArr[i - 1] > SEGMENT_GAP_S) { segs.push([s0, i]); s0 = i; }
  }

  let seqBase = 0, lost = 0, Tsum = 0, Tn = 0;
  const lat = [];
  let prevEnd = null, prevT = nominal;
  for (const [i0, i1] of segs) {
    const a = Array.prototype.slice.call(tArr, i0, i1);
    const f = fitSegment(a, nominal);
    if (prevEnd != null) {
      // Samples missed during a reconnect: the gap length in whole intervals.
      const missing = Math.max(0, Math.round((f.t[0] - prevEnd) / prevT) - 1);
      out.lostBefore[i0] = missing;
      lost += missing;
      seqBase += missing + 1;
    }
    for (let k = 0; k < a.length; k++) {
      const i = i0 + k;
      out.t[i] = f.t[k];
      out.seq[i] = seqBase + f.seq[k];
      if (k > 0) { const gap = f.seq[k] - f.seq[k - 1] - 1; out.lostBefore[i] = gap; lost += gap; }
      lat.push(a[k] - f.t[k]);
    }
    seqBase = out.seq[i1 - 1];
    prevEnd = f.t[a.length - 1];
    prevT = f.T;
    Tsum += f.T * a.length; Tn += a.length;
  }
  const T = Tn ? Tsum / Tn : nominal;
  let maxGap = 0;
  for (let i = 1; i < N; i++) maxGap = Math.max(maxGap, tArr[i] - tArr[i - 1]);
  out.quality = {
    samples: N,
    lost,
    lostPct: (100 * lost) / (N + lost),
    rateHz: 1 / T,
    intervalMs: T * 1000,
    delayMedianMs: median(lat) * 1000,  // arrival delay relative to the least-delayed packets
    delayP95Ms: quantile(lat, 0.95) * 1000,
    delayMaxMs: lat.reduce((m, v) => Math.max(m, v), -Infinity) * 1000,
    maxGapS: maxGap,
    segments: segs.length,
  };
  return out;
}
