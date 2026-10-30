// What kind of device/browser the app runs in, for the few places that need to behave differently.

const ua = navigator.userAgent || '';

// iPadOS reports itself as a Mac; a touch screen gives it away.
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
// Bluefy (iOS browser with Web Bluetooth) is a WebKit browser that adds navigator.bluetooth.
export const isBluefy = /Bluefy/i.test(ua) || (isIOS && !!navigator.bluetooth);
export const isMobile = isIOS || isAndroid;

export const BLUEFY_APP_URL = 'https://apps.apple.com/app/id1492822055';

// Can the share sheet take files? (iOS/Android: "Save to Files", AirDrop, Mail…)
export function canShareFiles(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

// Open the share sheet with files. Returns true when shared, false if cancelled or unsupported.
export async function shareFiles(files, title) {
  if (!canShareFiles(files)) return false;
  try {
    await navigator.share({ files, title });
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    return false;
  }
}
