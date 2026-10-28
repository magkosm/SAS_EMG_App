// Entry point: wires the Record/Replay modes, tabs, the session button, live-view controls and keyboard shortcuts.

import { state, on, emit, clock } from './state.js';
import { initLive, refreshColors } from './live.js';
import { initSetup, camPrefs } from './ui-setup.js';
import { initCalib } from './ui-calib.js';
import { initProtocol, startStep, finishStep, addRep, nextStep, prevStep } from './ui-protocol.js';
import { initResults } from './ui-results.js';
import { startSession, stopSession } from './session.js';
import { restoreFolder } from './folder.js';
import { startBatteryPolling } from './sensors.js';
import { cam, isRecording } from './recorder.js';
import { initReplay, onReplayShown, refreshReplayColors, openRecordedSession, seekTo, getSessionForAnalysis } from './replay.js';
import { initAnalysis, onAnalysisShown } from './ui-analysis.js';
import { $, fmtClock, toast } from './util.js';

// ---- Record / Replay ------------------------------------------------------------
function setView(view) {
  state.view = view;
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#recordView').hidden = view !== 'record';
  if (view === 'replay') onReplayShown();
  else { $('#replayView').hidden = true; $('#replayEmpty').hidden = true; }
  if (view === 'analysis') onAnalysisShown();
  else { $('#analysisView').hidden = true; $('#analysisEmpty').hidden = true; }
  history.replaceState(null, '', view === 'record' ? location.pathname : '#' + view);
  emit('view', view);
}
document.querySelectorAll('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
on('openReplay', async (ss) => {
  setView('replay');
  await openRecordedSession(ss);
});
on('openAnalysis', async (ss) => {
  if (getSessionForAnalysis()?.id !== ss.id) await openRecordedSession(ss);
  setView('analysis');
});
on('setView', (v) => setView(v));
// Analysis → Replay at a moment (click on a burst raster or a cluster window).
on('replayAt', (t) => { setView('replay'); seekTo(t); });

// ---- Tabs -------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach((el) => { el.hidden = el.id !== 'tab-' + name; });
  state.activeTab = name;
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Session button ---------------------------------------------------------------
const btnSession = $('#btnSession');
let busy = false;
btnSession.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    if (state.session?.active) {
      if (!confirm('Stop the session and save all files?')) return;
      if (state.protocol.attempt) finishStep();
      btnSession.disabled = true;
      btnSession.textContent = 'Saving…';
      await stopSession();
      showTab('results');
    } else {
      if (!state.sensors.length && !confirm('No sensors are connected. Start anyway?')) return;
      if (camPrefs.record && !cam.stream && !confirm('Camera is off, so no video will be recorded. Start anyway?')) return;
      const subject = $('#subject').value.trim();
      await startSession({ subject, recordVideo: camPrefs.record });
      showTab('protocol');
    }
  } catch (err) {
    toast(err.message, 'bad', 8000);
  } finally {
    busy = false;
    btnSession.disabled = false;
    syncSessionUi();
  }
});

function syncSessionUi() {
  const active = !!state.session?.active;
  btnSession.textContent = active ? '■ Stop & save' : 'Start session';
  btnSession.classList.toggle('primary', !active);
  btnSession.classList.toggle('danger', active);
  $('#subject').disabled = active;
  $('#sessionClock').classList.toggle('on', active);
  $('#recBadge').hidden = !active;
}
on('session', syncSessionUi);

setInterval(() => {
  const ss = state.session;
  $('#sessionClock').textContent = ss?.active ? fmtClock(clock() - ss.t0) : ss ? fmtClock(ss.t1 - ss.t0) : '--:--';
  if (ss?.active) $('#recText').textContent = isRecording() ? 'REC video + EMG' : 'REC EMG only';
}, 250);

// ---- Live-view controls -------------------------------------------------------------
$('#segMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  state.displayMode = b.dataset.mode;
  document.querySelectorAll('#segMode button').forEach((x) => x.classList.toggle('active', x === b));
  const missing = state.sensors.filter((s) => (b.dataset.mode === 'mvc' && !(s.calib.mvc > 0)) || (b.dataset.mode === 'rest' && !(s.calib.restMean > 0)));
  if (missing.length && b.dataset.mode !== 'raw') toast(`${missing.length} sensor(s) not calibrated for this unit yet; they stay in raw.`);
  emit('display');
});
$('#selWindow').addEventListener('change', (e) => { state.windowSec = +e.target.value; });
$('#selSmooth').addEventListener('change', (e) => { state.smoothN = +e.target.value; });
$('#chkAuto').addEventListener('change', (e) => { state.autoScale = e.target.checked; });
$('#btnPause').addEventListener('click', (e) => {
  state.pausedAt = state.pausedAt ? null : clock();
  e.target.textContent = state.pausedAt ? 'Resume view' : 'Pause view';
  e.target.classList.toggle('primary', !!state.pausedAt);
});

// ---- Theme --------------------------------------------------------------------------------
const THEME_KEY = 'm40logger.theme';
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  refreshColors();
  refreshReplayColors();
  emit('theme');
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage blocked */ }
$('#btnTheme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const t = dark ? 'light' : 'dark';
  applyTheme(t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked */ }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { refreshColors(); refreshReplayColors(); });

// ---- Keyboard (protocol tab) ---------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (state.view !== 'record' || state.activeTab !== 'protocol' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const running = !!state.protocol.attempt;
  if (e.code === 'Space') { e.preventDefault(); if (running) addRep(1); }
  else if (e.code === 'Backspace') { e.preventDefault(); if (running) addRep(-1); }
  else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); running ? finishStep() : startStep(); }
  else if (e.code === 'ArrowRight' && !running) { e.preventDefault(); nextStep(); }
  else if (e.code === 'ArrowLeft' && !running) { e.preventDefault(); prevStep(); }
});
// Buttons keep focus after a click; drop it so Space/Enter don't re-trigger the last button.
document.addEventListener('click', (e) => {
  if (state.activeTab === 'protocol' && e.target.closest('#tab-protocol button')) e.target.closest('button').blur();
});

window.addEventListener('beforeunload', (e) => {
  if (state.session?.active) { e.preventDefault(); e.returnValue = ''; }
});

// ---- Boot --------------------------------------------------------------------------------------
initLive();
initSetup();
initCalib();
initProtocol();
initResults();
initReplay();
initAnalysis();
startBatteryPolling();
syncSessionUi();
showTab('setup');
setView(location.hash === '#replay' ? 'replay' : location.hash === '#analysis' ? 'analysis' : 'record');
window.__appReady = true;
// Remembered save folder: restored in the background so the UI is usable immediately.
restoreFolder().then(() => emit('folder'));
