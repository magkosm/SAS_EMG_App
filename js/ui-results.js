// Tab 4: per-step summary heatmap, session notes and file export.

import { state, on, emit, seriesVar, sensorLabel } from './state.js';
import { STEPS } from './protocol.js';
import { unitFor, statIn, UNIT_LABEL, UNIT_DIGITS } from './processing.js';
import { sessionAttempts, buildDataFiles, downloadSessionFile } from './session.js';
import { folder } from './folder.js';
import { canShareFiles, shareFiles } from './platform.js';
import { h, $, fmtClock, fmtNum, downloadBlob, fill, toast } from './util.js';

const root = () => $('#tab-results');
const prefs = { metric: 'mean' };

// Sequential blue ramp (light → dark), used for "how high relative to this sensor's highest step".
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
function rampColor(f) {
  const i = Math.max(0, Math.min(RAMP.length - 1, Math.round(f * (RAMP.length - 1))));
  return { bg: RAMP[i], fg: i >= 7 ? '#ffffff' : '#0b0b0b' };
}

function heatmap(ss) {
  const att = sessionAttempts(ss).filter((a) => !a.superseded);
  if (!att.length) return h('p', { class: 'muted' }, 'No finished steps yet. Results appear here after each step.');
  const sensors = state.sensors.filter((s) => att.some((a) => a.stats[s.key]));
  const byStep = new Map(att.map((a) => [a.step, a]));
  const cell = (a, s) => {
    const u = prefs.metric === 'pctActive' ? 'pct' : unitFor(s);
    return statIn(a?.stats[s.key], prefs.metric, u === 'pct' ? 'raw' : u);
  };
  const colMax = Object.fromEntries(sensors.map((s) => [s.key, Math.max(1e-9, ...att.map((a) => cell(a, s) ?? 0))]));

  const unitNote = prefs.metric === 'pctActive'
    ? '% of samples above rest + 3 SD'
    : sensors.map((s) => `${sensorLabel(s)}: ${unitFor(s) === 'raw' ? 'raw' : UNIT_LABEL[unitFor(s)]}`).join(' · ');

  return h('div', {},
    h('table', { class: 'heat' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'l' }, 'Step'),
        sensors.map((s) => h('th', {}, h('span', { class: 'swatch', style: { background: seriesVar(s) } }), h('br'), sensorLabel(s))),
        h('th', {}, 'Reps'), h('th', {}, 'Time'), h('th', {}, 'Sx'))),
      h('tbody', {}, STEPS.map((st, i) => {
        const a = byStep.get(i);
        return h('tr', {},
          h('td', { class: 'l', title: st.title }, `${st.n}. ${st.title}`),
          sensors.map((s) => {
            const v = a ? cell(a, s) : null;
            if (v == null) return h('td', { class: 'empty' }, '·');
            const c = rampColor(v / colMax[s.key]);
            const digits = prefs.metric === 'pctActive' ? 0 : UNIT_DIGITS[unitFor(s)];
            return h('td', { style: { background: c.bg, color: c.fg }, title: `${sensorLabel(s)} · step ${st.n}: ${fmtNum(v, 2)}` }, fmtNum(v, digits));
          }),
          h('td', { class: a ? '' : 'empty' }, a ? `${a.reps}/${st.reps}` : '·'),
          h('td', { class: a ? '' : 'empty' }, a ? fmtClock(a.t1 - a.t0) : '·'),
          h('td', { class: a?.symptom != null ? '' : 'empty' }, a?.symptom ?? '·'));
      }))),
    h('div', { class: 'legend-ramp' }, 'low', h('span', { class: 'r' }), 'high · shading is per sensor column (relative to that sensor’s highest step)'),
    h('p', { class: 'tiny', style: { marginTop: '4px' } }, 'Units: ', unitNote, '. Sx = symptom rating 0–10.'),
  );
}

function files(ss) {
  if (!ss) return h('p', { class: 'muted' }, 'No session yet.');
  if (ss.active) {
    return h('div', {},
      h('p', { class: 'muted' }, ss.dir
        ? ['Recording to ', h('b', {}, `${folder.name}/${ss.id}`), '. Data files autosave every 30 s; the video file is finalised when you stop.']
        : 'Recording in this browser. Data is backed up here every 30 s; stop the session to share or download the files.'),
      h('button', { class: 'btn small', onclick: () => {
        const f = buildDataFiles(ss);
        downloadBlob(f['samples_long.csv'], `${ss.id}_samples_long_partial.csv`);
      } }, 'Download data so far'));
  }
  const names = Object.keys(ss.files);
  const asFiles = () => names.map((n) => new File([ss.files[n]], `${ss.id}_${n}`, { type: ss.files[n].type }));
  const shareable = names.length && canShareFiles(asFiles());
  return h('div', {},
    ss.saved ? h('div', { class: 'callout' }, '✓ Saved to ', h('b', {}, `${folder.name}/${ss.id}/`)) : null,
    ss.storedInBrowser ? h('div', { class: 'callout' }, '✓ Kept in this browser on this device. It stays listed in Replay and Analysis until you delete it there.') : null,
    shareable ? h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('button', { class: 'btn primary', onclick: () => shareFiles(asFiles(), ss.id).catch((e) => toast('Share failed: ' + e.message, 'bad')) }, '⇪ Share / Save to Files…'),
      h('span', { class: 'tiny' }, 'All files at once: Save to Files, AirDrop, Mail…')) : null,
    h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('button', { class: 'btn primary', onclick: () => emit('openReplay', ss) }, '▶ Replay this session'),
      h('button', { class: 'btn', onclick: () => emit('openAnalysis', ss) }, '◧ Analyse this session')),
    names.length ? h('div', { style: { marginTop: '8px' } },
      h('p', { class: 'muted' }, ss.saved ? 'Also available here:' : 'Download each file:'),
      h('div', { class: 'btn-row' },
        names.map((n) => h('button', { class: 'btn small', onclick: () => downloadSessionFile(n) }, n)),
        h('button', { class: 'btn small primary', onclick: () => names.forEach((n, i) => setTimeout(() => downloadSessionFile(n), i * 400)) }, 'Download all'))) : null,
    h('details', { class: 'guide', style: { marginTop: '10px' } },
      h('summary', {}, 'What is in each file'),
      h('ul', {},
        h('li', {}, h('b', {}, 'video.mp4/webm'), ': camera recording; starts at video.startOffset_s in session.json.'),
        h('li', {}, h('b', {}, 'samples_long.csv'), ': every received sample (t_s, video_t_s, sensor, raw, smoothed, step, phase).'),
        h('li', {}, h('b', {}, 'samples_wide_10Hz.csv'), ': one row per 0.1 s, one column per sensor.'),
        h('li', {}, h('b', {}, 'events.csv'), ': session, calibration, step start/end, each counted rep, notes, sensor dropouts.'),
        h('li', {}, h('b', {}, 'step_summary.csv'), ': per step and sensor: mean, peak, %MVC, × rest, % active.'),
        h('li', {}, h('b', {}, 'session.json'), ': sensors (name, site, side, serial), calibration, processing settings, rep times.'))),
  );
}

// Per-sensor timing quality from the cleaned timestamps (timing.js), after the session stops.
function quality(ss) {
  const rows = Object.values(ss.sensorsSeen).filter((si) => ss.timing?.[si.key]?.samples);
  if (!rows.length) return null;
  const flag = (q) => (q.lostPct > 2 ? '⚠ ' : '');
  return h('div', { class: 'section' },
    h('h2', {}, 'Data quality'),
    h('table', { class: 'cal-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Sensor'), h('th', {}, 'Rate'), h('th', {}, 'Samples'), h('th', {}, 'Lost'), h('th', {}, 'Delay p95'), h('th', {}, 'Dropouts'))),
      h('tbody', {}, rows.map((si) => {
        const q = ss.timing[si.key];
        return h('tr', {},
          h('td', {}, h('span', { class: 'swatch', style: { background: `var(--s${si.colorIdx + 1})` } }), si.label),
          h('td', { class: 'num' }, `${fmtNum(q.rateHz, 3)} Hz`),
          h('td', { class: 'num' }, q.samples),
          h('td', { class: 'num' }, `${flag(q)}${q.lost} (${fmtNum(q.lostPct, 1)} %)`),
          h('td', { class: 'num', title: 'Bluetooth delivery delay removed from the timestamps (relative to the fastest packets)' }, `${fmtNum(q.delayP95Ms, 0)} ms`),
          h('td', { class: 'num', title: 'Gaps longer than 2 s (reconnects)' }, q.segments - 1));
      }))),
    h('p', { class: 'tiny', style: { marginTop: '6px' } },
      'Timestamps in the files are cleaned: each sample sits on the sensor’s own 100 ms rhythm, so Bluetooth delivery delay no longer blurs timing. ',
      'Lost = samples the sensor sent that never arrived (marked as lost_before in samples_long.csv).'),
  );
}

function render() {
  const el = root();
  const ss = state.session;
  fill(el,
    h('div', { class: 'section' },
      h('h2', {}, 'Per-step summary'),
      h('div', { class: 'seg', role: 'group', style: { marginBottom: '10px' } },
        [['mean', 'Mean'], ['peak', 'Peak'], ['pctActive', '% active']].map(([k, l]) =>
          h('button', { class: prefs.metric === k ? 'active' : '', onclick: () => { prefs.metric = k; render(); } }, l))),
      ss ? heatmap(ss) : h('p', { class: 'muted' }, 'Start a session and run steps to see results.'),
    ),
    h('div', { class: 'section' },
      h('h2', {}, 'Session notes'),
      h('textarea', { rows: 3, style: { width: '100%' }, disabled: !ss, placeholder: 'Free text, saved in session.json',
        onchange: (e) => { if (ss) ss.notes = e.target.value; } }, ss?.notes || ''),
    ),
    ss && !ss.active ? quality(ss) : null,
    h('div', { class: 'section' }, h('h2', {}, 'Files'), files(ss)),
  );
}

export function initResults() {
  on('session', render);
  on('attempts', render);
  on('calib', render);
  on('display', render);
  render();
}
