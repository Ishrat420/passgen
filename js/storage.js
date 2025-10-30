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
