const lowers = 'abcdefghijklmnopqrstuvwxyz',
      uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      digits = '0123456789',
      symbols = '!@#$%^&*()-_=+[]{};:,.<>?';


// Handle mutual exclusivity between compatibility and diversity toggles
document.addEventListener('DOMContentLoaded', () => {
  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  const policyHint = document.getElementById('policyHint');
  const compatHint = document.getElementById('compatHint');
    
    function updateToggleState() {
      // Policy toggle visual state
      if (policyToggle.disabled) {
        policyLabel.classList.add('disabled');
        policyLock.classList.add('show');
      } else {
        policyLabel.classList.remove('disabled');
        policyLock.classList.remove('show');
      }

      // Compat toggle visual state
      if (compatToggle.disabled) {
        compatLabel.classList.add('disabled');
        compatLock.classList.add('show');
      } else {
        compatLabel.classList.remove('disabled');
        compatLock.classList.remove('show');
      }
    }

    policyToggle.addEventListener('change', () => {
      if (policyToggle.checked) {
        compatToggle.checked = false;
        compatToggle.disabled = true;
      } else {
        compatToggle.disabled = false;
      }
      updateToggleState();
    });

    compatToggle.addEventListener('change', () => {
      if (compatToggle.checked) {
        policyToggle.checked = false;
        policyToggle.disabled = true;
      } else {
        policyToggle.disabled = false;
      }
      updateToggleState();
    });
});

function normalizeSite(site) {
  try {
    let u = site.trim();
    if (!u.includes('://')) u = 'https://' + u;
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return site.toLowerCase().trim();
  }
}

function hexToBytes(hex) {
  const a = [];
  for (let i = 0; i < hex.length; i += 2) a.push(parseInt(hex.slice(i, i + 2), 16));
  return a;
}

async function pbkdf2(pass, salt, iters = 100000, len = 32) {
  const e = new TextEncoder();
  const m = await crypto.subtle.importKey('raw', e.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: e.encode(salt), iterations: iters, hash: 'SHA-256' },
    m,
    len * 8
  );
  return Array.from(new Uint8Array(b)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function argon2Hash(pass, salt, memMB = 64) {
  const o = { pass, salt, time: 3, mem: memMB * 1024, parallelism: 1, hashLen: 32, type: argon2.ArgonType.Argon2id };
  const { hashHex } = await argon2.hash(o);
  return hashHex;
}

async function scryptHash(pass, salt, N = 16384) {
  const e = new TextEncoder();
  const dk = await scrypt.scrypt(e.encode(pass), e.encode(salt), N, 8, 1, 32);
  return Array.from(dk).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function digestHex(input, algo = 'SHA-256') {
  const e = new TextEncoder();
  const d = e.encode(input);
  const h = await crypto.subtle.digest(algo, d);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function mapToPassword(hex, len = 16, policyOn = true, compatMode = false) {
  const bytes = hexToBytes(hex);
  let charset = compatMode
    ? lowers + uppers + digits + '!@#$%^&*()-_=+'
    : lowers + uppers + digits + symbols;
  let pwd = '';
  for (let i = 0; i < len; i++) {
    pwd += charset[bytes[i % bytes.length] % charset.length];
  }
  if (!policyOn) return pwd;

  const arr = pwd.split('');
  const cats = [uppers, lowers, digits, symbols];
  cats.forEach((set, idx) => {
    const pos = bytes[idx + 4] % arr.length;
    arr[pos] = set[bytes[idx] % set.length];
  });
  return arr.join('');
}

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

  if (!site || !secret) {
    resultDiv.style.display = 'block';
    pwSpan.innerText = 'Please enter website and secret.';
    return;
  }

  const nsite = normalizeSite(site);
  const combined = `${nsite}|${secret}|${counter}`;
  let hex;

  try {
    if (algo === 'PBKDF2-SHA256')
      hex = await pbkdf2(secret, combined, parseInt(document.getElementById('iterations').value));
    else if (algo === 'Argon2id')
      hex = await argon2Hash(secret, combined, parseInt(document.getElementById('argonMem').value));
    else if (algo === 'scrypt')
      hex = await scryptHash(secret, combined, parseInt(document.getElementById('scryptN').value));
    else
      hex = await digestHex(combined, algo);

    const pwd = mapToPassword(hex, length, policyOn, compatMode);
    resultDiv.style.display = 'block';
    pwSpan.innerText = pwd;

    const diversityWarn = document.getElementById('diversityWarning');
    diversityWarn.style.display = 'none';
    diversityWarn.innerText = '';

    if (policyOn) {
      const hasUpper = /[A-Z]/.test(pwd);
      const hasLower = /[a-z]/.test(pwd);
      const hasDigit = /\d/.test(pwd);
      const hasSymbol = /[^A-Za-z0-9]/.test(pwd);

      if (!(hasUpper && hasLower && hasDigit && hasSymbol)) {
        diversityWarn.innerText = "⚠️ Password lacks full character diversity. Try increasing 'Characters to Use'.";
        diversityWarn.style.display = 'block';
        setTimeout(() => (diversityWarn.style.display = 'none'), 8000);
      }
    }

    const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}`;
    const rid = await digestHex(recipe, 'SHA-256');
    document.getElementById('recipeInfo').innerText = 'Recipe ID ' + rid.slice(0, 8);

    clearTimeout(window.hideTimer);
    window.hideTimer = setTimeout(() => {
      pwSpan.innerText = '•••••••• (hidden)';
    }, 30000);

    document.getElementById('explainBox').style.display = 'none';
  } catch (e) {
    pwSpan.innerText = 'Error ' + e;
  }
}

function copyToClipboard() {
  const t = document.getElementById('password').innerText;
  if (!t) return;
  navigator.clipboard.writeText(t).then(() => {
    const b = document.getElementById('copyBtn');
    const o = b.innerText;
    b.innerText = 'Copied!';
    setTimeout(() => (b.innerText = o), 2000);
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
    const policyLabel = document.querySelector('label[for="policyToggle"]');
    const compatLabel = document.querySelector('label[for="compatToggle"]');

    // Create lock icons
    const policyLock = document.createElement('span');
    policyLock.className = 'switch-lock';
    policyLock.textContent = '🔒';
    policyLabel.appendChild(policyLock);

    const compatLock = document.createElement('span');
    compatLock.className = 'switch-lock';
    compatLock.textContent = '🔒';
    compatLabel.appendChild(compatLock);

  const recipe = `${algo}|${nsite}|${counter}|${length}|${policyOn}|${compatMode}`;
  const rid = await digestHex(recipe, 'SHA-256');
  const box = document.getElementById('explainBox');
  box.style.display = 'block';
  box.textContent = `Algorithm: ${algo}\nNormalized site: ${nsite}\nCounter: ${counter}\nLength: ${length}\nDeterministic policy: ${document.getElementById('policyToggle').checked}\nRecipe ID: ${rid.slice(0, 8)}\n\nAll characters derived deterministically from this recipe and the master phrase.`;
}

