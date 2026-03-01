/**
 * Account management for Azkura Auth
 * CRUD operations + export/import with encryption
 */

import { encrypt, decrypt } from './crypto.js';
import {
  getLocalItem,
  setLocalItem,
  getSessionAccounts,
  setSessionAccounts,
  clearLocal,
  clearSession,
} from './storage.js';

/**
 * Generate a unique ID
 * @returns {string}
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Get service icon/color from issuer name
 * @param {string} issuer
 * @returns {{bg: string, letter: string}}
 */
export function getServiceMeta(issuer) {
  const name = (issuer || '').toLowerCase();
  const colorMap = {
    discord: { bg: '#5865F2', emoji: '🎮' },
    github: { bg: '#24292e', emoji: '🐙' },
    google: { bg: '#4285F4', emoji: '🔵' },
    gmail: { bg: '#EA4335', emoji: '📧' },
    aws: { bg: '#FF9900', emoji: '☁️' },
    amazon: { bg: '#FF9900', emoji: '📦' },
    stripe: { bg: '#6772E5', emoji: '💳' },
    twitter: { bg: '#1DA1F2', emoji: '🐦' },
    x: { bg: '#000000', emoji: '✖️' },
    facebook: { bg: '#1877F2', emoji: '📘' },
    instagram: { bg: '#E1306C', emoji: '📷' },
    microsoft: { bg: '#00A4EF', emoji: '🪟' },
    apple: { bg: '#555555', emoji: '🍎' },
    gitlab: { bg: '#FC6D26', emoji: '🦊' },
    dropbox: { bg: '#0061FF', emoji: '📦' },
    slack: { bg: '#4A154B', emoji: '💬' },
    twitch: { bg: '#9146FF', emoji: '🎮' },
    reddit: { bg: '#FF4500', emoji: '🤖' },
    linkedin: { bg: '#0A66C2', emoji: '💼' },
    cloudflare: { bg: '#F48120', emoji: '☁️' },
    digitalocean: { bg: '#0080FF', emoji: '🌊' },
    bitwarden: { bg: '#175DDC', emoji: '🔐' },
    binance: { bg: '#F0B90B', emoji: '₿' },
    coinbase: { bg: '#0052FF', emoji: '🪙' },
  };

  for (const [key, val] of Object.entries(colorMap)) {
    if (name.includes(key)) return val;
  }

  // Generate consistent color from issuer string
  let hash = 0;
  for (const char of (issuer || 'A')) {
    hash = (hash * 31 + char.charCodeAt(0)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return { bg: `hsl(${hue}, 60%, 40%)`, emoji: null };
}

// ─── Vault operations ────────────────────────────────────────────────────────

/**
 * Load and decrypt vault, store in session
 * @param {string} password
 * @returns {Promise<Array>} accounts
 */
export async function unlockVault(password) {
  const vault = await getLocalItem('vault');

  if (!vault) {
    // First time unlock with no accounts
    await setSessionAccounts([]);
    return [];
  }

  const plaintext = await decrypt(vault, password); // throws if wrong password
  const accounts = JSON.parse(plaintext);
  await setSessionAccounts(accounts);
  return accounts;
}

/**
 * Save current session accounts to encrypted local vault
 * @param {string} password
 */
export async function saveVault(password) {
  const accounts = await getSessionAccounts();
  if (!accounts) return;

  const plaintext = JSON.stringify(accounts);
  const encrypted = await encrypt(plaintext, password);
  await setLocalItem('vault', encrypted);
}

/**
 * Lock the vault (clear session)
 */
export async function lockVault() {
  await clearSession();
}

// ─── Account CRUD ────────────────────────────────────────────────────────────

/**
 * Get all accounts from session
 * @returns {Promise<Array>}
 */
export async function getAccounts() {
  const accounts = await getSessionAccounts();
  return accounts || [];
}

/**
 * Add a new account
 * @param {object} accountData
 * @param {string} password - For re-encrypting vault
 * @returns {Promise<object>} Created account
 */
export async function addAccount(accountData, password) {
  const accounts = await getAccounts();

  const account = {
    id: generateId(),
    issuer: accountData.issuer || '',
    account: accountData.account || '',
    secret: accountData.secret.replace(/\s/g, '').toUpperCase(),
    algorithm: accountData.algorithm || 'SHA1',
    digits: accountData.digits || 6,
    period: accountData.period || 30,
    createdAt: Date.now(),
  };

  accounts.push(account);
  await setSessionAccounts(accounts);
  await saveVault(password);
  return account;
}

/**
 * Update an existing account
 * @param {string} id
 * @param {object} updates
 * @param {string} password
 * @returns {Promise<object>} Updated account
 */
export async function updateAccount(id, updates, password) {
  const accounts = await getAccounts();
  const index = accounts.findIndex(a => a.id === id);
  if (index === -1) throw new Error('Account not found');

  accounts[index] = {
    ...accounts[index],
    ...updates,
    id, // preserve id
    updatedAt: Date.now(),
  };

  if (updates.secret) {
    accounts[index].secret = updates.secret.replace(/\s/g, '').toUpperCase();
  }

  await setSessionAccounts(accounts);
  await saveVault(password);
  return accounts[index];
}

/**
 * Delete an account by ID
 * @param {string} id
 * @param {string} password
 */
export async function deleteAccount(id, password) {
  const accounts = await getAccounts();
  const filtered = accounts.filter(a => a.id !== id);
  await setSessionAccounts(filtered);
  await saveVault(password);
}

/**
 * Reorder accounts (after drag-and-drop)
 * @param {string[]} orderedIds
 * @param {string} password
 */
export async function reorderAccounts(orderedIds, password) {
  const accounts = await getAccounts();
  const map = Object.fromEntries(accounts.map(a => [a.id, a]));
  const reordered = orderedIds.map(id => map[id]).filter(Boolean);
  await setSessionAccounts(reordered);
  await saveVault(password);
}

/**
 * Search accounts by query
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function searchAccounts(query) {
  const accounts = await getAccounts();
  if (!query || !query.trim()) return accounts;
  const q = query.toLowerCase();
  return accounts.filter(a =>
    (a.issuer || '').toLowerCase().includes(q) ||
    (a.account || '').toLowerCase().includes(q)
  );
}

// ─── Export / Import ─────────────────────────────────────────────────────────

/**
 * Export accounts as encrypted JSON backup
 * @param {string} exportPassword - Password for the backup file (can differ from vault password)
 * @returns {Promise<string>} JSON string for download
 */
export async function exportBackup(exportPassword) {
  const accounts = await getAccounts();
  const plaintext = JSON.stringify(accounts);
  const encrypted = await encrypt(plaintext, exportPassword);

  const backup = {
    app: 'azkura-auth',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    accountCount: accounts.length,
    encrypted,
  };

  return JSON.stringify(backup, null, 2);
}

/**
 * Import accounts from encrypted JSON backup
 * @param {string} jsonString - Content of backup file
 * @param {string} importPassword - Password used when exporting
 * @param {string} vaultPassword - Current vault password to re-encrypt
 * @returns {Promise<{imported: number, total: number}>}
 */
export async function importBackup(jsonString, importPassword, vaultPassword) {
  let backup;
  try {
    backup = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid backup file: not valid JSON');
  }

  if (backup.app !== 'azkura-auth') {
    throw new Error('Invalid backup file: not an Azkura Auth backup');
  }

  const plaintext = await decrypt(backup.encrypted, importPassword);
  const importedAccounts = JSON.parse(plaintext);

  if (!Array.isArray(importedAccounts)) {
    throw new Error('Invalid backup: corrupted account data');
  }

  const existing = await getAccounts();
  const existingIds = new Set(existing.map(a => a.secret + a.account));

  // Add accounts that don't already exist (by secret + account combo)
  const newAccounts = importedAccounts.filter(a =>
    !existingIds.has(a.secret + a.account)
  );

  const merged = [...existing, ...newAccounts.map(a => ({
    ...a,
    id: generateId(), // new ID to avoid collisions
  }))];

  await setSessionAccounts(merged);
  await saveVault(vaultPassword);

  return { imported: newAccounts.length, total: merged.length };
}

/**
 * Restore accounts from Google Drive backup (no password needed)
 * @param {Array} accountsData - Accounts array from Drive backup
 * @param {string} vaultPassword - Current vault password to encrypt
 * @returns {Promise<{imported: number, total: number}>}
 */
export async function restoreFromDriveBackup(accountsData, vaultPassword) {
  if (!Array.isArray(accountsData)) {
    throw new Error('Invalid backup: accounts data is not an array');
  }

  const existing = await getAccounts();
  const existingIds = new Set(existing.map(a => a.secret + a.account));

  // Add accounts that don't already exist (by secret + account combo)
  const newAccounts = accountsData.filter(a =>
    !existingIds.has(a.secret + a.account)
  );

  const merged = [...existing, ...newAccounts.map(a => ({
    ...a,
    id: generateId(), // new ID to avoid collisions
  }))];

  await setSessionAccounts(merged);
  await saveVault(vaultPassword);

  return { imported: newAccounts.length, total: merged.length };
}

/**
 * Delete all accounts and reset vault
 * @param {string} password
 */
export async function deleteAllAccounts(password) {
  await setSessionAccounts([]);
  await saveVault(password);
}

/**
 * Completely wipe all extension data (for "reset app")
 */
export async function wipeAllData() {
  await clearLocal();
  await clearSession();
}
