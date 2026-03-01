/**
 * Google Authentication module for Azkura Auth
 * Handles login/logout with chrome.identity.getAuthToken + fallback for mobile
 */

import { setLocalItem, getLocalItem, removeLocalItem } from './storage.js';

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const STORAGE_KEY_TOKEN = 'googleAuthToken';
const STORAGE_KEY_USER = 'googleUserProfile';

// OAuth2 config from manifest
const OAUTH2_CLIENT_ID = '861059574565-2lnjskhsb0s00c1g6fepv7s5kd6veqcs.apps.googleusercontent.com';
const OAUTH2_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file'
];

/**
 * Check if user is logged in with Google
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn() {
  const token = await getLocalItem(STORAGE_KEY_TOKEN);
  const user = await getLocalItem(STORAGE_KEY_USER);
  return !!(token && user);
}

/**
 * Get current user profile
 * @returns {Promise<{name: string, email: string, picture: string} | null>}
 */
export async function getUserProfile() {
  return await getLocalItem(STORAGE_KEY_USER);
}

/**
 * Get current auth token
 * @returns {Promise<string | null>}
 */
export async function getAuthToken() {
  return await getLocalItem(STORAGE_KEY_TOKEN);
}

/**
 * Get auth token with fallback for mobile browsers
 * Tries chrome.identity.getAuthToken first, falls back to launchWebAuthFlow on mobile
 * @param {boolean} interactive - Whether to show UI if needed
 * @returns {Promise<string>} Access token
 */
async function getAuthTokenWithFallback(interactive = true) {
  // Try chrome.identity.getAuthToken first (works on desktop)
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!token) {
          reject(new Error('No token received'));
        } else {
          resolve(token);
        }
      });
    });
    return token;
  } catch (error) {
    // If getAuthToken fails (common on mobile), try launchWebAuthFlow
    console.log('[Google Auth] getAuthToken failed, trying launchWebAuthFlow:', error.message);
    
    if (!interactive) {
      throw error; // Can't do non-interactive auth with launchWebAuthFlow
    }
    
    return await getTokenViaWebAuthFlow();
  }
}

/**
 * Get token using launchWebAuthFlow (fallback for mobile browsers)
 * Constructs OAuth2 URL manually and extracts token from redirect URL
 * @returns {Promise<string>} Access token
 */
async function getTokenViaWebAuthFlow() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const state = Math.random().toString(36).substring(2, 15);
  
  // Build OAuth2 URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', OAUTH2_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH2_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'consent');
  
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (redirectUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        
        if (!redirectUrl) {
          reject(new Error('No redirect URL received'));
          return;
        }
        
        // Parse access token from redirect URL hash
        const hash = redirectUrl.split('#')[1];
        if (!hash) {
          reject(new Error('No hash in redirect URL'));
          return;
        }
        
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const returnedState = params.get('state');
        
        if (!accessToken) {
          const error = params.get('error');
          reject(new Error(error || 'No access token in response'));
          return;
        }
        
        // Verify state to prevent CSRF
        if (returnedState !== state) {
          reject(new Error('State mismatch - possible CSRF attack'));
          return;
        }
        
        resolve(accessToken);
      }
    );
  });
}

/**
 * Login with Google using getAuthToken with fallback to launchWebAuthFlow
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function loginGoogle() {
  try {
    // Get auth token with fallback for mobile
    const token = await getAuthTokenWithFallback(true);

    // Store token
    await setLocalItem(STORAGE_KEY_TOKEN, token);

    // Fetch user profile
    const user = await fetchUserProfile(token);
    
    if (!user) {
      throw new Error('Failed to fetch user profile');
    }

    // Store user profile
    await setLocalItem(STORAGE_KEY_USER, user);

    return { success: true, user };
  } catch (error) {
    console.error('[Google Auth] Login failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Logout from Google
 * Removes token from storage and from Chrome's cache
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function logoutGoogle() {
  try {
    const token = await getLocalItem(STORAGE_KEY_TOKEN);
    
    if (token) {
      // Remove cached token from Chrome
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
      
      // Also revoke token if possible (optional, for security)
      try {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`, {
          method: 'GET'
        });
      } catch (e) {
        // Ignore revoke errors
      }
    }

    // Clear stored data
    await removeLocalItem(STORAGE_KEY_TOKEN);
    await removeLocalItem(STORAGE_KEY_USER);

    return { success: true };
  } catch (error) {
    console.error('[Google Auth] Logout failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Refresh user profile (useful after page reload)
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function refreshUserProfile() {
  try {
    const token = await getLocalItem(STORAGE_KEY_TOKEN);
    
    if (!token) {
      return { success: false, error: 'Not logged in' };
    }

    // Try to fetch profile with existing token
    const user = await fetchUserProfile(token);
    
    if (user) {
      await setLocalItem(STORAGE_KEY_USER, user);
      return { success: true, user };
    }

    // Token might be expired, try to get new token non-interactively
    // Note: On mobile, this will likely fail, requiring re-login
    try {
      const newToken = await getAuthTokenWithFallback(false);
      await setLocalItem(STORAGE_KEY_TOKEN, newToken);
      const refreshedUser = await fetchUserProfile(newToken);
      
      if (refreshedUser) {
        await setLocalItem(STORAGE_KEY_USER, refreshedUser);
        return { success: true, user: refreshedUser };
      }
    } catch (refreshError) {
      console.log('[Google Auth] Non-interactive refresh failed:', refreshError.message);
    }

    throw new Error('Failed to refresh profile');
  } catch (error) {
    console.error('[Google Auth] Refresh failed:', error);
    // Clear stored data if refresh fails
    await removeLocalItem(STORAGE_KEY_TOKEN);
    await removeLocalItem(STORAGE_KEY_USER);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch user profile from Google API
 * @param {string} token 
 * @returns {Promise<{name: string, email: string, picture: string} | null>}
 */
async function fetchUserProfile(token) {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    
    return {
      name: data.name || 'Google User',
      email: data.email || '',
      picture: data.picture || null,
      id: data.id || ''
    };
  } catch (error) {
    console.error('[Google Auth] Fetch profile failed:', error);
    return null;
  }
}

/**
 * Validate if current token is still valid
 * @returns {Promise<boolean>}
 */
export async function validateToken() {
  const token = await getLocalItem(STORAGE_KEY_TOKEN);
  if (!token) return false;

  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return response.ok;
  } catch {
    return false;
  }
}
