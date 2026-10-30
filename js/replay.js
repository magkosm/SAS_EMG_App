// Replay mode: load a recorded session (folder, files, or the one just recorded) and play the video
// in sync with the EMG, with step bands, rep markers, calibration windows, dropouts and comments.
// Comments come from the session (step notes, symptom ratings) and can be added during replay;
// replay comments are saved as comments.csv in the session folder.

import { state, on, emit } from './state.js';
import { h, $, fmtNum, cssVar, toast, niceCeil, csvRow, downloadBlob, fmtBytes } from './util.js';
import { folder, restoreFolder } from './folder.js';
import { lowerBound } from './processing.js';
import { listSessions, getSession, deleteSession, putFiles, filesOf, storageEstimate } from './store.js';
import { canShareFiles, shareFiles } from './platform.js';

const rv = {
  id: '',
  meta: null,
  dir: null,        // session folder handle when opened from disk (for comments.csv)
  sensors: [],      // { key, name, label, colorIdx, calib, t, raw, sm, yMax:{raw,mvc,rest} }
  steps: [],        // attempts from session.json
  reps: [],         // { t, step, rep, superseded } sorted by t
  calib: [],        // { kind, t0, t1 }
  lost: [],         // { t, type, sensor }
  comments: [],     // { id, t, step, text, kind: 'note' | 'symptom' | 'replay', created }
  commentsDirty: false,
  duration: 0,
  hasVideo: false,
  vStart: 0,        // session time of video frame 0 (from session.json)
  sync: 0,          // manual correction, seconds (+ = video shown later)
  t: 0,
  playing: false,
  rate: 1,
  mode: 'raw',
  windowSec: 20,
  side: 'steps',
};
const video = () => $('#rvVideo');
let videoUrl = null;
let commentSeq = 0;
const isShown = () => state.view === 'replay';

// ---- Small helpers -------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fmtT(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  return (neg ? '−' : '') + m + ':' + (sec % 60).toFixed(1).padStart(4, '0');
}

const UNIT_LABEL = { raw: '', mvc: '% MVC', rest: '× rest' };
const UNIT_DIGITS = { raw: 0, mvc: 0, rest: 1 };
function unitFor(s) {
  if (rv.mode === 'mvc' && s.calib?.mvc > 0) return 'mvc';
  if (rv.mode === 'rest' && s.calib?.restMean > 0) return 'rest';
  return 'raw';
}
function conv(s, v, u) {
  if (v == null) return null;
  if (u === 'mvc') return (v / s.calib.mvc) * 100;
  if (u === 'rest') return v / s.calib.restMean;
  return v;
}
function threshold(s) {
  const c = s.calib;
  return c?.restMean != null ? c.restMean + 3 * (c.restSd || 0) : null;
}
function valueAt(s, t) {
  let j = lowerBound(s.t, t);
  if (j > 0 && (j >= s.t.length || t - s.t[j - 1] < s.t[j] - t)) j--;
  if (j < 0 || j >= s.t.length || Math.abs(s.t[j] - t) > 0.5) return null;
  return j;
}
function stepAt(t) {
  const hits = rv.steps.filter((a) => t >= a.t0 && t <= a.t1);
  return hits.find((a) => !a.superseded) || hits[0] || null;
}

// ---- Loading ------------------------------------------------------------------------------

async function filesFromDir(dir) {
  const files = [];
  for await (const [, hnd] of dir.entries()) if (hnd.kind === 'file') files.push(await hnd.getFile());
  return files;
}

async function sessionDirsIn(dir) {
  const out = [];
  for await (const [name, hnd] of dir.entries()) {
    if (hnd.kind !== 'directory') continue;
    try {
      const meta = JSON.parse(await (await (await hnd.getFileHandle('session.json')).getFile()).text());
      out.push({ name, hnd, meta });
    } catch { /* not a session folder */ }
  }
  return out.sort((a, b) => (b.meta.started || '').localeCompare(a.meta.started || ''));
}

async function openDir(dir) {
  try {
    const files = await filesFromDir(dir);
    if (files.some((f) => f.name === 'session.json')) return loadFiles(files, dir);
    // A parent folder (the save folder) was chosen: list its sessions instead.
    const sessions = await sessionDirsIn(dir);
    if (!sessions.length) { toast(`No session.json in “${dir.name}” or its sub-folders.`, 'bad', 7000); return; }
    showEmpty();
    showSessionList(sessions, `Sessions in “${dir.name}”`);
  } catch (err) {
    toast(`Could not read “${dir.name}”: ${err.message}`, 'bad', 8000);
  }
}

async function pickFolder() {
  if (!('showDirectoryPicker' in window)) { $('#rvFileInput').click(); return; }
  try {
    const opts = { id: 'm40replay', mode: 'readwrite' };
    if (folder.handle) opts.startIn = folder.handle;
    await openDir(await window.showDirectoryPicker(opts));
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 'bad');
  }
}

// storeId: id of a session kept in this browser (store.js), so replay comments are saved back there.
export async function loadFiles(files, dir = null, storeId = null) {
  const find = (name) => files.find((f) => f.name === name) || files.find((f) => f.name.endsWith('_' + name));
  const metaF = find('session.json');
  const samplesF = find('samples_long.csv');
  if (!metaF || !samplesF) {
    const missing = [!metaF && 'session.json', !samplesF && 'samples_long.csv'].filter(Boolean).join(' and ');
    toast(`Missing ${missing}. Pick the whole session folder, or select all its files.`, 'bad', 8000);
    return false;
  }
  try {
    const meta = JSON.parse(await metaF.text());
    const eventsF = find('events.csv');
    const commentsF = find('comments.csv');
    const videoF = (meta.video && find(meta.video.file)) || files.find((f) => /^video\//.test(f.type) || /\.(mp4|webm|mov)$/i.test(f.name));
    build(meta, parseCsv(await samplesF.text()), eventsF ? parseCsv(await eventsF.text()) : null, commentsF ? parseCsv(await commentsF.text()) : null);
    rv.dir = dir;
    rv.storeId = storeId;
    await attachVideo(videoF, meta.video);
    showMain();
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not read the session: ' + err.message, 'bad', 8000);
    return false;
  }
}

// Replay the session that was just recorded on this page.
export async function openRecordedSession(ss) {
  const files = Object.entries(ss.files).map(([n, b]) => new File([b], n, { type: b.type }));
  if (ss.dir) {
    try {
      for await (const [, hnd] of ss.dir.entries()) {
        if (hnd.kind === 'file' && !ss.files[hnd.name]) files.push(await hnd.getFile());
      }
    } catch (err) { toast('Could not read the session folder: ' + err.message, 'bad'); }
  }
  return loadFiles(files, ss.dir || null, !ss.dir && ss.storedInBrowser ? ss.id : null);
}

function build(meta, samples, events, commentRows) {
  rv.meta = meta;
  rv.id = meta.session || '';
  const hdr = samples[0];
  const col = (n) => hdr.indexOf(n);
  const [cT, cKey, cName, cSite, cSide, cRaw, cSm, cLost, cPhase] = ['t_s', 'sensor_key', 'sensor_name', 'site', 'side', 'raw', 'smoothed', 'lost_before', 'phase'].map(col);
  if (cT < 0 || cKey < 0 || cRaw < 0) throw new Error('samples_long.csv has unexpected columns');

  const metaSensors = Object.fromEntries((meta.sensors || []).map((s) => [s.key, s]));
  const by = new Map();
  for (let i = 1; i < samples.length; i++) {
    const r = samples[i];
    if (r.length < 3 || r[cT] === '') continue;
    const k = r[cKey];
    let s = by.get(k);
    if (!s) {
      const m = metaSensors[k] || {};
      s = {
        key: k,
        name: m.name || r[cName] || k,
        label: m.label || `${m.siteShort || r[cSite] || ''} ${m.side ?? r[cSide] ?? ''}`.trim(),
        colorIdx: m.colorIdx ?? by.size,
        calib: m.calib || {},
        t: [], raw: [], sm: [],
        lost: [],   // { t, k }: k samples never arrived just before time t
        phase: [],  // 'calib_rest' | 'calib_mvc' | 'step' | 'rest' | ''
      };
      by.set(k, s);
    }
    s.t.push(+r[cT]);
    s.raw.push(+r[cRaw]);
    s.sm.push(cSm >= 0 && r[cSm] !== '' ? +r[cSm] : +r[cRaw]);
    if (cLost >= 0 && +r[cLost] > 0) s.lost.push({ t: +r[cT], k: +r[cLost] });
    s.phase.push(cPhase >= 0 ? r[cPhase] : '');
  }
  rv.sensors = [...by.values()].sort((a, b) => a.colorIdx - b.colorIdx);
  for (const s of rv.sensors) {
    const order = s.t.map((_, i) => i).sort((a, b) => s.t[a] - s.t[b]);
    s.t = Float64Array.from(order, (i) => s.t[i]);
    s.raw = Float64Array.from(order, (i) => s.raw[i]);
    s.sm = Float64Array.from(order, (i) => s.sm[i]);
    s.phase = order.map((i) => s.phase[i]);
    const sorted = Float64Array.from(s.sm).sort();
    s.p995 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.995)] : 100;
  }
  computeScales();

  rv.steps = (meta.steps || []).map((a) => ({
    step: a.step, title: a.title, attempt: a.attempt, superseded: !!a.superseded,
    t0: a.start_s, t1: a.end_s, reps: a.reps, target: a.reps_target,
    repTimes: a.rep_times_s || [], symptom: a.symptom, note: a.note, stats: a.stats || {},
  })).sort((a, b) => a.t0 - b.t0);
  rv.reps = rv.steps.flatMap((a) => a.repTimes.map((t, i) => ({ t, step: a.step, rep: i + 1, superseded: a.superseded })))
    .sort((a, b) => a.t - b.t);
  rv.calib = (meta.calibration || []).map((c) => ({ kind: c.kind, t0: c.start_s, t1: c.end_s }));

  // Events: dropouts, discarded steps, and the comments written during the session.
  rv.lost = [];
  rv.comments = [];
  const lastNote = new Map(), lastSx = new Map();
  if (events?.length) {
    const eh = events[0];
    const [eT, eType, eStep, eSensor, eDetail] = ['t_s', 'type', 'step', 'sensor', 'detail'].map((n) => eh.indexOf(n));
    for (const r of events.slice(1)) {
      const type = r[eType];
      if (type === 'sensor_lost' || type === 'sensor_reconnected') rv.lost.push({ t: +r[eT], type, sensor: r[eSensor] });
      else if (type === 'step_abort') rv.lost.push({ t: +r[eT], type, sensor: '' });
      // A note is logged on every edit and a symptom on every click; keep the final one per step.
      else if (type === 'note') lastNote.set(r[eStep], { t: +r[eT], step: +r[eStep] || null, text: r[eDetail] });
      else if (type === 'symptom') lastSx.set(r[eStep], { t: +r[eT], step: +r[eStep] || null, text: r[eDetail] });
    }
  }
  for (const n of lastNote.values()) if (n.text) rv.comments.push({ ...n, kind: 'note' });
  for (const n of lastSx.values()) if (n.text !== '' && n.text !== 'cleared') rv.comments.push({ ...n, text: `Symptoms ${n.text}/10`, kind: 'symptom' });
  // Sessions without events.csv: fall back to the notes stored with each step.
  if (!events) {
    for (const a of rv.steps) {
      if (a.note) rv.comments.push({ t: a.t1, step: a.step, text: a.note, kind: 'note' });
      if (a.symptom != null) rv.comments.push({ t: a.t1, step: a.step, text: `Symptoms ${a.symptom}/10`, kind: 'symptom' });
    }
  }
  if (commentRows?.length) {
    const ch = commentRows[0];
    const [cTt, cStep, cText, cCreated] = ['t_s', 'step', 'text', 'created'].map((n) => ch.indexOf(n));
    for (const r of commentRows.slice(1)) {
      if (r[cText] == null || r[cText] === '') continue;
      rv.comments.push({ t: +r[cTt], step: +r[cStep] || null, text: r[cText], kind: 'replay', created: r[cCreated] });
    }
  }
  rv.comments.forEach((c) => { c.id = ++commentSeq; });
  rv.comments.sort((a, b) => a.t - b.t);
  rv.commentsDirty = false;

  const lastT = Math.max(0, ...rv.sensors.map((s) => (s.t.length ? s.t[s.t.length - 1] : 0)));
  rv.duration = Math.max(meta.duration_s || 0, lastT);
  rv.t = 0;
  try { rv.sync = +(localStorage.getItem('m40review.sync.' + rv.id) || 0); } catch { rv.sync = 0; }
  overviewCache = null;
}

function computeScales() {
  for (const s of rv.sensors) {
    const top = Math.max(s.p995, threshold(s) || 0) * 1.15;
    s.yMax = {
      raw: niceCeil(Math.max(50, top)),
      mvc: s.calib?.mvc > 0 ? niceCeil(Math.max(10, (top / s.calib.mvc) * 100)) : null,
      rest: s.calib?.restMean > 0 ? niceCeil(Math.max(2, top / s.calib.restMean)) : null,
    };
  }
}

async function attachVideo(file, vmeta) {
  const v = video();
  setPlaying(false);
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  rv.hasVideo = false;
  rv.vStart = vmeta?.startOffset_s ?? 0;
  v.removeAttribute('src');
  v.load();
  if (!file) { $('#rvNoVideo').hidden = false; return; }
  videoUrl = URL.createObjectURL(file);
  v.src = videoUrl;
  await new Promise((resolve) => {
    v.onloadedmetadata = resolve;
    v.onerror = resolve;
    setTimeout(resolve, 8000);
  });
  if (v.error || !v.videoWidth) {
    toast('The video could not be played in this browser. Replaying EMG only.', 'bad', 8000);
    $('#rvNoVideo').hidden = false;
    return;
  }
  // MediaRecorder WebM files have no duration until the end has been seen once.
  if (!isFinite(v.duration)) {
    await new Promise((resolve) => {
      v.ontimeupdate = () => { v.ontimeupdate = null; resolve(); };
      v.currentTime = 1e9;
      setTimeout(resolve, 4000);
    });
    v.currentTime = 0;
  }
  rv.hasVideo = true;
  $('#rvNoVideo').hidden = true;
  v.playbackRate = rv.rate;
}

// ---- Clock ---------------------------------------------------------------------------------------

const videoZero = () => rv.vStart + rv.sync; // session time of video frame 0

function seek(t) {
  rv.t = Math.max(0, Math.min(rv.duration, t));
  if (rv.hasVideo) {
    const v = video();
    const vt = rv.t - videoZero();
    const inside = vt >= 0 && vt < v.duration;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, vt));
    // Outside the video the EMG runs on its own clock; inside, the video leads.
    if (rv.playing && inside && v.paused) v.play().catch(() => {});
    if (!inside && !v.paused) v.pause();
  }
}

function setPlaying(on) {
  rv.playing = on;
  $('#rvPlay').textContent = on ? '❚❚' : '▶';
  if (rv.hasVideo) {
    const v = video();
    const vt = rv.t - videoZero();
    if (on && vt >= 0 && vt < v.duration) v.play().catch(() => {});
    else v.pause();
  }
}
export function pauseReplay() { if (rv.playing) setPlaying(false); }

let lastFrame = performance.now();
function advance() {
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (!rv.playing) return;
  const v = video();
  const vt = rv.t - videoZero();
  const videoDrives = rv.hasVideo && !v.paused && vt >= 0 && vt <= v.duration;
  if (videoDrives) rv.t = v.currentTime + videoZero();
  else {
    rv.t += dt * rv.rate;
    // Moving from a stretch before the video into it: hand the clock to the video.
    if (rv.hasVideo && v.paused && rv.t - videoZero() >= 0 && rv.t - videoZero() < v.duration) {
      v.currentTime = rv.t - videoZero();
      v.play().catch(() => {});
    }
  }
  if (rv.t >= rv.duration) { rv.t = rv.duration; setPlaying(false); }
}

// ---- Drawing -------------------------------------------------------------------------------------

let colors = null;
export function refreshReplayColors() {
  colors = {
    ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'),
    axis: cssVar('--axis'), surface: cssVar('--surface'), band: cssVar('--band'), bandCalib: cssVar('--band-calib'),
    crit: cssVar('--crit'), accent: cssVar('--accent'), accentInk: cssVar('--accent-ink'),
    series: Array.from({ length: 8 }, (_, i) => cssVar(`--s${i + 1}`)),
  };
  overviewCache = null;
}

function fitCanvas(cv) {
  const W = cv.clientWidth, H = cv.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H, dpr };
}

const OV = { padL: 12, padR: 12, padT: 16, padB: 10 };
let overviewCache = null;

// Whole session: one lane per sensor (each scaled to its own range), steps and calibration shaded.
function drawOverviewBase(W, H, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = W - OV.padL - OV.padR, hh = H - OV.padT - OV.padB;
  const X = (t) => OV.padL + (t / rv.duration) * w;

  ctx.font = '600 10px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'alphabetic';
  for (const b of rv.calib) {
    ctx.fillStyle = colors.bandCalib;
    ctx.fillRect(X(b.t0), OV.padT, Math.max(1, X(b.t1) - X(b.t0)), hh);
  }
  for (const a of rv.steps) {
    if (a.superseded) continue;
    const x0 = X(a.t0), x1 = X(a.t1);
    ctx.fillStyle = colors.band;
    ctx.fillRect(x0, OV.padT, Math.max(1, x1 - x0), hh);
    ctx.fillStyle = colors.ink2;
    ctx.textAlign = 'center';
    ctx.fillText(String(a.step), (x0 + x1) / 2, OV.padT - 4);
  }

  const n = rv.sensors.length || 1;
  const lane = hh / n;
  rv.sensors.forEach((s, k) => {
    const top = OV.padT + k * lane;
    const base = top + lane - 1;
    const scale = (lane - 3) / s.yMax.raw;
    ctx.fillStyle = colors.series[s.colorIdx % 8];
    // Max per pixel column, drawn as a filled envelope.
    ctx.beginPath();
    ctx.moveTo(OV.padL, base);
    const cols = Math.max(1, Math.floor(w));
    let i = 0;
    for (let px = 0; px <= cols; px++) {
      const tEnd = ((px + 1) / cols) * rv.duration;
      let m = 0;
      while (i < s.t.length && s.t[i] < tEnd) { if (s.sm[i] > m) m = s.sm[i]; i++; }
      ctx.lineTo(OV.padL + px, base - Math.min(lane - 3, m * scale));
    }
    ctx.lineTo(OV.padL + cols, base);
    ctx.closePath();
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  for (const e of rv.lost) {
    if (e.type !== 'sensor_lost') continue;
    ctx.fillStyle = colors.crit;
    ctx.fillRect(Math.round(X(e.t)) - 1, OV.padT, 2, hh);
  }
  // Comments: small upward triangles along the bottom edge.
  ctx.fillStyle = colors.accent;
  for (const cm of rv.comments) {
    const x = X(cm.t);
    ctx.beginPath(); ctx.moveTo(x - 4, H - 1); ctx.lineTo(x + 4, H - 1); ctx.lineTo(x, H - 8); ctx.closePath(); ctx.fill();
  }
  return c;
}

function drawOverview() {
  const cv = $('#rvOverview');
  const { ctx, W, H, dpr } = fitCanvas(cv);
  if (!W || !H || !rv.duration) return;
  const key = `${W}x${H}@${dpr}`;
  if (!overviewCache || overviewCache.key !== key) overviewCache = { key, img: drawOverviewBase(W, H, dpr) };
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(overviewCache.img, 0, 0, W, H);

  const w = W - OV.padL - OV.padR;
  const X = (t) => OV.padL + (t / rv.duration) * w;
  const x0 = X(rv.t - rv.windowSec / 2), x1 = X(rv.t + rv.windowSec / 2);
  ctx.strokeStyle = colors.ink2;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.max(OV.padL, x0) + 0.5, OV.padT - 0.5, Math.min(OV.padL + w, x1) - Math.max(OV.padL, x0), H - OV.padT - OV.padB + 1);
  const x = Math.round(X(rv.t)) + 0.5;
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, H - 2); ctx.stroke();
}

function drawStrip(st, s, isFirst, isLast) {
  const { ctx, W, H } = fitCanvas(st.canvas);
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const padL = 46, padR = 14, padT = 26, padB = isLast ? 22 : 8;
  const w = W - padL - padR, hh = H - padT - padB;
  const win = rv.windowSec, tStart = rv.t - win / 2, tEnd = rv.t + win / 2;
  const u = unitFor(s);
  const yMax = s.yMax[u] || s.yMax.raw;
  const X = (t) => padL + ((t - tStart) / win) * w;
  const Y = (v) => padT + hh - (Math.min(v, yMax * 1.05) / yMax) * hh;
  st.geom = { padL, w, tStart, win };

  // Bands, labelled at the bottom so they don't collide with rep numbers
  ctx.font = '600 10.5px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const band = (t0, t1, fill, label) => {
    const x0 = Math.max(padL, X(t0)), x1 = Math.min(padL + w, X(t1));
    if (x1 <= x0) return;
    ctx.fillStyle = fill;
    ctx.fillRect(x0, padT, x1 - x0, hh);
    if (label && x1 - x0 > 50) { ctx.fillStyle = colors.ink2; ctx.fillText(label, x0 + 4, padT + hh - 5); }
  };
  for (const b of rv.calib) band(b.t0, b.t1, colors.bandCalib, b.kind === 'mvc' ? 'MVC' : 'Rest');
  for (const a of rv.steps) band(a.t0, a.t1, a.superseded ? colors.bandCalib : colors.band, `Step ${a.step}${a.superseded ? ' (superseded)' : ''}`);

  // Grid
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const y = Math.round(Y(yMax * f)) + 0.5;
    ctx.strokeStyle = f === 0 ? colors.axis : colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.fillStyle = colors.muted;
    const v = yMax * f;
    ctx.fillText(fmtNum(v, v < 10 && v % 1 ? 1 : 0), padL - 6, y);
  }

  // Rep markers: hairline + numbered tick at the top
  const vis = rv.reps.filter((r) => r.t >= tStart && r.t <= tEnd);
  const spacing = vis.length > 1 ? w / (win / Math.max(0.2, (vis[vis.length - 1].t - vis[0].t) / (vis.length - 1))) : 99;
  for (const r of vis) {
    const x = Math.round(X(r.t)) + 0.5;
    ctx.globalAlpha = r.superseded ? 0.35 : 1;
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT + 14); ctx.lineTo(x, padT + hh); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.ink2;
    ctx.beginPath(); ctx.moveTo(x - 4, padT + 6); ctx.lineTo(x + 4, padT + 6); ctx.lineTo(x, padT + 12); ctx.closePath(); ctx.fill();
    if (spacing > 22 || r.rep % 5 === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 10px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(r.rep), x, padT + 4);
    }
    ctx.globalAlpha = 1;
  }

  // Threshold
  const thr = threshold(s);
  if (thr != null) {
    const y = Y(conv(s, thr, u));
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colors.muted;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.restore();
  }

  // Traces
  const color = colors.series[s.colorIdx % 8];
  const i0 = Math.max(0, lowerBound(s.t, tStart) - 1);
  const i1 = Math.min(s.t.length, lowerBound(s.t, tEnd) + 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT - 2, w, hh + 4); ctx.clip();
  const path = (arr, alpha, lw) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i < i1; i++) {
      const x = X(s.t[i]), y = Y(conv(s, arr[i], u));
      if (i === i0 || s.t[i] - s.t[i - 1] > 0.6) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  path(s.raw, 0.28, 1);
  path(s.sm, 1, 2);
  ctx.restore();
  ctx.globalAlpha = 1;

  // Lost samples: short red bar along the baseline where samples never arrived
  ctx.fillStyle = colors.crit;
  for (const l of s.lost) {
    if (l.t < tStart || l.t - l.k * 0.1 > tEnd) continue;
    const x0 = Math.max(padL, X(l.t - (l.k + 0.5) * 0.1)), x1 = Math.min(padL + w, X(l.t - 0.05));
    if (x1 > x0) ctx.fillRect(x0, padT + hh - 3, Math.max(2, x1 - x0), 3);
  }

  // Dropouts
  for (const e of rv.lost) {
    if (e.sensor && e.sensor !== s.key) continue;
    if (e.t < tStart || e.t > tEnd) continue;
    const x = Math.round(X(e.t)) + 0.5;
    ctx.strokeStyle = colors.crit;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + hh); ctx.stroke();
    ctx.fillStyle = colors.crit;
    ctx.textAlign = 'left';
    ctx.font = '600 10.5px system-ui, -apple-system, sans-serif';
    ctx.fillText(e.type === 'sensor_lost' ? 'signal lost' : e.type === 'step_abort' ? 'step discarded' : 'reconnected', x + 4, padT + 26);
  }

  // Comments: accent line on every strip, text flag on the first strip only (two rows so close ones don't overlap)
  const rowEnd = [-Infinity, -Infinity];
  for (const cm of rv.comments) {
    if (cm.t < tStart || cm.t > tEnd) continue;
    const x = Math.round(X(cm.t)) + 0.5;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + hh); ctx.stroke();
    if (isFirst) {
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      let txt = cm.text.length > 48 ? cm.text.slice(0, 47) + '…' : cm.text;
      const maxW = padL + w - x - 6;
      while (txt.length > 4 && ctx.measureText(txt).width + 12 > maxW) txt = txt.slice(0, -2) + '…';
      const tw = ctx.measureText(txt).width + 12;
      const row = x > rowEnd[0] + 4 ? 0 : x > rowEnd[1] + 4 ? 1 : 0;
      const y = padT + 16 + row * 21;
      if (maxW > 40) {
        rowEnd[row] = x + tw;
        ctx.fillStyle = colors.accent;
        ctx.beginPath(); ctx.roundRect(x, y, tw, 18, [0, 6, 6, 0]); ctx.fill();
        ctx.fillStyle = colors.accentInk;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, x + 6, y + 9);
      }
    }
  }

  // Playhead (centre) with value
  const xp = Math.round(X(rv.t)) + 0.5;
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(xp, padT); ctx.lineTo(xp, padT + hh); ctx.stroke();
  const j = valueAt(s, rv.t);
  if (j != null) {
    const v = conv(s, s.sm[j], u);
    const y = Y(v);
    ctx.fillStyle = colors.surface;
    ctx.beginPath(); ctx.arc(xp, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(xp, y, 4, 0, Math.PI * 2); ctx.fill();
  }

  // Time axis
  if (isLast) {
    const step = win <= 10 ? 1 : win <= 20 ? 2 : win <= 60 ? 5 : 20;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    for (let k = Math.ceil(tStart / step) * step; k <= tEnd; k += step) {
      const x = X(k);
      if (x < padL + 10 || x > padL + w - 10 || k < 0) continue;
      ctx.fillText(fmtT(k).replace(/\.\d$/, ''), x, H - 6);
    }
  }

  const ut = st.label.querySelector('[data-unit]');
  const txt = u === 'raw' ? (rv.mode === 'raw' ? 'raw 0–1000' : 'raw (not calibrated)') : UNIT_LABEL[u];
  if (ut.textContent !== txt) ut.textContent = txt;
}

// ---- DOM: strips, tiles, steps, comments, readout --------------------------------------------------

const strips = new Map();
const sv = (s) => `var(--s${(s.colorIdx % 8) + 1})`;

function buildStrips() {
  const host = $('#rvStrips');
  host.replaceChildren();
  strips.clear();
  for (const s of rv.sensors) {
    const canvas = h('canvas');
    const label = h('div', { class: 'strip-label' },
      h('span', { class: 'swatch', style: { background: sv(s) } }), `${s.label} · ${s.name}`, h('span', { class: 'tiny', 'data-unit': '' }));
    const el = h('div', { class: 'strip' }, canvas, label);
    const st = { el, canvas, label, geom: null };
    canvas.addEventListener('click', (e) => {
      const g = st.geom;
      if (!g) return;
      const x = e.clientX - canvas.getBoundingClientRect().left;
      seek(g.tStart + ((x - g.padL) / g.w) * g.win);
    });
    strips.set(s.key, st);
    host.append(el);
  }
}

function buildTiles() {
  $('#rvTiles').replaceChildren(...rv.sensors.map((s) =>
    h('div', { class: 'tile', 'data-key': s.key, style: { '--sc': sv(s) } },
      h('div', { class: 'tile-top' }, h('span', { class: 'swatch', style: { background: sv(s) } }), h('span', { class: 'nm' }, `${s.label} · ${s.name}`)),
      h('div', { class: 'tile-val num' }, h('span', { class: 'v' }, '–'), h('small', { class: 'u' })),
      h('div', { class: 'tile-bar' }, h('i')),
      h('div', { class: 'tile-foot' }, h('span', { class: 'q' }), h('span', { class: 'b' })))));
}

function buildSteps() {
  const items = [
    ...rv.calib.map((c) => ({ kind: 'calib', t0: c.t0, t1: c.t1, c })),
    ...rv.steps.map((a) => ({ kind: 'step', t0: a.t0, t1: a.t1, a })),
  ].sort((x, y) => x.t0 - y.t0);
  const list = $('#rvSteps');
  if (!items.length) { list.replaceChildren(h('li', { class: 'calib' }, h('span'), h('div', { class: 'tiny' }, 'No steps were run in this session.'))); return; }
  list.replaceChildren(...items.map((it) => {
    const nComments = it.kind === 'step' ? rv.comments.filter((c) => c.t >= it.t0 && c.t <= it.t1 + 60 && c.step === it.a.step).length : 0;
    const li = it.kind === 'calib'
      ? h('li', { class: 'calib' },
          h('span', { class: 'n' }, '·'),
          h('div', {}, h('div', { class: 'tt' }, it.c.kind === 'mvc' ? 'MVC capture' : 'Rest baseline'),
            h('div', { class: 'tiny' }, `${fmtT(it.t0)} · ${Math.round(it.t1 - it.t0)} s`)))
      : h('li', { class: it.a.superseded ? 'superseded' : '' },
          h('span', { class: 'n' }, it.a.step),
          h('div', {},
            h('div', { class: 'tt' }, it.a.title, it.a.attempt > 1 ? h('span', { class: 'tiny' }, ` · attempt ${it.a.attempt}`) : null),
            h('div', { class: 'tiny' }, `${fmtT(it.t0)} · ${it.a.reps}/${it.a.target} reps · ${Math.round(it.t1 - it.t0)} s`,
              it.a.symptom != null ? ` · Sx ${it.a.symptom}` : '', it.a.superseded ? ' · superseded' : '',
              nComments ? ` · 💬 ${nComments}` : ''),
            it.a.note ? h('div', { class: 'rv-note' }, it.a.note) : null));
    li.dataset.t0 = it.t0;
    li.dataset.t1 = it.t1;
    li.addEventListener('click', () => seek(it.t0 - 1));
    return li;
  }));
}

const KIND_LABEL = { note: 'during session', symptom: 'rating', replay: 'replay' };

function buildComments() {
  $('#rvCommentCount').textContent = rv.comments.length ? `(${rv.comments.length})` : '';
  const host = $('#rvComments');
  const m = rv.meta;
  const unsaved = rv.commentsDirty && !rv.dir && !rv.storeId;
  host.replaceChildren(...[
    m.notes ? h('div', { class: 'rv-comment session' }, h('div', { class: 'tiny' }, 'Session note'), h('div', {}, m.notes)) : null,
    rv.comments.length ? null : h('p', { class: 'tiny', style: { padding: '8px' } }, 'No comments yet. Pause where something happens and type a comment above the charts, or press C.'),
    ...rv.comments.map((c) => h('div', { class: 'rv-comment', 'data-id': c.id, onclick: () => seek(c.t) },
      h('div', { class: 'rv-comment-head' },
        h('b', { class: 'num' }, fmtT(c.t)),
        c.step ? h('span', { class: 'tiny' }, `step ${c.step}`) : null,
        h('span', { class: 'tiny' }, KIND_LABEL[c.kind] || ''),
        c.kind === 'replay' ? h('button', { class: 'btn link small', title: 'Delete this comment', onclick: (e) => { e.stopPropagation(); deleteComment(c); } }, 'delete') : null),
      h('div', {}, c.text))),
    unsaved ? h('div', { style: { padding: '8px' } },
      h('p', { class: 'tiny' }, 'This session was opened from loose files, so replay comments are not saved automatically.'),
      h('button', { class: 'btn small primary', onclick: downloadComments }, 'Download comments.csv')) : null,
  ].filter(Boolean));
}

function buildInfo() {
  const m = rv.meta;
  const started = m.started ? new Date(m.started) : null;
  $('#rvInfo').replaceChildren(...[
    h('h3', {}, 'Session'),
    h('div', { class: 'tiny' }, h('b', {}, 'Subject: '), m.subject || '–'),
    h('div', { class: 'tiny' }, h('b', {}, 'Started: '), started ? started.toLocaleString() : '–'),
    h('div', { class: 'tiny' }, h('b', {}, 'Duration: '), fmtT(rv.duration)),
    h('div', { class: 'tiny' }, h('b', {}, 'Video: '), rv.hasVideo ? `${m.video?.file} (starts at ${fmtNum(rv.vStart, 2)} s)` : 'none'),
    h('div', { class: 'tiny' }, h('b', {}, 'Comments saved to: '), rv.dir ? `${rv.dir.name}/comments.csv` : rv.storeId ? 'this browser (with the session)' : 'not saved (loose files)'),
    ...rv.sensors.map((s) => {
      const q = m.timing?.[s.key];
      const lostN = q ? q.lost : s.lost.reduce((a, l) => a + l.k, 0);
      return h('div', { class: 'tiny' }, h('b', {}, `${s.label}: `),
        q ? `${fmtNum(q.rate_hz, 3)} Hz · ${lostN} lost (${fmtNum(q.lost_pct, 1)} %)` : `${s.t.length} samples${lostN ? ` · ${lostN} lost` : ''}`);
    }),
  ]);
}

function setSide(which) {
  rv.side = which;
  document.querySelectorAll('#rvSideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.side === which));
  $('#rvSteps').hidden = which !== 'steps';
  $('#rvComments').hidden = which !== 'comments';
}

// ---- Comments ---------------------------------------------------------------------------------------

function commentsCsv() {
  const rows = [csvRow(['t_s', 'video_t_s', 'step', 'text', 'created'])];
  for (const c of rv.comments.filter((x) => x.kind === 'replay')) {
    rows.push(csvRow([c.t, rv.hasVideo ? c.t - videoZero() : null, c.step ?? '', c.text, c.created || '']));
  }
  return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
}

async function saveComments() {
  if (!rv.dir && rv.storeId) {
    try {
      await putFiles(rv.storeId, { 'comments.csv': commentsCsv() });
      rv.commentsDirty = false;
    } catch (err) {
      toast('Comment not saved in this browser: ' + err.message + '. Use “Download comments.csv”.', 'bad', 8000);
      rv.storeId = null;
      buildInfo();
    }
    buildComments();
    return;
  }
  if (!rv.dir) { buildComments(); return; }
  try {
    const opts = { mode: 'readwrite' };
    if ((await rv.dir.queryPermission(opts)) !== 'granted' && (await rv.dir.requestPermission(opts)) !== 'granted') {
      throw new Error('no permission to write in the session folder');
    }
    const w = await (await rv.dir.getFileHandle('comments.csv', { create: true })).createWritable();
    await w.write(commentsCsv());
    await w.close();
    rv.commentsDirty = false;
  } catch (err) {
    toast('Comment not saved to the folder: ' + err.message + '. Use “Download comments.csv”.', 'bad', 8000);
    rv.dir = null;
    buildInfo();
  }
  buildComments();
}

function downloadComments() {
  downloadBlob(commentsCsv(), `${rv.id || 'session'}_comments.csv`);
  rv.commentsDirty = false;
  buildComments();
}

async function addComment(text) {
  text = text.trim();
  if (!text) return;
  const a = stepAt(rv.t);
  rv.comments.push({ id: ++commentSeq, t: rv.t, step: a?.step ?? null, text, kind: 'replay', created: new Date().toISOString() });
  rv.comments.sort((x, y) => x.t - y.t);
  rv.commentsDirty = true;
  overviewCache = null;
  buildSteps();
  await saveComments();
  toast(`Comment added at ${fmtT(rv.t)}${rv.dir ? ' and saved' : ''}`);
}

async function deleteComment(c) {
  if (!confirm(`Delete this comment?\n\n“${c.text}”`)) return;
  rv.comments = rv.comments.filter((x) => x !== c);
  rv.commentsDirty = true;
  overviewCache = null;
  buildSteps();
  await saveComments();
}

// ---- Readout + loop ------------------------------------------------------------------------------------

let lastUi = 0;
function updateReadout() {
  const t = rv.t;
  $('#rvTime').textContent = fmtT(t);
  $('#rvCommentAdd').textContent = `Add at ${fmtT(t)}`;
  const a = stepAt(t);
  const cal = rv.calib.find((c) => t >= c.t0 && t <= c.t1);
  if (a) {
    $('#rvStepLabel').textContent = `Step ${a.step}${a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}${a.superseded ? ' · superseded' : ''} · ${fmtT(t - a.t0)} into step`;
    $('#rvStepTitle').textContent = a.title;
    $('#rvRep').textContent = `${a.repTimes.filter((x) => x <= t).length} / ${a.target}`;
  } else {
    $('#rvStepLabel').textContent = cal ? 'Calibration' : 'Between steps';
    $('#rvStepTitle').textContent = cal ? (cal.kind === 'mvc' ? 'MVC capture' : 'Rest baseline') : '–';
    $('#rvRep').textContent = '–';
  }

  for (const s of rv.sensors) {
    const el = document.querySelector(`#rvTiles .tile[data-key="${s.key}"]`);
    if (!el) continue;
    const u = unitFor(s);
    const j = valueAt(s, t);
    const v = j == null ? null : conv(s, s.sm[j], u);
    el.querySelector('.v').textContent = fmtNum(v, UNIT_DIGITS[u]);
    el.querySelector('.u').textContent = UNIT_LABEL[u];
    el.querySelector('.tile-bar i').style.width = v == null ? '0%' : Math.min(100, (v / (s.yMax[u] || s.yMax.raw)) * 100) + '%';
    const thr = threshold(s);
    el.querySelector('.q').textContent = j == null ? 'no data' : thr != null ? (s.raw[j] > thr ? 'active' : 'rest level') : '';
    const st = a?.stats?.[s.key];
    const mean = st ? (u === 'mvc' ? st.meanMvc : u === 'rest' ? st.meanRest : st.mean) : null;
    el.querySelector('.b').textContent = mean != null ? `step mean ${fmtNum(mean, UNIT_DIGITS[u])}` : '';
  }

  document.querySelectorAll('#rvSteps li').forEach((li) => {
    const on = t >= +li.dataset.t0 && t <= +li.dataset.t1;
    if (li.classList.contains('current') !== on) {
      li.classList.toggle('current', on);
      if (on && rv.side === 'steps') li.scrollIntoView({ block: 'nearest' });
    }
  });
  // Highlight the comment the playhead has just passed (within 3 s).
  const near = [...rv.comments].reverse().find((c) => c.t <= t + 0.05 && t - c.t < 3);
  document.querySelectorAll('#rvComments .rv-comment[data-id]').forEach((el) => {
    const on = near && +el.dataset.id === near.id;
    if (el.classList.contains('current') !== on) {
      el.classList.toggle('current', on);
      if (on && rv.side === 'comments') el.scrollIntoView({ block: 'nearest' });
    }
  });

  const vn = $('#rvVideoNote');
  const vt = t - videoZero();
  vn.textContent = rv.hasVideo ? (vt < 0 ? 'before video start' : vt > video().duration + 0.05 ? 'after video end' : `video ${fmtT(vt)}`) : '';
}

function frame() {
  requestAnimationFrame(frame);
  if (!rv.meta || !isShown() || $('#replayView').hidden || document.hidden) return;
  advance();
  drawOverview();
  rv.sensors.forEach((s, i) => { const st = strips.get(s.key); if (st) drawStrip(st, s, i === 0, i === rv.sensors.length - 1); });
  const now = performance.now();
  if (now - lastUi > 100) { lastUi = now; updateReadout(); }
}

function showMain() {
  if (isShown()) {
    $('#replayEmpty').hidden = true;
    $('#replayView').hidden = false;
  }
  const m = rv.meta;
  $('#rvTitle').textContent = `${m.subject || m.session} · ${m.started ? new Date(m.started).toLocaleString() : ''}`;
  $('#rvSync').textContent = `${rv.sync >= 0 ? '+' : '−'}${Math.abs(rv.sync).toFixed(1)} s`;
  buildStrips();
  buildTiles();
  buildSteps();
  buildComments();
  buildInfo();
  setSide(rv.comments.length && !rv.steps.length ? 'comments' : rv.side);
  setPlaying(false);
  seek(0);
  emit('sessionLoaded', rv.id);
}

export function showEmpty() {
  setPlaying(false);
  $('#replayView').hidden = true;
  $('#replayEmpty').hidden = false;
}

// Called whenever Replay mode is shown.
export function onReplayShown() {
  if (rv.meta) { $('#replayView').hidden = false; $('#replayEmpty').hidden = true; }
  else { showEmpty(); showRecent(); }
}

// ---- Session list (remembered save folder) --------------------------------------------------------

function showSessionList(sessions, title, box = null) {
  const host = box || $('#rvFolderSessions') || $('#rvRecent');
  host.replaceChildren(
    h('h3', { style: { marginTop: '18px' } }, title),
    h('div', { class: 'rv-session-list' }, sessions.slice(0, 60).map(({ name, hnd, meta }) =>
      h('button', { class: 'btn rv-session', onclick: () => openDir(hnd) },
        h('b', {}, meta.subject || name),
        h('span', {}, meta.started ? new Date(meta.started).toLocaleString() : name),
        h('span', {}, `${fmtT(meta.duration_s)} · ${((n) => `${n} step${n === 1 ? '' : 's'}`)((meta.steps || []).filter((s) => !s.superseded).length)}${meta.video ? ' · video' : ''}`)))),
  );
}

async function showRecent(requestAccess = false) {
  const host = $('#rvRecent');
  const browserBox = h('div', { id: 'rvBrowserSessions' });
  const folderBox = h('div', { id: 'rvFolderSessions' });
  host.replaceChildren(browserBox, folderBox);
  renderBrowserSessions(browserBox);
  await restoreFolder();
  if (!folder.handle || !folderBox.isConnected) return;
  const opts = { mode: 'readwrite' };
  let perm = await folder.handle.queryPermission(opts);
  if (perm !== 'granted' && requestAccess) perm = await folder.handle.requestPermission(opts);
  if (perm !== 'granted') {
    folderBox.replaceChildren(h('div', { style: { marginTop: '18px' } },
      h('button', { class: 'btn primary', onclick: () => showRecent(true) }, `Show sessions in “${folder.name}”`)));
    return;
  }
  try {
    const sessions = await sessionDirsIn(folder.handle);
    if (sessions.length) showSessionList(sessions, `Sessions in “${folder.name}”`, folderBox);
    else folderBox.replaceChildren(h('p', { class: 'tiny', style: { marginTop: '18px' } }, `No sessions in “${folder.name}” yet.`));
  } catch (err) {
    folderBox.replaceChildren(h('p', { class: 'tiny' }, 'Save folder not readable: ' + err.message));
  }
}

// Sessions kept in this browser (store.js): open, share or delete.
async function renderBrowserSessions(box) {
  let list = [];
  try { list = await listSessions(); } catch { /* storage unavailable */ }
  if (!list.length) { box.replaceChildren(); return; }
  const est = await storageEstimate();
  const openStored = async (id) => {
    const rec = await getSession(id);
    if (!rec) { toast('That session is no longer in this browser.', 'bad'); renderBrowserSessions(box); return; }
    await loadFiles(filesOf(rec), null, id);
  };
  const shareStored = async (id) => {
    const rec = await getSession(id);
    const files = Object.entries(rec.files).map(([n, b]) => new File([b], `${id}_${n}`, { type: b.type }));
    if (!(await shareFiles(files, id).catch((e) => { toast('Share failed: ' + e.message, 'bad'); return true; })) && !canShareFiles(files)) {
      files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 400));
    }
  };
  const removeStored = async (id, label) => {
    if (!confirm(`Delete “${label}” from this browser?\n\nOnly the copy in this browser is removed. Files you shared or downloaded are not affected.`)) return;
    await deleteSession(id);
    if (rv.storeId === id) rv.storeId = null;
    renderBrowserSessions(box);
  };
  box.replaceChildren(...[
    h('h3', { style: { marginTop: '18px' } }, 'Sessions in this browser'),
    h('div', { class: 'rv-session-list' }, list.map((r) => {
      const label = r.subject || r.id;
      return h('div', { class: 'rv-stored' },
        h('b', {}, label),
        h('span', {}, r.started ? new Date(r.started).toLocaleString() : r.id),
        h('span', {}, `${fmtT(r.duration)} · ${r.steps} step${r.steps === 1 ? '' : 's'}${r.hasVideo ? ' · video' : ''} · ${fmtBytes(r.bytes || 0)}${r.complete ? '' : ' · not finished (backup)'}`),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', onclick: () => openStored(r.id) }, 'Open'),
          h('button', { class: 'btn small', onclick: () => shareStored(r.id) }, canShareFiles([new File([''], 'x.csv', { type: 'text/csv' })]) ? 'Share…' : 'Download'),
          h('button', { class: 'btn small ghost', onclick: () => removeStored(r.id, label) }, 'Delete')));
    })),
    est?.quota ? h('p', { class: 'tiny', style: { marginTop: '6px' } }, `Browser storage used: ${fmtBytes(est.usage || 0)} of about ${fmtBytes(est.quota)}.`) : null,
  ].filter(Boolean));
}
export { renderBrowserSessions };

// ---- Wiring ----------------------------------------------------------------------------------------

function stepJump(dir) {
  const starts = rv.steps.filter((a) => !a.superseded).map((a) => a.t0).sort((a, b) => a - b);
  const target = dir > 0 ? starts.find((t) => t > rv.t + 0.5) : [...starts].reverse().find((t) => t < rv.t - 1.5);
  if (target != null) seek(target - 0.5);
}
function repJump(dir) {
  const reps = rv.reps.filter((r) => !r.superseded);
  const target = dir > 0 ? reps.find((r) => r.t > rv.t + 0.05) : [...reps].reverse().find((r) => r.t < rv.t - 0.3);
  if (target) seek(target.t);
}

export function initReplay() {
  refreshReplayColors();
  $('#rvOpenFolder').addEventListener('click', pickFolder);
  $('#rvOpenFiles').addEventListener('click', () => $('#rvFileInput').click());
  $('#rvFileInput').addEventListener('change', (e) => { if (e.target.files.length) loadFiles([...e.target.files]); e.target.value = ''; });
  $('#rvBack').addEventListener('click', () => { showEmpty(); showRecent(); });

  // Drag and drop (only while Replay is shown): a folder (Chrome gives a handle) or loose files.
  document.addEventListener('dragover', (e) => { if (!isShown()) return; e.preventDefault(); $('#rvDrop').classList.add('over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#rvDrop').classList.remove('over'); });
  document.addEventListener('drop', async (e) => {
    if (!isShown()) return;
    e.preventDefault();
    $('#rvDrop').classList.remove('over');
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const files = [...e.dataTransfer.files];
    const handlePromises = items[0]?.getAsFileSystemHandle ? items.map((i) => i.getAsFileSystemHandle()) : [];
    if (handlePromises.length) {
      const handles = await Promise.all(handlePromises);
      const dir = handles.find((x) => x?.kind === 'directory');
      if (dir) return openDir(dir);
    }
    if (files.length) loadFiles(files);
  });

  document.querySelectorAll('#rvSideTabs button').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));
  $('#rvPlay').addEventListener('click', () => setPlaying(!rv.playing));
  $('#rvPrevRep').addEventListener('click', () => repJump(-1));
  $('#rvNextRep').addEventListener('click', () => repJump(1));
  $('#rvPrevStep').addEventListener('click', () => stepJump(-1));
  $('#rvNextStep').addEventListener('click', () => stepJump(1));
  $('#rvRate').addEventListener('change', (e) => { rv.rate = +e.target.value; video().playbackRate = rv.rate; });
  $('#rvWindow').addEventListener('change', (e) => { rv.windowSec = +e.target.value; });
  $('#rvMirror').addEventListener('change', (e) => video().classList.toggle('mirrored', e.target.checked));
  $('#rvMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    rv.mode = b.dataset.mode;
    document.querySelectorAll('#rvMode button').forEach((x) => x.classList.toggle('active', x === b));
  });
  const nudge = (d) => {
    rv.sync = Math.round((rv.sync + d) * 10) / 10;
    $('#rvSync').textContent = `${rv.sync >= 0 ? '+' : '−'}${Math.abs(rv.sync).toFixed(1)} s`;
    try { localStorage.setItem('m40review.sync.' + rv.id, rv.sync); } catch { /* storage blocked */ }
    seek(rv.t);
  };
  $('#rvSyncMinus').addEventListener('click', () => nudge(-0.1));
  $('#rvSyncPlus').addEventListener('click', () => nudge(0.1));

  $('#rvCommentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#rvCommentText');
    const text = inp.value;
    inp.value = '';
    inp.blur();
    await addComment(text);
    if (rv.side !== 'comments') setSide('comments');
  });
  $('#rvCommentText').addEventListener('focus', () => setPlaying(false));
  $('#rvCommentText').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });

  // Overview scrubbing
  const ov = $('#rvOverview');
  let dragging = false;
  const scrub = (e) => {
    const r = ov.getBoundingClientRect();
    const w = r.width - OV.padL - OV.padR;
    seek(((e.clientX - r.left - OV.padL) / w) * rv.duration);
  };
  ov.addEventListener('pointerdown', (e) => { dragging = true; ov.setPointerCapture(e.pointerId); scrub(e); });
  ov.addEventListener('pointermove', (e) => { if (dragging) scrub(e); });
  ov.addEventListener('pointerup', () => { dragging = false; });

  document.addEventListener('keydown', (e) => {
    if (!isShown() || !rv.meta || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); setPlaying(!rv.playing); }
    else if (k === 'ArrowLeft') { e.preventDefault(); seek(rv.t - (e.shiftKey ? 5 : 1)); }
    else if (k === 'ArrowRight') { e.preventDefault(); seek(rv.t + (e.shiftKey ? 5 : 1)); }
    else if (k === '[') repJump(-1);
    else if (k === ']') repJump(1);
    else if (k === 'PageUp') { e.preventDefault(); stepJump(-1); }
    else if (k === 'PageDown') { e.preventDefault(); stepJump(1); }
    else if (k === 'Home') seek(0);
    else if (k === 'c' || k === 'C') { e.preventDefault(); $('#rvCommentText').focus(); }
  });
  // Buttons keep focus after a click; drop it so Space toggles play instead of re-clicking.
  document.addEventListener('click', (e) => { if (isShown()) e.target.closest('.rv-content button, .rv-side button')?.blur(); });
  window.addEventListener('resize', () => { overviewCache = null; });

  on('view', (v) => { if (v !== 'replay') pauseReplay(); });
  requestAnimationFrame(frame);
}

// ---- For the Analysis mode ---------------------------------------------------------------------

export function getSessionForAnalysis() {
  if (!rv.meta) return null;
  return {
    id: rv.id,
    meta: rv.meta,
    dir: rv.dir,
    duration: rv.duration,
    sensors: rv.sensors.map((s) => ({ key: s.key, label: s.label, name: s.name, colorIdx: s.colorIdx, calib: s.calib, t: s.t, raw: s.raw, phase: s.phase })),
    steps: rv.steps.map((a) => ({ step: a.step, title: a.title, attempt: a.attempt, superseded: a.superseded, t0: a.t0, t1: a.t1, repTimes: a.repTimes, target: a.target })),
    calib: rv.calib,
  };
}
export function seekTo(t) { seek(t); }
export function openFolderDialog() { return pickFolder(); }
export function openFilesDialog() { $('#rvFileInput').click(); }

// Exposed for tests.
window.m40Replay = { loadFiles, rv };
