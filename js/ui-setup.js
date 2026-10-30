// Tab 1: pair sensors, name them, assign placement and LED colour; camera and save folder.

import { state, on, emit, seriesVar, sensorLabel } from './state.js';
import { SITES, LED_PATTERNS } from './protocol.js';
import { bleAvailability } from './ble.js';
import { addBleSensor, addSimSensor, reconnectRemembered, removeSensor, updateSensor, identify, reconnect, duplicatePlacements } from './sensors.js';
import { listCameras, openCamera, closeCamera, cam, cameraLabel } from './recorder.js';
import { folder, folderSupported, chooseFolder, forgetFolder } from './folder.js';
import { h, $, toast, fmtNum, fill } from './util.js';
import { runProbe } from './probe.js';
import { isIOS, isMobile, isBluefy, BLUEFY_APP_URL } from './platform.js';

const root = () => $('#tab-setup');
// Phones/tablets film the patient with the back camera, so no mirroring there by default.
export const camPrefs = { record: true, audio: false, mirror: !isMobile };

function ledDots(id) {
  const p = LED_PATTERNS.find((x) => x.id === id);
  return h('span', { class: 'led', title: p ? `LED: ${p.label}` : '' },
    h('i', { style: { background: p?.c1 } }), h('i', { style: { background: p?.c2 } }));
}

function statusEl(s) {
  const txt = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', disconnected: 'Disconnected' }[s.status] || s.status;
  return h('span', { class: 'status st-' + s.status }, h('i'), txt);
}

function sensorCard(s) {
  const usedLeds = new Set(state.sensors.filter((x) => x !== s).map((x) => x.led));
  const meta = [
    statusEl(s),
    h('span', {}, ledDots(s.led), ' ', LED_PATTERNS.find((p) => p.id === s.led)?.label),
    s.battery != null ? h('span', {}, `Battery ${s.battery}%`) : null,
    h('span', {}, s.sim ? 'simulated' : s.bleName),
    s.info.serial ? h('span', {}, 'SN ' + s.info.serial) : null,
    s.info.firmware ? h('span', {}, 'FW ' + s.info.firmware) : null,
  ];
  return h('div', { class: 'sensor-card', style: { '--sc': seriesVar(s) } },
    h('div', { class: 'sensor-head' },
      h('span', { class: 'swatch', style: { background: seriesVar(s) } }),
      h('input', { type: 'text', value: s.name, 'aria-label': 'Sensor name',
        onchange: (e) => updateSensor(s, { name: e.target.value.trim() || s.name }) }),
      h('button', { class: 'btn small ghost', title: 'Flash this sensor’s LED red/white', onclick: () => identify(s) }, 'Identify'),
      s.status === 'disconnected' ? h('button', { class: 'btn small', onclick: () => reconnect(s) }, 'Reconnect') : null,
      h('button', { class: 'btn small ghost', title: 'Disconnect and remove', onclick: () => {
        if (state.session?.active && !confirm(`Remove ${s.name} during a running session?`)) return;
        removeSensor(s);
      } }, '✕'),
    ),
    h('div', { class: 'sensor-grid' },
      h('label', { class: 'field' }, 'Muscle',
        h('select', { onchange: (e) => updateSensor(s, { site: e.target.value }) },
          SITES.map((x) => h('option', { value: x.key, selected: x.key === s.site }, x.label)))),
      h('label', { class: 'field' }, 'Side',
        h('select', { onchange: (e) => updateSensor(s, { side: e.target.value }) },
          [['L', 'Left'], ['R', 'Right'], ['', '–']].map(([v, l]) => h('option', { value: v, selected: v === s.side }, l)))),
      h('label', { class: 'field' }, 'LED colour',
        h('select', { onchange: (e) => updateSensor(s, { led: +e.target.value }) },
          LED_PATTERNS.map((p) => h('option', { value: p.id, selected: p.id === s.led, disabled: usedLeds.has(p.id) }, `${p.id}. ${p.label}`)))),
    ),
    h('div', { class: 'sensor-meta' }, meta),
  );
}

// Schematic only: where the three sites sit relative to landmarks (posterior view, right side).
// TRP ins = upper (cranial) insertion just below the superior nuchal line.
function placementFigure() {
  return h('div', { class: 'figure', html: `
<svg viewBox="0 0 320 210" width="320" role="img" aria-label="Schematic of sensor sites on the neck and shoulder">
  <g fill="none" stroke="var(--axis)" stroke-width="2" stroke-linecap="round">
    <ellipse cx="160" cy="58" rx="40" ry="46"/>
    <path d="M140 100 L136 132 M180 100 L184 132"/>
    <path d="M136 132 Q100 140 58 152 Q40 158 36 176 M184 132 Q220 140 262 152 Q280 158 284 176"/>
  </g>
  <g fill="var(--muted)" font-size="10" font-family="system-ui">
    <circle cx="160" cy="132" r="3"/><text x="150" y="150">C7</text>
    <circle cx="262" cy="153" r="3"/><text x="252" y="170">acromion</text>
    <circle cx="190" cy="80" r="3"/><text x="196" y="74">mastoid</text>
    <circle cx="160" cy="98" r="3"/><text x="96" y="92">occiput (EOP)</text><path d="M150 93 L158 97" stroke="var(--muted)"/>
  </g>
  <path d="M136 97 Q160 104 186 92" fill="none" stroke="var(--muted)" stroke-dasharray="3 3"/>
  <path d="M160 132 L262 153" stroke="var(--muted)" stroke-dasharray="3 3"/>
  <path d="M190 80 L178 128" stroke="var(--s1)" stroke-width="3" stroke-linecap="round" opacity=".35"/>
  <g font-size="11" font-weight="650" font-family="system-ui">
    <rect x="180" y="100" width="13" height="22" rx="4" transform="rotate(14 186 111)" fill="var(--s1)"/>
    <text x="226" y="104" fill="var(--ink)">SCM</text><path d="M224 101 L194 109" stroke="var(--ink-2)"/>
    <rect x="204" y="135" width="22" height="13" rx="4" transform="rotate(11 215 141)" fill="var(--s2)"/>
    <text x="196" y="196" fill="var(--ink)">TRP upper</text><path d="M215 186 L215 150" stroke="var(--ink-2)"/>
    <rect x="164" y="104" width="11" height="20" rx="4" fill="var(--s3)"/>
    <text x="82" y="126" fill="var(--ink)">TRP ins</text><path d="M126 122 L162 115" stroke="var(--ink-2)"/>
  </g>
  <text x="200" y="88" font-size="9" fill="var(--muted)" font-family="system-ui">sup. nuchal line</text>
  <text x="8" y="16" font-size="10" fill="var(--muted)" font-family="system-ui">Schematic, right side. Mirror for the left.</text>
</svg>` });
}

// ---- Fast-read test -----------------------------------------------------------------
const probe = { key: '', dur: 20, running: false, progress: 0, results: {} };

async function startProbe() {
  const s = state.sensors.find((x) => x.key === probe.key && x.status === 'live');
  if (!s) { toast('Pick a live sensor first.', 'bad'); return; }
  probe.running = true;
  probe.progress = 0;
  render();
  try {
    probe.results[s.key] = await runProbe(s, probe.dur, (p) => {
      probe.progress = p;
      const bar = $('#probeBar');
      if (bar) bar.style.width = (p * 100).toFixed(0) + '%';
    });
  } catch (err) {
    toast('Fast-read test: ' + err.message, 'bad', 7000);
  }
  probe.running = false;
  render();
}

function probeSection() {
  const live = state.sensors.filter((s) => s.status === 'live');
  if (!live.length) return null;
  if (!live.some((s) => s.key === probe.key)) probe.key = live[0].key;
  const res = probe.results[probe.key];
  const busy = probe.running || !!state.session?.active;
  const row = (label, a, b) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, a), h('td', { class: 'num' }, b));
  return h('div', { class: 'section' },
    h('h2', {}, 'Sampling test'),
    h('p', { class: 'muted' }, 'Checks whether reading a sensor on demand gives more than its 10 values per second. Keep the sensor on the skin and the muscle working a little (e.g. slow shrugs) during the test.'),
    h('div', { class: 'btn-row' },
      h('select', { disabled: busy, onchange: (e) => { probe.key = e.target.value; render(); } },
        live.map((s) => h('option', { value: s.key, selected: s.key === probe.key }, `${sensorLabel(s)} · ${s.name}`))),
      h('select', { disabled: busy, onchange: (e) => { probe.dur = +e.target.value; } },
        [10, 20, 30].map((v) => h('option', { value: v, selected: v === probe.dur }, v + ' s'))),
      h('button', { class: 'btn', disabled: busy, onclick: startProbe }, probe.running ? 'Testing…' : 'Run fast-read test')),
    state.session?.active ? h('p', { class: 'tiny' }, 'Not available while a session is recording (it would load the Bluetooth link).') : null,
    probe.running ? h('div', { class: 'tile-bar', style: { marginTop: '8px', '--sc': 'var(--accent)' } }, h('i', { id: 'probeBar', style: { width: (probe.progress * 100) + '%' } })) : null,
    res && !probe.running ? h('div', { style: { marginTop: '10px' } },
      h('div', { class: 'callout' + (res.gain ? ' warn' : '') }, res.verdict),
      h('table', { class: 'cal-table', style: { marginTop: '8px' } },
        h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Notifications'), h('th', {}, 'On-demand reads'))),
        h('tbody', {},
          row('Received per second', fmtNum(res.notifyHz, 1), fmtNum(res.readHz, 1)),
          row('Value changes per second', fmtNum(res.notifyChangeHz, 1), fmtNum(res.readChangeHz, 1)),
          row('Values only seen by reading', '–', fmtNum(res.freshPct, 1) + ' %'),
          row('Read round trip', '–', res.readRoundTripMs != null ? fmtNum(res.readRoundTripMs, 0) + ' ms' : '–'))),
      h('p', { class: 'tiny', style: { marginTop: '4px' } }, `${res.notifications} notifications and ${res.reads} reads in ${fmtNum(res.durationS, 1)} s${res.errors ? `, ${res.errors} read errors` : ''}.`)) : null,
  );
}

let pending = false;
function render() {
  const el = root();
  // Don't rebuild under the user's cursor while they type a name; catch up on blur.
  if (el.contains(document.activeElement) && document.activeElement.matches('input[type=text]')) { pending = true; return; }
  pending = false;
  const err = bleAvailability();
  const dups = duplicatePlacements();

  fill(el,
    h('div', { class: 'section' },
      h('h2', {}, 'Sensors'),
      err ? h('div', { class: 'callout bad' }, h('b', {}, 'Bluetooth unavailable. '), err,
        isIOS && !navigator.bluetooth ? [' ', h('a', { href: BLUEFY_APP_URL, target: '_blank', rel: 'noopener' }, 'Get Bluefy from the App Store'), ', then open ', h('b', {}, location.href.split('#')[0]), ' in it.'] : null) : null,
      isBluefy ? h('div', { class: 'callout' }, h('b', {}, 'iPhone/iPad (Bluefy): '),
        'keep Bluefy open with the screen on during a session. iOS pauses Bluetooth when the app is in the background or the screen locks; the app keeps the screen awake and marks any break in the data. ',
        'If a sensor is not listed, use “Show all Bluetooth devices”. Sessions are kept in this browser: share them from Results (Save to Files, AirDrop).') : null,
      h('p', { class: 'muted' }, 'Charge each M40, snap in two fresh electrodes, press its button (LED pulses like a heartbeat), then add it here. Repeat for each sensor.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', disabled: !!err, onclick: () => addBleSensor(false) }, '+ Add M40 sensor'),
        navigator.bluetooth?.getDevices ? h('button', { class: 'btn', disabled: !!err, onclick: reconnectRemembered }, 'Reconnect remembered') : null,
      ),
      h('div', { class: 'btn-row', style: { marginTop: '6px' } },
        h('button', { class: 'btn link', disabled: !!err, onclick: () => addBleSensor(true) }, 'Not listed? Show all Bluetooth devices'),
        h('button', { class: 'btn link', onclick: addSimSensor }, 'Add simulated sensor (demo)'),
      ),
      h('div', { style: { marginTop: '12px' } }, state.sensors.map(sensorCard)),
      dups.length ? h('div', { class: 'callout warn' }, h('b', {}, 'Same placement twice: '), dups.join(', '), '. Check muscle/side.') : null,
    ),

    probeSection(),

    h('div', { class: 'section' },
      h('h2', {}, 'Placement guide'),
      placementFigure(),
      h('p', { class: 'tiny' }, 'Skin: clean, dry, oil-free. Use fresh electrodes each time; they lose grip when moved. Press firmly while the muscle is contracted.'),
      SITES.filter((x) => x.key !== 'OTHER').map((x) =>
        h('details', { class: 'guide' },
          h('summary', {}, x.label),
          h('ul', {}, x.placement.map((p) => h('li', {}, p))))),
    ),

    h('div', { class: 'section' },
      h('h2', {}, 'Camera'),
      h('div', { class: 'btn-row' },
        h('select', { id: 'camSelect', style: { flex: 1 }, onchange: (e) => startCam(e.target.value) },
          h('option', { value: '' }, cam.stream ? cameraLabel() || 'Default camera' : 'Default camera')),
        cam.stream
          ? h('button', { class: 'btn', disabled: state.session?.active, onclick: () => { closeCamera(); emit('camera'); } }, 'Turn off')
          : h('button', { class: 'btn primary', onclick: () => startCam('') }, 'Turn camera on'),
      ),
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: camPrefs.record, onchange: (e) => { camPrefs.record = e.target.checked; } }), 'Record video during session'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: camPrefs.audio, disabled: state.session?.active, onchange: (e) => { camPrefs.audio = e.target.checked; if (cam.stream) startCam(cam.deviceId); } }), 'Include audio'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: camPrefs.mirror, onchange: (e) => { camPrefs.mirror = e.target.checked; $('#camPreview').classList.toggle('unmirrored', !camPrefs.mirror); } }), 'Mirror preview'),
      ),
      h('p', { class: 'tiny', style: { marginTop: '6px' } }, 'The recorded file is never mirrored. Video and EMG share one clock; the video start offset is stored in session.json and every CSV has a video_t_s column.'),
    ),

    h('div', { class: 'section' },
      h('h2', {}, 'Save folder'),
      folderSupported()
        ? h('div', {},
            h('p', { class: 'muted' }, folder.handle
              ? ['Each session gets its own sub-folder in ', h('b', {}, folder.name), '. Video streams to disk while recording.']
              : 'Pick a folder so video and data are written to disk during the session. Without one, files are offered as downloads at the end.'),
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn' + (folder.handle ? '' : ' primary'), disabled: state.session?.active, onclick: () => chooseFolder().catch((e) => e.name !== 'AbortError' && toast(e.message, 'bad')) }, folder.handle ? 'Change folder…' : 'Choose save folder…'),
              folder.handle ? h('button', { class: 'btn ghost', disabled: state.session?.active, onclick: forgetFolder }, 'Use downloads instead') : null))
        : h('p', { class: 'muted' }, 'This browser cannot write to a folder. Each session is kept in this browser instead; share or download it from Results, or open it in Replay.'),
    ),
  );
  if (cam.stream) fillCameraList();
}

async function fillCameraList() {
  const sel = $('#camSelect');
  if (!sel) return;
  try {
    const cams = await listCameras();
    const current = cam.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    sel.replaceChildren(...cams.map((c, i) => h('option', { value: c.deviceId, selected: c.deviceId === current }, c.label || `Camera ${i + 1}`)));
  } catch { /* leave default */ }
}

export async function startCam(deviceId) {
  try {
    const stream = await openCamera({ deviceId, audio: camPrefs.audio, facingMode: isMobile ? 'environment' : '' });
    const v = $('#camPreview');
    v.srcObject = stream;
    v.classList.toggle('unmirrored', !camPrefs.mirror);
    $('#camEmpty').hidden = true;
  } catch (err) {
    const hint = isIOS ? 'allow camera access for this app in the iOS Settings app' : isMobile ? 'allow camera access for this site in the browser settings' : 'check macOS Settings → Privacy → Camera for Chrome';
    toast(`Camera: ${err.message} (${hint})`, 'bad', 8000);
  }
  emit('camera');
}

export function initSetup() {
  root().addEventListener('focusout', () => setTimeout(() => pending && render(), 0));
  on('sensors', render);
  on('session', render);
  on('folder', render);
  on('camera', () => {
    if (!cam.stream) { $('#camPreview').srcObject = null; $('#camEmpty').hidden = false; }
    render();
  });
  render();
}

