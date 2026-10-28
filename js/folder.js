// Save folder (File System Access API). The handle is remembered in IndexedDB so the
// recording page and the review page share it across reloads.

import { emit } from './state.js';

const IDB = { db: 'm40logger', store: 'kv' };
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB.db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB.store);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB.store, mode);
      const r = fn(tx.objectStore(IDB.store));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

export const folder = { handle: null, name: '' };
export const folderSupported = () => 'showDirectoryPicker' in window;

export async function restoreFolder() {
  try {
    const hnd = await idb('readonly', (st) => st.get('saveDir'));
    if (hnd) { folder.handle = hnd; folder.name = hnd.name; }
  } catch { /* none stored */ }
}

export async function chooseFolder() {
  const hnd = await window.showDirectoryPicker({ id: 'm40logger', mode: 'readwrite' });
  folder.handle = hnd;
  folder.name = hnd.name;
  try { await idb('readwrite', (st) => st.put(hnd, 'saveDir')); } catch { /* not persisted */ }
  emit('folder');
}

export function forgetFolder() {
  folder.handle = null;
  folder.name = '';
  idb('readwrite', (st) => st.delete('saveDir')).catch(() => {});
  emit('folder');
}

export async function ensureFolderPermission(mode = 'readwrite') {
  if (!folder.handle) return false;
  const opts = { mode };
  if ((await folder.handle.queryPermission(opts)) === 'granted') return true;
  return (await folder.handle.requestPermission(opts)) === 'granted';
}
