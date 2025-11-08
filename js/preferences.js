const STORAGE_KEY = 'passwordgen.preferences.v1';

function hasLocalStorage() {
  try {
    if (typeof window === 'undefined' || !('localStorage' in window)) return false;
    const testKey = '__pref_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function loadPreferences() {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function savePreferences(preferences = {}) {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore persistence errors (e.g., storage quota exceeded).
  }
}

export function clearPreferences() {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore clearing errors.
  }
}
