/* ==========================================================================
   CONSTANTS
   ========================================================================== */

const CHARSETS = {
  lowers: 'abcdefghijklmnopqrstuvwxyz',
  uppers: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?'
};


/* ==========================================================================
   INITIALIZATION — Runs when DOM is ready
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initToggleExclusivity();
});


/* ==========================================================================
   TOGGLE HANDLING — Mutual exclusivity between Policy and Compatibility
   ========================================================================== */

function initToggleExclusivity() {
  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  const policyLabel = document.querySelector('label[for="policyToggle"]');
  const compatLabel = document.querySelector('label[for="compatToggle"]');

  // Add lock icons dynamically
  const policyLock = createLockIcon();
  const compatLock = createLockIcon();
  policyLabel.appendChild(policyLock);
  compatLabel.appendChild(compatLock);

  // Update visual states
  const updateUI = () => {
    updateToggleVisual(policyToggle, policyLabel, policyLock);
    updateToggleVisual(compatToggle, compatLabel, compatLock);
  };

  policyToggle.addEventListener('change', () => {
    if (policyToggle.checked) {
      compatToggle.checked = false;
      compatToggle.disabled = true;
    } else {
      compatToggle.disabled = false;
    }
    updateUI();
  });

  compatToggle.addEventListener('change', () => {
    if (compatToggle.checked) {
      policyToggle.checked = false;
      policyToggle.disabled = true;
    } else {
      policyToggle.disabled = false;
    }
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
  if (toggle.disabled) {
    label.classList.add('disabled');
    lock.classList.add('show');
  } else {
    label.classList.remove('disabled');
    lock.classList.remove('show');
  }
}


/* ==========================================================================
   UTILITY FUNCTIONS
   ========================================================================== */

function normalizeSite(site) {
  try {
    let url = site.trim();
    if (!url.includes('://')) url = 'https://' + url;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return site.toLowerCase().trim();
  }
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}


/* ==========================================================================
   CRYPTOGRAPHY HELPERS
   ========================================================================== */

async function pbkdf2(pass, salt, iters = 100000, len = 32) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: iters, hash: 'SHA-256' },
    key,
    len * 8
  );
  return bufferToHex(bits);
}

async function argon2Hash(pass, salt, memMB = 64) {
  const opts = {
    pass,
    salt,
    time: 3,
    mem: memMB * 1024,
    parallelism: 1,
    hashLen: 32,
    type: argon2.ArgonType.Argon2id
  };
  const { hashHex } = await argon2.hash(opts);
  return hashHex;
}

async function scryptHash(pass, salt, N = 16384) {
  const enc = new TextEncoder();
  const dk = await scrypt.scrypt(enc.encode(pass), enc.encode(salt), N, 8, 1, 32);
  return bufferToHex(dk);
}

async function digestHex(input, algo = 'SHA-256') {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(algo, enc.encode(input));
  return bufferToHex(hashBuffer);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}


/* ==========================================================================
   PASSWORD GENERATION
   ========================================================================== */

function mapToPassword(hex, len = 16, policyOn = true, compatMode = false) {
  const bytes = hexToBytes(hex);

  const charset = compatMode
    ? CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + '!@#$%^&*()-_=+'
    : CHARSETS.lowers + CHARSETS.uppers + CHARSETS.digits + CHARSETS.symbols;

  let password = '';
  for (let i = 0; i < len; i++) {
    password += charset[bytes[i % bytes.length] % charset.length];
  }

  if (!policyOn) return password;

  // Ensure deterministic diversity (A-Z, a-z, 0-9, symbol)
  const arr = password.split('');
  const categories = [CHARSETS.uppers, CHARSETS.lowers, CHARSETS.digits, CHARSETS.symbols];

  categories.forEach((set, idx) => {
    const pos = bytes[idx + 4] % arr.length;
    arr[pos] = set[bytes[idx] % set.length];
  });

  return arr.join('');
}


/* ==========================================================================
   MAIN GENERATION WORKFLOW
   ========================================================================== */

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

  const nsite = normalizeSite(site);
  const combined = `${nsite}|${secret}|${counter}`;
  let hex;

  try {
    switch (algo) {
      case 'PBKDF2-SHA256':
        hex = await pbkdf2(secret, combined, parseInt(document.getElementById('iterations').value));
        break;
      case 'Argon2id':
        hex = await argon2Hash(secret, combined, parseInt(document.getElementById('argonMem').value));
        break;
      case 'scrypt':
        hex = await scryptHash(secret, combined, parseInt(document.getElementById('scryptN').value));
        break;
      default:
        hex = await digestHex(combined, algo);
    }

    const pwd = mapToPassword(hex, length, policyOn, compatMode);
    pwSpan.innerText = pwd;
    resultDiv.style.display = 'block';

    // Diversity warning
    warn.style.display = 'none';
    if (policyOn && !isPasswordDiverse(pwd)) {
      warn.innerText = "⚠️ Password lacks full character diversity. Try increasing 'Characters to Use'.";
      warn.style.display = 'block';
      setTimeout(() => (warn.style.display = 'none'), 8000);
    }

    // Recipe ID & auto-hide
    const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
    const rid = await digestHex(recipe, 'SHA-256');
    document.getElementById('recipeInfo').innerText = 'Recipe ID ' + rid.slice(0, 8);

    clearTimeout(window.hideTimer);
    window.hideTimer = setTimeout(() => (pwSpan.innerText = '•••••••• (hidden)'), 30000);

    document.getElementById('explainBox').style.display = 'none';
  } catch (err) {
    pwSpan.innerText = 'Error: ' + err.message;
  }
}


/* ==========================================================================
   HELPERS — UI & Explanation
   ========================================================================== */

function isPasswordDiverse(pwd) {
  return (
    /[A-Z]/.test(pwd) &&
    /[a-z]/.test(pwd) &&
    /\d/.test(pwd) &&
    /[^A-Za-z0-9]/.test(pwd)
  );
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
  const nsite = normalizeSite(site);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;

  const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
  const rid = await digestHex(recipe, 'SHA-256');

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

