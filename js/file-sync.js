import { exportRegistrySnapshot, importRegistrySnapshot } from './storage.js';

const fileSyncStore = localforage.createInstance({ storeName: 'fileSync' });
const HANDLE_KEY = 'fileSync.handle';
const SETTINGS_KEY = 'fileSync.settings';

const defaultSettings = {
  autoSync: true,
  intervalMinutes: 5
};

const state = {
  handle: null,
  settings: { ...defaultSettings },
  isSyncing: false,
  isWriting: false,
  queuedWrite: false,
  autoTimer: null,
  status: 'Saved recipes and sync files only store recipe metadata, never your master passphrase.',
  statusTone: 'muted'
};

const elements = {
  panel: null,
  chooseBtn: null,
  syncNowBtn: null,
  autoToggle: null,
  interval: null,
  pauseBtn: null,
  fileLabel: null,
  status: null
};

let callbacks = {
  refreshHistoryList: null,
  updateStorageInfo: null
};

let isInitialized = false;

function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'FileSystemFileHandle' in window;
}

export async function initFileSync({ refreshHistoryList, updateStorageInfo } = {}) {
  elements.panel = document.getElementById('fileSyncPanel');
  if (!elements.panel) return;

  elements.chooseBtn = document.getElementById('fileSyncChooseBtn');
  elements.syncNowBtn = document.getElementById('fileSyncSyncNowBtn');
  elements.autoToggle = document.getElementById('fileSyncAutoToggle');
  elements.interval = document.getElementById('fileSyncInterval');
  elements.pauseBtn = document.getElementById('fileSyncPauseBtn');
  elements.fileLabel = document.getElementById('fileSyncFileLabel');
  elements.status = document.getElementById('fileSyncStatus');

  callbacks = { refreshHistoryList, updateStorageInfo };

  if (!supportsFileSystemAccess()) {
    setStatus('File System Access API not available. Use QR or JSON import/export instead.', 'error');
    disableControls();
    return;
  }

  attachListeners();
  await loadState();
  applySettingsToUi();

  isInitialized = true;

  if (state.handle) {
    updateFileLabel();
    await syncFromFile('startup');
    startAutoSync();
  } else {
    setStatus(state.status, 'muted');
  }
}

function attachListeners() {
  elements.chooseBtn?.addEventListener('click', () => void chooseFileHandle());
  elements.syncNowBtn?.addEventListener('click', () => void syncFromFile('manual'));
  elements.autoToggle?.addEventListener('change', handleAutoToggle);
  elements.interval?.addEventListener('change', handleIntervalChange);
  elements.pauseBtn?.addEventListener('click', handlePauseToggle);
}

async function loadState() {
  try {
    const [storedHandle, storedSettings] = await Promise.all([
      fileSyncStore.getItem(HANDLE_KEY),
      fileSyncStore.getItem(SETTINGS_KEY)
    ]);
    state.handle = storedHandle || null;
    state.settings = { ...defaultSettings, ...(storedSettings || {}) };
  } catch (error) {
    console.error('Failed to load file sync state', error);
  }
}

function applySettingsToUi() {
  if (elements.autoToggle) {
    elements.autoToggle.checked = Boolean(state.settings.autoSync);
  }
  if (elements.interval) {
    const minutes = Number(state.settings.intervalMinutes) || defaultSettings.intervalMinutes;
    elements.interval.value = String(minutes);
  }
  updatePauseButton();
  updateSyncControls();
}

function disableControls() {
  if (elements.chooseBtn) elements.chooseBtn.disabled = true;
  if (elements.syncNowBtn) elements.syncNowBtn.disabled = true;
  if (elements.autoToggle) elements.autoToggle.disabled = true;
  if (elements.interval) elements.interval.disabled = true;
  if (elements.pauseBtn) elements.pauseBtn.disabled = true;
}

function updatePauseButton() {
  if (!elements.pauseBtn) return;
  const isPaused = !state.settings.autoSync;
  elements.pauseBtn.textContent = isPaused ? 'Resume auto-sync' : 'Pause auto-sync';
}

function updateSyncControls() {
  if (elements.syncNowBtn) {
    elements.syncNowBtn.disabled = !state.handle;
  }
  if (elements.autoToggle) {
    elements.autoToggle.disabled = !state.handle;
  }
  if (elements.interval) {
    elements.interval.disabled = !state.handle || !state.settings.autoSync;
  }
  if (elements.pauseBtn) {
    elements.pauseBtn.disabled = !state.handle;
  }
}

async function chooseFileHandle() {
  try {
    const pickerOpts = {
      types: [
        {
          description: 'JSON files',
          accept: { 'application/json': ['.json'] }
        }
      ]
    };
    const handles = await window.showOpenFilePicker(pickerOpts);
    const handle = Array.isArray(handles) ? handles[0] : null;
    if (!handle) return;

    state.handle = handle;
    await fileSyncStore.setItem(HANDLE_KEY, handle);
    updateFileLabel();
    updateSyncControls();
    setStatus('Sync file selected. Requesting permission…', 'muted');
    await ensurePermission(handle, 'readwrite');
    await syncFromFile('file-selected');
    startAutoSync();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setStatus(`Unable to open sync file: ${error.message}`, 'error');
  }
}

function startAutoSync() {
  clearInterval(state.autoTimer);
  if (!state.settings.autoSync || !state.handle) return;

  const minutes = Number(state.settings.intervalMinutes) || defaultSettings.intervalMinutes;
  const intervalMs = Math.max(minutes, 1) * 60 * 1000;
  state.autoTimer = setInterval(() => void syncFromFile('auto'), intervalMs);
}

function handleAutoToggle(event) {
  const enabled = event.target.checked;
  state.settings.autoSync = enabled;
  persistSettings();
  updatePauseButton();
  updateSyncControls();
  if (enabled) {
    startAutoSync();
  } else {
    clearInterval(state.autoTimer);
    setStatus('Auto-sync paused. Manual "Sync now" will still pull updates.', 'muted');
  }
}

function handleIntervalChange(event) {
  const minutes = Number(event.target.value) || defaultSettings.intervalMinutes;
  state.settings.intervalMinutes = minutes;
  persistSettings();
  startAutoSync();
  setStatus(`Auto-sync interval set to ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'muted');
}

function handlePauseToggle() {
  state.settings.autoSync = !state.settings.autoSync;
  if (elements.autoToggle) {
    elements.autoToggle.checked = state.settings.autoSync;
  }
  persistSettings();
  updatePauseButton();
  updateSyncControls();
  if (state.settings.autoSync) {
    startAutoSync();
    setStatus('Auto-sync resumed.', 'success');
  } else {
    clearInterval(state.autoTimer);
    setStatus('Auto-sync paused. Manual sync will continue to work.', 'muted');
  }
}

function persistSettings() {
  void fileSyncStore.setItem(SETTINGS_KEY, { ...state.settings }).catch(error => {
    console.error('Failed to persist file sync settings', error);
  });
}

function updateFileLabel() {
  if (!elements.fileLabel) return;
  elements.fileLabel.textContent = state.handle ? `Sync file: ${state.handle.name}` : 'No sync file selected.';
}

function setStatus(message, tone = 'muted') {
  state.status = message;
  state.statusTone = tone;
  if (!elements.status) return;

  elements.status.textContent = message;
  elements.status.classList.remove(
    'file-sync-panel__message--success',
    'file-sync-panel__message--error',
    'file-sync-panel__message--muted'
  );

  if (tone === 'success') {
    elements.status.classList.add('file-sync-panel__message--success');
  } else if (tone === 'error') {
    elements.status.classList.add('file-sync-panel__message--error');
  } else {
    elements.status.classList.add('file-sync-panel__message--muted');
  }
}

async function ensurePermission(handle, mode = 'read') {
  if (!handle?.queryPermission || !handle?.requestPermission) return true;
  const opts = { mode };
  const current = await handle.queryPermission(opts);
  if (current === 'granted') return true;
  if (current === 'denied') return false;
  const result = await handle.requestPermission(opts);
  return result === 'granted';
}

async function syncFromFile(reason = 'manual') {
  if (!state.handle) {
    setStatus('Select a sync file to pull recipe updates.', 'muted');
    return;
  }
  if (state.isSyncing) return;
  state.isSyncing = true;

  try {
    const permitted = await ensurePermission(state.handle, 'read');
    if (!permitted) {
      setStatus('Permission needed to read the sync file. Please reselect it.', 'error');
      return;
    }

    const file = await state.handle.getFile();
    const text = await file.text();
    if (!text.trim()) {
      setStatus('Sync file is empty. A write will populate it with recipe metadata.', 'muted');
      return;
    }

    let snapshot;
    try {
      snapshot = JSON.parse(text);
    } catch (parseError) {
      setStatus('Sync file is not valid JSON. Please fix or replace it.', 'error');
      return;
    }

    const result = await importRegistrySnapshot(snapshot);
    const timestamp = new Date().toLocaleTimeString();
    setStatus(
      `Synced ${result.importedSites} site${result.importedSites === 1 ? '' : 's'} at ${timestamp}.`,
      'success'
    );
    await callbacks.refreshHistoryList?.();
    await callbacks.updateStorageInfo?.();
    if (reason === 'startup') {
      // Ensure local state is mirrored to disk after initial import.
      await notifyFileSyncRegistryChange();
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      await handleMissingFile();
      return;
    }
    setStatus(`Sync failed: ${error.message}`, 'error');
  } finally {
    state.isSyncing = false;
  }
}

function isMissingFileError(error) {
  return error?.name === 'NotFoundError' || /not\s+found/i.test(error?.message || '');
}

async function handleMissingFile() {
  setStatus('Sync file is missing or was removed. Reconnect it or choose a new file.', 'error');
  clearInterval(state.autoTimer);
  state.handle = null;
  updateSyncControls();
  updateFileLabel();
  try {
    await fileSyncStore.removeItem(HANDLE_KEY);
  } catch (error) {
    console.error('Failed to clear missing handle', error);
  }
}

export async function notifyFileSyncRegistryChange() {
  if (!isInitialized || !state.handle) return;
  if (state.isWriting) {
    state.queuedWrite = true;
    return;
  }

  state.isWriting = true;
  try {
    const permitted = await ensurePermission(state.handle, 'readwrite');
    if (!permitted) {
      setStatus('Permission needed to update the sync file. Please reselect it.', 'error');
      return;
    }

    const snapshot = await exportRegistrySnapshot();
    const writable = await state.handle.createWritable();
    await writable.write(JSON.stringify(snapshot, null, 2));
    await writable.close();
    const timestamp = new Date().toLocaleTimeString();
    setStatus(
      `Saved ${snapshot.sites} site${snapshot.sites === 1 ? '' : 's'} to sync file at ${timestamp}.`,
      'success'
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      await handleMissingFile();
      return;
    }
    setStatus(`Failed to write sync file: ${error.message}`, 'error');
  } finally {
    state.isWriting = false;
    if (state.queuedWrite) {
      state.queuedWrite = false;
      void notifyFileSyncRegistryChange();
    }
  }
}
