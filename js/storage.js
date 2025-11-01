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

export const stores = { recipeStore, historyStore, registryStore };

export async function getRegistryEntry(site) {
  return registryStore.getItem(site);
}

export async function recordRecipeUsage(recipe, existingRegistry = null) {
  const baseEntry = { ...recipe };
  const registry = existingRegistry ?? (await registryStore.getItem(baseEntry.site));

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
    if (entry) recipes.push(entry);
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
    const entry = await registryStore.getItem(key);
    if (!entry || !entry.site || !Array.isArray(entry.versions)) continue;

    const site = typeof entry.site === 'string' ? entry.site.trim() : '';
    if (!site) continue;

    const sanitizedVersions = entry.versions
      .filter(version => version && version.id)
      .map((version, index) => ({
        id: version.id,
        site,
        algorithm: version.algorithm,
        length: version.length,
        counter: version.counter,
        policyOn: Boolean(version.policyOn),
        compatMode: Boolean(version.compatMode),
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

    const incomingVersions = entry.versions
      .filter(version => version && version.id)
      .map(version => ({
        id: version.id,
        site,
        algorithm: version.algorithm,
        length: version.length,
        counter: version.counter,
        policyOn: Boolean(version.policyOn),
        compatMode: Boolean(version.compatMode),
        date: version.date || new Date().toISOString(),
        version: version.version
      }));

    if (!incomingVersions.length) continue;

    const existing = await registryStore.getItem(site);

    if (!existing) {
      const normalized = [...incomingVersions]
        .sort((a, b) => (a.version || 0) - (b.version || 0))
        .map((version, index) => ({
          ...version,
          version: index + 1
        }));

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

      merged.push({
        ...version,
        version: nextVersionNumber
      });
      changed = true;
      importedVersions += 1;
    }

    if (!changed) continue;

    merged.sort((a, b) => a.version - b.version);
    const reindexed = merged.map((version, index) => ({
      ...version,
      version: index + 1
    }));

    await registryStore.setItem(site, { site, versions: reindexed });
    await Promise.all(reindexed.map(version => recipeStore.setItem(version.id, version)));
    importedSites += 1;
  }

  return { importedSites, importedVersions };
}
