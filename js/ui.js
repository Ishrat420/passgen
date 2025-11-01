import { PasswordGenerator } from './generator.js';
import {
  fetchRecipes,
  recordRecipeUsage,
  clearRecipeHistory,
  clearAllData,
  importRecipes,
  exportRecipes,
  getRegistryEntry
} from './storage.js';
import { initSyncUI } from './sync.js';

let hideTimer = null;
let registryFadeTimer = null;
let lastGeneratedPassword = '';

window.addEventListener('DOMContentLoaded', () => {
  initToggleExclusivity();
  initEventHandlers();
  setupReactiveFields();
  refreshHistoryList();
  updateStorageInfo();
  initSyncUI({ refreshHistoryList, updateStorageInfo });
});

function initEventHandlers() {
  const generateBtn = document.getElementById('generateBtn');
  generateBtn.addEventListener('click', handleGenerate);

  document.getElementById('copyBtn').addEventListener('click', copyToClipboard);
  document.getElementById('explainBtn').addEventListener('click', explainPassword);
  document.getElementById('clearHistoryBtn').addEventListener('click', handleClearHistory);
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importBtn').addEventListener('click', handleImport);
  document.getElementById('resetAppBtn').addEventListener('click', handleResetAppData);

  const search = document.getElementById('searchHistory');
  search.addEventListener('input', event => refreshHistoryList(event.target.value));
}

async function handleGenerate() {
  const site = document.getElementById('website').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algorithm = document.getElementById('algorithm').value;
  const lengthInput = document.getElementById('length').value;
  const length = Number(lengthInput);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;
  const iterations = parseInt(document.getElementById('iterations').value, 10);
  const argonMem = parseInt(document.getElementById('argonMem').value, 10);
  const scryptN = parseInt(document.getElementById('scryptN').value, 10);

  resetUI({ clearPassword: true, clearRecipe: true });

  if (!site || !secret) {
    resetUI({ showError: 'Please enter website and secret.', clearRecipe: true });
    return;
  }

  const MIN_LENGTH = 8;
  const MAX_LENGTH = 50;
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    resetUI({
      showError: `Password length must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}.`,
      clearRecipe: true
    });
    return;
  }

  try {
    const generator = new PasswordGenerator({
      algorithm,
      length,
      policyOn,
      compatMode,
      parameters: { iterations, argonMem, scryptN }
    });

    const { password, normalizedSite } = await generator.generate({ site, secret, counter });

    lastGeneratedPassword = password;

    const passwordSpan = document.getElementById('password');
    const copyBtn = document.getElementById('copyBtn');
    passwordSpan.innerText = password;
    copyBtn.style.display = 'inline-block';

    handleDiversityWarning(generator, password);
    showResultBox();

    const effectiveLength = generator.length;

    const { short: recipeId } = await PasswordGenerator.computeRecipeId({
      algorithm,
      site: normalizedSite,
      counter,
      length: effectiveLength,
      policyOn,
      compatMode
    });

    document.getElementById('recipeInfo').innerText = 'Recipe ID ' + recipeId;

    const existingRegistry = await getRegistryEntry(normalizedSite);
    const recipeEntry = {
      id: recipeId,
      site: normalizedSite,
      algorithm,
      length: effectiveLength,
      counter,
      policyOn,
      compatMode,
      date: new Date().toISOString()
    };

    const registryResult = await recordRecipeUsage(recipeEntry, existingRegistry);
    updateRegistryMessage(normalizedSite, existingRegistry, registryResult);

    await refreshHistoryList(document.getElementById('searchHistory').value.trim());
    scheduleAutoHide();
  } catch (error) {
    resetUI({ showError: 'Error: ' + error.message, clearRecipe: true });
  }
}

function handleDiversityWarning(generator, password) {
  const warning = document.getElementById('diversityWarning');
  warning.style.display = 'none';
  warning.innerText = '';

  if (generator.policyOn && !generator.isDiverse(password)) {
    warning.innerText = '⚠️ Password lacks full character diversity.';
    warning.style.display = 'block';
    setTimeout(() => (warning.style.display = 'none'), 6000);
  }
}

function showResultBox() {
  const resultDiv = document.getElementById('result');
  resultDiv.classList.remove('result-hidden');
  resultDiv.classList.add('result-visible');
  resultDiv.style.display = 'block';
}

function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    document.getElementById('password').innerText = '•••••••• (hidden)';
  }, 30000);
}

function resetUI({ clearPassword = false, clearRecipe = false, showError = '' } = {}) {
  const resultDiv = document.getElementById('result');
  const passwordSpan = document.getElementById('password');
  const recipeInfo = document.getElementById('recipeInfo');
  const diversityWarn = document.getElementById('diversityWarning');
  const copyBtn = document.getElementById('copyBtn');
  const explainBox = document.getElementById('explainBox');

  resultDiv.style.display = 'block';
  diversityWarn.style.display = 'none';
  explainBox.style.display = 'none';

  if (clearPassword) passwordSpan.innerText = showError || '';
  if (clearRecipe) recipeInfo.innerText = '';

  if (showError) {
    passwordSpan.innerText = `⚠️ ${showError}`;
    passwordSpan.style.color = '#d33';
    copyBtn.style.display = 'none';
  } else {
    passwordSpan.style.color = '';
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

  updateUI();
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

function setupReactiveFields() {
  const reactiveFields = [
    'website', 'secret', 'algorithm', 'counter', 'length',
    'policyToggle', 'compatToggle', 'iterations', 'argonMem', 'scryptN'
  ];

  reactiveFields.forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('input', hideResultBox);
    element.addEventListener('change', hideResultBox);
  });
}

function hideResultBox() {
  const resultDiv = document.getElementById('result');
  resultDiv.classList.remove('result-visible');
  resultDiv.classList.add('result-hidden');
}

function updateRegistryMessage(site, previousRegistry, registryResult) {
  const messageEl = document.getElementById('registryMessage');
  clearTimeout(registryFadeTimer);
  messageEl.style.opacity = '1';
  messageEl.style.display = 'none';
  messageEl.textContent = '';

  if (!previousRegistry) return;

  const latestVersion = previousRegistry.versions[previousRegistry.versions.length - 1];
  const { matchedVersion } = registryResult;

  if (matchedVersion) {
    const lastCounter = matchedVersion.counter || '0';
    messageEl.append(document.createTextNode('💡 You’ve generated this recipe before. Latest saved version for '));

    const siteStrong = document.createElement('b');
    siteStrong.textContent = site;
    messageEl.appendChild(siteStrong);

    messageEl.append(document.createTextNode(': ('));

    const versionStrong = document.createElement('b');
    versionStrong.textContent = `v${latestVersion.version}`;
    messageEl.appendChild(versionStrong);

    const formattedDate = new Date(matchedVersion.date).toLocaleDateString();
    messageEl.append(document.createTextNode(`, ${formattedDate}).`));

    messageEl.appendChild(document.createElement('br'));

    const counterInfo = document.createElement('small');
    counterInfo.textContent = 'Last used Counter: ';
    const counterCode = document.createElement('code');
    counterCode.textContent = lastCounter;
    counterInfo.appendChild(counterCode);
    messageEl.appendChild(counterInfo);

    messageEl.appendChild(document.createElement('br'));

    const hint = document.createElement('small');
    hint.classList.add('highlight-hint');
    hint.textContent = 'Are you using a different Master Key?';
    messageEl.appendChild(hint);
  } else {
    messageEl.textContent = '🆕 This is a new recipe version (v' +
      (latestVersion.version + 1) +
      ') for ' +
      site +
      '.';
  }

  messageEl.style.display = 'block';
  messageEl.style.transition = 'opacity 1s ease';
  registryFadeTimer = setTimeout(() => {
    messageEl.style.opacity = '0';
    setTimeout(() => (messageEl.style.display = 'none'), 1000);
  }, 10000);
}

async function refreshHistoryList(filter = '') {
  const list = document.getElementById('historyList');
  list.innerHTML = '';

  const recipes = await fetchRecipes();
  const filtered = filter
    ? recipes.filter(recipe => recipe.site.toLowerCase().includes(filter.toLowerCase()))
    : recipes;

  if (!filtered.length) {
    const emptyItem = document.createElement('li');
    emptyItem.style.color = filter ? '#999' : '#555';
    emptyItem.textContent = filter ? 'No matching results.' : 'No recipes saved yet.';
    list.appendChild(emptyItem);
    updateStorageInfo();
    return;
  }

  filtered.forEach(recipe => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = recipe.site;
    li.appendChild(title);

    li.append(document.createTextNode(` — ${recipe.algorithm} `));
    li.appendChild(document.createElement('br'));

    const details = document.createElement('small');
    details.textContent = `ID: ${recipe.id} | Counter: ${recipe.counter} | ${recipe.length} chars | ${new Date(recipe.date).toLocaleString()}`;
    li.appendChild(details);

    list.appendChild(li);
  });

  updateStorageInfo();
}

async function handleClearHistory() {
  if (!confirm('Clear all saved recipes?')) return;
  await clearRecipeHistory();
  await refreshHistoryList();
}

async function handleExport() {
  const data = await exportRecipes();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'passwordgen_recipes.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function handleImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Invalid file format');
      await importRecipes(data);
      alert(`✅ Imported ${data.length} recipes`);
      await refreshHistoryList();
    } catch (error) {
      alert('❌ Failed to import JSON: ' + error.message);
    }
  };
  input.click();
}

async function handleResetAppData() {
  if (!confirm('⚠️ This will delete ALL stored recipes and registry data. Are you sure?')) return;

  try {
    await clearAllData();
    await refreshHistoryList();
    const registryMsg = document.getElementById('registryMessage');
    registryMsg.style.display = 'none';
    alert('✅ All app data has been cleared successfully!');
  } catch (error) {
    alert('❌ Failed to reset data: ' + error.message);
  }
}

function copyToClipboard() {
  const passwordSpan = document.getElementById('password');
  const button = document.getElementById('copyBtn');
  const text = passwordSpan.innerText.trim();
  const originalLabel = button.innerText;

  if (text.includes('(hidden)')) {
    passwordSpan.innerText = lastGeneratedPassword || '⚠️ Regenerate first.';
    button.innerText = 'Copy';
    return;
  }

  if (!text || text.startsWith('⚠️')) return;

  navigator.clipboard.writeText(text).then(() => {
    button.classList.remove('copied');
    button.innerText = 'Copied!';
    button.classList.add('copied');

    clearTimeout(button._resetTimeout);
    button._resetTimeout = setTimeout(() => {
      button.classList.remove('copied');
      button.innerText = originalLabel;
    }, 3000);
  }).catch(() => {
    button.innerText = 'Error';
    button.style.background = '#b71c1c';
    clearTimeout(button._resetTimeout);
    button._resetTimeout = setTimeout(() => {
      button.innerText = originalLabel;
      button.style.background = '';
    }, 3000);
  });
}

async function explainPassword() {
  const site = document.getElementById('website').value.trim();
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algorithm = document.getElementById('algorithm').value;
  const length = document.getElementById('length').value;
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;

  const normalizedSite = PasswordGenerator.normalizeSite(site);
  const { short: recipeId } = await PasswordGenerator.computeRecipeId({
    algorithm,
    site: normalizedSite,
    counter,
    length,
    policyOn,
    compatMode
  });

  const box = document.getElementById('explainBox');
  box.style.display = 'block';
  box.textContent = [
    `Algorithm: ${algorithm}`,
    `Normalized site: ${normalizedSite}`,
    `Counter: ${counter}`,
    `Length: ${length}`,
    `Deterministic policy: ${policyOn}`,
    `Compatibility mode: ${compatMode}`,
    `Recipe ID: ${recipeId}`,
    '',
    'Password is calculated with this recipe and the master phrase.',
    'The Recipe ID is a unique fingerprint of all your settings, except your master phrase.'
  ].join('\n');
}

async function updateStorageInfo() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    const usedMB = (usage / 1024 / 1024).toFixed(2);
    const quotaMB = (quota / 1024 / 1024).toFixed(0);
    document.getElementById('storageInfo').textContent = `Storage used: ${usedMB} MB / ${quotaMB} MB`;
  }
}
