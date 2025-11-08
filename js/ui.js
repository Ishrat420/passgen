import { PasswordGenerator } from './generator.js';
import {
  fetchRecipes,
  recordRecipeUsage,
  clearRecipeHistory,
  clearAllData,
  importRecipes,
  exportRecipes,
  getRegistryEntry,
  deleteRecipeById
} from './storage.js';
import { initSyncUI } from './sync.js';
import { loadPreferences, savePreferences, clearPreferences } from './preferences.js';

let hideTimer = null;
let registryFadeTimer = null;
let lastGeneratedPassword = '';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 50;
const SECRET_REQUIREMENT_MESSAGE =
  'Must contain at least 8 characters, including one uppercase, one lowercase and one number.';

let userPreferences = {};
let toggleController = null;

function registerFilledStateTracking(element) {
  if (!element || !(element instanceof HTMLElement)) return;
  if (element.matches('input[type="checkbox"], input[type="radio"]')) return;

  if (!('initialValue' in element.dataset)) {
    element.dataset.initialValue = determineInitialValue(element);
  }

  const updateState = () => updateFilledState(element);
  element.addEventListener('input', updateState);
  element.addEventListener('change', updateState);
  updateFilledState(element);
}

function determineInitialValue(element) {
  if (element instanceof HTMLSelectElement) {
    const explicitDefault = element.querySelector('option[selected]');
    if (explicitDefault) {
      return explicitDefault.value ?? explicitDefault.textContent ?? '';
    }
    if (element.options.length) {
      const firstOption = element.options[0];
      return firstOption.value ?? firstOption.textContent ?? '';
    }
    return '';
  }

  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return '';
    }
    const attrValue = element.getAttribute('value');
    if (attrValue !== null) return attrValue;
    return element.defaultValue ?? '';
  }

  if (element instanceof HTMLTextAreaElement) {
    const attrValue = element.getAttribute('value');
    if (attrValue !== null) return attrValue;
    return element.defaultValue ?? '';
  }

  return '';
}

function updateFilledState(element) {
  if (!element || !(element instanceof HTMLElement)) return;
  if (element.matches('input[type="checkbox"], input[type="radio"]')) return;

  const currentValue = typeof element.value === 'string' ? element.value.trim() : '';
  const baseline = element.dataset.initialValue ?? '';
  const isNumericInput = element instanceof HTMLInputElement && element.type === 'number';
  const isSelect = element instanceof HTMLSelectElement;

  let shouldMarkFilled;
  if (isNumericInput || isSelect) {
    shouldMarkFilled = currentValue !== '' && currentValue !== baseline;
  } else {
    shouldMarkFilled = currentValue !== '';
  }

  element.classList.toggle('is-filled', shouldMarkFilled);
}

window.addEventListener('DOMContentLoaded', () => {
  userPreferences = loadPreferences();
  applyStoredTogglePreferences();
  toggleController = initToggleExclusivity({
    onStateChange: state => {
      if (
        userPreferences.policyToggle !== state.policyOn ||
        userPreferences.compatToggle !== state.compatMode
      ) {
        userPreferences.policyToggle = state.policyOn;
        userPreferences.compatToggle = state.compatMode;
        persistPreferences();
      }
    }
  });
  initPreferencePersistence();
  initEventHandlers();
  setupReactiveFields();
  refreshHistoryList();
  updateStorageInfo();
  initSyncUI({ refreshHistoryList, updateStorageInfo });
});

function initEventHandlers() {
  const generateBtn = document.getElementById('generateBtn');
  generateBtn.addEventListener('click', handleGenerate);

  initSecretFieldValidation();

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
  const secretInput = document.getElementById('secret');
  const secret = secretInput.value.trim();
  const counterInput = document.getElementById('counter');
  const counterRaw = counterInput.value.trim() || '0';
  const normalizedCounter = PasswordGenerator.normalizeCounter(counterRaw);
  counterInput.value = normalizedCounter;
  updateFilledState(counterInput);
  const algorithm = document.getElementById('algorithm').value;
  const lengthInput = document.getElementById('length').value;
  const length = Number(lengthInput);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;
  const iterations = parseInt(document.getElementById('iterations').value, 10);
  const argonMem = parseInt(document.getElementById('argonMem').value, 10);
  const scryptN = parseInt(document.getElementById('scryptN').value, 10);

  const secretStrengthError = getSecretStrengthError(secret);

  if (!secret) {
    setSecretFieldError('Please enter your master secret.');
  } else if (secretStrengthError) {
    setSecretFieldError(secretStrengthError, { silent: true });
  } else {
    clearSecretFieldError();
  }

  if (!site || !secret) {
    const missingFields = [];
    if (!site) missingFields.push('website');
    if (!secret) missingFields.push('secret');

    const messagePrefix = 'Please enter ';
    const message =
      missingFields.length === 1
        ? `${messagePrefix}${missingFields[0]}.`
        : `${messagePrefix}website and secret.`;

    showValidationError(message);
    return;
  }

  if (secretStrengthError) {
    setSecretFieldError(secretStrengthError);
    showValidationError(secretStrengthError);
    return;
  }

  clearSecretFieldError();

  if (!Number.isInteger(length) || length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    showValidationError(
      `Password length must be an integer between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}.`
    );
    return;
  }

  resetUI({ clearPassword: true, clearRecipe: true });

  try {
    const generator = new PasswordGenerator({
      algorithm,
      length,
      policyOn,
      compatMode,
      parameters: { iterations, argonMem, scryptN }
    });

    const { password, normalizedSite } = await generator.generate({ site, secret, counter: normalizedCounter });

    lastGeneratedPassword = password;

    const passwordSpan = document.getElementById('password');
    const copyBtn = document.getElementById('copyBtn');
    passwordSpan.innerText = password;
    copyBtn.style.display = 'inline-block';

    handleDiversityWarning(generator, password);
    showResultBox();

    const effectiveLength = generator.length;

    const parameterSettings = generator.parameters;

    const { digest: recipeDigest, short: recipeShort } = await PasswordGenerator.computeRecipeId({
      algorithm,
      site: normalizedSite,
      counter: normalizedCounter,
      length: effectiveLength,
      policyOn,
      compatMode,
      parameters: parameterSettings
    });

    document.getElementById('recipeInfo').innerText = 'Recipe ID ' + recipeShort;

    const existingRegistry = await getRegistryEntry(normalizedSite);
    const recipeEntry = {
      id: recipeDigest,
      shortId: recipeShort,
      site: normalizedSite,
      algorithm,
      length: effectiveLength,
      counter: normalizedCounter,
      policyOn,
      compatMode,
      date: new Date().toISOString(),
      parameters: parameterSettings
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
  resultDiv.style.display = 'block';

  const previousTransition = resultDiv.style.transition;
  resultDiv.style.transition = 'max-height 0.3s ease, opacity 0.3s ease, transform 0.3s ease';

  resultDiv.classList.remove('result-hidden');
  resultDiv.classList.add('result-visible');

  const targetHeight = resultDiv.scrollHeight;
  // Force a reflow so the browser acknowledges the class changes before animating height.
  resultDiv.getBoundingClientRect();

  // Allow the result box to expand smoothly based on its content height.
  resultDiv.style.maxHeight = targetHeight + 'px';

  requestAnimationFrame(() => {
    resultDiv.style.maxHeight = '';
    resultDiv.style.transition = previousTransition;
  });
}

function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    document.getElementById('password').innerText = '•••••••• (hidden)';
  }, 30000);
}

function resetUI({ clearPassword = false, clearRecipe = false, showError = '' } = {}) {
  clearTimeout(hideTimer);
  const resultDiv = document.getElementById('result');
  const passwordSpan = document.getElementById('password');
  const recipeInfo = document.getElementById('recipeInfo');
  const diversityWarn = document.getElementById('diversityWarning');
  const copyBtn = document.getElementById('copyBtn');
  const explainBox = document.getElementById('explainBox');
  const explainBtn = document.getElementById('explainBtn');

  resultDiv.style.display = 'block';
  diversityWarn.style.display = 'none';
  explainBox.style.display = 'none';
  if (explainBtn) {
    explainBtn.style.display = 'inline-block';
    explainBtn.disabled = false;
  }

  if (clearPassword) passwordSpan.innerText = showError || '';
  if (clearRecipe) recipeInfo.innerText = '';

  if (showError) {
    passwordSpan.innerText = `⚠️ ${showError}`;
    passwordSpan.style.color = '#d33';
    copyBtn.style.display = 'none';
    resultDiv.classList.remove('result-hidden');
    resultDiv.classList.add('result-visible');
  } else {
    passwordSpan.style.color = '';
    copyBtn.style.display = 'inline-block';
  }
}

function showValidationError(message) {
  resetUI({ clearPassword: true, clearRecipe: true, showError: message });
  lastGeneratedPassword = '';
}

function getSecretStrengthError(secret) {
  if (!secret) return '';

  const hasMinLength = secret.length >= 8;
  const hasLowercase = /[a-z]/.test(secret);
  const hasUppercase = /[A-Z]/.test(secret);
  const hasNumber = /[0-9]/.test(secret);
  const hasSymbol = /[^\w\s]/.test(secret);

  return hasMinLength && hasLowercase && hasUppercase && hasNumber && hasSymbol
    ? ''
    : SECRET_REQUIREMENT_MESSAGE;
}

function setSecretFieldError(message, { silent = false } = {}) {
  const secretField = document.getElementById('secret');
  const errorField = document.getElementById('secretError');
  if (!secretField || !errorField) return;

  const hasError = Boolean(message);
  secretField.classList.toggle('is-invalid', hasError);
  if (hasError) {
    secretField.setAttribute('aria-invalid', 'true');
  } else {
    secretField.removeAttribute('aria-invalid');
  }

  if (typeof secretField.setCustomValidity === 'function') {
    secretField.setCustomValidity(message || '');
  }

  errorField.textContent = message || '';
  errorField.style.display = hasError ? 'block' : 'none';

  if (hasError && !silent && typeof secretField.reportValidity === 'function') {
    secretField.reportValidity();
  }
}

function clearSecretFieldError() {
  setSecretFieldError('', { silent: true });
}

function initSecretFieldValidation() {
  const secretField = document.getElementById('secret');
  if (!secretField) return;

  secretField.addEventListener('input', () => {
    const value = secretField.value.trim();
    if (!value) {
      clearSecretFieldError();
      return;
    }

    const strengthError = getSecretStrengthError(value);
    if (strengthError) {
      setSecretFieldError(strengthError, { silent: true });
    } else {
      clearSecretFieldError();
    }
  });
}

function initToggleExclusivity({ onStateChange } = {}) {
  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  const policyLabel = document.querySelector('label[for="policyToggle"]');
  const compatLabel = document.querySelector('label[for="compatToggle"]');
  const policyHint = document.getElementById('policyHint');
  const compatHint = document.getElementById('compatHint');

  const policyLock = createLockIcon();
  const compatLock = createLockIcon();
  policyLabel.appendChild(policyLock);
  compatLabel.appendChild(compatLock);

  const updateUI = () => {
    updateToggleVisual(policyToggle, policyLabel, policyLock);
    updateToggleVisual(compatToggle, compatLabel, compatLock);
  };

  const emitState = () => {
    onStateChange?.({
      policyOn: policyToggle.checked,
      compatMode: compatToggle.checked
    });
  };

  const applyExclusivity = () => {
    compatToggle.disabled = policyToggle.checked;
    if (policyToggle.checked) compatToggle.checked = false;

    policyToggle.disabled = compatToggle.checked;
    if (compatToggle.checked) policyToggle.checked = false;

    if (policyHint) policyHint.style.display = compatToggle.disabled ? 'block' : 'none';
    if (compatHint) compatHint.style.display = policyToggle.disabled ? 'block' : 'none';

    updateUI();
  };

  const enforceState = ({ notify = true } = {}) => {
    applyExclusivity();
    if (notify) emitState();
  };

  policyToggle.addEventListener('change', () => {
    enforceState();
  });

  compatToggle.addEventListener('change', () => {
    enforceState();
  });

  enforceState();

  return { enforceState };
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
    registerFilledStateTracking(element);
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
    li.classList.add('history-item');

    const content = document.createElement('div');
    content.className = 'history-item__content';

    const heading = document.createElement('div');
    heading.className = 'history-item__heading';

    const title = document.createElement('strong');
    title.textContent = recipe.site;
    heading.appendChild(title);

    const algorithmLabel = document.createElement('span');
    algorithmLabel.className = 'history-item__algorithm';
    algorithmLabel.textContent = recipe.algorithm;
    heading.appendChild(algorithmLabel);

    content.appendChild(heading);

    const shortId = recipe.shortId || (recipe.id ? recipe.id.slice(0, 8) : 'unknown');
    const parameterSettings = PasswordGenerator.normalizeParameters(recipe.parameters);
    const tuningParts = [];
    if (recipe.algorithm === 'PBKDF2-SHA256') {
      tuningParts.push(`iter=${parameterSettings.iterations}`);
    } else if (recipe.algorithm === 'Argon2id') {
      tuningParts.push(`mem=${parameterSettings.argonMem}MB`);
    } else if (recipe.algorithm === 'scrypt') {
      tuningParts.push(`N=${parameterSettings.scryptN}`);
    } else if (parameterSettings) {
      tuningParts.push(
        `iter=${parameterSettings.iterations},mem=${parameterSettings.argonMem},N=${parameterSettings.scryptN}`
      );
    }

    const detailParts = [
      `ID: ${shortId}`,
      `Counter: ${recipe.counter}`,
      `${recipe.length} chars`,
      new Date(recipe.date).toLocaleString()
    ];

    if (tuningParts.length) {
      detailParts.splice(3, 0, `Tuning: ${tuningParts.join(', ')}`);
    }

    const details = document.createElement('small');
    details.textContent = detailParts.join(' | ');
    content.appendChild(details);

    li.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'history-item__actions';

    const recalcButton = createHistoryActionButton({
      icon: '↻',
      label: `Reapply settings for ${recipe.site}`,
      onClick: () => handleRecipeRecalculate(recipe)
    });
    actions.appendChild(recalcButton);

    const deleteButton = createHistoryActionButton({
      icon: '🗑',
      label: `Delete saved recipe for ${recipe.site}`,
      disabled: !recipe.id,
      onClick: () => handleRecipeDelete(recipe)
    });
    actions.appendChild(deleteButton);

    li.appendChild(actions);

    list.appendChild(li);
  });

  updateStorageInfo();
}

function createHistoryActionButton({ icon, label, onClick, disabled = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-action-btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = Boolean(disabled);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'history-action-btn__icon';
  iconSpan.textContent = icon;
  button.appendChild(iconSpan);

  if (typeof onClick === 'function' && !button.disabled) {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick();
      } catch (error) {
        console.error('History action failed', error);
      }
    });
  }

  return button;
}

async function handleRecipeRecalculate(recipe) {
  if (!recipe) return;
  applyRecipeToForm(recipe);

  const secretField = document.getElementById('secret');
  if (secretField?.value.trim()) {
    await handleGenerate();
  } else if (secretField) {
    secretField.focus();
  }
}

async function handleRecipeDelete(recipe) {
  if (!recipe?.id) return;
  const siteName = recipe.site || 'this site';
  const shouldDelete = confirm(`Delete saved recipe for ${siteName}?`);
  if (!shouldDelete) return;

  try {
    await deleteRecipeById(recipe.id);
    const filter = document.getElementById('searchHistory').value.trim();
    await refreshHistoryList(filter);
  } catch (error) {
    console.error('Failed to delete recipe', error);
    alert('Failed to delete recipe: ' + error.message);
  }
}

function applyRecipeToForm(recipe) {
  if (!recipe) return;

  setTextFieldValue('website', recipe.site || '', 'input');

  const normalizedCounter = PasswordGenerator.normalizeCounter(recipe.counter ?? '0');
  setTextFieldValue('counter', normalizedCounter, 'change');

  const parsedLength = Number.parseInt(recipe.length, 10);
  const sanitizedLength = Number.isFinite(parsedLength)
    ? clamp(parsedLength, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
    : 16;
  setTextFieldValue('length', sanitizedLength, 'change');

  setSelectFieldValue('algorithm', recipe.algorithm);

  setToggleValue('policyToggle', Boolean(recipe.policyOn));
  setToggleValue('compatToggle', Boolean(recipe.compatMode));

  const params = PasswordGenerator.normalizeParameters(recipe.parameters);
  setTextFieldValue('iterations', params.iterations, 'change');
  setTextFieldValue('argonMem', params.argonMem, 'change');
  setTextFieldValue('scryptN', params.scryptN, 'change');

  toggleController?.enforceState({ notify: true });
  hideResultBox();
}

function setTextFieldValue(id, value, eventType = null) {
  const element = document.getElementById(id);
  if (!element) return;
  const nextValue = value === undefined || value === null ? '' : String(value);
  if (element.value !== nextValue) {
    element.value = nextValue;
    updateFilledState(element);
    if (eventType) {
      element.dispatchEvent(new Event(eventType, { bubbles: true }));
    }
  } else {
    updateFilledState(element);
    if (eventType) {
      element.dispatchEvent(new Event(eventType, { bubbles: true }));
    }
  }
}

function setSelectFieldValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  const allowedValues = Array.from(element.options).map(option => option.value);
  const targetValue = allowedValues.includes(String(value)) ? String(value) : element.value;
  if (element.value !== targetValue) {
    element.value = targetValue;
    updateFilledState(element);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    updateFilledState(element);
  }
}

function setToggleValue(id, checked) {
  const element = document.getElementById(id);
  if (!element) return;
  const normalized = Boolean(checked);
  if (element.checked !== normalized) {
    element.checked = normalized;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
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
    clearPreferences();
    userPreferences = {};
    resetPreferenceDefaults();
    toggleController?.enforceState({ notify: false });
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
  const iterations = parseInt(document.getElementById('iterations').value, 10);
  const argonMem = parseInt(document.getElementById('argonMem').value, 10);
  const scryptN = parseInt(document.getElementById('scryptN').value, 10);

  const parameterSettings = PasswordGenerator.normalizeParameters({ iterations, argonMem, scryptN });

  const normalizedSite = PasswordGenerator.normalizeSite(site);
  const normalizedCounter = PasswordGenerator.normalizeCounter(counter);
  const { short: recipeId } = await PasswordGenerator.computeRecipeId({
    algorithm,
    site: normalizedSite,
    counter: normalizedCounter,
    length,
    policyOn,
    compatMode,
    parameters: parameterSettings
  });

  const box = document.getElementById('explainBox');
  box.style.display = 'block';
  box.textContent = [
    `Algorithm: ${algorithm}`,
    `Normalized site: ${normalizedSite}`,
    `Counter: ${normalizedCounter}`,
    `Length: ${length}`,
    `Deterministic policy: ${policyOn}`,
    `Compatibility mode: ${compatMode}`,
    `Algorithm tuning: iterations=${parameterSettings.iterations}, argonMem=${parameterSettings.argonMem}, scryptN=${parameterSettings.scryptN}`,
    `Recipe ID: ${recipeId}`,
    '',
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

function initPreferencePersistence() {
  let shouldPersist = false;

  const registerField = ({ key, element, applyStored, readValue, events = ['change'] }) => {
    if (!element) return;

    if (Object.prototype.hasOwnProperty.call(userPreferences, key)) {
      const sanitized = applyStored(element, userPreferences[key]);
      if (sanitized === undefined) {
        delete userPreferences[key];
        shouldPersist = true;
      } else if (sanitized !== userPreferences[key]) {
        userPreferences[key] = sanitized;
        shouldPersist = true;
      }
    }

    const handler = () => {
      const value = readValue(element);
      if (value === undefined) {
        if (Object.prototype.hasOwnProperty.call(userPreferences, key)) {
          delete userPreferences[key];
          persistPreferences();
        }
        return;
      }

      if (userPreferences[key] !== value) {
        userPreferences[key] = value;
        persistPreferences();
      }
    };

    events.forEach(event => element.addEventListener(event, handler));
  };

  registerField({
    key: 'algorithm',
    element: document.getElementById('algorithm'),
    applyStored: (el, stored) => {
      if (typeof stored !== 'string') return el.value;
      const hasOption = Array.from(el.options).some(option => option.value === stored);
      if (hasOption) {
        el.value = stored;
        updateFilledState(el);
        return stored;
      }
      updateFilledState(el);
      return el.value;
    },
    readValue: el => el.value
  });

  registerField({
    key: 'length',
    element: document.getElementById('length'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH),
    readValue: el => readNumericPreference(el, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  });

  registerField({
    key: 'iterations',
    element: document.getElementById('iterations'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 10000),
    readValue: el => readNumericPreference(el, 10000)
  });

  registerField({
    key: 'argonMem',
    element: document.getElementById('argonMem'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 8),
    readValue: el => readNumericPreference(el, 8)
  });

  registerField({
    key: 'scryptN',
    element: document.getElementById('scryptN'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 1024),
    readValue: el => readNumericPreference(el, 1024)
  });

  const advancedDetails = document.querySelector('.advanced-card details');
  if (advancedDetails) {
    if (Object.prototype.hasOwnProperty.call(userPreferences, 'advancedOpen')) {
      advancedDetails.open = Boolean(userPreferences.advancedOpen);
    }

    advancedDetails.addEventListener('toggle', () => {
      userPreferences.advancedOpen = advancedDetails.open;
      persistPreferences();
    });
  }

  if (shouldPersist) persistPreferences();
}

function applyStoredTogglePreferences() {
  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  if (!policyToggle || !compatToggle) return;

  if (Object.prototype.hasOwnProperty.call(userPreferences, 'policyToggle')) {
    policyToggle.checked = Boolean(userPreferences.policyToggle);
  }
  if (Object.prototype.hasOwnProperty.call(userPreferences, 'compatToggle')) {
    compatToggle.checked = Boolean(userPreferences.compatToggle);
  }
}

function applyNumericPreference(element, stored, min, max = Number.POSITIVE_INFINITY) {
  const parsed = parseInteger(stored);
  if (parsed === null) return readNumericPreference(element, min, max);
  const clamped = clamp(parsed, min, max);
  element.value = clamped;
  updateFilledState(element);
  return clamped;
}

function readNumericPreference(element, min, max = Number.POSITIVE_INFINITY) {
  const parsed = parseInteger(element.value);
  if (parsed === null) return undefined;
  const clamped = clamp(parsed, min, max);
  if (clamped !== parsed) {
    element.value = clamped;
  }
  updateFilledState(element);
  return clamped;
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return value;
  let result = value;
  if (Number.isFinite(min)) result = Math.max(result, min);
  if (Number.isFinite(max)) result = Math.min(result, max);
  return result;
}

function persistPreferences() {
  savePreferences(userPreferences);
}

function resetPreferenceDefaults() {
  const algorithm = document.getElementById('algorithm');
  if (algorithm) algorithm.value = 'PBKDF2-SHA256';
  if (algorithm) updateFilledState(algorithm);

  const length = document.getElementById('length');
  if (length) length.value = '16';
  if (length) updateFilledState(length);

  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  if (policyToggle) policyToggle.checked = true;
  if (compatToggle) compatToggle.checked = false;

  const iterations = document.getElementById('iterations');
  if (iterations) iterations.value = '100000';
  if (iterations) updateFilledState(iterations);

  const argonMem = document.getElementById('argonMem');
  if (argonMem) argonMem.value = '64';
  if (argonMem) updateFilledState(argonMem);

  const scryptN = document.getElementById('scryptN');
  if (scryptN) scryptN.value = '16384';
  if (scryptN) updateFilledState(scryptN);

  const advancedDetails = document.querySelector('.advanced-card details');
  if (advancedDetails) advancedDetails.open = false;
}
