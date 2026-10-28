// DOM and formatting helpers.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// replaceChildren() that skips null/false parts (replaceChildren would render them as the text "null").
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

export function fmtClock(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const hh = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return (hh ? hh + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export function fmtNum(v, digits = 0) {
  if (v == null || !isFinite(v)) return '–';
  return v.toFixed(digits);
}

export function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function fmtBytes(b) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const safeName = (s) => (s || '').trim().replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');

export function csvRow(cells) {
  return cells
    .map((c) => {
      if (c == null) return '';
      if (typeof c === 'number') return isFinite(c) ? String(+c.toFixed(4)) : '';
      const s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    })
    .join(',');
}

export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function toast(msg, kind = '', ms = 4500) {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
  ]);
}

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function beep(freq = 880, dur = 0.08, vol = 0.15) {
  try {
    beep.ctx ||= new AudioContext();
    const ctx = beep.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  } catch { /* audio unavailable */ }
}
