/**
 * Storage abstraction for Azkura Auth
 *
 * Architecture:
 * - chrome.storage.local  → encrypted vault blob (TOTP secrets)
 * - chrome.storage.session → decrypted vault in memory (while unlocked)
 * - chrome.storage.sync   → non-sensitive UI preferences + PIN settings
 */

// ─── Local Storage (encrypted vault) ───────────────────────────────────────

export async function getLocalItem(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

export async function setLocalItem(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

export async function removeLocalItem(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, resolve);
  });
}

export async function clearLocal() {
  return new Promise((resolve) => {
    chrome.storage.local.clear(resolve);
  });
}

// ─── Session Storage (decrypted, in-memory) ─────────────────────────────────

export async function getSessionItem(key) {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => resolve(result[key]));
  });
}

export async function setSessionItem(key, value) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [key]: value }, resolve);
  });
}

export async function removeSessionItem(key) {
  return new Promise((resolve) => {
    chrome.storage.session.remove(key, resolve);
  });
}

export async function clearSession() {
  return new Promise((resolve) => {
    chrome.storage.session.clear(resolve);
  });
}

// ─── Sync Storage (UI preferences) ──────────────────────────────────────────

export async function getSyncItem(key) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(key, (result) => resolve(result[key]));
  });
}

export async function setSyncItem(key, value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, resolve);
  });
}

// ─── App-level helpers ──────────────────────────────────────────────────────

/**
 * Check if PIN has been set up
 * @returns {Promise<boolean>}
 */
export async function isPinSetup() {
  const pinData = await getLocalItem('pinData');
  return !!pinData;
}

/**
 * Check if PIN protection is enabled
 * User can disable PIN after setup for convenience
 * @returns {Promise<boolean>}
 */
export async function isPinEnabled() {
  // Default to true if PIN is set up (backward compatibility)
  // Default to false for new users who skip PIN
  const pinEnabled = await getSyncItem('pinEnabled');
  if (pinEnabled === undefined) {
    // If not explicitly set, check if PIN was set up
    const hasPin = await isPinSetup();
    return hasPin; // If PIN exists, assume enabled; if no PIN, disabled
  }
  return pinEnabled;
}

/**
 * Enable or disable PIN protection
 * @param {boolean} enabled
 */
export async function setPinEnabled(enabled) {
  return setSyncItem('pinEnabled', enabled);
}

/**
 * Check if vault is currently unlocked (decrypted data in session)
 * @returns {Promise<boolean>}
 */
export async function isUnlocked() {
  const accounts = await getSessionItem('accounts');
  return Array.isArray(accounts);
}

/**
 * Check if this is first time setup (no PIN and no vault)
 * @returns {Promise<boolean>}
 */
export async function isFirstTimeSetup() {
  const pinData = await getLocalItem('pinData');
  const vault = await getLocalItem('vault');
  return !pinData && !vault;
}

/**
 * Get decrypted accounts from session storage
 * @returns {Promise<Array|null>}
 */
export async function getSessionAccounts() {
  return getSessionItem('accounts');
}

/**
 * Save decrypted accounts to session storage
 * @param {Array} accounts
 */
export async function setSessionAccounts(accounts) {
  return setSessionItem('accounts', accounts);
}

/**
 * Get app preferences (merged sync + local defaults)
 * @returns {Promise<object>}
 */
export async function getPreferences() {
  const defaults = {
    accentColor: '#00E5FF',
    autoLockMinutes: 5,
    privacyMode: false,
    compactLayout: false,
    closeAfterCopy: true,
    autoFocusSearch: true,
    pinEnabled: true, // Default PIN enabled for new setups
  };

  const saved = await new Promise((resolve) => {
    chrome.storage.sync.get(Object.keys(defaults), (result) => resolve(result));
  });

  return { ...defaults, ...saved };
}

/**
 * Save a preference
 * @param {string} key
 * @param {*} value
 */
export async function setPreference(key, value) {
  return setSyncItem(key, value);
}

/**
 * Save multiple preferences at once
 * @param {object} prefs
 */
export async function setPreferences(prefs) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(prefs, resolve);
  });
}
