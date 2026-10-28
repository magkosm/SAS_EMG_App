// Fast-read test: does reading the EMG value on demand give more than the 10 Hz notifications?
// For one sensor, read the value as fast as Bluetooth allows while notifications keep coming, then
// compare how often each stream changes, and whether reads ever show values notifications never sent.

import { clock } from './state.js';

export async function runProbe(s, durSec, onProgress) {
  const link = s.link;
  if (!link.readAnalog) throw new Error('This sensor does not support on-demand reads.');
  const notes = [];
  const reads = [];
  const onVal = (e) => notes.push({ t: e.detail.t, v: e.detail.v });
  link.addEventListener('value', onVal);
  const t0 = clock();
  let errors = 0;
  try {
    while (clock() - t0 < durSec) {
      const tReq = clock();
      try {
        const v = await link.readAnalog();
        reads.push({ tReq, t: clock(), v });
      } catch {
        if (++errors > 20) throw new Error('Too many read errors. Is the sensor still connected?');
      }
      onProgress?.(Math.min(1, (clock() - t0) / durSec));
    }
  } finally {
    link.removeEventListener('value', onVal);
  }
  return analyse(notes, reads, clock() - t0, errors);
}

function changes(list) {
  const at = [];
  for (let i = 1; i < list.length; i++) if (list[i].v !== list[i - 1].v) at.push(list[i].t);
  return at;
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function analyse(notes, reads, dur, errors) {
  const nChanges = changes(notes);
  const rChanges = changes(reads);
  const intervals = rChanges.slice(1).map((t, i) => t - rChanges[i]);
  // A read value is "new" when no notification around it (−0.3…+0.6 s, wide enough for packets that
  // Bluetooth held back) carried the same value.
  let fresh = 0, j0 = 0;
  for (const r of reads) {
    while (j0 < notes.length && notes[j0].t < r.t - 0.3) j0++;
    let seen = false;
    for (let j = j0; j < notes.length && notes[j].t <= r.t + 0.6; j++) if (notes[j].v === r.v) { seen = true; break; }
    if (!seen && j0 < notes.length) fresh++;
  }
  const res = {
    durationS: dur,
    notifications: notes.length,
    reads: reads.length,
    errors,
    notifyHz: notes.length / dur,
    readHz: reads.length / dur,
    notifyChangeHz: nChanges.length / dur,
    readChangeHz: rChanges.length / dur,
    readChangeIntervalMs: intervals.length ? median(intervals) * 1000 : null,
    readRoundTripMs: reads.length ? median(reads.map((r) => r.t - r.tReq)) * 1000 : null,
    freshPct: reads.length ? (100 * fresh) / reads.length : 0,
  };
  // More information only if reads change clearly more often than notifications and show values
  // that notifications never carried.
  res.gain = res.readHz > res.notifyHz * 1.3 && res.readChangeHz > res.notifyChangeHz * 1.25 && res.freshPct > 10;
  res.verdict = res.reads < 20
    ? 'Too few reads to judge. Try again with the sensor close to the Mac.'
    : res.gain
      ? `Reading on demand shows new values about ${res.readChangeHz.toFixed(1)} times per second, more than the notifications. A fast-read recording mode would add information.`
      : res.readHz <= res.notifyHz * 1.3
        ? `Bluetooth only allowed ${res.readHz.toFixed(1)} reads per second, not faster than the notifications, so on-demand reading cannot help on this Mac.`
        : `No gain: reads returned the same values the notifications already carry (value changes about every ${res.readChangeIntervalMs != null ? Math.round(res.readChangeIntervalMs) : '–'} ms). The sensor updates its value 10 times a second; polling only returns repeats.`;
  return res;
}
