/**
 * Parse and generate otpauth:// URIs
 * Format: otpauth://totp/ISSUER:ACCOUNT?secret=BASE32&issuer=ISSUER&algorithm=SHA1&digits=6&period=30
 */

/**
 * Parse an otpauth:// URI into an account object
 * @param {string} uri
 * @returns {{type: string, issuer: string, account: string, secret: string, algorithm: string, digits: number, period: number}}
 * @throws {Error}
 */
export function parseOtpauthURI(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('Invalid URI: must be a string');
  }

  const trimmed = uri.trim();
  if (!trimmed.startsWith('otpauth://')) {
    throw new Error('Invalid URI: must start with otpauth://');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid URI: malformed URL');
  }

  const type = url.hostname.toLowerCase(); // 'totp' or 'hotp'
  if (type !== 'totp' && type !== 'hotp') {
    throw new Error(`Unsupported OTP type: ${type}`);
  }

  // Label: decode and split "Issuer:Account"
  const labelRaw = decodeURIComponent(url.pathname.slice(1));
  let issuer = '';
  let account = labelRaw;

  if (labelRaw.includes(':')) {
    const colonIndex = labelRaw.indexOf(':');
    issuer = labelRaw.slice(0, colonIndex).trim();
    account = labelRaw.slice(colonIndex + 1).trim();
  }

  const params = url.searchParams;

  // issuer parameter overrides label issuer if present
  if (params.get('issuer')) {
    issuer = params.get('issuer');
  }

  const secret = params.get('secret');
  if (!secret) {
    throw new Error('Invalid URI: missing secret parameter');
  }

  const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase();
  const digits = parseInt(params.get('digits') || '6', 10);
  const period = parseInt(params.get('period') || '30', 10);

  return {
    type,
    issuer: issuer || account.split('@')[1] || 'Unknown',
    account,
    secret: secret.replace(/\s/g, '').toUpperCase(),
    algorithm,
    digits: isNaN(digits) ? 6 : digits,
    period: isNaN(period) ? 30 : period,
  };
}

/**
 * Generate an otpauth:// URI from account data
 * @param {{issuer: string, account: string, secret: string, algorithm?: string, digits?: number, period?: number}} account
 * @returns {string}
 */
export function generateOtpauthURI(account) {
  const { issuer, account: acct, secret, algorithm = 'SHA1', digits = 6, period = 30 } = account;
  const label = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(acct)}` : encodeURIComponent(acct);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
