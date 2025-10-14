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

const stores = {
  history: localforage.createInstance({ storeName: 'history' }),
  registry: localforage.createInstance({ storeName: 'registry' })
};


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

     if (/[|]/.test(site) || /[|]/.test(secret)) {
     throw new Error('Inputs may not contain "|" character');}

    let hex;
    switch (this.algorithm) {
      case 'PBKDF2-SHA256':
        const iters = parseInt(this.getValue('iterations', 100000), 10) || 100000;
        hex = await CryptoHelper.pbkdf2(secret, combined, iters);
        break;
      case 'Argon2id':
        const memMB = parseInt(this.getValue('argonMem', 64), 10) || 64;
        hex = await CryptoHelper.argon2(secret, combined, memMB);
        break;
      case 'scrypt':
        const N = parseInt(this.getValue('scryptN', 16384), 10) || 16384;
        hex = await CryptoHelper.scrypt(secret, combined, N);
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
  // --- Initialize toggle exclusivity ---
  initToggleExclusivity();

  // --- Attach Reset App Data button ---
  const resetBtn = document.getElementById('resetAppBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('⚠️ This will delete ALL stored recipes and registry data. Are you sure?')) return;

      try {
        await Promise.all([
          localforage.clear(),
          stores.history.clear(),
          stores.registry.clear()
        ]);

        updateHistoryList();

        // Hide any lingering version/info messages
        const registryMsg = document.getElementById('registryMessage');
        if (registryMsg) registryMsg.style.display = 'none';

        alert('✅ All app data has been cleared successfully!');
      } catch (err) {
        alert('❌ Failed to reset data: ' + err.message);
      }
    });
  }

  // --- Reactive fields: hide result box when changed ---
  const reactiveFields = [
    'website', 'secret', 'algorithm', 'counter', 'length',
    'policyToggle', 'compatToggle', 'iterations', 'argonMem', 'scryptN'
  ];

  const resultDiv = document.getElementById('result');
  function hideResultBox() {
    if (!resultDiv) return;
    resultDiv.classList.remove('result-visible');
    resultDiv.classList.add('result-hidden');
  }

  reactiveFields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', hideResultBox);
    el.addEventListener('change', hideResultBox);
  });
});


async function generate() {
  const site = document.getElementById('website').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algo = document.getElementById('algorithm').value;
  const length = parseInt(document.getElementById('length').value, 10);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;

  resetUI({ clearPassword: true, clearRecipe: true });

  if (!site || !secret) {
    resetUI({ showError: 'Please enter website and secret.', clearRecipe: true });
    return;
  }

  try {
    const generator = new PasswordGenerator({ algorithm: algo, length, policyOn, compatMode });

    // Generate password deterministically
    const { password, nsite, hex } = await generator.generate(site, secret, counter);

    // Update UI
    const pwSpan = document.getElementById('password');
    const copyBtn = document.getElementById('copyBtn');
    const diversityWarn = document.getElementById('diversityWarning');
    const recipeInfo = document.getElementById('recipeInfo');

    pwSpan.innerText = password;
    copyBtn.style.display = 'inline-block';

    diversityWarn.style.display = 'none';
    diversityWarn.innerText = '';

    // Check diversity if required
    if (policyOn && !generator.isDiverse(password)) {
      diversityWarn.innerText = "⚠️ Password lacks full character diversity.";
      diversityWarn.style.display = 'block';
      setTimeout(() => (diversityWarn.style.display = 'none'), 6000);
    }
      
      const resultDiv = document.getElementById('result');
      resultDiv.classList.remove('result-hidden');
      resultDiv.classList.add('result-visible');
      
      // Build recipe ID
      const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
      const rid = await CryptoHelper.digest(recipe, 'SHA-256');
      recipeInfo.innerText = 'Recipe ID ' + rid.slice(0, 8);

      // 🔍 Fetch registry entry first (fix for undefined)
      const registryEntry = await stores.registry.getItem(nsite);
      const registryMsg = document.getElementById('registryMessage');
      clearTimeout(window.registryFadeTimer);

      // Always reset visibility cleanly
      registryMsg.style.opacity = '1';
      registryMsg.style.display = 'none';
      registryMsg.innerText = '';
      
      if (registryEntry) {
        const versions = registryEntry.versions;
        const latestVersion = versions[versions.length - 1]; // last one added = latest
        const existing = versions.find(v => v.id === rid.slice(0, 8));

        if (existing) {
            registryMsg.innerHTML = `
              💡 You’ve generated this recipe before (v${existing.version}, ${new Date(existing.date).toLocaleDateString()}). 
              <br><small>Latest saved version for ${nsite}: v${latestVersion.version} </small>`;
        } else {
          // New recipe → compare against latest known version // add counter as well here 
          registryMsg.innerText = `🆕 This is a new recipe version (v${latestVersion.version + 1}) for ${nsite}.`;
        }

        registryMsg.style.opacity = '1';
        registryMsg.style.display = 'block';
        registryMsg.style.transition = 'opacity 1s ease';

        clearTimeout(window.registryFadeTimer);
        window.registryFadeTimer = setTimeout(() => {
          registryMsg.style.opacity = '0';
          setTimeout(() => (registryMsg.style.display = 'none'), 1000);
        }, 10000);
      }

    // Save to local storage
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
      
      // Update Registry (persistent version tracking)
      const existing = await stores.registry.getItem(nsite);
      if (!existing) {
        // First ever recipe for this site
        recipeData.version = 1;
        await stores.registry.setItem(nsite, { site: nsite, versions: [recipeData] });
      } else {
        // Check if same recipe ID already exists
        const alreadyExists = existing.versions.some(v => v.id === recipeData.id);
        if (!alreadyExists) {
          const newVersion = existing.versions.length + 1;
          recipeData.version = newVersion;
          existing.versions.push(recipeData);
          await stores.registry.setItem(nsite, existing);
        }
      }
      
    updateHistoryList();

    // Auto-hide password after 30s
    clearTimeout(window.hideTimer);
    window.hideTimer = setTimeout(() => {
      pwSpan.innerText = '•••••••• (hidden)';
    }, 30000);
  } catch (e) {
    resetUI({ showError: 'Error: ' + e.message, clearRecipe: true });
  }
}



/* ==========================================================================
   UI UTILITIES
   ========================================================================== */

function resetUI({ clearPassword = false, clearRecipe = false, showError = '' } = {}) {
  const resultDiv = document.getElementById('result');
  const pwSpan = document.getElementById('password');
  const recipeInfo = document.getElementById('recipeInfo');
  const diversityWarn = document.getElementById('diversityWarning');
  const copyBtn = document.getElementById('copyBtn');
  const explainBox = document.getElementById('explainBox');

  resultDiv.style.display = 'block';
  diversityWarn.style.display = 'none';
  explainBox.style.display = 'none';

  if (clearPassword) pwSpan.innerText = showError || '';
  if (clearRecipe) recipeInfo.innerText = '';
  if (showError) {
    pwSpan.innerText = `⚠️ ${showError}`;
    pwSpan.style.color = '#d33';
    copyBtn.style.display = 'none';
  } else {
    pwSpan.style.color = '';
    copyBtn.style.display = 'inline-block';
  }
}


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
  const pwSpan = document.getElementById('password');
  const btn = document.getElementById('copyBtn');
  const text = pwSpan.innerText.trim();
  const originalLabel = btn.innerText;

  if (text.includes('(hidden)')) {
    pwSpan.innerText = window.lastGeneratedPassword || '⚠️ Regenerate first.';
    btn.innerText = 'Copy';
    return;
  }

  if (!text || text.startsWith('⚠️')) return;

  window.lastGeneratedPassword = text;

  navigator.clipboard.writeText(text).then(() => {
    btn.classList.remove('copied');
    btn.innerText = 'Copied!';
    btn.classList.add('copied');

    clearTimeout(btn._resetTimeout);
    btn._resetTimeout = setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerText = originalLabel;
    }, 3000);
  }).catch(() => {
    btn.innerText = 'Error';
    btn.style.background = '#b71c1c';
    clearTimeout(btn._resetTimeout);
    btn._resetTimeout = setTimeout(() => {
      btn.innerText = originalLabel;
      btn.style.background = '';
    }, 3000);
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
    'Password is calculated with this recipe and the master phrase.',
    'The Recipe ID is a unique fingerprint of all your settings, except your master phrase.'
  ].join('\n');
}

/* ==========================================================================
   LOCAL RECIPE HISTORY + SEARCH + IMPORT/EXPORT
   ========================================================================== */

async function updateHistoryList(filter = '') {
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  const keys = await localforage.keys();

  if (!keys.length) {
    list.innerHTML = '<li style="color:#555;">No recipes saved yet.</li>';
    updateStorageInfo();
    return;
  }

  let filteredCount = 0;

  for (const key of keys) {
    const recipe = await localforage.getItem(key);
    if (filter && !recipe.site.toLowerCase().includes(filter.toLowerCase())) continue;
    filteredCount++;

    const li = document.createElement('li');
    li.innerHTML = `
      <strong>${recipe.site}</strong> — ${recipe.algorithm} <br>
      <small>
        ID: ${recipe.id} | Counter: ${recipe.counter} | ${recipe.length} chars |
        ${new Date(recipe.date).toLocaleString()}
      </small>
    `;
    list.appendChild(li);
  }

  if (filteredCount === 0) {
    list.innerHTML = '<li style="color:#999;">No matching results.</li>';
  }

  updateStorageInfo();
}

async function clearHistory() {
  if (confirm('Clear all saved recipes?')) {
    await localforage.clear();
    updateHistoryList();
  }
}

async function exportHistory() {
  const keys = await localforage.keys();
  const data = [];
  for (const key of keys) data.push(await localforage.getItem(key));

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'passwordgen_recipes.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importHistory() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Invalid file format');
      for (const recipe of data) {
        if (recipe.id && recipe.site) {
          await localforage.setItem(recipe.id, recipe);
        }
      }
      alert(`✅ Imported ${data.length} recipes`);
      updateHistoryList();
    } catch (err) {
      alert('❌ Failed to import JSON: ' + err.message);
    }
  };
  input.click();
}

async function updateStorageInfo() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    const usedMB = (usage / 1024 / 1024).toFixed(2);
    const quotaMB = (quota / 1024 / 1024).toFixed(0);
    document.getElementById('storageInfo').textContent = `Storage used: ${usedMB} MB / ${quotaMB} MB`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('searchHistory');
  search.addEventListener('input', e => updateHistoryList(e.target.value));
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
  document.getElementById('exportBtn').addEventListener('click', exportHistory);
  document.getElementById('importBtn').addEventListener('click', importHistory);
  updateHistoryList();

  // --- Hide result box when inputs change ---
  const reactiveFields = [
    'website', 'secret', 'algorithm', 'counter', 'length',
    'policyToggle', 'compatToggle', 'iterations', 'argonMem', 'scryptN'
  ];

  reactiveFields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', hideResultBox);
    el.addEventListener('change', hideResultBox);
  });

  function hideResultBox() {
    const resultDiv = document.getElementById('result');
    if (!resultDiv) return;
    resultDiv.classList.remove('result-visible');
    resultDiv.classList.add('result-hidden');
  }
});


