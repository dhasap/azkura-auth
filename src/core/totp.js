/**
 * TOTP (Time-based One-Time Password) implementation
 * Using otplib v13 for RFC 6238 compliant generation
 * Supports SHA1, SHA256, SHA512 algorithms
 */

import { generate, verify, generateSecret, OTP } from 'otplib';

// Create OTP instance for configuration
const otp = new OTP();

/**
 * Generate a TOTP code using otplib v13
 * @param {string} secretBase32 - Base32 encoded secret (with or without spaces)
 * @param {object} options
 * @param {number} [options.digits=6] - Number of digits
 * @param {number} [options.period=30] - Time period in seconds
 * @param {string} [options.algorithm='SHA1'] - Hash algorithm (SHA1, SHA256, SHA512)
 * @returns {Promise<string>} - Zero-padded OTP code
 */
export async function generateTOTP(secretBase32, options = {}) {
  const {
    digits = 6,
    period = 30,
    algorithm = 'SHA1',
  } = options;

  // Clean secret (remove spaces, uppercase)
  const cleanSecret = secretBase32.replace(/\s/g, '').toUpperCase();

  // Validate secret
  if (!isValidSecret(cleanSecret)) {
    throw new Error('Invalid Base32 secret key');
  }

  try {
    const token = await generate({
      secret: cleanSecret,
      digits,
      period,
      algorithm: algorithm.toUpperCase(),
      window: 1 // Allow 1 step window for time drift
    });
    return token;
  } catch (error) {
    console.error('[TOTP] Generation error:', error);
    throw new Error('Failed to generate TOTP code: ' + error.message);
  }
}

/**
 * Verify a TOTP code (useful for testing)
 * @param {string} token - The code to verify
 * @param {string} secret - Base32 encoded secret
 * @param {object} options
 * @returns {Promise<boolean>}
 */
export async function verifyTOTP(token, secret, options = {}) {
  const {
    digits = 6,
    period = 30,
    algorithm = 'SHA1',
    window = 1
  } = options;

  const cleanSecret = secret.replace(/\s/g, '').toUpperCase();

  try {
    const result = await verify({
      secret: cleanSecret,
      token,
      digits,
      period,
      algorithm: algorithm.toUpperCase(),
      window
    });
    return result;
  } catch {
    return false;
  }
}

/**
 * Get remaining seconds in current TOTP window
 * @param {number} [period=30]
 * @returns {number} Seconds remaining (0-period)
 */
export function getRemainingSeconds(period = 30) {
  return period - (Math.floor(Date.now() / 1000) % period);
}

/**
 * Get elapsed fraction (0..1) of current window, for progress ring
 * @param {number} [period=30]
 * @returns {number} 0 = just refreshed, 1 = about to expire
 */
export function getElapsedFraction(period = 30) {
  return 1 - getRemainingSeconds(period) / period;
}

/**
 * Format a 6-digit code as "XXX XXX" (with space)
 * @param {string} code
 * @returns {string}
 */
export function formatCode(code) {
  if (!code) return '--- ---';
  if (code.length === 6) {
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }
  if (code.length === 8) {
    return `${code.slice(0, 4)} ${code.slice(4)}`;
  }
  return code;
}

/**
 * Validate a Base32 secret
 * @param {string} secret
 * @returns {boolean}
 */
export function isValidSecret(secret) {
  if (!secret || typeof secret !== 'string') return false;
  const clean = secret.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  // Base32 alphabet: A-Z, 2-7
  return /^[A-Z2-7]+$/.test(clean) && clean.length >= 8;
}

/**
 * Generate a random Base32 secret (useful for testing)
 * @param {number} [length=32]
 * @returns {string}
 */
export function generateRandomSecret(length = 32) {
  return generateSecret();
}

/**
 * Get the OTP instance for advanced usage
 * @returns {OTP}
 */
export function getOTPInstance() {
  return otp;
}
