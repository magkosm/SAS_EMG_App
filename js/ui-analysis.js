// Analysis mode: renders analysis.js results for the session loaded in Replay.
//   1. Activity vs rest   – every sample of each exercise as a distribution per sensor, AUC vs rest
//   2. Activations        – detected bursts over the session, per-step duty / reps with a burst / onset
//   3. Rep-locked stacks  – average response around each rep press (or burst onset), per step
//   4. Behaviour clusters – 1 s activation patterns clustered; occupancy per exercise vs rest

import { state, on, emit } from './state.js';
import { analyse, DEFAULTS } from './analysis.js';
import { getSessionForAnalysis, openFolderDialog, openFilesDialog } from './replay.js';
import { h, $, fmtNum, cssVar, niceCeil, csvRow, downloadBlob, toast, fmtClock } from './util.js';

const an = { opts: { ...DEFAULTS }, res: null, sessId: null, sess: null, stackStep: null, highlight: 'all' };
const UNIT_LABEL = { raw: 'raw', mvc: '% MVC', rest: '× rest' };
const UNIT_DIGITS = { raw: 0, mvc: 0, rest: 2 };
const isShown = () => state.view === 'analysis';
const sv = (ci) => `var(--s${(ci % 8) + 1})`;
// Clusters are a different kind of thing from sensors, so they get their own hues; the quietest is grey.
const CLUSTER_VARS = ['--muted', '--s7', '--s5', '--s4', '--s6', '--s8'];
const clusterVar = (i) => `var(${CLUSTER_VARS[i % CLUSTER_VARS.length]})`;
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const tip = (text) => svg('title', {}, text);
const fmtU = (v, unit) => (v == null ? '–' : fmtNum(v, UNIT_DIGITS[unit]) + (unit === 'raw' ? '' : ' ' + UNIT_LABEL[unit]));
const groupLabel = (g) => (g === 'rest' ? 'Rest' : `Step ${g.slice(1)}`);

function fitCanvas(cv, W, H) {
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
function colors() {
  return {
    ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'), axis: cssVar('--axis'),
    surface: cssVar('--surface'), band: cssVar('--band'), bandCalib: cssVar('--band-calib'), accent: cssVar('--accent'),
    series: Array.from({ length: 8 }, (_, i) => cssVar(`--s${i + 1}`)),
    cluster: CLUSTER_VARS.map((v) => cssVar(v)),
  };
}

// ---- Compute -----------------------------------------------------------------------------------

function recompute() {
  const sess = getSessionForAnalysis();
  an.sess = sess;
  if (!sess) { an.res = null; return; }
  try {
    an.res = analyse(sess, an.opts);
    an.sessId = sess.id;
    if (an.stackStep == null || !an.res.steps.some((a) => a.step === an.stackStep)) {
      // Open the detail on the step with the clearest rep-locked response.
      let best = null, bestScore = -Infinity;
      for (const e of an.res.stacks.perStep) {
        const score = an.res.sensors.reduce((sum, p) => {
          const x = e.bySensor[p.key];
          return sum + (x?.n && x.peak != null && p.restMeanUnit > 0 ? x.peak / p.restMeanUnit : 0);
        }, 0);
        if (score > bestScore) { bestScore = score; best = e.step; }
      }
      an.stackStep = best ?? an.res.steps[0]?.step ?? null;
    }
  } catch (err) {
    console.error(err);
    an.res = null;
    toast('Analysis failed: ' + err.message, 'bad', 8000);
  }
}

// ---- Toolbar --------------------------------------------------------------------------------------

function select(label, key, options, numeric = false) {
  return h('label', { class: 'field inline small' }, h('span', {}, label),
    h('select', { onchange: (e) => { an.opts[key] = numeric ? +e.target.value : e.target.value; recompute(); render(); } },
      options.map(([v, l]) => h('option', { value: v, selected: String(an.opts[key]) === String(v) }, l))));
}

function toolbar() {
  const sess = an.sess;
  const m = sess?.meta;
  return h('div', { class: 'an-toolbar' },
    h('div', { class: 'an-title' },
      h('b', {}, m ? (m.subject || m.session) : 'Analysis'),
      m?.started ? h('span', { class: 'tiny' }, ' · ' + new Date(m.started).toLocaleString()) : null,
      h('button', { class: 'btn small ghost', onclick: () => openFolderDialog() }, 'Open other session…')),
    h('div', { class: 'an-controls' },
      select('Unit', 'unit', [['rest', '× rest'], ['mvc', '% MVC'], ['raw', 'raw']]),
      select('Rest from', 'restSource', [['auto', 'auto'], ['calib', 'rest recording'], ['between', 'rests between steps'], ['both', 'both']]),
      select('Activation above rest +', 'k', [[2, '2 SD'], [3, '3 SD'], [4, '4 SD'], [5, '5 SD']], true),
      select('Min burst', 'minDur', [[0.2, '0.2 s'], [0.3, '0.3 s'], [0.5, '0.5 s'], [1, '1 s']], true),
      select('Stack on', 'align', [['rep', 'rep press'], ['onset', 'burst onset']]),
      h('label', { class: 'field inline small' }, h('span', {}, 'Stack window'),
        h('select', { onchange: (e) => { const [a, b] = e.target.value.split(',').map(Number); an.opts.pre = a; an.opts.post = b; recompute(); render(); } },
          [[0.5, 1.5], [1, 2], [2, 3]].map(([a, b]) => h('option', { value: `${a},${b}`, selected: an.opts.pre === a && an.opts.post === b }, `−${a} … +${b} s`)))),
      select('Clusters', 'clusters', [2, 3, 4, 5, 6].map((v) => [v, String(v)]), true),
      select('Window', 'win', [[0.5, '0.5 s'], [1, '1 s'], [2, '2 s']], true),
      select('Features', 'features', [['level', 'level'], ['level+var', 'level + variability']]),
      h('button', { class: 'btn small primary', onclick: exportAll }, 'Export analysis'),
    ),
  );
}

// ---- 1. Activity vs rest ------------------------------------------------------------------------------

function boxesCard(res, W) {
  const sensors = res.sensors;
  const groups = res.groups.filter((g) => Object.keys(g.bySensor).length);
  const labelW = 210, rowH = 24, headH = 40, footH = 22;
  const cw = (W - labelW) / sensors.length;
  const H = headH + groups.length * rowH + footH;
  const root = svg('svg', { width: W, height: H, class: 'an-svg', role: 'img', 'aria-label': 'Distribution of samples per exercise and sensor, compared with rest' });
  sensors.forEach((p, si) => {
    const x0 = labelW + si * cw + 8, pw = cw - 62;
    const max = niceCeil(Math.max(...groups.map((g) => g.bySensor[p.key]?.p95 ?? 0), 1e-6) * 1.05);
    const X = (v) => x0 + (Math.min(v, max) / max) * pw;
    root.append(
      svg('rect', { x: x0, y: 8, width: 10, height: 10, rx: 3, fill: sv(p.colorIdx) }),
      svg('text', { x: x0 + 15, y: 17, class: 'an-head' }, p.label),
      svg('text', { x: x0 + pw + 50, y: 17, class: 'an-axis', 'text-anchor': 'end' }, 'AUC'),
      svg('text', { x: x0, y: 33, class: 'an-axis' }, UNIT_LABEL[p.unit]));
    // Grid + axis ticks
    for (const f of [0, 0.5, 1]) {
      root.append(svg('line', { x1: X(max * f), x2: X(max * f), y1: headH - 4, y2: H - footH + 2, class: f ? 'an-grid' : 'an-base' }),
        svg('text', { x: X(max * f), y: H - 6, class: 'an-axis', 'text-anchor': 'middle' }, fmtNum(max * f, max * f < 10 && (max * f) % 1 ? 1 : 0)));
    }
    const rest = res.groups[0].bySensor[p.key];
    if (rest) root.append(svg('line', { x1: X(rest.median), x2: X(rest.median), y1: headH - 4, y2: H - footH + 2, class: 'an-restline' }));
    groups.forEach((g, gi) => {
      const st = g.bySensor[p.key];
      if (!st) return;
      const y = headH + gi * rowH + rowH / 2;
      const fill = g.kind === 'rest' ? 'var(--muted)' : sv(p.colorIdx);
      const cell = svg('g', {},
        tip(`${g.label} · ${p.label}\nmedian ${fmtU(st.median, p.unit)}, middle 50 %: ${fmtU(st.q1, p.unit)}–${fmtU(st.q3, p.unit)}\n5–95 %: ${fmtU(st.p5, p.unit)}–${fmtU(st.p95, p.unit)}${st.auc != null ? `\nAUC vs rest ${st.auc.toFixed(2)}` : ''}\n${st.n} samples`),
        svg('rect', { x: x0 - 4, y: y - rowH / 2, width: cw - 8, height: rowH, fill: 'transparent' }),
        svg('line', { x1: X(st.p5), x2: X(st.p95), y1: y, y2: y, stroke: fill, 'stroke-width': 1.5 }),
        svg('rect', { x: X(st.q1), y: y - 6, width: Math.max(2, X(st.q3) - X(st.q1)), height: 12, rx: 3, fill, 'fill-opacity': 0.35, stroke: fill }),
        svg('line', { x1: X(st.median), x2: X(st.median), y1: y - 7, y2: y + 7, class: 'an-median' }),
        st.auc != null ? svg('text', { x: x0 + pw + 50, y: y + 4, class: 'an-num' + (st.auc >= 0.8 ? ' strong' : ''), 'text-anchor': 'end' }, st.auc.toFixed(2)) : null);
      root.append(cell);
    });
  });
  groups.forEach((g, gi) => {
    const y = headH + gi * rowH + rowH / 2;
    if (gi % 2) root.insertBefore(svg('rect', { x: 0, y: y - rowH / 2, width: W, height: rowH, class: 'an-zebra' }), root.firstChild);
    root.append(svg('text', { x: 4, y: y + 4, class: 'an-label' + (g.kind === 'rest' ? ' rest' : '') }, g.label.length > 32 ? g.label.slice(0, 31) + '…' : g.label));
  });
  return card('Activity vs rest',
    'Every sample of each exercise per sensor. Box = middle 50 %, line = 5–95 %, tick = median, dashed line = rest median. AUC = chance that a sample from the exercise is higher than a rest sample (0.5 = like rest, ≥ 0.8 bold = clearly above rest). AUC looks at the whole exercise; short bursts show up better under Activations.',
    root);
}

// ---- 2. Activations -------------------------------------------------------------------------------------

function rasterCanvas(res, W) {
  const sess = an.sess, sensors = res.sensors;
  const labelW = 110, top = 22, rowH = 20, bottom = 22;
  const H = top + sensors.length * rowH + bottom;
  const cv = h('canvas', { class: 'an-canvas', title: 'Click to open this moment in Replay' });
  const draw = (hoverX) => {
    const c = colors();
    const ctx = fitCanvas(cv, W, H);
    const w = W - labelW - 10;
    const X = (t) => labelW + (t / sess.duration) * w;
    ctx.font = '600 10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    for (const [a, b] of res.rest.intervals) { ctx.fillStyle = c.bandCalib; ctx.fillRect(X(a), top - 4, Math.max(1, X(b) - X(a)), sensors.length * rowH + 4); }
    for (const a of res.steps) {
      ctx.fillStyle = c.band;
      ctx.fillRect(X(a.t0), top - 4, Math.max(1, X(a.t1) - X(a.t0)), sensors.length * rowH + 4);
      ctx.fillStyle = c.ink2;
      ctx.fillText(String(a.step), (X(a.t0) + X(a.t1)) / 2, 12);
      ctx.fillStyle = c.muted;
      for (const r of a.repTimes) ctx.fillRect(Math.round(X(r)), top + sensors.length * rowH + 1, 1, 4);
    }
    sensors.forEach((p, si) => {
      const y = top + si * rowH;
      ctx.fillStyle = c.ink;
      ctx.textAlign = 'left';
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      ctx.fillText(p.label, 4, y + 13);
      ctx.fillStyle = c.series[p.colorIdx % 8];
      for (const b of res.activations.bySensor[p.key]) ctx.fillRect(X(b.t0), y + 4, Math.max(1.5, X(b.t1) - X(b.t0)), rowH - 8);
    });
    ctx.fillStyle = c.muted;
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const stepS = sess.duration > 1200 ? 300 : sess.duration > 300 ? 60 : 30;
    for (let t = 0; t <= sess.duration; t += stepS) ctx.fillText(fmtClock(t), X(t), H - 4);
    if (hoverX != null) {
      ctx.strokeStyle = c.ink;
      ctx.beginPath(); ctx.moveTo(hoverX + 0.5, top - 4); ctx.lineTo(hoverX + 0.5, top + sensors.length * rowH); ctx.stroke();
      const t = ((hoverX - labelW) / w) * sess.duration;
      ctx.fillStyle = c.ink;
      ctx.textAlign = hoverX > W - 60 ? 'right' : 'left';
      ctx.fillText(fmtClock(t), hoverX + (hoverX > W - 60 ? -4 : 4), top + sensors.length * rowH + 14);
    }
    cv._toT = (x) => ((x - labelW) / w) * sess.duration;
  };
  draw(null);
  cv.addEventListener('mousemove', (e) => { const x = e.offsetX; draw(x > labelW ? x : null); });
  cv.addEventListener('mouseleave', () => draw(null));
  cv.addEventListener('click', (e) => { const t = cv._toT(e.offsetX); if (t >= 0) emit('replayAt', t); });
  return cv;
}

function dutyShade(v) {
  if (v == null) return null;
  const f = Math.max(0, Math.min(1, v / 100));
  return `color-mix(in srgb, var(--accent) ${Math.round(8 + f * 50)}%, var(--surface))`;
}

function activationCard(res, W) {
  const sensors = res.sensors;
  const restRow = res.activations.rest;
  const table = h('table', { class: 'an-table' },
    h('thead', {},
      h('tr', {}, h('th', { rowspan: 2, class: 'l' }, 'Step'), h('th', { rowspan: 2 }, 'Reps'),
        sensors.map((p) => h('th', { colspan: 3, class: 'grp' }, h('span', { class: 'swatch', style: { background: sv(p.colorIdx) } }), p.label))),
      h('tr', {}, sensors.flatMap(() => [h('th', { title: 'Share of the step with the muscle above the activation threshold' }, 'Active'), h('th', { title: 'Counted reps with a burst within ±0.75 s of the press' }, 'Reps with burst'), h('th', { title: 'Median burst onset relative to the rep press (negative = before)' }, 'Onset')]))),
    h('tbody', {},
      res.activations.perStep.map((r) => h('tr', {},
        h('td', { class: 'l', title: r.title }, `${r.step}. ${r.title}`),
        h('td', {}, `${r.reps}/${r.target}`),
        sensors.flatMap((p) => {
          const x = r.bySensor[p.key];
          return [
            h('td', { style: { background: dutyShade(x.duty) }, title: `${x.bursts} bursts (${fmtNum(x.burstsPerMin, 1)}/min), mean ${fmtNum(x.meanBurstDur, 2)} s, mean peak ${fmtU(x.meanBurstPeak, p.unit)}` }, x.duty != null ? fmtNum(x.duty, 0) + ' %' : '–'),
            h('td', {}, x.repsWithAct != null ? fmtNum(x.repsWithAct, 0) + ' %' : '–'),
            h('td', {}, x.onsetLatencyMs != null ? `${x.onsetLatencyMs > 0 ? '+' : ''}${fmtNum(x.onsetLatencyMs, 0)} ms` : '–'),
          ];
        }))),
      h('tr', { class: 'rest' },
        h('td', { class: 'l' }, 'Rest (false alarms)'), h('td', {}, '–'),
        sensors.flatMap((p) => {
          const x = restRow[p.key];
          return [h('td', {}, x.duty != null ? fmtNum(x.duty, 1) + ' %' : '–'), h('td', { colspan: 2, class: 'tiny' }, x.burstsPerMin != null ? `${fmtNum(x.burstsPerMin, 1)} bursts/min` : '–')];
        }))));
  const thr = sensors.map((p) => `${p.label} ${fmtU(p.thrOnUnit, p.unit)}`).join(' · ');
  return card('Activations',
    `A burst = the signal (0.3 s smoothing) rises above rest mean + ${an.opts.k} SD and stays there at least ${an.opts.minDur} s (it ends below + ${Math.max(0.5, an.opts.k - 1)} SD). Thresholds: ${thr}. The rest row shows how often this fires when the person is at rest; keep it near 0.`,
    h('div', {}, rasterCanvas(res, W), h('div', { class: 'an-scroll' }, table)));
}

// ---- 3. Rep-locked stacks ---------------------------------------------------------------------------------

function drawStack(cv, W, H, p, st, tau, yMax, detail) {
  const c = colors();
  const ctx = fitCanvas(cv, W, H);
  const padL = detail ? 40 : 4, padR = 6, padT = detail ? 10 : 4, padB = detail ? 20 : 4;
  const w = W - padL - padR, hh = H - padT - padB;
  const X = (t) => padL + ((t - tau[0]) / (tau[tau.length - 1] - tau[0])) * w;
  const Y = (v) => padT + hh - (Math.min(Math.max(v, 0), yMax * 1.05) / yMax) * hh;
  const col = c.series[p.colorIdx % 8];
  // Rest band (mean ± SD) and threshold
  ctx.fillStyle = c.bandCalib;
  ctx.fillRect(padL, Y(p.restMeanUnit + p.restSdUnit), w, Math.max(1, Y(p.restMeanUnit - p.restSdUnit) - Y(p.restMeanUnit + p.restSdUnit)));
  ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = c.muted;
  ctx.beginPath(); ctx.moveTo(padL, Y(p.thrOnUnit)); ctx.lineTo(padL + w, Y(p.thrOnUnit)); ctx.stroke(); ctx.restore();
  if (detail) {
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const f of [0, 0.5, 1]) {
      ctx.strokeStyle = f ? c.grid : c.axis;
      ctx.beginPath(); ctx.moveTo(padL, Y(yMax * f) + 0.5); ctx.lineTo(padL + w, Y(yMax * f) + 0.5); ctx.stroke();
      ctx.fillText(fmtNum(yMax * f, yMax * f < 10 && (yMax * f) % 1 ? 1 : 0), padL - 5, Y(yMax * f));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let t = Math.ceil(tau[0]); t <= tau[tau.length - 1]; t++) ctx.fillText(`${t > 0 ? '+' : ''}${t} s`, X(t), H - 5);
  }
  if (!st || !st.n) {
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillText('no events', padL + w / 2, padT + hh / 2);
    return;
  }
  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT - 2, w, hh + 4); ctx.clip();
  if (detail) {
    ctx.strokeStyle = col; ctx.globalAlpha = 0.18; ctx.lineWidth = 1;
    for (const seg of st.segments) {
      ctx.beginPath(); let pen = false;
      seg.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } const x = X(tau[i]), y = Y(v); if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // SD band + mean
  ctx.fillStyle = col; ctx.globalAlpha = 0.18;
  ctx.beginPath();
  tau.forEach((t, i) => { const v = st.mean[i] + (st.sd[i] || 0); if (i) ctx.lineTo(X(t), Y(v)); else ctx.moveTo(X(t), Y(v)); });
  for (let i = tau.length - 1; i >= 0; i--) ctx.lineTo(X(tau[i]), Y(st.mean[i] - (st.sd[i] || 0)));
  ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  tau.forEach((t, i) => { if (st.mean[i] == null) return; if (i) ctx.lineTo(X(t), Y(st.mean[i])); else ctx.moveTo(X(t), Y(st.mean[i])); });
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = c.ink2; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0) + 0.5, padT); ctx.lineTo(X(0) + 0.5, padT + hh); ctx.stroke();
}

function stacksCard(res, W) {
  const sensors = res.sensors, tau = res.stacks.tau;
  const yMax = {};
  for (const p of sensors) {
    let m = p.thrOnUnit;
    for (const e of res.stacks.perStep) { const x = e.bySensor[p.key]; if (x?.n) x.mean.forEach((v, i) => { if (v != null) m = Math.max(m, v + (x.sd[i] || 0)); }); }
    yMax[p.key] = niceCeil(Math.max(m * 1.05, 1e-6));
  }
  const labelW = 190, cellW = Math.max(110, Math.min(220, (W - labelW - 20) / sensors.length - 10)), cellH = 46;
  const evName = an.opts.align === 'onset' ? 'burst onsets' : 'rep presses';
  const grid = h('table', { class: 'an-stack-grid' },
    h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Step'), sensors.map((p) => h('th', {}, h('span', { class: 'swatch', style: { background: sv(p.colorIdx) } }), `${p.label} (${UNIT_LABEL[p.unit]})`)))),
    h('tbody', {}, res.stacks.perStep.map((e) => {
      const tr = h('tr', { class: e.step === an.stackStep ? 'sel' : '', onclick: () => { an.stackStep = e.step; render(); } },
        h('td', { class: 'l', title: e.title }, `${e.step}. ${e.title}`),
        sensors.map((p) => {
          const st = e.bySensor[p.key];
          const cv = h('canvas');
          drawStack(cv, cellW, cellH, p, st, tau, yMax[p.key], false);
          return h('td', { title: st?.n ? `${st.n} ${evName}; peak of average ${fmtU(st.peak, p.unit)} at ${st.peakAt > 0 ? '+' : ''}${st.peakAt} s` : 'no events' },
            cv, h('div', { class: 'tiny' }, st?.n ? `n ${st.n} · peak ${fmtU(st.peak, p.unit)} @ ${st.peakAt > 0 ? '+' : ''}${st.peakAt} s` : '–'));
        }));
      return tr;
    })));
  const sel = res.stacks.perStep.find((e) => e.step === an.stackStep);
  const detailW = Math.max(260, Math.min(460, (W - 20) / sensors.length - 12));
  const detail = sel ? h('div', { class: 'an-stack-detail' },
    h('h3', {}, `Step ${sel.step} · ${sel.title}: every ${an.opts.align === 'onset' ? 'burst' : 'rep'} stacked`),
    h('div', { class: 'an-row' }, sensors.map((p) => {
      const cv = h('canvas');
      drawStack(cv, detailW, 190, p, sel.bySensor[p.key], tau, yMax[p.key], true);
      const st = sel.bySensor[p.key];
      return h('div', {}, h('div', { class: 'an-subhead' }, h('span', { class: 'swatch', style: { background: sv(p.colorIdx) } }), p.label, h('span', { class: 'tiny' }, ` · n ${st?.n || 0}`)), cv);
    }))) : null;
  return card('Rep-locked stacks',
    `Signal around each ${evName} (0 s, vertical line), from −${an.opts.pre} to +${an.opts.post} s: thin lines = single events, thick line = average, shaded = ± 1 SD, grey band = rest ± 1 SD, dashed = activation threshold. Same scale per sensor down the column. Click a step for the detail.`,
    h('div', {}, detail, h('div', { class: 'an-scroll' }, grid)));
}

// ---- 4. Behaviour clusters --------------------------------------------------------------------------------

function clusterProfiles(cl, sensors) {
  const maxL = Math.max(2, ...cl.centroids.flatMap((c) => c.levels));
  const total = cl.windows.length;
  return h('div', { class: 'an-clusters' }, cl.centroids.map((c) => {
    const rowH = 15, W = 230, bx = 86;
    const s = svg('svg', { width: W, height: sensors.length * rowH + 4 });
    sensors.forEach((p, si) => {
      const y = si * rowH + 2;
      const v = c.levels[si];
      const thr = p.restMean > 0 ? p.thrOn / p.restMean : null;
      s.append(
        svg('text', { x: 0, y: y + 10, class: 'an-axis' }, p.label.length > 13 ? p.label.slice(0, 12) + '…' : p.label),
        svg('rect', { x: bx, y: y + 2, width: Math.max(2, (v / maxL) * (W - bx - 40)), height: 9, rx: 2, fill: sv(p.colorIdx) }, tip(`${p.label}: ${fmtNum(v, 2)} × rest`)),
        thr ? svg('line', { x1: bx + (thr / maxL) * (W - bx - 40), x2: bx + (thr / maxL) * (W - bx - 40), y1: y, y2: y + 13, class: 'an-thr' }) : null,
        svg('text', { x: W - 2, y: y + 10, class: 'an-num', 'text-anchor': 'end' }, fmtNum(v, 1) + '×'));
    });
    return h('div', { class: 'an-cluster' },
      h('div', { class: 'an-cluster-head' }, h('span', { class: 'swatch', style: { background: clusterVar(c.id) } }), h('b', {}, c.name)),
      h('div', { class: 'tiny' }, `${c.count} windows · ${fmtNum((100 * c.count) / total, 0)} %`),
      s);
  }));
}

function occupancyChart(cl, steps, W) {
  const rows = cl.groupsOrder.filter((g) => cl.counts[g]);
  const labelW = 210, rightW = 120, rowH = 22, headH = 4;
  const bw = W - labelW - rightW - 10;
  const H = headH + rows.length * rowH + 4;
  const titles = Object.fromEntries(steps.map((a) => ['S' + a.step, `${a.step}. ${a.title}`]));
  const root = svg('svg', { width: W, height: H, class: 'an-svg', role: 'img', 'aria-label': 'Share of each cluster per exercise' });
  rows.forEach((g, ri) => {
    const y = headH + ri * rowH;
    const lab = g === 'rest' ? 'Rest' : titles[g] || g;
    root.append(svg('text', { x: 4, y: y + 15, class: 'an-label' + (g === 'rest' ? ' rest' : '') }, lab.length > 32 ? lab.slice(0, 31) + '…' : lab));
    let x = labelW;
    cl.occupancy[g].forEach((p, ci) => {
      const wseg = p * bw;
      if (wseg <= 0) return;
      const n = Math.round(p * cl.counts[g]);
      root.append(svg('rect', { x: x + 1, y: y + 4, width: Math.max(1, wseg - 2), height: rowH - 8, rx: 3, fill: clusterVar(ci) },
        tip(`${lab}: ${cl.centroids[ci].name} ${fmtNum(p * 100, 0)} % (${n} of ${cl.counts[g]} windows)`)));
      if (wseg > 34) root.append(svg('text', { x: x + wseg / 2, y: y + 15, class: 'an-seg', 'text-anchor': 'middle' }, fmtNum(p * 100, 0) + '%'));
      x += wseg;
    });
    const act = cl.activeShare[g];
    root.append(svg('text', { x: W - 4, y: y + 15, class: 'an-num' + (g !== 'rest' && act >= 50 ? ' strong' : ''), 'text-anchor': 'end' }, act != null ? `${fmtNum(act, 0)} % active` : ''));
  });
  return root;
}

function scatter(cl, W, H) {
  const wrap = h('div', { class: 'an-scatter' });
  const cv = h('canvas');
  const tipEl = h('div', { class: 'an-tip', hidden: true });
  wrap.append(cv, tipEl);
  const pts = cl.windows;
  const xs = pts.map((w) => w.pc[0]), ys = pts.map((w) => w.pc[1] ?? 0);
  const pad = 30;
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const X = (v) => pad + ((v - x0) / (x1 - x0 || 1)) * (W - pad * 2);
  const Y = (v) => H - pad - ((v - y0) / (y1 - y0 || 1)) * (H - pad * 2);
  const draw = (hover) => {
    const c = colors();
    const ctx = fitCanvas(cv, W, H);
    ctx.strokeStyle = c.axis;
    ctx.strokeRect(pad - 8.5, 8.5, W - pad * 2 + 17, H - pad - 1);
    ctx.fillStyle = c.muted; ctx.font = '11px system-ui, -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`pattern axis 1 (${fmtNum((cl.explained[0] || 0) * 100, 0)} % of variation)`, W / 2, H - 8);
    ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(`axis 2 (${fmtNum((cl.explained[1] || 0) * 100, 0)} %)`, 0, 0); ctx.restore();
    const hl = an.highlight;
    const order = pts.map((_, i) => i).sort((a, b) => (pts[a].group === hl) - (pts[b].group === hl));
    for (const i of order) {
      const w = pts[i];
      const dim = hl !== 'all' && w.group !== hl;
      ctx.globalAlpha = dim ? 0.12 : 0.85;
      ctx.fillStyle = c.cluster[w.cluster % c.cluster.length];
      ctx.beginPath(); ctx.arc(X(w.pc[0]), Y(w.pc[1] ?? 0), 4, 0, Math.PI * 2); ctx.fill();
      if (w.group === 'rest' && !dim) { ctx.globalAlpha = 1; ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    if (hover != null) {
      const w = pts[hover];
      ctx.strokeStyle = c.ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(w.pc[0]), Y(w.pc[1] ?? 0), 7, 0, Math.PI * 2); ctx.stroke();
    }
  };
  const nearest = (mx, my) => {
    let bi = null, bd = 100;
    pts.forEach((w, i) => { if (an.highlight !== 'all' && w.group !== an.highlight) return; const d = (X(w.pc[0]) - mx) ** 2 + (Y(w.pc[1] ?? 0) - my) ** 2; if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  draw(null);
  cv.addEventListener('mousemove', (e) => {
    const i = nearest(e.offsetX, e.offsetY);
    draw(i);
    if (i == null) { tipEl.hidden = true; return; }
    const w = pts[i];
    tipEl.hidden = false;
    tipEl.textContent = `${groupLabel(w.group)} · ${fmtClock(w.t0)} · ${cl.centroids[w.cluster].name} — ${an.res.sensors.map((p, si) => `${p.label} ${fmtNum(w.levels[si], 1)}×`).join(', ')} · click to replay`;
    tipEl.style.left = Math.min(e.offsetX + 12, W - 260) + 'px';
    tipEl.style.top = e.offsetY + 12 + 'px';
  });
  cv.addEventListener('mouseleave', () => { draw(null); tipEl.hidden = true; });
  cv.addEventListener('click', (e) => { const i = nearest(e.offsetX, e.offsetY); if (i != null) emit('replayAt', pts[i].t0); });
  return wrap;
}

function clustersCard(res, W) {
  const cl = res.clusters;
  if (!cl.k) return card('Behaviour clusters', cl.note || 'Not enough data.', h('div'));
  const scatterW = Math.min(520, Math.max(320, W * 0.42));
  const groups = cl.groupsOrder.filter((g) => cl.counts[g]);
  return card('Behaviour clusters',
    `The session is cut into ${an.opts.win} s windows (rest and exercises only). Each window is described by how active each sensor is (level relative to rest${an.opts.features === 'level+var' ? ', plus variability' : ''}) and grouped into ${cl.k} patterns by k-means. Patterns are named from which sensors are above their activation threshold (thin line in the bars). The bars below show how much of each exercise falls in each pattern, against rest. "% active" = share of windows in a pattern with at least one sensor active.`,
    h('div', {},
      clusterProfiles(cl, res.sensors),
      h('div', { class: 'an-row an-row-top' },
        h('div', { class: 'an-grow' }, h('h3', {}, 'Patterns per exercise vs rest'), occupancyChart(cl, res.steps, Math.max(420, W - scatterW - 40))),
        h('div', {},
          h('div', { class: 'an-row' }, h('h3', { style: { margin: 0 } }, 'Windows on the two main pattern axes'),
            h('label', { class: 'field inline small' }, 'Highlight',
              h('select', { onchange: (e) => { an.highlight = e.target.value; render(); } },
                h('option', { value: 'all', selected: an.highlight === 'all' }, 'all'),
                groups.map((g) => h('option', { value: g, selected: an.highlight === g }, groupLabel(g)))))),
          scatter(cl, scatterW, 300),
          h('p', { class: 'tiny' }, 'Each dot is one window, coloured by pattern; rest windows have a dark ring. Click a dot to see it in Replay.')))));
}

// ---- Layout ------------------------------------------------------------------------------------------------

function card(title, help, body) {
  return h('section', { class: 'an-card' }, h('h2', {}, title), h('p', { class: 'an-help' }, help), body);
}

function render() {
  if (!isShown()) return;
  const view = $('#analysisView'), empty = $('#analysisEmpty');
  if (!an.sess || !an.res) { view.hidden = true; empty.hidden = false; return; }
  empty.hidden = true;
  view.hidden = false;
  const scrollTop = view.scrollTop;
  view.replaceChildren(toolbar());
  const body = h('div', { class: 'an-body' });
  view.append(body);
  // Card content width: body padding (2 × 16) + card padding (2 × 16) + borders.
  const W = Math.max(640, body.clientWidth - 68);
  const res = an.res;
  const restTxt = { calib: 'the rest recording', between: 'rests between steps', both: 'the rest recording and rests between steps', quietest: 'the quietest 20 % of samples' }[res.rest.source];
  body.append(
    h('div', { class: 'callout' }, `${res.steps.length} exercises analysed. Rest reference: ${restTxt}. `, res.notes.length ? h('b', {}, res.notes.join(' ')) : null),
    boxesCard(res, W),
    activationCard(res, W),
    stacksCard(res, W),
    clustersCard(res, W),
  );
  view.scrollTop = scrollTop;
}

export function onAnalysisShown() {
  const sess = getSessionForAnalysis();
  if (sess && sess.id !== an.sessId) { an.stackStep = null; an.highlight = 'all'; }
  recompute();
  render();
}

// ---- Export -----------------------------------------------------------------------------------------------

function buildExports(res) {
  const csv = (rows) => new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  const sensors = res.sensors;
  const lbl = Object.fromEntries(sensors.map((p) => [p.key, p.label]));
  const files = {};
  const g = [csvRow(['group', 'step', 'title', 'sensor', 'unit', 'n', 'p5', 'q1', 'median', 'q3', 'p95', 'mean', 'sd', 'auc_vs_rest', 'median_ratio_vs_rest'])];
  for (const gr of res.groups) for (const p of sensors) {
    const s = gr.bySensor[p.key];
    if (s) g.push(csvRow([gr.kind, gr.step ?? '', gr.label, p.label, p.unit, s.n, s.p5, s.q1, s.median, s.q3, s.p95, s.mean, s.sd, s.auc, s.ratio]));
  }
  files['analysis_groups.csv'] = csv(g);
  const a = [csvRow(['step', 'title', 'sensor', 'reps', 'active_pct', 'bursts', 'bursts_per_min', 'reps_with_burst_pct', 'onset_latency_ms', 'mean_burst_dur_s', 'mean_burst_peak', 'unit'])];
  for (const r of res.activations.perStep) for (const p of sensors) {
    const x = r.bySensor[p.key];
    a.push(csvRow([r.step, r.title, p.label, r.reps, x.duty, x.bursts, x.burstsPerMin, x.repsWithAct, x.onsetLatencyMs, x.meanBurstDur, x.meanBurstPeak, p.unit]));
  }
  for (const p of sensors) a.push(csvRow(['rest', 'Rest (false alarms)', p.label, '', res.activations.rest[p.key].duty, '', res.activations.rest[p.key].burstsPerMin, '', '', '', '', p.unit]));
  files['analysis_activation_steps.csv'] = csv(a);
  const b = [csvRow(['sensor', 't0_s', 't1_s', 'duration_s', 'peak', 'area', 'unit', 'during'])];
  for (const p of sensors) for (const x of res.activations.bySensor[p.key]) {
    const st = res.steps.find((s) => x.t0 >= s.t0 && x.t0 <= s.t1);
    b.push(csvRow([p.label, x.t0, x.t1, x.dur, x.peak, x.area, p.unit, st ? 'step ' + st.step : '']));
  }
  files['analysis_bursts.csv'] = csv(b);
  const s = [csvRow(['step', 'sensor', 'aligned_on', 'tau_s', 'mean', 'sd', 'n_events', 'unit'])];
  for (const e of res.stacks.perStep) for (const p of sensors) {
    const x = e.bySensor[p.key];
    if (x?.n) res.stacks.tau.forEach((t, i) => s.push(csvRow([e.step, p.label, res.stacks.align, t, x.mean[i], x.sd[i], x.n, p.unit])));
  }
  files['analysis_stacks.csv'] = csv(s);
  const cl = res.clusters;
  if (cl.k) {
    const w = [csvRow(['t0_s', 't1_s', 'group', 'cluster', 'cluster_name', 'axis1', 'axis2', ...sensors.map((p) => `${p.label}_x_rest`)])];
    for (const x of cl.windows) w.push(csvRow([x.t0, x.t1, x.group, x.cluster + 1, cl.centroids[x.cluster].name, x.pc[0], x.pc[1], ...x.levels]));
    files['analysis_windows.csv'] = csv(w);
    const c = [csvRow(['cluster', 'name', 'windows', ...sensors.map((p) => `${p.label}_x_rest`), ...cl.groupsOrder.map((gg) => `share_${gg}`)])];
    cl.centroids.forEach((x, i) => c.push(csvRow([i + 1, x.name, x.count, ...x.levels, ...cl.groupsOrder.map((gg) => cl.occupancy[gg]?.[i])])));
    files['analysis_clusters.csv'] = csv(c);
  }
  files['analysis_settings.json'] = new Blob([JSON.stringify({ session: an.sess.id, created: new Date().toISOString(), settings: res.opts, rest: res.rest, notes: res.notes, sensors: res.sensors.map(({ key, label, unit, restMean, restSd, thrOn, thrOff }) => ({ key, label, unit, restMean, restSd, thrOn, thrOff })), labels: lbl }, null, 2)], { type: 'application/json' });
  return files;
}

async function exportAll() {
  if (!an.res) return;
  const files = buildExports(an.res);
  const dir = an.sess.dir;
  if (dir) {
    try {
      const opts = { mode: 'readwrite' };
      if ((await dir.queryPermission(opts)) !== 'granted' && (await dir.requestPermission(opts)) !== 'granted') throw new Error('no write permission');
      const sub = await dir.getDirectoryHandle('analysis', { create: true });
      for (const [n, blob] of Object.entries(files)) {
        const w = await (await sub.getFileHandle(n, { create: true })).createWritable();
        await w.write(blob);
        await w.close();
      }
      toast(`Saved ${Object.keys(files).length} files to ${dir.name}/analysis/`);
      return;
    } catch (err) {
      toast('Could not write to the session folder (' + err.message + '). Downloading instead.', 'bad');
    }
  }
  Object.entries(files).forEach(([n, blob], i) => setTimeout(() => downloadBlob(blob, `${an.sess.id}_${n}`), i * 350));
}

// ---- Init --------------------------------------------------------------------------------------------------

export function initAnalysis() {
  $('#anOpenFolder').addEventListener('click', () => openFolderDialog());
  $('#anOpenFiles').addEventListener('click', () => openFilesDialog());
  on('sessionLoaded', () => { an.stackStep = null; an.highlight = 'all'; if (isShown()) onAnalysisShown(); });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (isShown()) render(); }, 200); });
  on('theme', () => { if (isShown()) render(); });
}

// Exposed for tests.
window.m40Analysis = { an, buildExports: () => an.res && buildExports(an.res) };
