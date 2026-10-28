// Web Bluetooth link to an ANR M40 Muscle Sense.
// Profile from ANR's "BLE for M40 Muscle Sense" design guide and the M40 product sheet:
//   advertising: manufacturer data, company ID 0x05DA
//   0x1815 Automation IO  → 0x2A58 Analog  (uint16 LE, EMG level 0–1000, notify every 100 ms)
//                         → 0x2A56 Digital (uint8, LED colour pattern 1–24, read/write)
//   0x180F Battery        → 0x2A19 Battery level (uint8, %)   [firmware ≥ 1.5]
//   0x180A Device info    → 0x2A24 model, 0x2A25 serial, 0x2A26 firmware, 0x2A27 hw, 0x2A28 sw

import { clock } from './state.js';
import { withTimeout } from './util.js';

export const ANR_COMPANY_ID = 0x05da;
const SVC_AIO = 0x1815, CH_ANALOG = 0x2a58, CH_DIGITAL = 0x2a56;
const SVC_BATT = 0x180f, CH_BATT = 0x2a19;
const SVC_DIS = 0x180a;
const DIS_CHARS = { model: 0x2a24, serial: 0x2a25, firmware: 0x2a26, hardware: 0x2a27, software: 0x2a28 };
const OPTIONAL_SERVICES = [SVC_AIO, SVC_BATT, SVC_DIS];

export function bleAvailability() {
  if (!window.isSecureContext) return 'Open the app via http://localhost (not as a file) so Bluetooth is allowed.';
  if (!navigator.bluetooth) return 'This browser has no Web Bluetooth. Use Google Chrome or Microsoft Edge on the Mac.';
  return null;
}

// Must be called from a click handler (browser requires a user gesture per device).
export function pickM40({ showAll = false } = {}) {
  const options = showAll
    ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
    : {
        filters: [
          { manufacturerData: [{ companyIdentifier: ANR_COMPANY_ID }] },
          { services: [SVC_AIO] },
          { namePrefix: 'M40' },
          { namePrefix: 'ANR' },
        ],
        optionalServices: OPTIONAL_SERVICES,
      };
  return navigator.bluetooth.requestDevice(options);
}

export async function rememberedDevices() {
  if (!navigator.bluetooth?.getDevices) return [];
  try { return await navigator.bluetooth.getDevices(); } catch { return []; }
}

export class M40Link extends EventTarget {
  constructor(device) {
    super();
    this.device = device;
    this.wanted = true;
    this.queue = Promise.resolve();
    this.analog = this.digital = this.batt = null;
    this.retry = 0;
    this.reconnecting = false;
    this.readsInFlight = 0;
    this.held = [];          // notifications that arrived while a read was in flight
    this.lastReadDv = null;
    // Same function reference every time, so a re-used characteristic object never gets a duplicate listener.
    this.onValueEvt = (e) => this.#onValue(e.target.value);
    device.addEventListener('gattserverdisconnected', () => this.#onDisconnected());
  }

  get id() { return this.device.id; }
  get name() { return this.device.name || 'M40'; }

  #status(s, detail) { this.dispatchEvent(new CustomEvent('status', { detail: { status: s, detail } })); }

  // GATT allows one operation at a time per device; serialise everything.
  #op(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async connect() {
    this.wanted = true;
    this.#status(this.retry ? 'reconnecting' : 'connecting');
    const server = await withTimeout(this.device.gatt.connect(), 20000, 'Bluetooth connect');
    await this.#op(async () => {
      const aio = await server.getPrimaryService(SVC_AIO);
      this.analog = await aio.getCharacteristic(CH_ANALOG);
      try { this.digital = await aio.getCharacteristic(CH_DIGITAL); } catch { this.digital = null; }
      try {
        const b = await server.getPrimaryService(SVC_BATT);
        this.batt = await b.getCharacteristic(CH_BATT);
      } catch { this.batt = null; }
      this.analog.addEventListener('characteristicvaluechanged', this.onValueEvt);
      await this.analog.startNotifications();
    });
    this.retry = 0;
    this.#status('live');
  }

  // A readValue() also fires 'characteristicvaluechanged' with the read result. Those echoes must not
  // enter the recorded stream: while a read is in flight, hold events back and drop the one that is
  // the read's own value (same DataView object, per the Web Bluetooth spec).
  #onValue(dv) {
    if (!dv || dv.byteLength === 0 || dv === this.lastReadDv) return;
    if (this.readsInFlight > 0) { this.held.push({ dv, t: clock() }); return; }
    this.#emit(dv, clock());
  }

  #emit(dv, t) {
    const v = dv.byteLength >= 2 ? dv.getUint16(0, true) : dv.getUint8(0);
    this.dispatchEvent(new CustomEvent('value', { detail: { v, t } }));
  }

  // Ask the sensor for its current EMG value instead of waiting for the next notification.
  readAnalog() {
    if (!this.analog || !this.device.gatt.connected) return Promise.reject(new Error('not connected'));
    return this.#op(async () => {
      this.readsInFlight++;
      let dv = null;
      try {
        dv = await this.analog.readValue();
        this.lastReadDv = dv;
        return dv.byteLength >= 2 ? dv.getUint16(0, true) : dv.getUint8(0);
      } finally {
        this.readsInFlight--;
        const held = this.held;
        this.held = [];
        for (const e of held) if (e.dv !== dv) this.#emit(e.dv, e.t);
      }
    });
  }

  setLed(pattern) {
    if (!this.digital) return Promise.resolve();
    return this.#op(() => this.digital.writeValue(Uint8Array.of(pattern)));
  }

  readBattery() {
    if (!this.batt || !this.device.gatt.connected) return Promise.resolve(null);
    return this.#op(async () => (await this.batt.readValue()).getUint8(0));
  }

  readInfo() {
    return this.#op(async () => {
      const info = {};
      try {
        const dis = await this.device.gatt.getPrimaryService(SVC_DIS);
        const dec = new TextDecoder();
        for (const [k, uuid] of Object.entries(DIS_CHARS)) {
          try {
            const c = await dis.getCharacteristic(uuid);
            info[k] = dec.decode(await c.readValue()).replace(/\0+$/, '').trim();
          } catch { /* characteristic not present */ }
        }
      } catch { /* no device-info service */ }
      return info;
    });
  }

  async #onDisconnected() {
    this.analog = this.digital = this.batt = null;
    if (!this.wanted) { this.#status('disconnected'); return; }
    if (this.reconnecting) return;
    this.reconnecting = true;
    // Out of range, battery, or a radio hiccup: keep trying while the sensor is still wanted.
    while (this.wanted && !this.device.gatt.connected) {
      this.retry++;
      this.#status('reconnecting', `attempt ${this.retry}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** Math.min(this.retry - 1, 3), 8000)));
      if (!this.wanted) break;
      try { await this.connect(); this.reconnecting = false; this.dispatchEvent(new Event('reconnected')); return; }
      catch { /* retry */ }
    }
    this.reconnecting = false;
    if (!this.wanted) this.#status('disconnected');
  }

  async close() {
    this.wanted = false;
    try { await this.analog?.stopNotifications(); } catch { /* already gone */ }
    try { this.device.gatt.disconnect(); } catch { /* ignore */ }
    this.#status('disconnected');
  }
}
