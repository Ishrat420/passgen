import { PasswordGenerator } from './generator.js';

/* ==========================================================================
   MODULE: Storage utilities
   ========================================================================= */

const APP_NAME = 'PasswordGen';
const RECIPE_STORE_NAME = 'recipes';

localforage.config({
  name: APP_NAME,
  storeName: RECIPE_STORE_NAME,
  description: 'Stores recipe metadata for deterministic password generator'
});

const recipeStore = localforage;
const historyStore = localforage.createInstance({ storeName: 'history' });
const registryStore = localforage.createInstance({ storeName: 'registry' });

function normalizeCounterValue(counter) {
  const raw = String(counter ?? '0').trim();
  if (raw === '') return '0';

  if (/^-?\d+$/.test(raw)) {
    if (typeof BigInt === 'function') {
      try {
        return String(BigInt(raw));
      } catch {
        // Fall back to Number parsing below.
      }
    }

    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return raw.replace(/^0+(?=\d)/, '');
    return String(parsed);
  }

  return raw;
}

function ensureShortId(version = {}) {
  if (!version) return version;

  const normalizedCounter = normalizeCounterValue(version.counter ?? '0');
  const id = version.id;
  const shortId = id ? id.slice(0, 8) : '';

  const needsShort = shortId && version.shortId !== shortId;
  const needsCounter = version.counter !== normalizedCounter;

  if (!needsShort && !needsCounter) return version;

  return {
    ...version,
    shortId: needsShort ? shortId : version.shortId,
    counter: normalizedCounter
  };
}

async function ensureRecipeIdentifiers(version = {}) {
  const withShort = ensureShortId(version);
  if (!withShort) return withShort;

  const normalizedParameters = PasswordGenerator.normalizeParameters(withShort.parameters);
  const hasParameterChanges =
    !withShort.parameters ||
    withShort.parameters.iterations !== normalizedParameters.iterations ||
    withShort.parameters.argonMem !== normalizedParameters.argonMem ||
    withShort.parameters.scryptN !== normalizedParameters.scryptN;

  const baseEntry = hasParameterChanges
    ? { ...withShort, parameters: normalizedParameters }
    : withShort;

  const id = typeof baseEntry.id === 'string' ? baseEntry.id : '';
  if (id.length === 64) return baseEntry;

  if (!baseEntry.site || !baseEntry.algorithm || !baseEntry.length) {
    return baseEntry;
  }

  try {
    const { digest } = await PasswordGenerator.computeRecipeId({
      algorithm: baseEntry.algorithm,
      site: baseEntry.site,
      counter: baseEntry.counter ?? '0',
      length: baseEntry.length,
      policyOn: Boolean(baseEntry.policyOn),
      compatMode: Boolean(baseEntry.compatMode),
      parameters: normalizedParameters
    });
    if (digest && digest.length === 64) {
      return {
        ...baseEntry,
        id: digest,
        shortId: digest.slice(0, 8)
      };
    }
  } catch {
    // Ignore digest errors and fall back to existing identifier.
  }

  return baseEntry;
}

async function normalizeRegistryEntry(entry) {
  if (!entry || !Array.isArray(entry.versions)) return entry;

  let mutated = false;
  const normalizedVersions = [];
  const removals = [];
  const updates = [];

  for (const version of entry.versions) {
    if (!version) continue;
    const normalized = await ensureRecipeIdentifiers(version);
    if (!normalized) continue;
    if (normalized !== version) mutated = true;
    normalizedVersions.push(normalized);

    if (normalized && normalized.id) {
      updates.push(normalized);
      if (version.id && normalized.id !== version.id) {
        removals.push(version.id);
      }
    }
  }

  if (!mutated) return entry;

  await Promise.all(removals.map(id => recipeStore.removeItem(id)));
  const normalizedEntry = { ...entry, versions: normalizedVersions };
  await registryStore.setItem(entry.site, normalizedEntry);
  await Promise.all(updates.map(version => recipeStore.setItem(version.id, version)));
  return normalizedEntry;
}

async function normalizeRecipeEntry(entry, key) {
  if (!entry) return entry;
  const normalized = await ensureRecipeIdentifiers(entry);
  if (!normalized || !normalized.id) return normalized;

  if (key && key !== normalized.id) {
    await recipeStore.removeItem(key);
  }
  await recipeStore.setItem(normalized.id, normalized);
  return normalized;
}

export const stores = { recipeStore, historyStore, registryStore };

export async function getRegistryEntry(site) {
  const entry = await registryStore.getItem(site);
  return normalizeRegistryEntry(entry);
}

export async function recordRecipeUsage(recipe, existingRegistry = null) {
  const originalId = recipe?.id;
  const baseEntry = await ensureRecipeIdentifiers(recipe);
  if (originalId && baseEntry?.id && originalId !== baseEntry.id) {
    await recipeStore.removeItem(originalId);
  }
  const registry = existingRegistry
    ? await normalizeRegistryEntry(existingRegistry)
    : await normalizeRegistryEntry(await registryStore.getItem(baseEntry.site));

  if (!registry) {
    const versionedEntry = { ...baseEntry, version: 1 };
    const newRegistry = { site: baseEntry.site, versions: [versionedEntry] };
    await registryStore.setItem(baseEntry.site, newRegistry);
    await recipeStore.setItem(versionedEntry.id, versionedEntry);
    return {
      registryEntry: newRegistry,
      matchedVersion: versionedEntry,
      latestVersion: versionedEntry,
      wasExistingRegistry: false,
      isNewVersion: false
    };
  }

  const match = registry.versions.find(v => v.id === baseEntry.id);
  if (match) {
    const stored = { ...baseEntry, version: match.version };
    await recipeStore.setItem(stored.id, stored);
    return {
      registryEntry: registry,
      matchedVersion: match,
      latestVersion: registry.versions[registry.versions.length - 1],
      wasExistingRegistry: true,
      isNewVersion: false
    };
  }

  const newVersionNumber = registry.versions.length + 1;
  const newVersion = { ...baseEntry, version: newVersionNumber };
  const updatedRegistry = {
    site: registry.site,
    versions: [...registry.versions, newVersion]
  };

  await registryStore.setItem(baseEntry.site, updatedRegistry);
  await recipeStore.setItem(newVersion.id, newVersion);

  return {
    registryEntry: updatedRegistry,
    matchedVersion: null,
    latestVersion: newVersion,
    wasExistingRegistry: true,
    isNewVersion: true
  };
}

export async function fetchRecipes() {
  const keys = await recipeStore.keys();
  const recipes = [];
  for (const key of keys) {
    const entry = await recipeStore.getItem(key);
    if (!entry) continue;
    const normalized = await normalizeRecipeEntry(entry, key);
    if (normalized) recipes.push(normalized);
  }
  return recipes.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function clearRecipeHistory() {
  await recipeStore.clear();
}

export async function clearAllData() {
  await Promise.all([localforage.clear(), historyStore.clear(), registryStore.clear()]);
}

export async function importRecipes(recipes = []) {
  for (const recipe of recipes) {
    if (!recipe || !recipe.id || !recipe.site) continue;
    await recordRecipeUsage(recipe);
  }
}

export async function exportRecipes() {
  return fetchRecipes();
}

export async function exportRegistrySnapshot() {
  const keys = await registryStore.keys();
  const entries = [];

  for (const key of keys) {
    const entry = await normalizeRegistryEntry(await registryStore.getItem(key));
    if (!entry || !entry.site || !Array.isArray(entry.versions)) continue;

    const site = typeof entry.site === 'string' ? entry.site.trim() : '';
    if (!site) continue;

    const sanitizedVersions = entry.versions
      .filter(version => version && version.id)
      .map((version, index) => ({
        id: version.id,
        shortId: version.shortId || (version.id ? version.id.slice(0, 8) : ''),
        site,
        algorithm: version.algorithm,
        length: version.length,
        counter: version.counter,
        policyOn: Boolean(version.policyOn),
        compatMode: Boolean(version.compatMode),
        parameters: PasswordGenerator.normalizeParameters(version.parameters),
        date: version.date || new Date().toISOString(),
        version: version.version || index + 1
      }));

    if (!sanitizedVersions.length) continue;

    sanitizedVersions.sort((a, b) => a.version - b.version);

    entries.push({
      site,
      versions: sanitizedVersions
    });
  }

  entries.sort((a, b) => a.site.localeCompare(b.site));

  return {
    exportedAt: new Date().toISOString(),
    sites: entries.length,
    entries
  };
}

export async function importRegistrySnapshot(snapshot = {}) {
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  let importedSites = 0;
  let importedVersions = 0;

  for (const entry of entries) {
    if (!entry || !entry.site || !Array.isArray(entry.versions)) continue;

    const site = String(entry.site).trim();
    if (!site) continue;

    const incomingVersions = [];
    for (const version of entry.versions) {
      if (!version || !version.id) continue;
      const prepared = await ensureRecipeIdentifiers({
        id: version.id,
        shortId: version.shortId || (version.id ? version.id.slice(0, 8) : ''),
        site,
        algorithm: version.algorithm,
        length: version.length,
        counter: version.counter,
        policyOn: Boolean(version.policyOn),
        compatMode: Boolean(version.compatMode),
        parameters: PasswordGenerator.normalizeParameters(version.parameters),
        date: version.date || new Date().toISOString(),
        version: version.version
      });
      if (prepared && prepared.id) {
        incomingVersions.push(prepared);
      }
    }

    if (!incomingVersions.length) continue;

    const existing = await normalizeRegistryEntry(await registryStore.getItem(site));

    if (!existing) {
      const sorted = [...incomingVersions].sort((a, b) => (a.version || 0) - (b.version || 0));
      const normalized = [];
      for (let index = 0; index < sorted.length; index += 1) {
        const withVersion = { ...sorted[index], version: index + 1 };
        const prepared = await ensureRecipeIdentifiers(withVersion);
        if (prepared && prepared.id) {
          normalized.push(prepared);
        }
      }

      await registryStore.setItem(site, { site, versions: normalized });
      await Promise.all(normalized.map(version => recipeStore.setItem(version.id, version)));

      importedSites += 1;
      importedVersions += normalized.length;
      continue;
    }

    const merged = Array.isArray(existing.versions) ? [...existing.versions] : [];
    let changed = false;

    for (const version of incomingVersions) {
      const alreadyExists = merged.some(existingVersion => existingVersion.id === version.id);
      if (alreadyExists) continue;

      const nextVersionNumber = version.version && version.version > 0
        ? version.version
        : merged.length + 1;

      const prepared = await ensureRecipeIdentifiers({
        ...version,
        version: nextVersionNumber
      });
      merged.push(prepared);
      changed = true;
      importedVersions += 1;
    }

    if (!changed) continue;

    merged.sort((a, b) => a.version - b.version);
    const reindexed = [];
    for (let index = 0; index < merged.length; index += 1) {
      const prepared = await ensureRecipeIdentifiers({
        ...merged[index],
        version: index + 1
      });
      reindexed.push(prepared);
    }

    await registryStore.setItem(site, { site, versions: reindexed });
    await Promise.all(reindexed.map(version => recipeStore.setItem(version.id, version)));
    importedSites += 1;
  }

  return { importedSites, importedVersions };
}
