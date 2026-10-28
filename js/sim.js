// Simulated M40 for training and testing without hardware. Same interface as M40Link.
// The signal reacts to calibration captures, running protocol steps and counted reps.
// Timing mimics Bluetooth: values are made every 100 ms on the sensor's own (slightly off) clock,
// then arrive after a variable delay, sometimes held back and delivered in a burst, rarely lost.

import { state, clock } from './state.js';
import { STEPS } from './protocol.js';

let simCount = 0;

function randn() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class SimLink extends EventTarget {
  constructor() {
    super();
    simCount++;
    this.id = 'sim-' + simCount + '-' + Math.random().toString(36).slice(2, 7);
    this.name = 'Simulated M40 #' + simCount;
    this.sim = true;
    this.base = 22 + Math.random() * 18;
    this.gain = 0.8 + Math.random() * 0.5;
    this.mvc = 520 + Math.random() * 260;
    this.burst = 0;
    this.battery = 70 + Math.floor(Math.random() * 30);
    this.T = 0.1 * (1 + (Math.random() - 0.5) * 1e-4); // ±50 ppm clock error
    this.current = Math.round(this.base);
    this.truth = [];      // { sent, arrived } per delivered sample, for testing the timestamp clean-up
    this.lostCount = 0;
    this.outbox = [];
    this.pumpTimer = null;
  }

  #status(s) { this.dispatchEvent(new CustomEvent('status', { detail: { status: s } })); }

  async connect() {
    this.#status('connecting');
    await new Promise((r) => setTimeout(r, 400));
    this.#status('live');
    const start = clock() + 0.1;
    let k = 0, stallUntil = -1, lastArrival = -1;
    const tick = () => {
      if (!this.timer) return;
      const sent = start + k * this.T;
      const v = Math.round(this.#sample());
      this.current = v;
      k++;
      if (Math.random() < 0.003) this.lostCount++;
      else {
        let arrive = sent + 0.006 + Math.random() ** 3 * 0.04;
        if (sent > stallUntil && Math.random() < 0.01) stallUntil = sent + 0.15 + Math.random() * 0.25;
        if (arrive < stallUntil) arrive = stallUntil + Math.random() * 0.002;
        arrive = Math.max(arrive, lastArrival + 0.0005);
        lastArrival = arrive;
        this.outbox.push({ arrive, sent, v });
        this.#pump();
      }
      this.timer = setTimeout(tick, Math.max(0, (start + k * this.T - clock()) * 1000));
    };
    this.timer = setTimeout(tick, 100);
  }

  // Deliver queued packets strictly in order (Bluetooth never reorders), each at its arrival time.
  #pump() {
    if (this.pumpTimer || !this.outbox.length) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      if (!this.timer) { this.outbox = []; return; }
      while (this.outbox.length && this.outbox[0].arrive <= clock() + 0.0005) {
        const p = this.outbox.shift();
        const t = clock();
        if (this.truth.length > 30000) this.truth.splice(0, 10000);
        this.truth.push({ sent: p.sent, arrived: t });
        this.dispatchEvent(new CustomEvent('value', { detail: { v: p.v, t } }));
      }
      this.#pump();
    }, Math.max(0, (this.outbox[0].arrive - clock()) * 1000));
  }

  #sensor() { return state.sensors.find((s) => s.link === this); }

  #sample() {
    const s = this.#sensor();
    const t = clock();
    let v = this.base + randn() * this.base * 0.18;
    const c = state.calib;
    if (s && c && c.kind === 'mvc' && c.keys.includes(s.key) && t >= c.t0) {
      const ramp = Math.min(1, (t - c.t0) / 1.2);
      v = this.base + ramp * (this.mvc - this.base) * (0.9 + 0.1 * Math.sin(t * 3)) + randn() * 25;
    }
    const a = state.protocol.attempt;
    if (s && a) {
      const step = STEPS[a.step];
      const siteGain = { SCM: 1.0, UT: 0.7, TI: 0.5, OTHER: 0.4 }[s.site] ?? 0.4;
      const amp = step.head ? 120 * siteGain : 14 * siteGain;
      const freq = step.head ? 0.7 : 1.4;
      v += amp * this.gain * (0.5 + 0.5 * Math.sin(2 * Math.PI * freq * (t - a.t0) + s.colorIdx));
      const lastRep = a.repTimes[a.repTimes.length - 1];
      if (lastRep != null && t - lastRep < 1.5) v += amp * 1.4 * Math.exp(-(t - lastRep) * 2.5);
    }
    return Math.max(0, Math.min(1000, v));
  }

  setLed() { return Promise.resolve(); }
  // Like the real sensor: the readable value only changes when a new measurement is made (10 Hz).
  readAnalog() { return new Promise((r) => setTimeout(() => r(this.current), 15 + Math.random() * 30)); }
  readBattery() { return Promise.resolve(this.battery); }
  readInfo() { return Promise.resolve({ model: 'M40 (simulated)', firmware: 'sim' }); }
  async close() {
    clearTimeout(this.timer);
    this.timer = null;
    this.#status('disconnected');
  }
}
