import { PasswordGenerator } from './generator.js';
import {
  fetchRecipes,
  recordRecipeUsage,
  clearRecipeHistory,
  clearAllData,
  importRecipes,
  exportRecipes,
  getRegistryEntry,
  deleteRecipeById,
  fetchAccountLabels,
  storeAccountLabel
} from './storage.js';
import { initSyncUI } from './sync.js';
import { initFileSync, notifyFileSyncRegistryChange } from './file-sync.js';
import { loadPreferences, savePreferences, clearPreferences } from './preferences.js';

let hideTimer = null;
let registryFadeTimer = null;
let lastGeneratedPassword = '';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 50;
const MIN_PIN_LENGTH = 3;
const MAX_PIN_LENGTH = 12;
const SECRET_REQUIREMENT_MESSAGE =
  'Must contain at least 8 characters, including one uppercase, one lowercase and one number.';

let userPreferences = {};
let toggleController = null;

const SIMPLE_ALGORITHMS = new Set(['SHA-256', 'SHA-512', 'BLAKE2b-512', 'BLAKE2s-256', 'HMAC-SHA256']);

const DOMAIN_STATUS = Object.freeze({
  LABEL: 'label',
  CHECKING: 'checking',
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified'
});

const domainVerificationCache = new Map();
let labelStatusTimer = null;
let domainStatusUI = null;
const domainState = {
  kind: DOMAIN_STATUS.LABEL,
  status: DOMAIN_STATUS.LABEL,
  labelValue: '',
  domainValue: '',
  forceLabel: false,
  verifyEnabled: true,
  hasTyped: false,
  userInteracted: false
};

function isSimpleAlgorithm(algorithm) {
  return SIMPLE_ALGORITHMS.has(algorithm);
}

function parseNumericCounterValue(counter) {
  const raw = String(counter ?? '').trim();
  if (!raw || !/^-?\d+$/.test(raw)) return null;

  if (typeof BigInt === 'function') {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeDomainCandidate(value) {
  if (!value) return false;
  return /:\/\//.test(value) || /^www\./i.test(value) || value.includes('.');
}

function normalizeDomainValue(value) {
  if (!value) return '';
  let input = String(value).trim().toLowerCase();
  if (!input) return '';

  let hostname = input;
  try {
    let candidate = hostname;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    hostname = new URL(candidate).hostname;
  } catch {
    // Fall back to raw input when URL parsing fails.
  }

  return hostname.toLowerCase().trim().replace(/^www\./, '').replace(/\.+$/, '');
}

function resolveSiteInput(rawValue, { verifyEnabled = true, forceLabel = false } = {}) {
  const labelValue = String(rawValue ?? '').trim();
  if (!labelValue) {
    return { kind: 'empty', labelValue: '', domainValue: '' };
  }

  if (!verifyEnabled || forceLabel) {
    return { kind: 'label', labelValue, domainValue: '' };
  }

  if (!looksLikeDomainCandidate(labelValue)) {
    return { kind: 'label', labelValue, domainValue: '' };
  }

  const domainValue = normalizeDomainValue(labelValue);
  if (!domainValue) {
    return { kind: 'label', labelValue, domainValue: '' };
  }

  return { kind: 'domain', labelValue, domainValue };
}

function resolveSiteValuesForGeneration() {
  const siteInput = document.getElementById('website');
  const verifyToggle = document.getElementById('verifyDomainsToggle');
  const verifyEnabled = verifyToggle ? verifyToggle.checked : true;
  const parsed = resolveSiteInput(siteInput?.value ?? '', {
    verifyEnabled,
    forceLabel: domainState.forceLabel
  });

  const isVerifiedDomain =
    parsed.kind === 'domain' &&
    verifyEnabled &&
    domainState.status === DOMAIN_STATUS.VERIFIED &&
    domainState.domainValue === parsed.domainValue &&
    !domainState.forceLabel;

  return {
    siteValue: isVerifiedDomain ? parsed.domainValue : parsed.labelValue,
    labelValue: parsed.labelValue,
    domainValue: isVerifiedDomain ? parsed.domainValue : undefined,
    domainVerified: isVerifiedDomain
  };
}

function hasMatchingParameters(version, parameters) {
  const versionParams = PasswordGenerator.normalizeParameters(version.parameters);
  return (
    versionParams.iterations === parameters.iterations &&
    versionParams.argonMem === parameters.argonMem &&
    versionParams.scryptN === parameters.scryptN &&
    versionParams.balloonSpace === parameters.balloonSpace &&
    versionParams.balloonTime === parameters.balloonTime &&
    versionParams.balloonDelta === parameters.balloonDelta
  );
}

function normalizeOutputType(outputType) {
  return outputType === 'pin' ? 'pin' : 'password';
}

function getLengthBounds(outputType) {
  return normalizeOutputType(outputType) === 'pin'
    ? { min: MIN_PIN_LENGTH, max: MAX_PIN_LENGTH, label: 'PIN Digits', description: 'PIN digits' }
    : { min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH, label: 'Character Length', description: 'Password length' };
}

function updateLengthControlForOutputType() {
  const outputType = document.getElementById('outputType')?.value;
  const lengthInput = document.getElementById('length');
  const lengthLabel = document.getElementById('lengthLabel');
  const bounds = getLengthBounds(outputType);

  if (lengthLabel) lengthLabel.textContent = bounds.label;
  if (lengthInput) {
    lengthInput.min = String(bounds.min);
    lengthInput.max = String(bounds.max);
  }
}

function isPinOutputSelected() {
  return normalizeOutputType(document.getElementById('outputType')?.value) === 'pin';
}

function setHintVisibility(hint, show, message = null) {
  if (!hint) return;
  if (!('defaultText' in hint.dataset)) {
    hint.dataset.defaultText = hint.textContent;
  }

  hint.textContent = message || hint.dataset.defaultText;
  hint.style.display = show ? 'block' : 'none';
  hint.classList.toggle('show', show);
}

function findLatestSeriesVersion(registry, {
  algorithm,
  outputType,
  length,
  policyOn,
  compatMode,
  parameters
}) {
  if (!registry || !Array.isArray(registry.versions)) return null;

  return registry.versions.reduce((latest, version) => {
    if (!version) return latest;
    if (version.algorithm !== algorithm) return latest;
    if (normalizeOutputType(version.outputType) !== normalizeOutputType(outputType)) return latest;
    if (version.length !== length) return latest;
    if (Boolean(version.policyOn) !== Boolean(policyOn)) return latest;
    if (Boolean(version.compatMode) !== Boolean(compatMode)) return latest;
    if (!hasMatchingParameters(version, parameters)) return latest;

    if (!latest) return version;
    const latestVersionNumber = typeof latest.version === 'number' ? latest.version : 0;
    const versionNumber = typeof version.version === 'number' ? version.version : 0;
    return versionNumber >= latestVersionNumber ? version : latest;
  }, null);
}

function getCounterSequenceError({
  registry,
  normalizedCounter,
  algorithm,
  outputType,
  length,
  policyOn,
  compatMode,
  parameters
}) {
  const nextCounterValue = parseNumericCounterValue(normalizedCounter);
  if (nextCounterValue === null) return '';

  const latestSeries = findLatestSeriesVersion(registry, {
    algorithm,
    outputType,
    length,
    policyOn,
    compatMode,
    parameters
  });
  if (!latestSeries) return '';

  const latestCounterRaw = latestSeries.counter ?? '0';
  const latestCounterValue = parseNumericCounterValue(latestCounterRaw);
  if (latestCounterValue === null) return '';

  const expectedNext = typeof latestCounterValue === 'bigint'
    ? latestCounterValue + 1n
    : latestCounterValue + 1;
  if (nextCounterValue > expectedNext) {
    return `Counter must increment by 1. Last used counter for this recipe is ${latestCounterRaw}. Please use ${expectedNext} next.`;
  }

  return '';
}

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
  updateLengthControlForOutputType();
  initDomainVerification();
  initAccountLabelSuggestions();
  refreshHistoryList();
  updateStorageInfo();
  initSyncUI({ refreshHistoryList, updateStorageInfo });
  initFileSync({ refreshHistoryList, updateStorageInfo });
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
  const rawSiteValue = document.getElementById('website').value ?? '';
  await showDomainStatusForGeneration(rawSiteValue);
  const siteValues = resolveSiteValuesForGeneration();
  const site = siteValues.siteValue;
  const accountLabel = document.getElementById('accountLabel').value.trim();
  const secretInput = document.getElementById('secret');
  const secret = secretInput.value.trim();
  const counterInput = document.getElementById('counter');
  const counterRaw = counterInput.value.trim() || '0';
  const normalizedCounter = PasswordGenerator.normalizeCounter(counterRaw);
  counterInput.value = normalizedCounter;
  updateFilledState(counterInput);
  const algorithm = document.getElementById('algorithm').value;
  const outputType = document.getElementById('outputType').value;
  const lengthInput = document.getElementById('length').value;
  const length = Number(lengthInput);
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;
  const iterations = parseInt(document.getElementById('iterations').value, 10);
  const argonMem = parseInt(document.getElementById('argonMem').value, 10);
  const scryptN = parseInt(document.getElementById('scryptN').value, 10);
  const balloonSpace = parseInt(document.getElementById('balloonSpace').value, 10);
  const balloonTime = parseInt(document.getElementById('balloonTime').value, 10);
  const balloonDelta = parseInt(document.getElementById('balloonDelta').value, 10);

  const secretStrengthError = getSecretStrengthError(secret);

  if (!secret) {
    setSecretFieldError('Please enter your master secret.');
  } else if (secretStrengthError) {
    setSecretFieldError(secretStrengthError, { silent: true });
  } else {
    clearSecretFieldError();
  }

  if (!siteValues.labelValue || !secret) {
    const missingFields = [];
    if (!siteValues.labelValue) missingFields.push('website');
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

  const lengthBounds = getLengthBounds(outputType);

  if (!Number.isInteger(length) || length < lengthBounds.min || length > lengthBounds.max) {
    showValidationError(
      `${lengthBounds.description} must be an integer between ${lengthBounds.min} and ${lengthBounds.max}.`
    );
    return;
  }

  const normalizedSite = site;
  const parameterSettings = PasswordGenerator.normalizeParameters({
    iterations,
    argonMem,
    scryptN,
    balloonSpace,
    balloonTime,
    balloonDelta
  });
  const existingRegistry = await getRegistryEntry(normalizedSite);
  const counterSequenceError = getCounterSequenceError({
    registry: existingRegistry,
    normalizedCounter,
    algorithm,
    outputType,
    length,
    policyOn,
    compatMode,
    parameters: parameterSettings
  });
  if (counterSequenceError) {
    showValidationError(counterSequenceError);
    return;
  }

  resetUI({ clearPassword: true, clearRecipe: true });

  try {
    const generator = new PasswordGenerator({
      algorithm,
      outputType,
      length,
      policyOn,
      compatMode,
      parameters: { iterations, argonMem, scryptN, balloonSpace, balloonTime, balloonDelta }
    });

    const { password } = await generator.generate({
      site: normalizedSite,
      secret,
      counter: normalizedCounter,
      normalizeSite: false
    });

    lastGeneratedPassword = password;

    const passwordSpan = document.getElementById('password');
    const copyBtn = document.getElementById('copyBtn');
    passwordSpan.innerText = password;
    copyBtn.style.display = 'inline-block';

    handleDiversityWarning(generator, password);
    showResultBox();

    const effectiveLength = generator.length;

    const { digest: recipeDigest, short: recipeShort } = await PasswordGenerator.computeRecipeId({
      algorithm,
      outputType: generator.outputType,
      site: normalizedSite,
      counter: normalizedCounter,
      length: effectiveLength,
      policyOn,
      compatMode,
      parameters: generator.parameters
    });

    document.getElementById('recipeInfo').innerText = 'Recipe ID ' + recipeShort;

    const recipeEntry = {
      id: recipeDigest,
      shortId: recipeShort,
      site: normalizedSite,
      labelValue: siteValues.labelValue || undefined,
      domainValue: siteValues.domainValue,
      domainVerified: siteValues.domainVerified || undefined,
      algorithm,
      outputType: generator.outputType,
      length: effectiveLength,
      counter: normalizedCounter,
      policyOn,
      compatMode,
      date: new Date().toISOString(),
      parameters: generator.parameters,
      ...(accountLabel ? { accountLabel } : {})
    };

    const registryResult = await recordRecipeUsage(recipeEntry, existingRegistry);
    updateRegistryMessage(normalizedSite, existingRegistry, registryResult);
    await rememberAccountLabel(accountLabel);

    await refreshHistoryList(document.getElementById('searchHistory').value.trim());
    await notifyFileSyncRegistryChange();
    scheduleAutoHide();
  } catch (error) {
    resetUI({ showError: 'Error: ' + error.message, clearRecipe: true });
  }
}

function handleDiversityWarning(generator, password) {
  const warning = document.getElementById('diversityWarning');
  warning.style.display = 'none';
  warning.innerText = '';

  if (generator.outputType !== 'pin' && generator.policyOn && !generator.isDiverse(password)) {
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
  const outputTypeSelect = document.getElementById('outputType');

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
    if (isPinOutputSelected()) {
      policyToggle.disabled = true;
      compatToggle.disabled = true;
      setHintVisibility(policyHint, true, 'Character Policy does not apply to PIN output.');
      setHintVisibility(compatHint, true, 'Compatibility Mode does not apply to PIN output.');
      updateUI();
      return;
    }

    compatToggle.disabled = policyToggle.checked;
    if (policyToggle.checked) compatToggle.checked = false;

    policyToggle.disabled = compatToggle.checked;
    if (compatToggle.checked) policyToggle.checked = false;

    setHintVisibility(policyHint, compatToggle.disabled);
    setHintVisibility(compatHint, policyToggle.disabled);

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

  outputTypeSelect?.addEventListener('change', () => {
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
    'website', 'accountLabel', 'secret', 'algorithm', 'outputType', 'counter', 'length',
    'policyToggle', 'compatToggle', 'verifyDomainsToggle', 'iterations', 'argonMem', 'scryptN',
    'balloonSpace', 'balloonTime', 'balloonDelta'
  ];

  reactiveFields.forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    registerFilledStateTracking(element);
    element.addEventListener('input', hideResultBox);
    element.addEventListener('change', hideResultBox);
    if (id === 'outputType') {
      element.addEventListener('change', updateLengthControlForOutputType);
    }
  });
}

function initDomainVerification() {
  const siteInput = document.getElementById('website');
  const statusEl = document.getElementById('domainStatus');
  const statusIcon = statusEl?.querySelector('.domain-status__icon');
  const statusText = statusEl?.querySelector('.domain-status__text');
  const verifyToggle = document.getElementById('verifyDomainsToggle');
  if (!siteInput || !statusEl || !statusIcon || !statusText || !verifyToggle) return;

  const setStatus = status => {
    domainState.status = status;
    statusEl.hidden = false;
    statusEl.classList.remove(
      'domain-status--label',
      'domain-status--checking',
      'domain-status--verified',
      'domain-status--unverified'
    );
    statusIcon.classList.remove('domain-status__icon--tick');

    if (status === DOMAIN_STATUS.LABEL) {
      statusEl.classList.add('domain-status--label');
      statusIcon.textContent = '🏷';
      statusText.textContent = 'Saved as label';
    } else if (status === DOMAIN_STATUS.CHECKING) {
      statusEl.classList.add('domain-status--checking');
      statusIcon.textContent = '';
      statusText.textContent = 'Checking domain…';
    } else if (status === DOMAIN_STATUS.VERIFIED) {
      statusEl.classList.add('domain-status--verified');
      statusIcon.textContent = '✓';
      statusText.textContent = 'Domain verified';
      void statusIcon.offsetWidth;
      statusIcon.classList.add('domain-status__icon--tick');
    } else if (status === DOMAIN_STATUS.UNVERIFIED) {
      statusEl.classList.add('domain-status--unverified');
      statusIcon.textContent = '?';
      statusText.textContent = 'Couldn’t verify this domain. Saved';
    }
  };

  const hideStatus = () => {
    clearTimeout(labelStatusTimer);
    statusEl.hidden = true;
  };

  domainStatusUI = { setStatus, hideStatus };

  const handleInputUpdate = event => {
    const rawValue = siteInput.value ?? '';
    const trimmedValue = String(rawValue).trim();
    if (event?.type === 'input' && event.isTrusted) {
      domainState.hasTyped = true;
      domainState.userInteracted = true;
    }
    if (trimmedValue !== domainState.labelValue) {
      domainState.forceLabel = false;
    }

    domainState.verifyEnabled = verifyToggle.checked;
    const parsed = resolveSiteInput(trimmedValue, {
      verifyEnabled: domainState.verifyEnabled,
      forceLabel: domainState.forceLabel
    });

    domainState.kind = parsed.kind;
    domainState.labelValue = parsed.labelValue;
    domainState.domainValue = parsed.domainValue;

    if (['input', 'change', 'focus'].includes(event?.type)) {
      clearTimeout(labelStatusTimer);
      hideStatus();
    }
  };

  const showStatusForCurrentValue = async ({ allowWhileFocused = false } = {}) => {
    if (!domainStatusUI) return;
    if (!verifyToggle.checked) {
      domainStatusUI.hideStatus();
      return;
    }
    if (!domainState.hasTyped || !domainState.userInteracted) {
      domainStatusUI.hideStatus();
      return;
    }
    if (!allowWhileFocused && document.activeElement === siteInput) {
      domainStatusUI.hideStatus();
      return;
    }

    const parsed = resolveSiteInput(siteInput.value ?? '', {
      verifyEnabled: true,
      forceLabel: domainState.forceLabel
    });

    if (!parsed.labelValue) {
      domainStatusUI.hideStatus();
      return;
    }

    if (parsed.kind === 'label') {
      domainStatusUI.setStatus(DOMAIN_STATUS.LABEL);
      return;
    }

    if (domainVerificationCache.has(parsed.domainValue)) {
      domainStatusUI.setStatus(domainVerificationCache.get(parsed.domainValue));
      return;
    }

    domainStatusUI.setStatus(DOMAIN_STATUS.CHECKING);
    const result = await verifyDomain(parsed.domainValue);
    domainVerificationCache.set(parsed.domainValue, result);
    domainStatusUI.setStatus(result);
  };

  siteInput.addEventListener('input', handleInputUpdate);
  siteInput.addEventListener('change', handleInputUpdate);
  siteInput.addEventListener('blur', event => {
    handleInputUpdate(event);
    void showStatusForCurrentValue();
  });
  siteInput.addEventListener('keydown', event => {
    if (event.isTrusted) domainState.userInteracted = true;
  });
  siteInput.addEventListener('pointerdown', event => {
    if (event.isTrusted) domainState.userInteracted = true;
  });
  siteInput.addEventListener('paste', event => {
    if (event.isTrusted) domainState.userInteracted = true;
  });
  siteInput.addEventListener('focus', () => {
    clearTimeout(labelStatusTimer);
    hideStatus();
  });

  verifyToggle.addEventListener('change', () => {
    domainState.verifyEnabled = verifyToggle.checked;
    domainState.forceLabel = false;
    handleInputUpdate({ type: 'change' });
    if (verifyToggle.checked) {
      void showStatusForCurrentValue();
    } else {
      hideStatus();
    }
  });

  handleInputUpdate();
  domainStatusUI.hideStatus();
}

async function showDomainStatusForGeneration(rawValue) {
  if (!domainStatusUI) return;
  const verifyToggle = document.getElementById('verifyDomainsToggle');
  if (!verifyToggle || !verifyToggle.checked) {
    domainStatusUI.hideStatus();
    return;
  }
  if (!domainState.hasTyped || !domainState.userInteracted) {
    domainStatusUI.hideStatus();
    return;
  }
  if (document.activeElement === document.getElementById('website')) {
    domainStatusUI.hideStatus();
    return;
  }

  const parsed = resolveSiteInput(rawValue, {
    verifyEnabled: true,
    forceLabel: domainState.forceLabel
  });

  if (!parsed.labelValue) {
    domainStatusUI.hideStatus();
    return;
  }

  if (parsed.kind === 'label') {
    domainStatusUI.setStatus(DOMAIN_STATUS.LABEL);
    return;
  }

  if (domainVerificationCache.has(parsed.domainValue)) {
    domainStatusUI.setStatus(domainVerificationCache.get(parsed.domainValue));
    return;
  }

  domainStatusUI.setStatus(DOMAIN_STATUS.CHECKING);
  const result = await verifyDomain(parsed.domainValue);
  domainVerificationCache.set(parsed.domainValue, result);
  domainStatusUI.setStatus(result);
}

async function verifyDomain(domainValue) {
  if (domainVerificationCache.has(domainValue)) {
    return domainVerificationCache.get(domainValue);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domainValue)}&type=A`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      return DOMAIN_STATUS.UNVERIFIED;
    }
    const data = await response.json();
    const hasAnswer = Array.isArray(data.Answer) && data.Answer.length > 0;
    return hasAnswer ? DOMAIN_STATUS.VERIFIED : DOMAIN_STATUS.UNVERIFIED;
  } catch {
    return DOMAIN_STATUS.UNVERIFIED;
  } finally {
    clearTimeout(timeoutId);
  }
}

function initAccountLabelSuggestions() {
  const accountLabelInput = document.getElementById('accountLabel');
  const suggestionPanel = document.getElementById('accountLabelPanel');
  if (!accountLabelInput || !suggestionPanel) return;

  let suppressNextOpen = false;
  let suppressNextFocusOpen = false;
  suggestionPanel.hidden = true;
  suggestionPanel.classList.remove('is-open');

  const refreshSuggestions = (event = {}) => {
    if (suppressNextOpen) {
      suppressNextOpen = false;
      void updateAccountLabelSuggestions(accountLabelInput.value, { openPanel: false });
      return;
    }

    if (event.type === 'focus' && suppressNextFocusOpen) {
      suppressNextFocusOpen = false;
      void updateAccountLabelSuggestions(accountLabelInput.value, { openPanel: false });
      return;
    }

    const isFocused = document.activeElement === accountLabelInput;
    const shouldOpen =
      event.type === 'focus' ||
      event.type === 'click' ||
      (event.type === 'input' && isFocused);

    void updateAccountLabelSuggestions(accountLabelInput.value, { openPanel: shouldOpen });
  };

  const closePanel = () => {
    suggestionPanel.hidden = true;
    suggestionPanel.classList.remove('is-open');
  };

  const openPanel = () => {
    if (suggestionPanel.childElementCount > 0) {
      suggestionPanel.hidden = false;
      suggestionPanel.classList.add('is-open');
    }
  };

  accountLabelInput.addEventListener('focus', refreshSuggestions);
  accountLabelInput.addEventListener('click', refreshSuggestions);
  accountLabelInput.addEventListener('input', refreshSuggestions);
  accountLabelInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closePanel();
    }
  });

  document.addEventListener('click', event => {
    if (event.target === accountLabelInput || suggestionPanel.contains(event.target)) return;
    closePanel();
  });

  document.addEventListener('focusin', event => {
    if (event.target === accountLabelInput || suggestionPanel.contains(event.target)) return;
    closePanel();
  });

  accountLabelInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== accountLabelInput) {
        closePanel();
      }
    }, 150);
  });

  suggestionPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closePanel();
      accountLabelInput.focus();
    }
  });

  suggestionPanel.addEventListener('focusout', event => {
    if (!suggestionPanel.contains(event.relatedTarget)) {
      closePanel();
    }
  });

  suggestionPanel.addEventListener('pointerdown', event => {
    if (event.target.closest('.suggestion-item')) {
      event.preventDefault();
    }
  });

  suggestionPanel.addEventListener('click', event => {
    const item = event.target.closest('.suggestion-item');
    if (!item) return;
    const value = item.dataset.value || '';
    if (!value) return;
    accountLabelInput.value = value;
    updateFilledState(accountLabelInput);
    suppressNextOpen = true;
    suppressNextFocusOpen = true;
    closePanel();
    accountLabelInput.dispatchEvent(new Event('input', { bubbles: true }));
    accountLabelInput.focus();
  });
}

async function updateAccountLabelSuggestions(filterValue = '', { openPanel = false } = {}) {
  const panel = document.getElementById('accountLabelPanel');
  if (!panel) return;

  const labels = await fetchAccountLabels();
  const filter = filterValue.trim().toLowerCase();
  const filtered = filter
    ? labels.filter(label => label.toLowerCase().includes(filter))
    : labels;

  panel.innerHTML = '';

  filtered.forEach(label => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-item';
    button.dataset.value = label;
    button.textContent = label;
    panel.appendChild(button);
  });

  const isOpen = openPanel && filtered.length;
  panel.hidden = !isOpen;
  panel.classList.toggle('is-open', isOpen);
}

async function rememberAccountLabel(accountLabel) {
  if (!accountLabel) return;
  await storeAccountLabel(accountLabel);
  await updateAccountLabelSuggestions(accountLabel, { openPanel: false });
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
    emptyItem.className = 'history-item history-item--empty';
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

    if (recipe.domainVerified) {
      const badge = document.createElement('span');
      badge.className = 'history-item__badge';
      badge.textContent = 'Verified domain';
      heading.appendChild(badge);
    }

    const algorithmLabel = document.createElement('span');
    algorithmLabel.className = 'history-item__algorithm';
    algorithmLabel.textContent = recipe.algorithm;
    heading.appendChild(algorithmLabel);

    content.appendChild(heading);

    const shortId = recipe.shortId || (recipe.id ? recipe.id.slice(0, 8) : 'unknown');
    const parameterSettings = PasswordGenerator.normalizeParameters(recipe.parameters);
    const tuningParts = formatRecipeTuning(recipe.algorithm, parameterSettings);

    const accountSummary = recipe.accountLabel || '';
    const detailParts = [
      `ID: ${shortId}`,
      ...(accountSummary ? [`Account: ${accountSummary}`] : []),
      `Counter: ${recipe.counter}`,
      normalizeOutputType(recipe.outputType) === 'pin'
        ? `${recipe.length} PIN digits`
        : `${recipe.length} chars`,
      new Date(recipe.date).toLocaleString()
    ];

    if (tuningParts.length) {
      detailParts.splice(3, 0, `Tuning: ${tuningParts.join(' · ')}`);
    }

    const meta = document.createElement('div');
    meta.className = 'history-item__meta';
    detailParts.forEach(part => {
      const metaItem = document.createElement('span');
      metaItem.textContent = part;
      meta.appendChild(metaItem);
    });
    content.appendChild(meta);

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

function formatRecipeTuning(algorithm, parameters = {}) {
  const normalized = PasswordGenerator.normalizeParameters(parameters);
  const { iterations, argonMem, scryptN, balloonSpace, balloonTime, balloonDelta } = normalized;

  const parts = [];

  const appendPart = (label, rawValue, suffix = '') => {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return;
    }

    const numericValue = Number(rawValue);
    const formattedValue = Number.isFinite(numericValue) ? numericValue.toLocaleString() : String(rawValue);
    parts.push(`${label}${formattedValue}${suffix}`);
  };

  switch (algorithm) {
    case 'PBKDF2-SHA256':
      appendPart('Iterations: ', iterations);
      break;
    case 'Argon2id':
      appendPart('Iterations: ', iterations);
      appendPart('Memory: ', argonMem, ' MB');
      break;
    case 'scrypt':
      appendPart('N: ', scryptN);
      break;
    case 'Balloon-SHA256':
      appendPart('Space: ', balloonSpace);
      appendPart('Time: ', balloonTime);
      appendPart('Δ: ', balloonDelta);
      break;
    case 'SHA-256':
    case 'SHA-512':
    case 'BLAKE2b-512':
    case 'BLAKE2s-256':
    case 'HMAC-SHA256':
      break;
    default:
      appendPart('Iterations: ', iterations);
      appendPart('Memory: ', argonMem, ' MB');
      appendPart('N: ', scryptN);
      break;
  }

  return parts;
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
    await notifyFileSyncRegistryChange();
  } catch (error) {
    console.error('Failed to delete recipe', error);
    alert('Failed to delete recipe: ' + error.message);
  }
}

function applyRecipeToForm(recipe) {
  if (!recipe) return;

  setTextFieldValue('website', recipe.site || '', 'input');
  setTextFieldValue('accountLabel', recipe.accountLabel || '', 'input');

  const normalizedCounter = PasswordGenerator.normalizeCounter(recipe.counter ?? '0');
  setTextFieldValue('counter', normalizedCounter, 'change');

  const normalizedOutputType = normalizeOutputType(recipe.outputType);
  setSelectFieldValue('outputType', normalizedOutputType, { forceEvent: true });
  updateLengthControlForOutputType();

  const parsedLength = Number.parseInt(recipe.length, 10);
  const lengthBounds = getLengthBounds(normalizedOutputType);
  const sanitizedLength = Number.isFinite(parsedLength)
    ? clamp(parsedLength, lengthBounds.min, lengthBounds.max)
    : lengthBounds.min;
  setTextFieldValue('length', sanitizedLength, 'change');

  setSelectFieldValue('algorithm', recipe.algorithm);

  setToggleValue('policyToggle', Boolean(recipe.policyOn), { forceEvent: true });
  setToggleValue('compatToggle', Boolean(recipe.compatMode), { forceEvent: true });

  const params = PasswordGenerator.normalizeParameters(recipe.parameters);
  setTextFieldValue('iterations', params.iterations, 'change');
  setTextFieldValue('argonMem', params.argonMem, 'change');
  setTextFieldValue('scryptN', params.scryptN, 'change');
  setTextFieldValue('balloonSpace', params.balloonSpace, 'change');
  setTextFieldValue('balloonTime', params.balloonTime, 'change');
  setTextFieldValue('balloonDelta', params.balloonDelta, 'change');

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

function setSelectFieldValue(id, value, { forceEvent = false } = {}) {
  const element = document.getElementById(id);
  if (!element) return;
  const allowedValues = Array.from(element.options).map(option => option.value);
  const targetValue = allowedValues.includes(String(value)) ? String(value) : element.value;
  const changed = element.value !== targetValue;
  if (changed) {
    element.value = targetValue;
  }
  updateFilledState(element);
  if (changed || forceEvent) {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setToggleValue(id, checked, { forceEvent = false } = {}) {
  const element = document.getElementById(id);
  if (!element) return;
  const normalized = Boolean(checked);
  const changed = element.checked !== normalized;
  if (changed) {
    element.checked = normalized;
  }
  if (changed || forceEvent) {
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
      await notifyFileSyncRegistryChange();
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
    await notifyFileSyncRegistryChange();
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
  const siteValues = resolveSiteValuesForGeneration();
  const site = siteValues.siteValue;
  const secret = document.getElementById('secret').value.trim();
  const counter = document.getElementById('counter').value.trim() || '0';
  const algorithm = document.getElementById('algorithm').value;
  const outputType = document.getElementById('outputType').value;
  const length = document.getElementById('length').value;
  const policyOn = document.getElementById('policyToggle').checked;
  const compatMode = document.getElementById('compatToggle').checked;
  const iterations = parseInt(document.getElementById('iterations').value, 10);
  const argonMem = parseInt(document.getElementById('argonMem').value, 10);
  const scryptN = parseInt(document.getElementById('scryptN').value, 10);
  const balloonSpace = parseInt(document.getElementById('balloonSpace').value, 10);
  const balloonTime = parseInt(document.getElementById('balloonTime').value, 10);
  const balloonDelta = parseInt(document.getElementById('balloonDelta').value, 10);

  const parameterSettings = PasswordGenerator.normalizeParameters({
    iterations,
    argonMem,
    scryptN,
    balloonSpace,
    balloonTime,
    balloonDelta
  });

  const normalizedSite = site;
  const normalizedCounter = PasswordGenerator.normalizeCounter(counter);
  const { short: recipeId } = await PasswordGenerator.computeRecipeId({
    algorithm,
    outputType,
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
    `Output type: ${normalizeOutputType(outputType)}`,
    `Normalized site: ${normalizedSite}`,
    `Counter: ${normalizedCounter}`,
    `Length: ${length}`,
    `Deterministic policy: ${policyOn}`,
    `Compatibility mode: ${compatMode}`,
    isSimpleAlgorithm(algorithm)
      ? 'Algorithm tuning: not applicable'
      : `Algorithm tuning: iterations=${parameterSettings.iterations}, argonMem=${parameterSettings.argonMem}, scryptN=${parameterSettings.scryptN}, balloonSpace=${parameterSettings.balloonSpace}, balloonTime=${parameterSettings.balloonTime}, balloonDelta=${parameterSettings.balloonDelta}`,
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
    document.getElementById('storageInfo').textContent =
      `Storage used: ${usedMB} MB / ${quotaMB} MB — only recipe metadata is stored, never your master passphrase.`;
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
    key: 'outputType',
    element: document.getElementById('outputType'),
    applyStored: (el, stored) => {
      el.value = normalizeOutputType(stored);
      updateFilledState(el);
      updateLengthControlForOutputType();
      return el.value;
    },
    readValue: el => normalizeOutputType(el.value)
  });

  registerField({
    key: 'verifyDomains',
    element: document.getElementById('verifyDomainsToggle'),
    applyStored: (el, stored) => {
      if (typeof stored !== 'boolean') return Boolean(el.checked);
      el.checked = stored;
      return stored;
    },
    readValue: el => Boolean(el.checked),
    events: ['change']
  });

  registerField({
    key: 'length',
    element: document.getElementById('length'),
    applyStored: (el, stored) => {
      const bounds = getLengthBounds(document.getElementById('outputType')?.value);
      return applyNumericPreference(el, stored, bounds.min, bounds.max);
    },
    readValue: el => {
      const bounds = getLengthBounds(document.getElementById('outputType')?.value);
      return readNumericPreference(el, bounds.min, bounds.max);
    }
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

  registerField({
    key: 'balloonSpace',
    element: document.getElementById('balloonSpace'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 4, 4096),
    readValue: el => readNumericPreference(el, 4, 4096)
  });

  registerField({
    key: 'balloonTime',
    element: document.getElementById('balloonTime'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 1, 24),
    readValue: el => readNumericPreference(el, 1, 24)
  });

  registerField({
    key: 'balloonDelta',
    element: document.getElementById('balloonDelta'),
    applyStored: (el, stored) => applyNumericPreference(el, stored, 1, 8),
    readValue: el => readNumericPreference(el, 1, 8)
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
  const verifyToggle = document.getElementById('verifyDomainsToggle');
  if (!policyToggle || !compatToggle) return;

  if (Object.prototype.hasOwnProperty.call(userPreferences, 'policyToggle')) {
    policyToggle.checked = Boolean(userPreferences.policyToggle);
  }
  if (Object.prototype.hasOwnProperty.call(userPreferences, 'compatToggle')) {
    compatToggle.checked = Boolean(userPreferences.compatToggle);
  }
  if (verifyToggle && Object.prototype.hasOwnProperty.call(userPreferences, 'verifyDomains')) {
    verifyToggle.checked = Boolean(userPreferences.verifyDomains);
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

  const outputType = document.getElementById('outputType');
  if (outputType) outputType.value = 'password';
  if (outputType) updateFilledState(outputType);
  updateLengthControlForOutputType();

  const length = document.getElementById('length');
  if (length) length.value = '16';
  if (length) updateFilledState(length);

  const policyToggle = document.getElementById('policyToggle');
  const compatToggle = document.getElementById('compatToggle');
  const verifyToggle = document.getElementById('verifyDomainsToggle');
  if (policyToggle) policyToggle.checked = true;
  if (compatToggle) compatToggle.checked = false;
  if (verifyToggle) verifyToggle.checked = true;

  const iterations = document.getElementById('iterations');
  if (iterations) iterations.value = '100000';
  if (iterations) updateFilledState(iterations);

  const argonMem = document.getElementById('argonMem');
  if (argonMem) argonMem.value = '64';
  if (argonMem) updateFilledState(argonMem);

  const scryptN = document.getElementById('scryptN');
  if (scryptN) scryptN.value = '16384';
  if (scryptN) updateFilledState(scryptN);

  const balloonSpace = document.getElementById('balloonSpace');
  if (balloonSpace) balloonSpace.value = '64';
  if (balloonSpace) updateFilledState(balloonSpace);

  const balloonTime = document.getElementById('balloonTime');
  if (balloonTime) balloonTime.value = '3';
  if (balloonTime) updateFilledState(balloonTime);

  const balloonDelta = document.getElementById('balloonDelta');
  if (balloonDelta) balloonDelta.value = '3';
  if (balloonDelta) updateFilledState(balloonDelta);

  const advancedDetails = document.querySelector('.advanced-card details');
  if (advancedDetails) advancedDetails.open = false;
}
