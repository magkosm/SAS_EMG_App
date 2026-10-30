// Sessions kept in this browser (IndexedDB) when there is no save folder: phones and tablets,
// Bluefy, or a computer without a chosen folder. Data stays on the device; nothing is uploaded.
// Each record: { id, subject, started, duration, steps, hasVideo, bytes, complete, savedAt, files: { name: Blob } }

const DB = 'm40sessions', STORE = 'sessions';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(r?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('storage aborted')); };
  }));
}

// Ask the browser not to evict our data under storage pressure (silently ignored where unsupported).
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
}

export async function putSession(rec) {
  const bytes = Object.values(rec.files).reduce((s, b) => s + (b?.size || 0), 0);
  return tx('readwrite', (st) => st.put({ ...rec, bytes, savedAt: new Date().toISOString() }));
}

// Add or replace single files (e.g. comments.csv) in a stored session.
export async function putFiles(id, files) {
  const rec = await getSession(id);
  if (!rec) throw new Error('session not found in this browser');
  Object.assign(rec.files, files);
  return putSession(rec);
}

export function getSession(id) {
  return tx('readonly', (st) => st.get(id));
}

// Summaries only (no file contents), newest first.
export async function listSessions() {
  const all = (await tx('readonly', (st) => st.getAll())) || [];
  return all
    .map(({ files, ...meta }) => ({ ...meta, fileNames: Object.keys(files || {}) }))
    .sort((a, b) => (b.started || '').localeCompare(a.started || ''));
}

export function deleteSession(id) {
  return tx('readwrite', (st) => st.delete(id));
}

export function filesOf(rec) {
  return Object.entries(rec.files).map(([n, b]) => new File([b], n, { type: b.type }));
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
