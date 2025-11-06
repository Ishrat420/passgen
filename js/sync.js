import { exportRegistrySnapshot, importRegistrySnapshot } from './storage.js';

const SYNC_PREFIX = 'PGENSYNC-';
const LEGACY_SYNC_PREFIXES = ['PGENSYNC:', 'passgen-sync:'];
const PAYLOAD_VERSION = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const sendState = {
  keyPair: null,
  sessionId: '',
  snapshot: null,
  stats: null,
  code: '',
  offerPayload: '',
  finalPayload: ''
};

const receiveState = {
  keyPair: null,
  sessionId: '',
  secretBytes: null,
  code: '',
  responsePayload: ''
};

let isPreparingOffer = false;

export function initSyncUI({ refreshHistoryList, updateStorageInfo } = {}) {
  const syncBtn = document.getElementById('syncBtn');
  const modal = document.getElementById('syncModal');
  if (!syncBtn || !modal) return;

  const closeBtn = modal.querySelector('.sync-modal__close');
  const modeButtons = Array.from(modal.querySelectorAll('.sync-mode__btn'));
  const sendPanel = document.getElementById('syncSendPanel');
  const receivePanel = document.getElementById('syncReceivePanel');
  const regenerateBtn = document.getElementById('syncRegenerateBtn');
  const copyOfferBtn = document.getElementById('syncCopyOfferBtn');
  const copyFinalBtn = document.getElementById('syncCopyFinalBtn');
  const copyResponseBtn = document.getElementById('syncCopyResponseBtn');
  const processResponseBtn = document.getElementById('syncProcessResponseBtn');
  const processOfferBtn = document.getElementById('syncProcessOfferBtn');
  const importBtn = document.getElementById('syncImportBtn');

  const offerTextarea = document.getElementById('syncOfferPayload');
  const responseInput = document.getElementById('syncResponseInput');
  const finalTextarea = document.getElementById('syncFinalPayload');
  const sendStatus = document.getElementById('syncSendStatus');
  const responseTextarea = document.getElementById('syncResponsePayload');
  const offerInput = document.getElementById('syncOfferInput');
  const finalInput = document.getElementById('syncFinalInput');
  const confirmCodeInput = document.getElementById('syncCodeConfirm');
  const importStatus = document.getElementById('syncImportStatus');
  const sessionCodeLabel = document.getElementById('syncSessionCode');
  const receiverCodeLabel = document.getElementById('syncReceiverCode');
  const offerCanvas = document.getElementById('syncOfferQr');
  const finalCanvas = document.getElementById('syncFinalQr');
  const responseCanvas = document.getElementById('syncResponseQr');

  function switchMode(mode) {
    modeButtons.forEach(button => {
      const isActive = button.dataset.mode === mode;
      button.classList.toggle('sync-mode__btn--active', isActive);
    });

    if (mode === 'receive') {
      sendPanel.classList.add('hidden');
      receivePanel.classList.remove('hidden');
      resetSendState();
      if (importStatus) {
        importStatus.textContent = '';
        importStatus.className = 'sync-status';
      }
      clearReceiveUi();
    } else {
      receivePanel.classList.add('hidden');
      sendPanel.classList.remove('hidden');
      resetReceiveState();
      void prepareSendOffer();
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') closeModal();
  }

  function openModal(defaultMode = 'send') {
    modal.classList.remove('hidden');
    document.body.classList.add('sync-modal-open');
    document.addEventListener('keydown', handleKeydown);
    switchMode(defaultMode);
  }

  function closeModal() {
    modal.classList.add('hidden');
    document.body.classList.remove('sync-modal-open');
    document.removeEventListener('keydown', handleKeydown);
    resetSendState();
    resetReceiveState();
    clearSendUi();
    clearReceiveUi();
  }

  function clearSendUi() {
    if (offerTextarea) offerTextarea.value = '';
    if (responseInput) responseInput.value = '';
    if (finalTextarea) finalTextarea.value = '';
    if (sessionCodeLabel) sessionCodeLabel.textContent = '———';
    if (sendStatus) {
      sendStatus.textContent = '';
      sendStatus.className = 'sync-status';
    }
    if (offerCanvas) clearCanvas(offerCanvas);
    if (finalCanvas) clearCanvas(finalCanvas);
  }

  function clearReceiveUi() {
    if (offerInput) offerInput.value = '';
    if (responseTextarea) responseTextarea.value = '';
    if (finalInput) finalInput.value = '';
    if (receiverCodeLabel) receiverCodeLabel.textContent = '———';
    if (confirmCodeInput) confirmCodeInput.value = '';
    if (importStatus) {
      importStatus.textContent = '';
      importStatus.className = 'sync-status';
    }
    if (responseCanvas) clearCanvas(responseCanvas);
  }

  async function prepareSendOffer() {
    if (isPreparingOffer) return;
    isPreparingOffer = true;
    resetSendState();
    clearSendUi();

    try {
      const snapshot = await exportRegistrySnapshot();
      const stats = snapshot;
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits', 'deriveKey']
      );
      const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
      const sessionId = generateSessionId();

      const offerEnvelope = {
        v: PAYLOAD_VERSION,
        t: 'offer',
        session: sessionId,
        senderPub: toBase64(publicKeyBytes),
        meta: {
          exportedAt: snapshot.exportedAt,
          sites: snapshot.sites,
          versions: countVersions(snapshot)
        }
      };

      const encodedOffer = encodeEnvelope(offerEnvelope);

      sendState.keyPair = keyPair;
      sendState.sessionId = sessionId;
      sendState.snapshot = snapshot;
      sendState.stats = stats;
      sendState.offerPayload = encodedOffer;

      if (offerTextarea) offerTextarea.value = encodedOffer;
      await renderQrCode(offerCanvas, encodedOffer);

      if (sendStatus) {
        if (stats && stats.sites) {
          const versions = countVersions(stats);
          sendStatus.textContent = `Offering ${stats.sites} site${stats.sites === 1 ? '' : 's'} with ${versions} version${versions === 1 ? '' : 's'}.`;
        } else {
          sendStatus.textContent = 'No registry entries yet. You can still pair to prepare for future syncs.';
        }
        sendStatus.className = 'sync-status';
      }
    } catch (error) {
      if (sendStatus) {
        sendStatus.textContent = `Failed to prepare offer: ${error.message}`;
        sendStatus.className = 'sync-status sync-status--error';
      }
    } finally {
      isPreparingOffer = false;
    }
  }

  async function handleCopyOffer() {
    if (!sendState.offerPayload) return;
    await copyToClipboard(sendState.offerPayload, copyOfferBtn);
  }

  async function handleCopyFinal() {
    if (!sendState.finalPayload) return;
    await copyToClipboard(sendState.finalPayload, copyFinalBtn);
  }

  async function handleCopyResponse() {
    if (!receiveState.responsePayload) return;
    await copyToClipboard(receiveState.responsePayload, copyResponseBtn);
  }

  async function handleProcessResponse() {
    if (!responseInput) return;
    const raw = responseInput.value.trim();
    if (!raw) {
      updateSendStatus('Paste the receiver\'s response payload first.', true);
      return;
    }

    if (!sendState.keyPair || !sendState.sessionId || !sendState.snapshot) {
      updateSendStatus('Offer session missing. Regenerate and start again.', true);
      return;
    }

    let envelope;
    try {
      envelope = decodeEnvelope(raw);
    } catch (error) {
      updateSendStatus(error.message, true);
      return;
    }

    if (envelope.t !== 'response') {
      updateSendStatus('Payload is not a response envelope.', true);
      return;
    }

    if (envelope.session !== sendState.sessionId) {
      updateSendStatus('Response session does not match the active offer.', true);
      return;
    }

    if (!envelope.receiverPub) {
      updateSendStatus('Response missing receiver public key.', true);
      return;
    }

    try {
      const receiverKey = await importRawPublicKey(fromBase64(envelope.receiverPub));
      const secretBytes = await deriveSharedSecret(sendState.keyPair.privateKey, receiverKey);
      const proof = await deriveProof(secretBytes, sendState.sessionId);
      if (envelope.proof !== proof) {
        updateSendStatus('Response integrity check failed. Ask the receiver to regenerate.', true);
        return;
      }

      const code = await derivePairingCode(secretBytes, sendState.sessionId);
      const keySalt = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await deriveAesKey(secretBytes, keySalt);
      const { ciphertext, iv, digest } = await encryptSnapshot(sendState.snapshot, aesKey);

      const dataEnvelope = {
        v: PAYLOAD_VERSION,
        t: 'data',
        session: sendState.sessionId,
        iv: toBase64(iv),
        c: toBase64(ciphertext),
        h: toBase64(digest),
        salt: toBase64(keySalt),
        auth: code,
        meta: {
          exportedAt: sendState.snapshot.exportedAt,
          sites: sendState.stats?.sites || 0,
          versions: countVersions(sendState.stats)
        }
      };

      const encodedData = encodeEnvelope(dataEnvelope);
      sendState.finalPayload = encodedData;
      sendState.code = code;

      if (sessionCodeLabel) sessionCodeLabel.textContent = code;
      if (finalTextarea) finalTextarea.value = encodedData;
      await renderQrCode(finalCanvas, encodedData);
      updateSendStatus(`Ready to share encrypted bundle. Confirm code ${code} with the receiver before sending.`, false);
    } catch (error) {
      updateSendStatus(`Failed to process response: ${error.message}`, true);
    }
  }

  async function handleProcessOffer() {
    if (!offerInput) return;
    const raw = offerInput.value.trim();
    if (!raw) {
      updateReceiveStatus('Paste the offer payload from the sender.', true);
      return;
    }

    let envelope;
    try {
      envelope = decodeEnvelope(raw);
    } catch (error) {
      updateReceiveStatus(error.message, true);
      return;
    }

    if (envelope.t !== 'offer') {
      updateReceiveStatus('Payload is not a pairing offer.', true);
      return;
    }

    if (!envelope.senderPub) {
      updateReceiveStatus('Offer missing sender public key.', true);
      return;
    }

    try {
      const senderKey = await importRawPublicKey(fromBase64(envelope.senderPub));
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits', 'deriveKey']
      );
      const secretBytes = await deriveSharedSecret(keyPair.privateKey, senderKey);
      const proof = await deriveProof(secretBytes, envelope.session);
      const code = await derivePairingCode(secretBytes, envelope.session);
      const receiverPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

      const responseEnvelope = {
        v: PAYLOAD_VERSION,
        t: 'response',
        session: envelope.session,
        receiverPub: toBase64(receiverPubBytes),
        proof
      };

      const encodedResponse = encodeEnvelope(responseEnvelope);

      receiveState.keyPair = keyPair;
      receiveState.sessionId = envelope.session;
      receiveState.secretBytes = secretBytes;
      receiveState.code = code;
      receiveState.responsePayload = encodedResponse;

      if (receiverCodeLabel) receiverCodeLabel.textContent = code;
      if (responseTextarea) responseTextarea.value = encodedResponse;
      await renderQrCode(responseCanvas, encodedResponse);
      updateReceiveStatus('Share this response with the sender, then wait for the final payload.', false);
    } catch (error) {
      resetReceiveState();
      updateReceiveStatus(`Failed to process offer: ${error.message}`, true);
    }
  }

  async function handleImport() {
    if (!finalInput) return;
    const rawPayload = finalInput.value.trim();
    if (!rawPayload) {
      updateReceiveStatus('Paste the final payload from the sender.', true);
      return;
    }

    if (!receiveState.sessionId || !receiveState.secretBytes) {
      updateReceiveStatus('Pairing not ready. Process the offer first.', true);
      return;
    }

    let envelope;
    try {
      envelope = decodeEnvelope(rawPayload);
    } catch (error) {
      updateReceiveStatus(error.message, true);
      return;
    }

    if (envelope.t !== 'data') {
      updateReceiveStatus('Payload is not the final data bundle.', true);
      return;
    }

    if (envelope.session !== receiveState.sessionId) {
      updateReceiveStatus('Session mismatch. Ensure you are importing the matching payload.', true);
      return;
    }

    if (!envelope.iv || !envelope.c) {
      updateReceiveStatus('Payload missing encryption fields.', true);
      return;
    }

    if (!envelope.salt) {
      updateReceiveStatus('Payload missing key derivation salt.', true);
      return;
    }

    try {
      const expectedCode = await derivePairingCode(receiveState.secretBytes, receiveState.sessionId);

      if (!confirmCodeInput) {
        updateReceiveStatus('Pairing code confirmation input missing.', true);
        return;
      }

      const typedCode = confirmCodeInput.value.replace(/\s+/g, '');
      if (!typedCode) {
        updateReceiveStatus('Enter the pairing code you heard from the sender.', true);
        return;
      }

      if (!/^\d{8}$/.test(typedCode)) {
        updateReceiveStatus('Pairing codes are 8 digits. Double-check and try again.', true);
        return;
      }

      if (typedCode !== expectedCode) {
        updateReceiveStatus('The entered pairing code does not match this session.', true);
        return;
      }

      if (envelope.auth !== expectedCode) {
        updateReceiveStatus('Received payload failed the pairing code check. Rejecting payload.', true);
        return;
      }

      const aesKey = await deriveAesKey(receiveState.secretBytes, fromBase64(envelope.salt));

      const snapshot = await decryptSnapshot(
        {
          iv: fromBase64(envelope.iv),
          ciphertext: fromBase64(envelope.c),
          digest: envelope.h ? fromBase64(envelope.h) : null
        },
        aesKey
      );

      const { importedSites, importedVersions } = await importRegistrySnapshot(snapshot);
      updateReceiveStatus(`✅ Imported ${importedVersions} version${importedVersions === 1 ? '' : 's'} across ${importedSites} site${importedSites === 1 ? '' : 's'}.`, false);
      finalInput.value = '';
      confirmCodeInput.value = '';

      if (typeof refreshHistoryList === 'function') {
        const searchValue = document.getElementById('searchHistory')?.value?.trim() || '';
        await refreshHistoryList(searchValue);
      }
      if (typeof updateStorageInfo === 'function') {
        await updateStorageInfo();
      }
    } catch (error) {
      updateReceiveStatus(`❌ Import failed: ${error.message}`, true);
    }
  }

  function updateSendStatus(message, isError) {
    if (!sendStatus) return;
    sendStatus.textContent = message;
    sendStatus.className = `sync-status${isError ? ' sync-status--error' : ' sync-status--success'}`;
  }

  function updateReceiveStatus(message, isError) {
    if (!importStatus) return;
    importStatus.textContent = message;
    importStatus.className = `sync-status${isError ? ' sync-status--error' : ' sync-status--success'}`;
  }

  function resetSendState() {
    sendState.keyPair = null;
    sendState.sessionId = '';
    sendState.snapshot = null;
    sendState.stats = null;
    sendState.code = '';
    sendState.offerPayload = '';
    sendState.finalPayload = '';
  }

  function resetReceiveState() {
    receiveState.keyPair = null;
    receiveState.sessionId = '';
    receiveState.secretBytes = null;
    receiveState.code = '';
    receiveState.responsePayload = '';
  }

  syncBtn.addEventListener('click', () => openModal('send'));
  closeBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
  modeButtons.forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));
  regenerateBtn?.addEventListener('click', prepareSendOffer);
  copyOfferBtn?.addEventListener('click', handleCopyOffer);
  copyFinalBtn?.addEventListener('click', handleCopyFinal);
  copyResponseBtn?.addEventListener('click', handleCopyResponse);
  processResponseBtn?.addEventListener('click', handleProcessResponse);
  processOfferBtn?.addEventListener('click', handleProcessOffer);
  importBtn?.addEventListener('click', handleImport);
}

export { encodeEnvelope, decodeEnvelope };

function countVersions(stats) {
  if (!stats || !Array.isArray(stats.entries)) return 0;
  return stats.entries.reduce((total, entry) => total + (entry.versions?.length || 0), 0);
}

function generateSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 20);
}

function encodeEnvelope(envelope) {
  return `${SYNC_PREFIX}${encodeText(JSON.stringify(envelope))}`;
}

function decodeEnvelope(payload) {
  const cleaned = payload.trim();
  const knownPrefixes = [SYNC_PREFIX, ...LEGACY_SYNC_PREFIXES];
  const detectedPrefix = knownPrefixes.find(prefix => cleaned.startsWith(prefix));
  if (!detectedPrefix) {
    throw new Error('Invalid payload format. Expecting QR data from PasswordGen.');
  }

  const encoded = cleaned.slice(detectedPrefix.length).replace(/\s+/g, '');
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

  if (!envelope || envelope.v !== PAYLOAD_VERSION) {
    throw new Error('Unsupported payload version.');
  }

  return envelope;
}

async function deriveSharedSecret(privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

async function deriveKeyMaterial(secretBytes, saltBytes, info, length) {
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const infoBytes = typeof info === 'string' ? textEncoder.encode(info) : info;
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: infoBytes
    },
    baseKey,
    length * 8
  );
  return new Uint8Array(bits);
}

async function deriveAesKey(secretBytes, saltBytes) {
  const material = await deriveKeyMaterial(secretBytes, saltBytes, 'passgen:sync:aes', 32);
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function deriveProof(secretBytes, sessionId) {
  const salt = textEncoder.encode(`passgen:sync:proof:${sessionId}`);
  const material = await deriveKeyMaterial(secretBytes, salt, 'passgen:sync:proof', 32);
  return toBase64(material);
}

async function derivePairingCode(secretBytes, sessionId) {
  const salt = textEncoder.encode(`passgen:sync:code:${sessionId}`);
  const material = await deriveKeyMaterial(secretBytes, salt, 'passgen:sync:code', 4);
  let value = 0n;
  for (const byte of material) {
    value = (value << 8n) | BigInt(byte);
  }
  const codeNumber = Number(value % 100000000n);
  return codeNumber.toString().padStart(8, '0');
}

async function encryptSnapshot(snapshot, aesKey) {
  const plaintext = textEncoder.encode(JSON.stringify(snapshot));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const digest = await crypto.subtle.digest('SHA-256', plaintext);
  return { ciphertext: new Uint8Array(ciphertext), iv, digest: new Uint8Array(digest) };
}

async function decryptSnapshot({ iv, ciphertext, digest }, aesKey) {
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
    const plaintext = new Uint8Array(decrypted);
    if (digest) {
      const computed = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext));
      if (!compareBytes(digest, computed)) {
        throw new Error('Integrity check failed.');
      }
    }
    return JSON.parse(textDecoder.decode(plaintext));
  } catch (error) {
    throw new Error(error.message || 'Unable to decrypt payload.');
  }
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
      {
        margin: config.margin,
        scale: config.scale,
        errorCorrectionLevel: config.errorCorrectionLevel
      },
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

async function importRawPublicKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

function compareBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
