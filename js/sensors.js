// Sensor registry: wraps a link (real or simulated), keeps names/placement per device, polls battery.

import { state, emit, nextColorSlot, sensorLabel } from './state.js';
import { M40Link, pickM40, rememberedDevices } from './ble.js';
import { SimLink } from './sim.js';
import { siteByKey, LED_DEFAULT_ORDER, SITES } from './protocol.js';
import { ingest, newBuffers } from './processing.js';
import { toast } from './util.js';
import { logEvent } from './session.js';

const PROFILE_KEY = 'm40logger.profiles.v1';
let keySeq = 0;

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { return {}; }
}
function saveProfile(s) {
  if (s.sim) return;
  const all = loadProfiles();
  all[s.deviceId] = { name: s.name, site: s.site, side: s.side, led: s.led, bleName: s.bleName };
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
}

function defaultSite() {
  // Suggest the first site nobody uses yet: SCM, TRP upper, TRP ins.
  const used = new Set(state.sensors.map((s) => s.site));
  return (SITES.find((x) => x.key !== 'OTHER' && !used.has(x.key)) || SITES[0]).key;
}
function defaultLed() {
  const used = new Set(state.sensors.map((s) => s.led));
  return LED_DEFAULT_ORDER.find((n) => !used.has(n)) || 1;
}

function makeSensor(link) {
  const prof = link.sim ? null : loadProfiles()[link.id];
  const idx = state.sensors.length + 1;
  const site = prof?.site || defaultSite();
  const s = {
    key: 's' + ++keySeq,
    colorIdx: nextColorSlot(),
    link,
    sim: !!link.sim,
    deviceId: link.id,
    bleName: link.name,
    name: prof?.name || (link.sim ? `Sim ${idx}` : `Sensor ${idx}`),
    site,
    siteShort: siteByKey(site).short,
    side: prof?.side ?? 'R',
    led: prof?.led && !state.sensors.some((x) => x.led === prof.led) ? prof.led : defaultLed(),
    status: 'connecting',
    battery: null,
    info: {},
    buf: newBuffers(),
    calib: { restMean: null, restSd: null, restN: 0, mvc: null },
  };
  return s;
}

function wire(s) {
  s.link.addEventListener('value', (e) => ingest(s, e.detail.v, e.detail.t));
  s.link.addEventListener('status', (e) => {
    const prev = s.status;
    s.status = e.detail.status;
    if (prev !== s.status) {
      if (s.status === 'reconnecting' && prev === 'live') {
        toast(`${s.name} (${sensorLabel(s)}) lost connection, reconnecting…`, 'bad');
        logEvent('sensor_lost', { sensor: s.key });
      }
      emit('sensors');
    }
  });
  s.link.addEventListener('reconnected', () => {
    toast(`${s.name} reconnected`);
    logEvent('sensor_reconnected', { sensor: s.key });
    s.link.setLed(s.led).catch(() => {});
  });
}

async function start(s) {
  state.sensors.push(s);
  wire(s);
  emit('sensors');
  try {
    await s.link.connect();
    await s.link.setLed(s.led).catch(() => {});
    s.info = await s.link.readInfo().catch(() => ({}));
    s.battery = await s.link.readBattery().catch(() => null);
    emit('sensors');
  } catch (err) {
    s.status = 'disconnected';
    emit('sensors');
    toast(`Could not connect to ${s.bleName}: ${err.message}`, 'bad', 7000);
  }
}

export async function addBleSensor(showAll = false) {
  let device;
  try {
    device = await pickM40({ showAll });
  } catch (err) {
    if (err.name !== 'NotFoundError') toast(err.message, 'bad');
    return; // user cancelled the chooser
  }
  const existing = state.sensors.find((s) => s.deviceId === device.id);
  if (existing) {
    if (existing.status !== 'live') reconnect(existing);
    else toast(`${existing.name} is already connected`);
    return;
  }
  await start(makeSensor(new M40Link(device)));
}

export async function reconnectRemembered() {
  const devices = await rememberedDevices();
  const fresh = devices.filter((d) => !state.sensors.some((s) => s.deviceId === d.id));
  if (!fresh.length) { toast('No other remembered sensors found. Use “Add M40 sensor”.'); return; }
  toast(`Trying ${fresh.length} remembered sensor(s)… make sure they are switched on.`);
  for (const d of fresh) start(makeSensor(new M40Link(d)));
}

export function addSimSensor() {
  start(makeSensor(new SimLink()));
}

export async function reconnect(s) {
  try { await s.link.connect(); await s.link.setLed(s.led).catch(() => {}); emit('sensors'); }
  catch (err) { toast(`Reconnect failed: ${err.message}`, 'bad'); }
}

export async function removeSensor(s) {
  await s.link.close();
  state.sensors = state.sensors.filter((x) => x !== s);
  emit('sensors');
}

export function updateSensor(s, patch) {
  Object.assign(s, patch);
  if (patch.site) s.siteShort = siteByKey(patch.site).short;
  if (patch.led) s.link.setLed(patch.led).catch((e) => toast('LED change failed: ' + e.message, 'bad'));
  saveProfile(s);
  emit('sensors');
}

// Flash a sensor's LED through a few patterns so you can see which physical unit it is.
export async function identify(s) {
  const seq = [11, 16, 11, 16, s.led];
  for (const p of seq) {
    await s.link.setLed(p).catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }
}

export function startBatteryPolling() {
  setInterval(async () => {
    for (const s of state.sensors) {
      if (s.status !== 'live') continue;
      const b = await s.link.readBattery().catch(() => null);
      if (b != null && b !== s.battery) {
        s.battery = b;
        if (b <= 15) toast(`${s.name}: battery ${b}%`, 'bad');
        emit('sensors');
      }
    }
  }, 60000);
}

export function duplicatePlacements() {
  const seen = new Map();
  const dups = [];
  for (const s of state.sensors) {
    if (s.site === 'OTHER') continue;
    const k = s.site + '|' + s.side;
    if (seen.has(k)) dups.push(sensorLabel(s));
    seen.set(k, s);
  }
  return dups;
}
