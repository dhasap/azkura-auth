/**
 * Google Authentication module for Azkura Auth
 * Handles login/logout with chrome.identity.getAuthToken
 */

import { setLocalItem, getLocalItem, removeLocalItem } from './storage.js';

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const STORAGE_KEY_TOKEN = 'googleAuthToken';
const STORAGE_KEY_USER = 'googleUserProfile';

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
 * Login with Google using chrome.identity.getAuthToken
 * Interactive: true (will show popup if needed)
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function loginGoogle() {
  try {
    // Get auth token interactively
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!token) {
          reject(new Error('No token received'));
        } else {
          resolve(token);
        }
      });
    });

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
    const newToken = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error('Token expired'));
        } else {
          resolve(token);
        }
      });
    });

    await setLocalItem(STORAGE_KEY_TOKEN, newToken);
    const refreshedUser = await fetchUserProfile(newToken);
    
    if (refreshedUser) {
      await setLocalItem(STORAGE_KEY_USER, refreshedUser);
      return { success: true, user: refreshedUser };
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
