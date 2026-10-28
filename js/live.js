// Live view: one strip chart per sensor (small multiples, shared time axis), level tiles,
// the "now" panel and the camera overlay.

import { state, clock, on, sensorLabel, seriesVar } from './state.js';
import { STEPS } from './protocol.js';
import { unitFor, convert, activeThreshold, lowerBound, UNIT_LABEL, UNIT_DIGITS } from './processing.js';
import { h, $, fmtClock, fmtNum, cssVar, fmtBytes, niceCeil } from './util.js';
import { cam, isRecording } from './recorder.js';
import { dejitter } from './timing.js';

const strips = new Map(); // sensor key → { el, canvas, label, geom, yMax }
let colors = null;

function readColors() {
  colors = {
    ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'),
    grid: cssVar('--grid'), axis: cssVar('--axis'), surface: cssVar('--surface'),
    band: cssVar('--band'), bandCalib: cssVar('--band-calib'), crit: cssVar('--crit'),
    series: Array.from({ length: 8 }, (_, i) => cssVar(`--s${i + 1}`)),
  };
}
export function refreshColors() { readColors(); }

const FIXED_MAX = { raw: 1000, mvc: 100, rest: 10 };
const MIN_MAX = { raw: 50, mvc: 10, rest: 2 };

// ---- Strip DOM ----------------------------------------------------------

function rebuildStrips() {
  const host = $('#strips');
  const keys = new Set(state.sensors.map((s) => s.key));
  for (const [k, st] of strips) if (!keys.has(k)) { st.el.remove(); strips.delete(k); }
  for (const s of state.sensors) {
    let st = strips.get(s.key);
    if (!st) {
      const canvas = h('canvas');
      const label = h('div', { class: 'strip-label' });
      const el = h('div', { class: 'strip' }, canvas, label);
      st = { el, canvas, label, geom: null, yMax: 1000 };
      canvas.addEventListener('mousemove', (e) => {
        const g = st.geom;
        if (!g) return;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        state.hoverT = x >= g.padL && x <= g.W - g.padR ? g.tStart + ((x - g.padL) / g.w) * g.win : null;
      });
      canvas.addEventListener('mouseleave', () => { state.hoverT = null; });
      strips.set(s.key, st);
    }
    host.append(st.el); // keeps DOM order = sensor order
    st.label.replaceChildren(
      h('span', { class: 'swatch', style: { background: seriesVar(s) } }),
      `${sensorLabel(s)} · ${s.name}`,
      h('span', { class: 'tiny', 'data-unit': '' }),
    );
  }
  $('#stripsEmpty').hidden = state.sensors.length > 0;
}

// ---- Drawing ------------------------------------------------------------------

function bandsInView(tStart, tEnd) {
  const out = [];
  const p = state.protocol;
  for (const a of p.attempts) if (a.t1 > tStart && a.t0 < tEnd && !a.superseded) out.push({ t0: a.t0, t1: a.t1, label: 'Step ' + STEPS[a.step].n, kind: 'step' });
  if (p.attempt) out.push({ t0: p.attempt.t0, t1: tEnd, label: 'Step ' + STEPS[p.attempt.step].n, kind: 'step' });
  for (const b of state.calibBands) if (b.t1 > tStart && b.t0 < tEnd) out.push({ ...b, label: b.kind === 'mvc' ? 'MVC' : 'Rest', kind: 'calib' });
  if (state.calib) out.push({ t0: state.calib.t0, t1: tEnd, label: state.calib.kind === 'mvc' ? 'MVC' : 'Rest', kind: 'calib' });
  return out;
}

function drawStrip(st, s, tEnd, showX) {
  const cv = st.canvas;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 46, padR = 14, padT = 26, padB = showX ? 22 : 8;
  const w = W - padL - padR, hh = H - padT - padB;
  const win = state.windowSec, tStart = tEnd - win;
  const unit = unitFor(s);
  const b = s.buf;
  const i0 = Math.max(0, lowerBound(b.t, tStart) - 1);
  const i1 = lowerBound(b.t, tEnd + 0.001);

  let yMax = FIXED_MAX[unit];
  if (state.autoScale) {
    let m = 0;
    for (let i = i0; i < i1; i++) m = Math.max(m, b.sm[i], b.raw[i] * 0.85);
    const thr = activeThreshold(s);
    if (thr != null) m = Math.max(m, thr);
    yMax = niceCeil(Math.max(MIN_MAX[unit], (convert(s, m, unit) || 0) * 1.15));
  }
  st.yMax = yMax;
  st.unit = unit;
  st.geom = { padL, padR, W, w, tStart, win };

  const X = (t) => padL + ((t - tStart) / win) * w;
  const Y = (v) => padT + hh - (Math.min(v, yMax * 1.05) / yMax) * hh;

  // Bands (steps / calibration)
  ctx.font = '600 10.5px system-ui, -apple-system, sans-serif';
  for (const bd of bandsInView(tStart, tEnd)) {
    const x0 = Math.max(padL, X(bd.t0)), x1 = Math.min(padL + w, X(bd.t1));
    if (x1 <= x0) continue;
    ctx.fillStyle = bd.kind === 'calib' ? colors.bandCalib : colors.band;
    ctx.fillRect(x0, padT, x1 - x0, hh);
    if (x1 - x0 > 40) {
      ctx.fillStyle = colors.ink2;
      ctx.fillText(bd.label, x0 + 4, padT + 11);
    }
  }

  // Grid + y labels
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const y = Math.round(Y(yMax * f)) + 0.5;
    ctx.strokeStyle = f === 0 ? colors.axis : colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.fillText(fmtNum(yMax * f, yMax * f < 10 && yMax * f % 1 ? 1 : 0), padL - 6, y);
  }

  // Active threshold (rest mean + 3 SD)
  const thr = activeThreshold(s);
  if (thr != null) {
    const y = Y(convert(s, thr, unit));
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colors.muted;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.restore();
  }

  // Lines: raw (faint, 1px) and smoothed (2px)
  const color = colors.series[s.colorIdx];
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT - 2, w, hh + 4); ctx.clip();
  const path = (arr, alpha, lw) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = i0; i < i1; i++) {
      const x = X(b.t[i]), y = Y(convert(s, arr[i], unit));
      if (!pen || b.t[i] - b.t[i - 1] > 0.6) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      pen = true;
    }
    ctx.stroke();
  };
  path(b.raw, 0.28, 1);
  path(b.sm, 1, 2);
  ctx.globalAlpha = 1;
  ctx.restore();

  // Latest-value marker with a surface ring
  if (i1 > 0 && !state.pausedAt && tEnd - b.t[i1 - 1] < 1.5) {
    const x = X(b.t[i1 - 1]), y = Y(convert(s, b.sm[i1 - 1], unit));
    ctx.fillStyle = colors.surface;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }

  // Connection problems
  if (s.status !== 'live') {
    ctx.fillStyle = colors.crit;
    ctx.textAlign = 'center';
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(s.status === 'reconnecting' ? 'Connection lost · reconnecting…' : s.status === 'connecting' ? 'Connecting…' : 'Disconnected', padL + w / 2, padT + hh / 2);
  }

  // X axis
  if (showX) {
    const step = win <= 10 ? 2 : win <= 30 ? 5 : win <= 60 ? 10 : 20;
    const ref = state.session?.active ? state.session.t0 : null;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    const base = ref ?? tEnd;
    const first = Math.ceil((tStart - base) / step) * step;
    for (let k = first; k <= tEnd - base + 1e-6; k += step) {
      const x = X(base + k);
      if (x < padL + 8 || x > padL + w - 8) continue;
      ctx.fillText(ref != null ? fmtClock(k) : (k === 0 ? 'now' : `${k} s`), x, H - 6);
    }
  }

  // Hover crosshair with value readout
  if (state.hoverT != null && state.hoverT >= tStart && state.hoverT <= tEnd) {
    const x = Math.round(X(state.hoverT)) + 0.5;
    ctx.strokeStyle = colors.ink2;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + hh); ctx.stroke();
    let j = lowerBound(b.t, state.hoverT);
    if (j > 0 && (j >= b.t.length || state.hoverT - b.t[j - 1] < b.t[j] - state.hoverT)) j--;
    if (j >= 0 && j < b.t.length && Math.abs(b.t[j] - state.hoverT) < 0.5) {
      const v = convert(s, b.sm[j], unit);
      const txt = `${fmtNum(v, UNIT_DIGITS[unit])}${unit === 'raw' ? '' : ' ' + UNIT_LABEL[unit]}  (raw ${b.raw[j]})`;
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      const tw = ctx.measureText(txt).width + 12;
      const bx = Math.min(x + 8, padL + w - tw);
      const by = Math.max(padT, Math.min(Y(v) - 22, padT + hh - 20));
      ctx.fillStyle = colors.ink;
      ctx.globalAlpha = 0.88;
      ctx.beginPath(); ctx.roundRect(bx, by, tw, 20, 5); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.surface;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 6, by + 10);
    }
  }

  const unitEl = st.label.querySelector('[data-unit]');
  const ut = unit === 'raw' ? (state.displayMode === 'raw' ? 'raw 0–1000' : 'raw (not calibrated)') : UNIT_LABEL[unit];
  if (unitEl.textContent !== ut) unitEl.textContent = ut;
}

// ---- Tiles ----------------------------------------------------------------------

function rebuildTiles() {
  const host = $('#tiles');
  host.replaceChildren(...state.sensors.map((s) =>
    h('div', { class: 'tile', 'data-key': s.key, style: { '--sc': seriesVar(s) } },
      h('div', { class: 'tile-top' },
        h('span', { class: 'swatch', style: { background: seriesVar(s) } }),
        h('span', { class: 'nm' }, `${sensorLabel(s)} · ${s.name}`)),
      h('div', { class: 'tile-val num' }, h('span', { class: 'v' }, '–'), h('small', { class: 'u' })),
      h('div', { class: 'tile-bar' }, h('i')),
      h('div', { class: 'tile-foot' }, h('span', { class: 'q' }), h('span', { class: 'b' })),
    )));
}

// Rate and loss over the last minute, from the same timestamp clean-up used for the files. Every 2 s.
function liveQuality(s, now) {
  if (s.lq && now - s.lq.at < 2) return s.lq.q;
  const t = s.buf.t;
  const i0 = Math.max(0, lowerBound(t, now - 60));
  const q = t.length - i0 >= 50 ? dejitter(t.slice(i0)).quality : null;
  s.lq = { at: now, q };
  return q;
}

function updateTiles(now) {
  for (const s of state.sensors) {
    const el = document.querySelector(`.tile[data-key="${s.key}"]`);
    if (!el) continue;
    const st = strips.get(s.key);
    const unit = unitFor(s);
    const stale = s.lastT == null || now - s.lastT > 1.5;
    const v = stale ? null : convert(s, s.lastSm, unit);
    el.querySelector('.v').textContent = fmtNum(v, UNIT_DIGITS[unit]);
    el.querySelector('.u').textContent = UNIT_LABEL[unit];
    el.querySelector('.tile-bar i').style.width = v == null ? '0%' : Math.min(100, (v / (st?.yMax || FIXED_MAX[unit])) * 100) + '%';
    let q;
    if (s.status !== 'live') q = s.status === 'reconnecting' ? '⚠ reconnecting' : s.status === 'connecting' ? 'connecting…' : '✕ offline';
    else if (stale) q = '⚠ no data';
    else if (s.satCount > 5) q = '⚠ saturated';
    else {
      const lq = liveQuality(s, now);
      q = lq ? `${lq.rateHz.toFixed(1)} Hz · ${lq.lostPct < 0.05 ? '0' : lq.lostPct.toFixed(1)}% lost` : `${s.dtAvg ? (1 / s.dtAvg).toFixed(1) : '–'} Hz`;
      if (lq && lq.lostPct > 5) q = '⚠ ' + q;
    }
    const qEl = el.querySelector('.q');
    qEl.textContent = q;
    el.classList.toggle('warn-flag', q.startsWith('⚠') || q.startsWith('✕'));
    el.querySelector('.b').textContent = s.battery != null ? `🔋 ${s.battery}%` : '';
  }
}

// ---- Now panel + camera overlay ---------------------------------------------------

function updateNow(now) {
  const p = state.protocol;
  const el = $('#nowStep');
  let html;
  if (state.calib) {
    const c = state.calib;
    const left = c.t1 - now;
    html = `<div class="now-label">Calibration</div><div class="now-title">${c.kind === 'mvc' ? 'MVC capture' : 'Rest baseline'}</div>
      <div class="now-meta"><span>${left > 0 && now < c.t0 ? 'Get ready…' : 'Recording'}</span><span><b>${Math.max(0, Math.ceil(now < c.t0 ? c.t0 - now : left))}</b> s</span></div>`;
  } else if (p.attempt) {
    const st = STEPS[p.attempt.step];
    const ir = p.interRestUntil && now < p.interRestUntil ? `<span class="inter-rest">Rest ${Math.ceil(p.interRestUntil - now)} s</span>` : '';
    html = `<div class="now-label">Step ${st.n} of ${STEPS.length} · running</div><div class="now-title">${st.title}</div>
      <div class="now-meta"><span>Reps <b>${p.attempt.reps}</b> / ${st.reps}</span><span>Time <b>${fmtClock(now - p.attempt.t0)}</b></span>${ir}</div>`;
  } else if (p.restUntil && now < p.restUntil) {
    const nx = STEPS[p.index];
    html = `<div class="now-label">Rest between steps</div><div class="now-title">Next: Step ${nx.n} · ${nx.title}</div>
      <div class="now-meta"><span>Rest <b>${fmtClock(p.restUntil - now)}</b></span></div>`;
  } else {
    const nx = STEPS[p.index];
    html = `<div class="now-label">${state.session?.active ? 'Ready' : 'No session running'}</div><div class="now-title">Step ${nx.n} · ${nx.title}</div>
      <div class="now-meta"><span>${nx.reps} reps</span></div>`;
  }
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }

  const ov = $('#camOverlay');
  const ss = state.session;
  let txt = '';
  if (ss?.active) {
    txt = `● ${fmtClock(now - ss.t0)}`;
    if (p.attempt) txt += ` · Step ${STEPS[p.attempt.step].n}`;
    if (isRecording()) txt += ` · ${fmtBytes(cam.bytes)}`;
  }
  if (ov.textContent !== txt) ov.textContent = txt;
}

// ---- Loop -----------------------------------------------------------------------------

let lastTiles = 0;
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const now = clock();
  const tEnd = state.pausedAt ?? now;
  const list = state.sensors;
  list.forEach((s, i) => {
    const st = strips.get(s.key);
    if (st) drawStrip(st, s, tEnd, i === list.length - 1);
  });
  if (now - lastTiles > 0.2) {
    lastTiles = now;
    updateTiles(now);
    updateNow(now);
  }
}

export function initLive() {
  readColors();
  on('sensors', () => { rebuildStrips(); rebuildTiles(); });
  rebuildStrips();
  requestAnimationFrame(frame);
}
