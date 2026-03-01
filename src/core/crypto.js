/**
 * Cryptographic utilities for Azkura Auth
 * AES-256-GCM encryption + PBKDF2 key derivation
 * 
 * Supports:
 * - PIN-based encryption (high security)
 * - Default key encryption (convenience, PIN optional)
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// Default encryption key for PIN-less mode (derived from extension info)
// Note: This provides obfuscation, not strong security. User should enable PIN for sensitive data.
let cachedDefaultKey = null;

/**
 * Generate random bytes
 * @param {number} length
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Convert Uint8Array to Base64 string
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert Base64 string to Uint8Array
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Derive AES-256-GCM key from password using PBKDF2
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 310_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Get or generate default encryption key for PIN-less mode
 * This provides basic obfuscation when user chooses not to use PIN
 * @returns {Promise<string>} - Default encryption key
 */
export async function getDefaultKey() {
  if (cachedDefaultKey) {
    return cachedDefaultKey;
  }

  // Create a deterministic key based on extension info and browser properties
  // This is NOT cryptographically secure but provides basic obfuscation
  const extensionId = chrome.runtime.id || 'azkura-auth';
  const browserInfo = navigator.userAgent || 'unknown';
  const screenInfo = `${screen.width}x${screen.height}`;
  
  // Combine into a string
  const keyMaterial = `${extensionId}:${browserInfo}:${screenInfo}:azkura-default-key-v1`;
  
  // Hash it to get a consistent key
  const encoder = new TextEncoder();
  const data = encoder.encode(keyMaterial);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  
  // Convert to base64 string for use as password
  cachedDefaultKey = btoa(String.fromCharCode(...hashArray));
  return cachedDefaultKey;
}

/**
 * Clear cached default key (called on logout/security events)
 */
export function clearDefaultKeyCache() {
  cachedDefaultKey = null;
}

/**
 * Encrypt plaintext string with a password
 * @param {string} plaintext
 * @param {string} password - If null/empty, uses default key
 * @returns {Promise<{salt: string, iv: string, ciphertext: string, version: number}>}
 */
export async function encrypt(plaintext, password) {
  // Use default key if no password provided
  const effectivePassword = password || await getDefaultKey();
  
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(effectivePassword, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );

  return {
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    version: 1,
  };
}

/**
 * Decrypt an encrypted bundle with a password
 * @param {{salt: string, iv: string, ciphertext: string}} bundle
 * @param {string} password - If null/empty, uses default key
 * @returns {Promise<string>} - Decrypted plaintext
 * @throws {Error} If password is wrong or data is corrupted
 */
export async function decrypt(bundle, password) {
  // Use default key if no password provided
  const effectivePassword = password || await getDefaultKey();
  
  const salt = fromBase64(bundle.salt);
  const iv = fromBase64(bundle.iv);
  const ciphertext = fromBase64(bundle.ciphertext);
  const key = await deriveKey(effectivePassword, salt);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return dec.decode(plaintext);
  } catch {
    throw new Error('Incorrect PIN/password or corrupted data');
  }
}

/**
 * Hash a PIN/password for verification (separate from vault key derivation)
 * Uses PBKDF2 with different salt to create a verification hash
 * @param {string} pin
 * @param {Uint8Array} salt
 * @returns {Promise<string>} Base64-encoded hash
 */
export async function hashPin(pin, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Verify a PIN against stored hash + salt
 * @param {string} pin
 * @param {string} storedHash - Base64
 * @param {string} storedSalt - Base64
 * @returns {Promise<boolean>}
 */
export async function verifyPin(pin, storedHash, storedSalt) {
  const salt = fromBase64(storedSalt);
  const hash = await hashPin(pin, salt);
  return hash === storedHash;
}

/**
 * Setup PIN: generate salt and hash
 * @param {string} pin
 * @returns {Promise<{hash: string, salt: string}>}
 */
export async function setupPin(pin) {
  const salt = randomBytes(16);
  const hash = await hashPin(pin, salt);
  return {
    hash,
    salt: toBase64(salt),
  };
}
