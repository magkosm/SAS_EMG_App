// Session lifecycle: logging samples/events, video recording, and file export.

import { state, clock, emit, on, sensorLabel } from './state.js';
import { STEPS } from './protocol.js';
import { cam, startRecording, stopRecording, isRecording, videoExtension } from './recorder.js';
import { csvRow, stamp, safeName, downloadBlob, toast } from './util.js';
import { ACTIVE_SD } from './processing.js';
import { dejitter } from './timing.js';
import { folder, ensureFolderPermission } from './folder.js';

export const APP_VERSION = '1.0.0';

// ---- Logging -------------------------------------------------------------

export function logEvent(type, detail = {}) {
  const ss = state.session;
  if (!ss?.active) return;
  ss.events.push({ t: clock() - ss.t0, type, ...detail });
}

function currentPhase(t) {
  const c = state.calib;
  if (c && t >= c.t0) return c.kind === 'mvc' ? 'calib_mvc' : 'calib_rest';
  if (state.protocol.attempt) return 'step';
  if (state.protocol.restUntil && t < state.protocol.restUntil) return 'rest';
  return '';
}

on('sample', ({ s, raw, sm, t }) => {
  const ss = state.session;
  if (!ss?.active) return;
  let d = ss.data[s.key];
  if (!d) d = ss.data[s.key] = { t: [], raw: [], sm: [], step: [], phase: [] };
  d.t.push(t - ss.t0);
  d.raw.push(raw);
  d.sm.push(sm);
  d.step.push(state.protocol.attempt ? STEPS[state.protocol.attempt.step].n : 0);
  d.phase.push(currentPhase(t));
});

// ---- Start / stop ----------------------------------------------------------

export async function startSession({ subject, recordVideo }) {
  const wallStart = new Date();
  const id = `${safeName(subject) || 'session'}_${stamp(wallStart)}`;
  const ss = {
    active: true,
    id,
    subject: subject || '',
    wallStart,
    t0: clock(),
    t1: null,
    data: {},
    events: [],
    sensorsSeen: {},
    video: null,
    dir: null,
    saved: false,
    files: {},          // name → Blob, when no folder is used
    autosave: null,
    notes: '',
  };

  if (folder.handle) {
    try {
      if (await ensureFolderPermission()) ss.dir = await folder.handle.getDirectoryHandle(id, { create: true });
      else toast('No permission for the save folder. Files will be offered as downloads.', 'bad');
    } catch (err) {
      toast('Save folder unavailable (' + err.message + '). Files will be offered as downloads.', 'bad');
    }
  }

  state.session = ss;
  rememberSensors(ss);

  if (recordVideo && cam.stream) {
    try {
      const fileName = `video.${videoExtension()}`;
      let writable = null;
      if (ss.dir) writable = await (await ss.dir.getFileHandle(fileName, { create: true })).createWritable();
      const startedAt = await startRecording(writable);
      ss.video = { file: fileName, mime: cam.mime, startOffset: startedAt - ss.t0, toDisk: !!writable };
    } catch (err) {
      toast('Video recording failed to start: ' + err.message, 'bad', 8000);
    }
  }

  ss.events.unshift({ t: 0, type: 'session_start', detail: id });
  if (ss.video) ss.events.push({ t: ss.video.startOffset, type: 'video_start', detail: ss.video.file });

  if (ss.dir) {
    ss.autosave = setInterval(() => {
      if (!ss.autosaving) ss.autosaving = writeDataFiles(ss).catch(() => {}).finally(() => { ss.autosaving = null; });
    }, 30000);
  }
  emit('session');
  return ss;
}

function rememberSensors(ss) {
  for (const s of state.sensors) {
    ss.sensorsSeen[s.key] = {
      key: s.key, name: s.name, site: s.site, siteShort: s.siteShort, side: s.side, label: sensorLabel(s),
      led: s.led, colorIdx: s.colorIdx, deviceName: s.bleName, deviceId: s.deviceId, simulated: s.sim,
      info: s.info, battery: s.battery, calib: { ...s.calib },
    };
  }
}

export async function stopSession() {
  const ss = state.session;
  if (!ss?.active) return;
  logEvent('session_end');
  ss.t1 = clock();
  ss.active = false;
  clearInterval(ss.autosave);
  await ss.autosaving;
  rememberSensors(ss);
  emit('session');

  let videoBlob = null;
  if (isRecording()) {
    toast('Finishing video file…');
    videoBlob = await stopRecording();
    if (ss.video) ss.video.bytes = cam.bytes;
    if (cam.error) toast('Video write problem: ' + cam.error.message, 'bad', 9000);
  }
  if (videoBlob && ss.video) {
    if (ss.dir && !ss.video.toDisk) await writeFile(ss.dir, ss.video.file, videoBlob).catch(() => { ss.files[ss.video.file] = videoBlob; });
    else if (!ss.dir) ss.files[ss.video.file] = videoBlob;
  }

  if (ss.dir) {
    try {
      await writeDataFiles(ss);
      ss.saved = true;
      toast(`Saved to folder “${folder.name}/${ss.id}”`);
    } catch (err) {
      toast('Saving to folder failed: ' + err.message + '. Use the download buttons in Results.', 'bad', 9000);
      Object.assign(ss.files, buildDataFiles(ss));
    }
  } else {
    Object.assign(ss.files, buildDataFiles(ss));
  }
  emit('session');
}

// ---- Files -------------------------------------------------------------------

async function writeFile(dir, name, data) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function writeDataFiles(ss) {
  rememberSensors(ss);
  const files = buildDataFiles(ss);
  for (const [name, blob] of Object.entries(files)) await writeFile(ss.dir, name, blob);
}

export function sessionAttempts(ss = state.session) {
  return state.protocol.attempts.filter((a) => a.sessionId === ss?.id);
}

function sensorCols(ss) {
  return Object.values(ss.sensorsSeen);
}

function colName(si) {
  return safeName(`${si.siteShort}_${si.side || ''}_${si.name}`).replace(/_+/g, '_');
}

export function buildDataFiles(ss) {
  const csv = (rows) => new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  const vOff = ss.video?.startOffset;
  const vt = (t) => (vOff != null ? t - vOff : null);
  const sensors = sensorCols(ss);
  const files = {};

  // Cleaned timestamps: the sensor's steady 100 ms rhythm recovered from the arrival times (timing.js).
  const tc = {};
  ss.timing = {};
  for (const si of sensors) {
    const d = ss.data[si.key];
    if (!d) continue;
    const dj = dejitter(d.t);
    tc[si.key] = dj;
    ss.timing[si.key] = dj.quality;
  }

  // Long format: one row per received sample.
  const long = [csvRow(['t_s', 'video_t_s', 't_arrival_s', 'seq', 'lost_before', 'sensor_key', 'sensor_name', 'site', 'side', 'raw', 'smoothed', 'step', 'phase'])];
  for (const si of sensors) {
    const d = ss.data[si.key];
    if (!d) continue;
    const dj = tc[si.key];
    for (let i = 0; i < d.t.length; i++) {
      const t = dj.t[i];
      long.push(csvRow([t, vt(t), d.t[i], dj.seq[i], dj.lostBefore[i], si.key, si.name, si.siteShort, si.side, d.raw[i], d.sm[i], d.step[i] || '', d.phase[i]]));
    }
  }
  files['samples_long.csv'] = csv(long);

  // Wide format resampled to a 10 Hz grid (last sample within 150 ms, else blank).
  const end = ((ss.t1 ?? clock()) - ss.t0);
  const keys = sensors.filter((si) => ss.data[si.key]);
  const wide = [csvRow(['t_s', 'video_t_s', 'step', 'phase', ...keys.map((si) => colName(si) + '_raw'), ...keys.map((si) => colName(si) + '_smoothed')])];
  const ptr = Object.fromEntries(keys.map((si) => [si.key, 0]));
  for (let g = 0; g <= end + 1e-9; g = Math.round((g + 0.1) * 10) / 10) {
    const raws = [], sms = [];
    let step = '', phase = '';
    for (const si of keys) {
      const d = ss.data[si.key];
      const ct = tc[si.key].t;
      let p = ptr[si.key];
      while (p + 1 < ct.length && ct[p + 1] <= g) p++;
      ptr[si.key] = p;
      if (ct[p] <= g && g - ct[p] < 0.15) {
        raws.push(d.raw[p]); sms.push(d.sm[p]);
        step ||= d.step[p] || ''; phase ||= d.phase[p];
      } else { raws.push(null); sms.push(null); }
    }
    wide.push(csvRow([g, vt(g), step, phase, ...raws, ...sms]));
  }
  files['samples_wide_10Hz.csv'] = csv(wide);

  // Events.
  const ev = [csvRow(['t_s', 'video_t_s', 'type', 'step', 'rep', 'sensor', 'detail'])];
  for (const e of ss.events) ev.push(csvRow([e.t, vt(e.t), e.type, e.step ?? '', e.rep ?? '', e.sensor ?? '', e.detail ?? '']));
  files['events.csv'] = csv(ev);

  // Per-step summary.
  const att = sessionAttempts(ss);
  const metricCols = ['mean_raw', 'peak_raw', 'mean_pctMVC', 'peak_pctMVC', 'mean_xRest', 'pct_active'];
  const sum = [csvRow(['step', 'title', 'attempt', 'superseded', 'start_s', 'end_s', 'duration_s', 'video_start_s', 'reps_target', 'reps_counted', 'symptom_0_10', 'note',
    ...sensors.flatMap((si) => metricCols.map((m) => `${colName(si)}_${m}`))])];
  for (const a of att) {
    const st = STEPS[a.step];
    const t0 = a.t0 - ss.t0, t1 = a.t1 - ss.t0;
    sum.push(csvRow([st.n, st.title, a.attemptNo, a.superseded ? 'yes' : '', t0, t1, t1 - t0, vt(t0), st.reps, a.reps, a.symptom ?? '', a.note || '',
      ...sensors.flatMap((si) => {
        const x = a.stats[si.key];
        return x ? [x.mean, x.peak, x.meanMvc, x.peakMvc, x.meanRest, x.pctActive] : metricCols.map(() => null);
      })]));
  }
  files['step_summary.csv'] = csv(sum);

  // Metadata.
  const meta = {
    app: 'M40 Neck EMG Logger', version: APP_VERSION,
    session: ss.id, subject: ss.subject, notes: ss.notes,
    started: ss.wallStart.toISOString(),
    duration_s: end,
    timebase: 't_s = seconds since session start (browser monotonic clock), cleaned of Bluetooth delivery jitter; t_arrival_s = when the packet reached the browser; video_t_s = t_s − video.startOffset_s',
    device: 'ANR M40 Muscle Sense, EMG level 0–1000 (0.1 % full scale), ~10 Hz notifications',
    processing: {
      smoothing: `moving average, ${state.smoothN} samples (${(state.smoothN / 10).toFixed(1)} s)`,
      rest: `mean and SD of the rest capture after dropping the top 5 %; active threshold = mean + ${ACTIVE_SD} SD`,
      mvc: 'highest 1 s moving average during the MVC capture(s); %MVC = level / MVC × 100',
      peak: 'maximum of the smoothed signal within the step',
      timing: 'Each sensor sends every ~100 ms on its own clock. t_s = fitted send time (interval incl. clock drift, aligned to the least-delayed packets); seq numbers the sensor\'s intervals; lost_before = samples that never arrived just before this one.',
    },
    timing: Object.fromEntries(Object.entries(ss.timing).map(([k, q]) => [k, roundQuality(q)])),
    video: ss.video ? { file: ss.video.file, mime: ss.video.mime, startOffset_s: ss.video.startOffset, bytes: ss.video.bytes ?? cam.bytes } : null,
    sensors,
    steps: att.map((a) => ({
      step: STEPS[a.step].n, title: STEPS[a.step].title, attempt: a.attemptNo, superseded: !!a.superseded,
      start_s: a.t0 - ss.t0, end_s: a.t1 - ss.t0, reps_target: STEPS[a.step].reps, reps: a.reps,
      rep_times_s: a.repTimes.map((t) => +(t - ss.t0).toFixed(3)), symptom: a.symptom, note: a.note, stats: a.stats,
    })),
    calibration: state.calibBands.filter((b) => b.t0 >= ss.t0).map((b) => ({ kind: b.kind, start_s: b.t0 - ss.t0, end_s: b.t1 - ss.t0, sensors: b.keys })),
  };
  files['session.json'] = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
  return files;
}

function roundQuality(q) {
  const r = (v, d) => (v == null || !isFinite(v) ? null : +v.toFixed(d));
  return {
    samples: q.samples, lost: q.lost, lost_pct: r(q.lostPct, 2), rate_hz: r(q.rateHz, 5), interval_ms: r(q.intervalMs, 4),
    delay_median_ms: r(q.delayMedianMs, 1), delay_p95_ms: r(q.delayP95Ms, 1), delay_max_ms: r(q.delayMaxMs, 1),
    max_gap_s: r(q.maxGapS, 2), segments: q.segments,
  };
}

export function downloadSessionFile(name) {
  const ss = state.session;
  const blob = ss?.files[name];
  if (blob) downloadBlob(blob, `${ss.id}_${name}`);
}
