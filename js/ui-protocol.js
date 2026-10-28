// Tab 3: the 15-step protocol. Start/finish each step, count reps, rest timers, metronome,
// quick per-step stats and a symptom rating.

import { state, on, emit, clock, seriesVar, sensorLabel } from './state.js';
import { STEPS } from './protocol.js';
import { windowStats, unitFor, statIn, UNIT_LABEL, UNIT_DIGITS } from './processing.js';
import { logEvent, sessionAttempts } from './session.js';
import { h, $, fmtClock, fmtNum, beep, toast, fill } from './util.js';

const root = () => $('#tab-protocol');
const prefs = { restSec: 30, metronome: false, metroSec: 1.0, beepReps: true };
let metroTimer = null;
let lastFinished = null;
let attemptSeq = 0;

const P = () => state.protocol;

function doneSteps() {
  const set = new Set();
  for (const a of sessionAttempts()) if (!a.superseded) set.add(a.step);
  return set;
}

// ---- Actions ---------------------------------------------------------------

export function startStep() {
  const p = P();
  if (p.attempt) return;
  if (!state.session?.active) { toast('Start the session first (button top right).', 'bad'); return; }
  if (state.calib) { toast('Wait for the calibration capture to finish.', 'bad'); return; }
  if (!state.sensors.some((s) => s.status === 'live')) toast('No live sensors. Recording anyway.', 'bad');
  const n = STEPS[p.index].n;
  p.attempt = { id: ++attemptSeq, step: p.index, t0: clock(), reps: 0, repTimes: [], sessionId: state.session.id };
  p.restUntil = null;
  p.interRestUntil = null;
  lastFinished = null;
  logEvent('step_start', { step: n });
  beep(1046, 0.12);
  if (prefs.metronome) startMetronome();
  render();
}

export function addRep(delta = 1) {
  const a = P().attempt;
  if (!a) return;
  const st = STEPS[a.step];
  if (delta > 0) {
    a.reps++;
    a.repTimes.push(clock());
    logEvent('rep', { step: st.n, rep: a.reps });
    if (st.interRepRest) P().interRestUntil = clock() + st.interRepRest;
    if (a.reps === st.reps) { beep(1318, 0.1); setTimeout(() => beep(1568, 0.14), 140); }
    else if (prefs.beepReps) beep(740, 0.05, 0.08);
  } else if (a.reps > 0) {
    a.reps--;
    a.repTimes.pop();
    logEvent('rep_undo', { step: st.n, rep: a.reps });
  }
  updateLive();
}

export function finishStep() {
  const p = P();
  const a = p.attempt;
  if (!a) return;
  stopMetronome();
  a.t1 = clock();
  const ss = state.session;
  const st = STEPS[a.step];
  a.attemptNo = sessionAttempts().filter((x) => x.step === a.step).length + 1;
  // Earlier attempts of the same step become superseded.
  for (const x of sessionAttempts()) if (x.step === a.step) x.superseded = true;
  a.stats = {};
  for (const s of state.sensors) {
    const d = ss?.data[s.key];
    a.stats[s.key] = d ? windowStats(s, d, a.t0 - ss.t0, a.t1 - ss.t0) : windowStats(s, s.buf, a.t0, a.t1);
  }
  a.symptom = null;
  a.note = '';
  p.attempts.push(a);
  p.attempt = null;
  p.interRestUntil = null;
  logEvent('step_end', { step: st.n, rep: a.reps, detail: `${fmtNum(a.t1 - a.t0, 1)} s` });
  beep(784, 0.15);
  lastFinished = a;

  // Move on to the next step that has not been done yet.
  const done = doneSteps();
  let next = a.step + 1;
  while (next < STEPS.length && done.has(next)) next++;
  if (next < STEPS.length) {
    p.index = next;
    if (prefs.restSec > 0) p.restUntil = clock() + prefs.restSec;
  } else {
    toast('All 15 steps done. Stop the session (top right) to save.');
  }
  emit('attempts');
  render();
}

export function abortStep() {
  const p = P();
  if (!p.attempt) return;
  if (!confirm('Discard this step attempt? (Data stays in the raw log, marked as aborted.)')) return;
  logEvent('step_abort', { step: STEPS[p.attempt.step].n });
  stopMetronome();
  p.attempt = null;
  p.interRestUntil = null;
  render();
}

function select(i) {
  const p = P();
  if (p.attempt) { toast('Finish or discard the running step first.'); return; }
  p.index = Math.max(0, Math.min(STEPS.length - 1, i));
  p.restUntil = null;
  lastFinished = null;
  render();
}
export const nextStep = () => select(P().index + 1);
export const prevStep = () => select(P().index - 1);

function startMetronome() {
  stopMetronome();
  metroTimer = setInterval(() => beep(1200, 0.03, 0.12), prefs.metroSec * 1000);
}
function stopMetronome() { clearInterval(metroTimer); metroTimer = null; }

// ---- Rendering ----------------------------------------------------------------------

function stepList() {
  const p = P();
  const done = doneSteps();
  return h('ol', { class: 'step-list' }, STEPS.map((st, i) => {
    const running = p.attempt?.step === i;
    return h('li', { class: [i === p.index ? 'current' : '', running ? 'running' : ''].join(' '), onclick: () => select(i) },
      h('span', { class: 'n' }, st.n),
      h('span', {}, st.title),
      h('span', { class: 'r' }, `${st.reps}×`),
      h('span', { class: 'st', title: running ? 'running' : done.has(i) ? 'done' : '' }, running ? '●' : done.has(i) ? '✓' : ''));
  }));
}

function miniStats(a) {
  const rows = state.sensors.filter((s) => a.stats[s.key]);
  if (!rows.length) return h('p', { class: 'tiny' }, 'No sensor data in this step.');
  return h('table', { class: 'mini-stats' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Sensor'), h('th', {}, 'Mean'), h('th', {}, 'Peak'), h('th', {}, '% active'))),
    h('tbody', {}, rows.map((s) => {
      const x = a.stats[s.key];
      const u = unitFor(s);
      const f = (v) => fmtNum(v, UNIT_DIGITS[u]) + (u === 'raw' ? '' : ' ' + UNIT_LABEL[u]);
      return h('tr', {},
        h('td', {}, h('span', { class: 'swatch', style: { background: seriesVar(s) } }), sensorLabel(s)),
        h('td', {}, f(statIn(x, 'mean', u))),
        h('td', {}, f(statIn(x, 'peak', u))),
        h('td', {}, x.pctActive != null ? fmtNum(x.pctActive, 0) + ' %' : '–'));
    })));
}

function afterStep(a) {
  const st = STEPS[a.step];
  return h('div', { class: 'after-step' },
    h('h3', {}, `Step ${st.n} done · ${a.reps}/${st.reps} reps · ${fmtClock(a.t1 - a.t0)}`),
    miniStats(a),
    h('div', { class: 'field' }, 'Symptoms during the step (0 = none, 10 = worst), optional',
      h('div', { class: 'symptom' }, Array.from({ length: 11 }, (_, v) =>
        h('button', { class: 'btn' + (a.symptom === v ? ' sel' : ''), onclick: () => {
          a.symptom = a.symptom === v ? null : v;
          logEvent('symptom', { step: st.n, detail: a.symptom ?? 'cleared' });
          emit('attempts');
          render();
        } }, v)))),
    h('label', { class: 'field', style: { marginTop: '8px' } }, 'Note',
      h('textarea', { rows: 2, placeholder: 'e.g. dizziness, compensation, lost count…', onchange: (e) => { a.note = e.target.value; logEvent('note', { step: st.n, detail: a.note }); } }, a.note || '')),
    h('div', { class: 'btn-row', style: { marginTop: '8px' } },
      h('button', { class: 'btn small', onclick: () => { select(a.step); } }, `Redo step ${st.n}`)),
  );
}

function stepCard() {
  const p = P();
  const st = STEPS[p.index];
  const a = p.attempt;
  const running = !!a;
  const sessionOn = !!state.session?.active;

  return h('div', { class: 'step-card' },
    h('div', { class: 'step-kicker' }, `Step ${st.n} of ${STEPS.length} · ${st.reps} repetitions${st.head ? '' : ' · head still'}`),
    h('div', { class: 'step-title' }, st.title),
    h('div', { class: 'cue' }, h('span', { class: 'cue-label' }, 'Say to the patient'), st.cue),
    h('div', { class: 'setup-note' }, h('b', {}, 'Setup: '), st.setup),

    h('div', { class: 'rep-row' },
      h('div', { class: 'rep-count', id: 'repCount' }, ''),
      h('div', { class: 'rep-btns' },
        h('button', { class: 'btn', disabled: !running, title: 'Backspace', onclick: () => addRep(-1) }, '−'),
        h('button', { class: 'btn primary', disabled: !running, title: 'Space', onclick: () => addRep(1) }, '+')),
      h('div', { class: 'step-timer' }, h('div', { class: 'tiny' }, 'Step time'), h('div', { class: 't', id: 'stepTime' }, '0:00'))),
    h('div', { id: 'interRest' }),

    h('div', { class: 'step-actions' },
      running
        ? h('button', { class: 'btn danger big grow', onclick: finishStep }, '■ Finish step')
        : h('button', { class: 'btn primary big grow', disabled: !sessionOn, onclick: startStep }, `▶ Start step ${st.n}`),
      running ? h('button', { class: 'btn', onclick: abortStep }, 'Discard') : null,
      !running ? h('button', { class: 'btn', disabled: p.index === 0, onclick: prevStep }, '←') : null,
      !running ? h('button', { class: 'btn', disabled: p.index === STEPS.length - 1, onclick: nextStep }, '→') : null),
    !sessionOn ? h('p', { class: 'tiny', style: { marginTop: '6px' } }, 'Start the session (top right) to enable steps.') : null,

    p.restUntil ? h('div', { class: 'rest-banner' },
      h('div', { class: 'countdown', id: 'restLeft' }, ''),
      h('div', { style: { flex: 1 } }, h('b', {}, 'Rest'), h('div', { class: 'tiny' }, `then step ${st.n}`)),
      h('button', { class: 'btn small', onclick: () => { p.restUntil = null; render(); } }, 'Skip rest')) : null,

    lastFinished ? afterStep(lastFinished) : null,
  );
}

function render() {
  const el = root();
  const keepScroll = el.scrollTop;
  fill(el,
    h('div', { class: 'section' }, stepCard(),
      h('div', { class: 'shortcuts' },
        h('span', {}, h('kbd', {}, 'Enter'), ' start / finish'),
        h('span', {}, h('kbd', {}, 'Space'), ' +1 rep'),
        h('span', {}, h('kbd', {}, '⌫'), ' −1 rep'),
        h('span', {}, h('kbd', {}, '←'), h('kbd', {}, '→'), ' step'))),
    h('div', { class: 'section' },
      h('div', { class: 'btn-row' },
        h('label', { class: 'field inline' }, 'Rest between steps',
          h('select', { onchange: (e) => { prefs.restSec = +e.target.value; } },
            [0, 15, 30, 60, 90, 120].map((v) => h('option', { value: v, selected: v === prefs.restSec }, v ? v + ' s' : 'none')))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.beepReps, onchange: (e) => { prefs.beepReps = e.target.checked; } }), 'Beep on rep')),
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.metronome, onchange: (e) => {
          prefs.metronome = e.target.checked;
          if (P().attempt) prefs.metronome ? startMetronome() : stopMetronome();
        } }), 'Pacing metronome'),
        h('label', { class: 'field inline' }, 'every',
          h('select', { onchange: (e) => { prefs.metroSec = +e.target.value; if (metroTimer) startMetronome(); } },
            [0.5, 0.75, 1, 1.5, 2, 3].map((v) => h('option', { value: v, selected: v === prefs.metroSec }, v + ' s'))))),
    ),
    h('div', { class: 'section' }, h('h2', {}, 'Protocol'), stepList()),
  );
  el.scrollTop = keepScroll;
  updateLive();
}

function updateLive() {
  const p = P();
  const now = clock();
  const st = STEPS[p.index];
  const a = p.attempt;
  const rc = $('#repCount');
  if (rc) {
    const reps = a ? a.reps : 0;
    const txt = `${reps}<small> / ${st.reps}</small>`;
    if (rc.innerHTML !== txt) rc.innerHTML = txt;
    rc.classList.toggle('hit', !!a && reps >= st.reps);
  }
  const t = $('#stepTime');
  if (t) t.textContent = a ? fmtClock(now - a.t0) : '0:00';
  const ir = $('#interRest');
  if (ir) {
    const left = p.interRestUntil ? p.interRestUntil - now : 0;
    const txt = left > 0 ? `Rest ${Math.ceil(left)} s` : '';
    if (ir.textContent !== txt) ir.replaceChildren(txt ? h('span', { class: 'inter-rest' }, txt) : '');
    if (p.interRestUntil && left <= 0) { p.interRestUntil = null; beep(988, 0.08); }
  }
  const rl = $('#restLeft');
  if (rl && p.restUntil) {
    const left = p.restUntil - now;
    rl.textContent = fmtClock(left);
    if (left <= 0) { p.restUntil = null; beep(988, 0.1); setTimeout(() => beep(988, 0.1), 180); render(); }
  }
}

export function initProtocol() {
  on('session', render);
  setInterval(updateLive, 200);
  render();
}
