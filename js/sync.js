import { exportRegistrySnapshot, importRegistrySnapshot } from './storage.js';

const QUICK_PREFIX = 'PGENQUICK-';
const PAYLOAD_VERSION = 2;
const QUICK_KDF_ITERATIONS = 200000;
const QUICK_MIN_PASSPHRASE_LENGTH = 16;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const quickState = {
  passphrase: '',
  payload: '',
  stats: null
};

let currentMode = 'send';
let isPreparingQuickBundle = false;
let quickScannerDetector = null;
let quickScannerStream = null;
let quickScannerFrameId = 0;
let isQuickScannerActive = false;

export function initSyncUI({ refreshHistoryList, updateStorageInfo } = {}) {
  const syncBtn = document.getElementById('syncBtn');
  const modal = document.getElementById('syncModal');
  if (!syncBtn || !modal) return;

  const closeBtn = modal.querySelector('.sync-modal__close');
  const modeButtons = Array.from(modal.querySelectorAll('.sync-mode__btn'));

  const quickSendPanel = document.getElementById('syncQuickSendPanel');
  const quickReceivePanel = document.getElementById('syncQuickReceivePanel');
  const quickCanvas = document.getElementById('syncQuickQr');
  const quickPassphraseLabel = document.getElementById('syncQuickPassphrase');
  const quickPassphraseInput = document.getElementById('syncQuickPassphraseInput');
  const quickPayloadTextarea = document.getElementById('syncQuickPayload');
  const quickInputTextarea = document.getElementById('syncQuickInput');
  const quickStatus = document.getElementById('syncQuickStatus');
  const quickImportStatus = document.getElementById('syncQuickImportStatus');

  const quickCopyPassphraseBtn = document.getElementById('syncQuickCopyPassphraseBtn');
  const quickRegenerateBtn = document.getElementById('syncQuickRegenerateBtn');
  const quickCopyPayloadBtn = document.getElementById('syncCopyQuickPayloadBtn');
  const quickImportBtn = document.getElementById('syncQuickImportBtn');
  const quickScanBtn = document.getElementById('syncQuickScanBtn');
  const quickScanner = document.getElementById('syncQuickScanner');
  const quickScannerCloseBtn = document.getElementById('syncQuickScannerClose');
  const quickScannerVideo = document.getElementById('syncQuickScannerVideo');
  const quickScannerStatus = document.getElementById('syncQuickScannerStatus');

  function switchMode(mode) {
    currentMode = mode;
    modeButtons.forEach(button => {
      const isActive = button.dataset.mode === mode;
      button.classList.toggle('sync-mode__btn--active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    if (mode === 'receive') {
      quickSendPanel?.classList.add('hidden');
      quickReceivePanel?.classList.remove('hidden');
      clearQuickReceiveUi();
    } else {
      quickReceivePanel?.classList.add('hidden');
      quickSendPanel?.classList.remove('hidden');
      clearQuickReceiveUi();
      if (!quickState.payload) {
        void prepareQuickBundle();
      }
    }
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (isQuickScannerOpen()) {
      closeQuickScanner();
      return;
    }
    closeModal();
  }

  function openModal(defaultMode = 'send') {
    modal.classList.remove('hidden');
    document.body.classList.add('sync-modal-open');
    document.addEventListener('keydown', handleKeydown);
    currentMode = defaultMode;
    resetQuickState();
    clearQuickSendUi();
    clearQuickReceiveUi();
    switchMode(defaultMode);
  }

  function closeModal() {
    modal.classList.add('hidden');
    document.body.classList.remove('sync-modal-open');
    document.removeEventListener('keydown', handleKeydown);
    closeQuickScanner({ silent: true, restoreFocus: false });
    resetQuickState();
    clearQuickSendUi();
    clearQuickReceiveUi();
  }

  function clearQuickSendUi() {
    if (quickPassphraseLabel) quickPassphraseLabel.textContent = '——————';
    if (quickPayloadTextarea) quickPayloadTextarea.value = '';
    if (quickStatus) {
      quickStatus.textContent = '';
      quickStatus.className = 'sync-status';
    }
    if (quickCanvas) clearCanvas(quickCanvas);
  }

  function clearQuickReceiveUi() {
    if (quickPassphraseInput) quickPassphraseInput.value = '';
    if (quickInputTextarea) quickInputTextarea.value = '';
    if (quickImportStatus) {
      quickImportStatus.textContent = '';
      quickImportStatus.className = 'sync-status';
    }
    closeQuickScanner({ silent: true, restoreFocus: false });
  }

  async function prepareQuickBundle({ regenerate = false } = {}) {
    if (!quickSendPanel) return;
    if (isPreparingQuickBundle) return;
    isPreparingQuickBundle = true;

    if (quickStatus) {
      quickStatus.textContent = 'Preparing encrypted bundle…';
      quickStatus.className = 'sync-status';
    }

    try {
      const snapshot = await exportRegistrySnapshot();
      const stats = snapshot;
      let displayPassphrase = quickState.passphrase;
      if (!displayPassphrase || regenerate) {
        displayPassphrase = generateQuickPassphrase();
      }

      const compactPassphrase = ensureQuickPassphrase(displayPassphrase);
      const payload = await encodeQuickPayload(snapshot, compactPassphrase);

      quickState.passphrase = formatQuickPassphrase(compactPassphrase);
      quickState.payload = payload;
      quickState.stats = stats;

      if (quickPassphraseLabel) {
        quickPassphraseLabel.textContent = quickState.passphrase;
      }
      if (quickPayloadTextarea) {
        quickPayloadTextarea.value = payload;
      }
      await renderQrCode(quickCanvas, payload);

      if (quickStatus) {
        if (stats && stats.sites) {
          const versions = countVersions(stats);
          quickStatus.textContent = `Bundle includes ${stats.sites} site${stats.sites === 1 ? '' : 's'} and ${versions} version${versions === 1 ? '' : 's'}. Share only after the receiver confirms the passphrase.`;
          quickStatus.className = 'sync-status sync-status--success';
        } else {
          quickStatus.textContent = 'No registry entries yet. The passphrase still protects future syncs.';
          quickStatus.className = 'sync-status';
        }
      }
    } catch (error) {
      if (quickStatus) {
        quickStatus.textContent = `Failed to prepare bundle: ${error.message}`;
        quickStatus.className = 'sync-status sync-status--error';
      }
      if (quickCanvas) clearCanvas(quickCanvas);
    } finally {
      isPreparingQuickBundle = false;
    }
  }

  async function handleCopyQuickPassphrase() {
    if (!quickState.passphrase) return;
    await copyToClipboard(quickState.passphrase, quickCopyPassphraseBtn);
  }

  async function handleCopyQuickPayload() {
    if (!quickState.payload) return;
    await copyToClipboard(quickState.payload, quickCopyPayloadBtn);
  }

  function handleQuickRegenerate() {
    void prepareQuickBundle({ regenerate: true });
  }

  async function handleQuickImport() {
    if (!quickInputTextarea || !quickPassphraseInput) return;

    const rawPassphrase = quickPassphraseInput.value;
    let compactPassphrase;
    try {
      compactPassphrase = ensureQuickPassphrase(rawPassphrase);
    } catch (error) {
      updateQuickImportStatus(error.message, true);
      return;
    }

    const rawPayload = quickInputTextarea.value.trim();
    if (!rawPayload) {
      updateQuickImportStatus('Paste the encrypted bundle from the sender.', true);
      return;
    }

    let envelope;
    try {
      envelope = decodeQuickPayload(rawPayload);
    } catch (error) {
      updateQuickImportStatus(error.message, true);
      return;
    }

    try {
      const snapshot = await decryptQuickPayload(envelope, compactPassphrase);
      const { importedSites, importedVersions } = await importRegistrySnapshot(snapshot);
      updateQuickImportStatus(`✅ Imported ${importedVersions} version${importedVersions === 1 ? '' : 's'} across ${importedSites} site${importedSites === 1 ? '' : 's'}.`, false);
      quickInputTextarea.value = '';
      quickPassphraseInput.value = '';

      if (typeof refreshHistoryList === 'function') {
        const searchValue = document.getElementById('searchHistory')?.value?.trim() || '';
        await refreshHistoryList(searchValue);
      }
      if (typeof updateStorageInfo === 'function') {
        await updateStorageInfo();
      }
    } catch (error) {
      updateQuickImportStatus(`❌ Import failed: ${error.message}`, true);
    }
  }

  function isQuickScannerOpen() {
    return quickScanner && !quickScanner.classList.contains('hidden');
  }

  async function handleQuickScan() {
    if (!quickScanner || !quickScannerVideo || !quickScannerStatus) return;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      updateQuickImportStatus('Camera access is not available in this browser. Paste the bundle manually.', true);
      return;
    }

    try {
      if (!quickScannerDetector && typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        quickScannerDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch (error) {
      quickScannerDetector = null;
    }

    if (!quickScannerDetector) {
      updateQuickImportStatus('QR scanning is not supported in this browser. Paste the bundle manually.', true);
      return;
    }

    if (isQuickScannerActive) return;

    try {
      quickScannerStatus.textContent = 'Opening camera…';
      quickScanner.classList.remove('hidden');
      quickScannerVideo.srcObject = null;
      quickScannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      quickScannerVideo.srcObject = quickScannerStream;
      isQuickScannerActive = true;
      await quickScannerVideo.play();
      quickScannerStatus.textContent = 'Align the QR code within the frame.';
      quickScannerCloseBtn?.focus();
      quickScannerFrameId = requestAnimationFrame(scanQuickFrame);
    } catch (error) {
      closeQuickScanner({ silent: true });
      updateQuickImportStatus('Camera permission denied. Paste the bundle manually.', true);
    }
  }

  async function scanQuickFrame() {
    if (!isQuickScannerActive || !quickScannerDetector || !quickScannerVideo) return;

    if (quickScannerVideo.readyState < 2) {
      quickScannerFrameId = requestAnimationFrame(scanQuickFrame);
      return;
    }

    try {
      const barcodes = await quickScannerDetector.detect(quickScannerVideo);
      const hit = barcodes.find(code => typeof code.rawValue === 'string' && code.rawValue.trim().length > 0);
      if (hit) {
        const value = hit.rawValue.trim();
        if (quickInputTextarea) {
          quickInputTextarea.value = value;
        }
        updateQuickImportStatus('Encrypted bundle captured from QR. Confirm the passphrase, then import.', false);
        closeQuickScanner();
        return;
      }
      quickScannerStatus.textContent = 'Hold steady—scanning…';
    } catch (error) {
      quickScannerStatus.textContent = 'Unable to read QR yet. Adjust lighting or distance.';
    }

    quickScannerFrameId = requestAnimationFrame(scanQuickFrame);
  }

  function closeQuickScanner({ silent = false, restoreFocus = true } = {}) {
    if (!quickScanner) return;
    if (quickScannerFrameId) {
      cancelAnimationFrame(quickScannerFrameId);
      quickScannerFrameId = 0;
    }
    if (quickScannerVideo) {
      try {
        quickScannerVideo.pause();
      } catch (error) {
        // ignore pause errors
      }
      quickScannerVideo.srcObject = null;
    }
    if (quickScannerStream) {
      quickScannerStream.getTracks().forEach(track => track.stop());
      quickScannerStream = null;
    }
    isQuickScannerActive = false;
    quickScanner.classList.add('hidden');
    if (!silent && quickScannerStatus) {
      quickScannerStatus.textContent = 'Allow camera access and point it at the sender QR.';
    }
    if (restoreFocus && quickScanBtn && !quickScanBtn.disabled) {
      quickScanBtn.focus();
    }
  }

  function updateQuickImportStatus(message, isError) {
    if (!quickImportStatus) return;
    quickImportStatus.textContent = message;
    quickImportStatus.className = `sync-status${isError ? ' sync-status--error' : ' sync-status--success'}`;
  }

  function resetQuickState() {
    quickState.passphrase = '';
    quickState.payload = '';
    quickState.stats = null;
  }

  syncBtn.addEventListener('click', () => openModal('send'));
  closeBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target !== modal) return;
    if (isQuickScannerOpen()) {
      closeQuickScanner();
      return;
    }
    closeModal();
  });
  modeButtons.forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));
  const canAttemptScan =
    typeof navigator !== 'undefined' &&
    !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') &&
    typeof window !== 'undefined' &&
    'BarcodeDetector' in window;

  if (quickScanBtn && !canAttemptScan) {
    quickScanBtn.disabled = true;
    quickScanBtn.title = 'QR scanning is not supported in this browser.';
  }

  quickCopyPassphraseBtn?.addEventListener('click', handleCopyQuickPassphrase);
  quickRegenerateBtn?.addEventListener('click', handleQuickRegenerate);
  quickCopyPayloadBtn?.addEventListener('click', handleCopyQuickPayload);
  quickImportBtn?.addEventListener('click', handleQuickImport);
  quickScanBtn?.addEventListener('click', handleQuickScan);
  quickScannerCloseBtn?.addEventListener('click', () => closeQuickScanner());
  quickScanner?.addEventListener('click', event => {
    if (event.target === quickScanner) {
      closeQuickScanner();
    }
  });
}

function countVersions(stats) {
  if (!stats || !Array.isArray(stats.entries)) return 0;
  return stats.entries.reduce((total, entry) => total + (entry.versions?.length || 0), 0);
}

async function encodeQuickPayload(snapshot, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveQuickAesKey(passphrase, salt, QUICK_KDF_ITERATIONS);
  const plaintext = textEncoder.encode(JSON.stringify(snapshot));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext));

  const envelope = {
    v: PAYLOAD_VERSION,
    t: 'quick',
    iter: QUICK_KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    c: toBase64(ciphertext)
  };

  return `${QUICK_PREFIX}${encodeText(JSON.stringify(envelope))}`;
}

function decodeQuickPayload(payload) {
  const cleaned = payload.trim();
  if (!cleaned.startsWith(QUICK_PREFIX)) {
    throw new Error('Payload is not a quick transfer bundle.');
  }

  const encoded = cleaned.slice(QUICK_PREFIX.length).replace(/\s+/g, '');
  let json;
  try {
    json = decodeText(encoded);
  } catch (error) {
    throw new Error('Payload data is corrupted or incomplete.');
  }

  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch (error) {
    throw new Error('Failed to parse payload JSON.');
  }

  if (!envelope || envelope.v !== PAYLOAD_VERSION || envelope.t !== 'quick') {
    throw new Error('Payload is not a quick transfer bundle.');
  }

  return envelope;
}

async function deriveQuickAesKey(passphrase, saltBytes, iterations) {
  const passphraseBytes = textEncoder.encode(passphrase);
  const baseKey = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations
    },
    baseKey,
    256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function decryptQuickPayload(envelope, passphrase) {
  if (!envelope || envelope.t !== 'quick') {
    throw new Error('Payload is not a quick transfer bundle.');
  }
  if (!envelope.salt || !envelope.iv || !envelope.c) {
    throw new Error('Payload missing encryption fields.');
  }

  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  const ciphertext = fromBase64(envelope.c);
  const iterations = typeof envelope.iter === 'number' && envelope.iter > 0 ? envelope.iter : QUICK_KDF_ITERATIONS;
  const aesKey = await deriveQuickAesKey(passphrase, salt, iterations);

  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
    return JSON.parse(textDecoder.decode(new Uint8Array(decrypted)));
  } catch (error) {
    throw new Error('Unable to decrypt payload. Double-check the passphrase and try again.');
  }
}

function ensureQuickPassphrase(value) {
  const compact = compactQuickPassphrase(value);
  if (compact.length < QUICK_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must include at least ${QUICK_MIN_PASSPHRASE_LENGTH} characters (four groups).`);
  }
  return compact;
}

function compactQuickPassphrase(value) {
  return (value || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
}

function formatQuickPassphrase(compact) {
  return compact.match(/.{1,4}/g)?.join('-') || compact;
}

function generateQuickPassphrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const compact = base32Encode(bytes).slice(0, QUICK_MIN_PASSPHRASE_LENGTH);
  return formatQuickPassphrase(compact);
}

async function renderQrCode(canvas, value) {
  if (!canvas) return;
  if (!value) {
    clearCanvas(canvas);
    return;
  }

  if (
    typeof QRCode === 'undefined' ||
    typeof QRCode.toCanvas !== 'function' ||
    typeof QRCode.create !== 'function'
  ) {
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width || 220, canvas.height || 220);
      context.font = '14px monospace';
      context.fillText('QR unavailable', 10, 20);
    }
    return;
  }

  const config = selectQrRenderConfig(value);

  return new Promise((resolve, reject) => {
    QRCode.toCanvas(
      canvas,
      value,
      { width: 320, margin: 6, minScale: 5, errorCorrectionLevel: 'Q' },
      error => {
        if (error) {
          reject(error);
          return;
        }
        canvas.dataset.qrModules = String(config.moduleCount);
        canvas.dataset.qrLevel = config.errorCorrectionLevel;
        if (typeof canvas.setAttribute === 'function') {
          canvas.setAttribute(
            'aria-label',
            `QR code with ${config.moduleCount}×${config.moduleCount} modules using ${config.errorCorrectionLevel}-level error correction`
          );
        }
        resolve();
      }
    );
  });
}

function selectQrRenderConfig(value) {
  const levels = ['M', 'Q', 'L'];
  const maxDenseModules = 135;
  const maxCanvasSize = 640;
  const configs = [];
  let lastError = null;

  for (const level of levels) {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: level });
      const moduleCount = qr.getModuleCount();
      configs.push({ level, moduleCount });
      if (moduleCount <= maxDenseModules) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!configs.length) {
    if (lastError && /code length overflow/i.test(lastError.message)) {
      throw new Error('Payload exceeds the maximum QR capacity. Copy the payload instead.');
    }
    throw lastError || new Error('Unable to encode payload.');
  }

  const selected =
    configs.find(config => config.moduleCount <= maxDenseModules) || configs[configs.length - 1];

  let margin = selected.moduleCount > 120 ? 6 : 5;
  let preferredScale = 6;

  if (selected.moduleCount > 150) {
    preferredScale = 4;
  } else if (selected.moduleCount > 110) {
    preferredScale = 5;
  }

  const totalModules = selected.moduleCount + margin * 2;
  const maxScale = Math.max(4, Math.floor(maxCanvasSize / totalModules));
  const scale = Math.max(4, Math.min(preferredScale, maxScale));

  return {
    margin,
    scale,
    errorCorrectionLevel: selected.level,
    moduleCount: selected.moduleCount
  };
}

function clearCanvas(canvas) {
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, canvas.width || 220, canvas.height || 220);
  }
  if (canvas.dataset) {
    delete canvas.dataset.qrModules;
    delete canvas.dataset.qrLevel;
  }
  if (typeof canvas.removeAttribute === 'function') {
    canvas.removeAttribute('aria-label');
  }
}

let syncToastTimer = null;

function showSyncToast(message, { tone = 'error', duration = 4000 } = {}) {
  const toast = document.getElementById('syncToast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove('sync-toast--success', 'sync-toast--error');
  toast.classList.add(tone === 'success' ? 'sync-toast--success' : 'sync-toast--error');
  toast.classList.add('sync-toast--visible');

  clearTimeout(syncToastTimer);
  syncToastTimer = setTimeout(() => {
    toast.classList.remove('sync-toast--visible');
  }, duration);
}

async function copyToClipboard(value, button) {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    showSyncToast('Clipboard access is unavailable. Please copy the payload manually.', { tone: 'error' });
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copy unavailable';
      setTimeout(() => {
        button.textContent = original;
      }, 2500);
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    if (button) {
      button.classList.add('sync-actions__success');
      const original = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => {
        button.classList.remove('sync-actions__success');
        button.textContent = original;
      }, 2500);
    }
  } catch (error) {
    showSyncToast('Failed to copy to clipboard. Please copy the payload manually.', { tone: 'error' });
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copy failed';
      setTimeout(() => {
        button.textContent = original;
      }, 2500);
    }
  }
}

function encodeText(value) {
  const bytes = textEncoder.encode(value);
  return base32Encode(bytes);
}

function decodeText(value) {
  const sanitized = value.replace(/\s+/g, '');
  const base32Candidate = sanitized.toUpperCase();
  if (base32Pattern.test(base32Candidate)) {
    try {
      const decoded = base32Decode(base32Candidate);
      return textDecoder.decode(decoded);
    } catch (error) {
      // Fall through to legacy decoding on failure.
    }
  }

  const binary = atob(sanitized);
  const percentEncoded = Array.from(binary)
    .map(char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  return decodeURIComponent(percentEncoded);
}

const base32Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const base32Lookup = base32Alphabet.split('').reduce((lookup, char, index) => {
  lookup[char] = index;
  return lookup;
}, {});
const base32Pattern = /^[0-9A-Z]+$/;

function base32Encode(bytes) {
  if (!bytes || !bytes.length) return '';

  let output = '';
  let buffer = 0;
  let bitsLeft = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    buffer = (buffer << 8) | bytes[i];
    bitsLeft += 8;

    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      output += base32Alphabet[(buffer >> bitsLeft) & 0x1f];
    }
  }

  if (bitsLeft > 0) {
    output += base32Alphabet[(buffer << (5 - bitsLeft)) & 0x1f];
  }

  return output;
}

function base32Decode(value) {
  if (!value) return new Uint8Array(0);

  let buffer = 0;
  let bitsLeft = 0;
  const bytes = [];

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const val = base32Lookup[char];
    if (val === undefined) {
      throw new Error(`Invalid base32 character: ${char}`);
    }

    buffer = (buffer << 5) | val;
    bitsLeft += 5;

    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }

  const mask = (1 << bitsLeft) - 1;
  if (bitsLeft > 0 && (buffer & mask) !== 0) {
    throw new Error('Excess padding bits detected in base32 input.');
  }

  return new Uint8Array(bytes);
}

function toBase64(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
