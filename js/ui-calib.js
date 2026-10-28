// Tab 2: rest baseline and (optional) MVC captures.

import { state, on, emit, clock, seriesVar, sensorLabel } from './state.js';
import { siteByKey } from './protocol.js';
import { summarizeRest, summarizeMvc, ACTIVE_SD } from './processing.js';
import { logEvent } from './session.js';
import { h, $, fmtNum, beep, toast, fill } from './util.js';

const root = () => $('#tab-calib');
const prefs = { restSec: 15, mvcSec: 5, lead: 3 };
let timer = null;

function liveSensors() { return state.sensors.filter((s) => s.status === 'live'); }

function begin(kind, sensors) {
  if (state.calib) return;
  if (state.protocol.attempt) { toast('Finish the running step first.', 'bad'); return; }
  if (!sensors.length) { toast('No live sensors.', 'bad'); return; }
  const now = clock();
  const dur = kind === 'mvc' ? prefs.mvcSec : prefs.restSec;
  state.calib = {
    kind,
    keys: sensors.map((s) => s.key),
    t0: now + prefs.lead,
    t1: now + prefs.lead + dur,
    data: Object.fromEntries(sensors.map((s) => [s.key, []])),
    beeped: false,
  };
  logEvent(kind === 'mvc' ? 'calib_mvc_start' : 'calib_rest_start', { detail: sensors.map((s) => s.key).join(' ') });
  timer = setInterval(tick, 100);
  render();
}

function tick() {
  const c = state.calib;
  if (!c) return;
  const now = clock();
  if (!c.beeped && now >= c.t0) { c.beeped = true; beep(880); }
  if (now >= c.t1) finish();
  else updateCountdown();
}

function cancel() {
  clearInterval(timer);
  state.calib = null;
  logEvent('calib_cancel');
  render();
}

function finish() {
  clearInterval(timer);
  const c = state.calib;
  state.calib = null;
  beep(660, 0.15);
  const problems = [];
  for (const key of c.keys) {
    const s = state.sensors.find((x) => x.key === key);
    if (!s) continue;
    const vals = c.data[key];
    if (c.kind === 'rest') {
      const r = summarizeRest(vals);
      if (!r) { problems.push(s.name); continue; }
      s.calib.restMean = r.mean;
      s.calib.restSd = r.sd;
      s.calib.restN = r.n;
    } else {
      const m = summarizeMvc(vals);
      if (m == null) { problems.push(s.name); continue; }
      s.calib.mvcTrials = [...(s.calib.mvcTrials || []), m];
      s.calib.mvc = Math.max(...s.calib.mvcTrials);
    }
  }
  state.calibBands.push({ kind: c.kind, t0: c.t0, t1: c.t1, keys: c.keys });
  logEvent(c.kind === 'mvc' ? 'calib_mvc_end' : 'calib_rest_end', {
    detail: c.keys.map((k) => {
      const s = state.sensors.find((x) => x.key === k);
      return s ? `${k}:${c.kind === 'mvc' ? fmtNum(s.calib.mvc, 1) : fmtNum(s.calib.restMean, 1) + '±' + fmtNum(s.calib.restSd, 1)}` : k;
    }).join(' '),
  });
  if (problems.length) toast('Too few samples for: ' + problems.join(', '), 'bad');
  emit('calib');
  render();
}

function updateCountdown() {
  const c = state.calib;
  const el = $('#calCountdown');
  if (!c || !el) return;
  const now = clock();
  const pre = now < c.t0;
  el.textContent = Math.ceil(pre ? c.t0 - now : c.t1 - now);
  $('#calPhase').textContent = pre ? 'Get ready…' : c.kind === 'mvc' ? 'Push! Maximal effort' : 'Relax, stay still';
}

function render() {
  const el = root();
  const c = state.calib;
  const live = liveSensors();

  const capture = c
    ? h('div', { class: 'capture-box' },
        h('div', { class: 'countdown', id: 'calCountdown' }, ''),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: 650 } }, c.kind === 'mvc' ? 'MVC capture' : 'Rest baseline'),
          h('div', { class: 'muted', id: 'calPhase' }, '')),
        h('button', { class: 'btn small', onclick: cancel }, 'Cancel'))
    : null;

  fill(el,
    h('div', { class: 'section' },
      h('h2', {}, 'Rest baseline'),
      h('p', { class: 'muted' }, 'Seated, head neutral, eyes open, shoulders relaxed, no talking. Gives the rest level and the activity threshold (rest + ', String(ACTIVE_SD), ' SD) drawn as a dashed line.'),
      h('div', { class: 'btn-row' },
        h('label', { class: 'field inline' }, 'Duration',
          h('select', { onchange: (e) => { prefs.restSec = +e.target.value; } },
            [10, 15, 20, 30].map((v) => h('option', { value: v, selected: v === prefs.restSec }, v + ' s')))),
        h('button', { class: 'btn primary', disabled: !!c || !live.length, onclick: () => begin('rest', live) }, 'Record rest (all sensors)')),
      c?.kind === 'rest' ? capture : null,
    ),

    h('div', { class: 'section' },
      h('h2', {}, 'MVC (optional)'),
      h('div', { class: 'callout' }, 'Only if clinically appropriate for this patient. Without MVC, use ', h('b', {}, '× Rest'), ' or ', h('b', {}, 'Raw'), ' units. Repeat up to 3 times per muscle; the highest 1 s mean is kept.'),
      h('div', { class: 'btn-row', style: { margin: '10px 0' } },
        h('label', { class: 'field inline' }, 'Hold',
          h('select', { onchange: (e) => { prefs.mvcSec = +e.target.value; } },
            [3, 5, 7].map((v) => h('option', { value: v, selected: v === prefs.mvcSec }, v + ' s')))),
        h('button', { class: 'btn', disabled: !!c || !live.length, onclick: () => begin('mvc', live) }, 'Capture MVC (all sensors)')),
      c?.kind === 'mvc' ? capture : null,
    ),

    h('div', { class: 'section' },
      h('h2', {}, 'Calibration values'),
      state.sensors.length ? h('table', { class: 'cal-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Sensor'), h('th', {}, 'Rest (mean ± SD)'), h('th', {}, 'Threshold'), h('th', {}, 'MVC'), h('th', {}))),
        h('tbody', {}, state.sensors.map((s) => h('tr', {},
          h('td', {}, h('span', { class: 'swatch', style: { background: seriesVar(s) } }), `${sensorLabel(s)} · ${s.name}`),
          h('td', { class: 'num' }, s.calib.restMean != null ? `${fmtNum(s.calib.restMean, 1)} ± ${fmtNum(s.calib.restSd, 1)}` : '–'),
          h('td', { class: 'num' }, s.calib.restMean != null ? fmtNum(s.calib.restMean + ACTIVE_SD * s.calib.restSd, 1) : '–'),
          h('td', { class: 'num', title: (s.calib.mvcTrials || []).map((v) => fmtNum(v, 0)).join(', ') },
            s.calib.mvc != null ? `${fmtNum(s.calib.mvc, 0)} (${s.calib.mvcTrials.length}×)` : '–'),
          h('td', {}, h('button', { class: 'btn small', disabled: !!c || s.status !== 'live', onclick: () => begin('mvc', [s]) }, 'MVC'),
            ' ',
            h('button', { class: 'btn small ghost', title: 'Clear this sensor’s calibration', onclick: () => { s.calib = { restMean: null, restSd: null, restN: 0, mvc: null }; emit('calib'); render(); } }, 'Reset')),
        )))) : h('p', { class: 'muted' }, 'Connect sensors first.'),
      state.sensors.length ? h('div', { style: { marginTop: '12px' } },
        h('h3', {}, 'Suggested MVC manoeuvres'),
        [...new Set(state.sensors.map((s) => s.site))].map((k) =>
          h('p', { class: 'tiny' }, h('b', {}, siteByKey(k).short + ': '), siteByKey(k).mvc))) : null,
    ),
  );
  updateCountdown();
}

export function initCalib() {
  on('sensors', render);
  render();
}
