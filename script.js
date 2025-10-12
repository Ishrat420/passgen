/* ==========================================================================
   CONSTANTS
   ========================================================================== */

const CHARSETS = {
  lowers: 'abcdefghijklmnopqrstuvwxyz',
  uppers: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?'
};

/* --- Local Storage Setup --- */
localforage.config({
  name: 'PasswordGen',
  storeName: 'recipes',
  description: 'Stores recipe metadata for deterministic password generator'
});


/* ==========================================================================
   CLASS: CryptoHelper — Static cryptography utilities
   ========================================================================== */

class CryptoHelper {
  static async pbkdf2(pass, salt, iters = 100000, len = 32) {
    const e = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', e.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: e.encode(salt), iterations: iters, hash: 'SHA-256' },
      key,
      len * 8
    );
    return this.bufferToHex(bits);
  }

  static async argon2(pass, salt, memMB = 64) {
    const o = { pass, salt, time: 3, mem: memMB * 1024, parallelism: 1, hashLen: 32, type: argon2.ArgonType.Argon2id };
    const { hashHex } = await argon2.hash(o);
    return hashHex;
  }

  static async scrypt(pass, salt, N = 16384) {
    const e = new TextEncoder();
    const dk = await scrypt.scrypt(e.encode(pass), e.encode(salt), N, 8, 1, 32);
    return this.bufferToHex(dk);
  }

  static async digest(input, algo = 'SHA-256') {
    const e = new TextEncoder();
    const d = e.encode(input);
    const hash = await crypto.subtle.digest(algo, d);
    return this.bufferToHex(hash);
  }

  static bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}


/* ==========================================================================
   CLASS: PasswordGenerator
   ========================================================================== */

class PasswordGenerator {
  constructor({ algorithm, length, policyOn, compatMode }) {
    this.algorithm = algorithm;
    this.length = length;
    this.policyOn = policyOn;
    this.compatMode = compatMode;
  }

  async generate(site, secret, counter = '0') {
    const nsite = this.normalizeSite(site);
    const combined = `${nsite}|${secret}|${counter}`;

    let hex;
    switch (this.algorithm) {
      case 'PBKDF2-SHA256':
        hex = await CryptoHelper.pbkdf2(secret, combined, this.getValue('iterations', 100000));
        break;
      case 'Argon2id':
        hex = await CryptoHelper.argon2(secret, combined, this.getValue('argonMem', 64));
        break;
      case 'scrypt':
        hex = await CryptoHelper.scrypt(secret, combined, this.getValue('scryptN', 16384));
        break;
      default:
        hex = await CryptoHelper.digest(combined, this.algorithm);
    }

    const password = this.mapToPassword(hex);
    return { password, nsite, hex };
  }

  mapToPassword(hex) {
    const bytes = this.hexToBytes(hex);
    const charset = this.compatMode
      ? CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + '!@#$%^&*()-_=+'
      : CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + CHARSETS.symbols;

    let pwd = '';
    for (let i = 0; i < this.length; i++) {
      pwd += charset[bytes[i % bytes.length] % charset.length];
    }

    if (!this.policyOn) return pwd;

    // Ensure deterministic character diversity
    const arr = pwd.split('');
    const categories = [CHARSETS.uppers, CHARSETS.lowers, CHARSETS.digits, CHARSETS.symbols];
    categories.forEach((set, idx) => {
      const pos = bytes[idx + 4] % arr.length;
      arr[pos] = set[bytes[idx] % set.length];
    });

    return arr.join('');
  }

  // --- Helpers --------------------------------------------------------------
  hexToBytes(hex) {
    const a = [];
    for (let i = 0; i < hex.length; i += 2) a.push(parseInt(hex.slice(i, i + 2), 16));
    return a;
  }

  normalizeSite(site) {
    try {
      let u = site.trim();
      if (!u.includes('://')) u = 'https://' + u;
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return site.toLowerCase().trim();
    }
  }

  isDiverse(pwd) {
    return (
      /[A-Z]/.test(pwd) &&
      /[a-z]/.test(pwd) &&
      /\d/.test(pwd) &&
      /[^A-Za-z0-9]/.test(pwd)
    );
  }

  getValue(id, fallback) {
    const el = document.getElementById(id);
    return el ? parseInt(el.value, 10) : fallback;
  }
}


/* ==========================================================================
   UI CONTROLLER LOGIC
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initToggleExclusivity();
});

async function generate() {
  const site = document.getElementById('website').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algo = document.getElementById('algorithm').value;
  const length = parseInt(document.getElementById('length').value, 10);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;

  const resultDiv = document.getElementById('result');
  const pwSpan = document.getElementById('password');
  const warn = document.getElementById('diversityWarning');

  if (!site || !secret) {
    resultDiv.style.display = 'block';
    pwSpan.innerText = '⚠️ Please enter website and secret.';
    return;
  }

  const gen = new PasswordGenerator({ algorithm: algo, length, policyOn, compatMode });
  const { password, nsite } = await gen.generate(site, secret, counter);

  pwSpan.innerText = password;
  resultDiv.style.display = 'block';

  // Diversity feedback
  warn.style.display = 'none';
  if (policyOn && !gen.isDiverse(password)) {
    warn.innerText = "⚠️ Password lacks full character diversity. Try increasing 'Characters to Use'.";
    warn.style.display = 'block';
    setTimeout(() => (warn.style.display = 'none'), 8000);
  }

  // Recipe ID & auto-hide
  const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
  const rid = await CryptoHelper.digest(recipe, 'SHA-256');
  document.getElementById('recipeInfo').innerText = 'Recipe ID ' + rid.slice(0, 8);
    
    //Saving data locally
    const recipeData = {
      id: rid.slice(0, 8),
      site: nsite,
      algorithm: algo,
      length,
      counter,
      policyOn,
      compatMode,
      date: new Date().toISOString()
    };

    await localforage.setItem(recipeData.id, recipeData);
    updateHistoryList(); // refresh list after saving

  clearTimeout(window.hideTimer);
  window.hideTimer = setTimeout(() => (pwSpan.innerText = '•••••••• (hidden)'), 30000);

  document.getElementById('explainBox').style.display = 'none';
}


/* ==========================================================================
   UI UTILITIES
   ========================================================================== */

function initToggleExclusivity() {
  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  const policyLabel = document.querySelector('label[for="policyToggle"]');
  const compatLabel = document.querySelector('label[for="compatToggle"]');

  const policyLock = createLockIcon();
  const compatLock = createLockIcon();
  policyLabel.appendChild(policyLock);
  compatLabel.appendChild(compatLock);

  const updateUI = () => {
    updateToggleVisual(policyToggle, policyLabel, policyLock);
    updateToggleVisual(compatToggle, compatLabel, compatLock);
  };

  policyToggle.addEventListener('change', () => {
    compatToggle.disabled = policyToggle.checked;
    if (policyToggle.checked) compatToggle.checked = false;
    updateUI();
  });

  compatToggle.addEventListener('change', () => {
    policyToggle.disabled = compatToggle.checked;
    if (compatToggle.checked) policyToggle.checked = false;
    updateUI();
  });
}

function createLockIcon() {
  const lock = document.createElement('span');
  lock.className = 'switch-lock';
  lock.textContent = '🔒';
  return lock;
}

function updateToggleVisual(toggle, label, lock) {
  label.classList.toggle('disabled', toggle.disabled);
  lock.classList.toggle('show', toggle.disabled);
}

function copyToClipboard() {
  const text = document.getElementById('password').innerText;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    const original = btn.innerText;
    btn.innerText = 'Copied!';
    setTimeout(() => (btn.innerText = original), 2000);
  });
}

async function explainPassword() {
  const site = document.getElementById('website').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algo = document.getElementById('algorithm').value;
  const length = document.getElementById('length').value;
  const nsite = new PasswordGenerator({}).normalizeSite(site);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;

  const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
  const rid = await CryptoHelper.digest(recipe, 'SHA-256');

  const box = document.getElementById('explainBox');
  box.style.display = 'block';
  box.textContent = [
    `Algorithm: ${algo}`,
    `Normalized site: ${nsite}`,
    `Counter: ${counter}`,
    `Length: ${length}`,
    `Deterministic policy: ${policyOn}`,
    `Compatibility mode: ${compatMode}`,
    `Recipe ID: ${rid.slice(0, 8)}`,
    '',
    'All characters derived deterministically from this recipe and the master phrase.'
  ].join('\n');
}

/* ==========================================================================
   LOCAL RECIPE HISTORY
   ========================================================================== */

async function updateHistoryList() {
  const list = document.getElementById('historyList');
  list.innerHTML = ''; // clear previous list
  const keys = await localforage.keys();

  if (!keys.length) {
    list.innerHTML = '<li style="color:#555;">No recipes saved yet.</li>';
    return;
  }

  for (const key of keys) {
    const recipe = await localforage.getItem(key);
    const li = document.createElement('li');
    li.style.marginBottom = '0.3rem';
    li.innerHTML = `
      <strong>${recipe.site}</strong> 
      — ${recipe.algorithm}, #${recipe.counter}, ${recipe.length} chars
      <br><small>ID: ${recipe.id} | ${new Date(recipe.date).toLocaleString()}</small>
    `;
    list.appendChild(li);
  }
}

async function clearHistory() {
  if (confirm('Clear all saved recipes?')) {
    await localforage.clear();
    updateHistoryList();
  }
}

// Attach clear button listener
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
  updateHistoryList(); // load history on startup
});
