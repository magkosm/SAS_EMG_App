// Mac camera: preview + MediaRecorder. Chunks stream to a file on disk when a save folder is set,
// otherwise they are kept in memory and offered as a download at the end.

import { clock } from './state.js';

export const cam = {
  stream: null,
  deviceId: '',
  audio: false,
  recorder: null,
  mime: '',
  ext: 'webm',
  chunks: [],
  writable: null,
  writeChain: Promise.resolve(),
  bytes: 0,
  startedAt: null, // app clock
  error: null,
};

export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

export async function openCamera({ deviceId = '', audio = false, height = 720 } = {}) {
  closeCamera();
  const video = { height: { ideal: height }, frameRate: { ideal: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  cam.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  cam.deviceId = deviceId;
  cam.audio = audio;
  return cam.stream;
}

export function closeCamera() {
  if (cam.recorder && cam.recorder.state !== 'inactive') return; // never kill the camera mid-recording
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
}

export function cameraLabel() {
  return cam.stream?.getVideoTracks()[0]?.label || '';
}

function pickMime() {
  const audio = !!cam.stream?.getAudioTracks().length;
  const candidates = [
    ...(audio ? [['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4']] : [['video/mp4;codecs=avc1.42E01F', 'mp4']]),
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [m, ext] of candidates) if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
  return { mime: '', ext: 'webm' };
}

export function videoExtension() { return pickMime().ext; }

// writable: optional FileSystemWritableFileStream.
export function startRecording(writable) {
  if (!cam.stream) throw new Error('Camera is off');
  const { mime, ext } = pickMime();
  cam.mime = mime;
  cam.ext = ext;
  cam.chunks = [];
  cam.bytes = 0;
  cam.writable = writable || null;
  cam.writeChain = Promise.resolve();
  cam.error = null;
  const rec = new MediaRecorder(cam.stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: 4_000_000,
  });
  cam.recorder = rec;
  // Frames are captured from the moment start() is called; the 'start' event fires later,
  // so stamp the clock just before start() to keep video and EMG aligned.
  const t0 = clock();
  return new Promise((resolve) => {
    rec.onstart = () => { cam.startedAt = t0; resolve(t0); };
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      cam.bytes += e.data.size;
      if (cam.writable) {
        const w = cam.writable;
        cam.writeChain = cam.writeChain.then(() => w.write(e.data)).catch((err) => {
          // Disk write failed: fall back to memory so nothing is lost.
          cam.error = err;
          cam.chunks.push(e.data);
        });
      } else {
        cam.chunks.push(e.data);
      }
    };
    rec.onerror = (e) => { cam.error = e.error || new Error('recorder error'); };
    rec.start(1000);
  });
}

// Resolves with a Blob when recording to memory (or after a disk error), else null.
export function stopRecording() {
  const rec = cam.recorder;
  if (!rec || rec.state === 'inactive') return Promise.resolve(null);
  return new Promise((resolve) => {
    rec.onstop = async () => {
      await cam.writeChain;
      let blob = null;
      if (cam.writable) {
        try { await cam.writable.close(); } catch (err) { cam.error = err; }
      }
      if (cam.chunks.length) blob = new Blob(cam.chunks, { type: cam.mime || 'video/webm' });
      cam.writable = null;
      cam.recorder = null;
      resolve(blob);
    };
    rec.stop();
  });
}

export const isRecording = () => cam.recorder?.state === 'recording';
