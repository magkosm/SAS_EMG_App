// Shared app state, a tiny event bus and the app clock.

export const clock = () => performance.now() / 1000; // seconds, monotonic

export const state = {
  view: 'record',       // 'record' | 'replay'
  sensors: [],          // Sensor objects, in the order they were added
  displayMode: 'raw',   // 'raw' | 'mvc' | 'rest'
  smoothN: 5,           // moving-average length in samples (10 Hz → 0.5 s)
  windowSec: 30,
  autoScale: true,
  pausedAt: null,       // app-clock time the live view froze at, or null
  hoverT: null,         // app-clock time under the mouse, or null
  session: null,        // active or last finished session (see session.js)
  protocol: {
    index: 0,           // selected step (0-based)
    attempt: null,      // running attempt { step, t0, reps, repTimes }
    attempts: [],       // finished attempts (all sessions this page load)
    restUntil: null,    // app-clock end of the between-step rest countdown
    interRestUntil: null,
  },
  calib: null,          // running capture { kind, keys, t0, t1 }
  calibBands: [],       // finished captures, for shading the live view
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach((fn) => fn(data));
}

const SLOT_COUNT = 8;
export function nextColorSlot() {
  const used = new Set(state.sensors.map((s) => s.colorIdx));
  for (let i = 0; i < SLOT_COUNT; i++) if (!used.has(i)) return i;
  return state.sensors.length % SLOT_COUNT;
}
export const seriesVar = (s) => `var(--s${s.colorIdx + 1})`;

export function sensorLabel(s) {
  const site = s.site === 'OTHER' ? 'Other' : s.siteShort;
  return `${site}${s.side ? ' ' + s.side : ''}`;
}
