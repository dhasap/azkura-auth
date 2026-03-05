/**
 * Google Authentication module for Azkura Auth
 * Handles login/logout with chrome.identity.getAuthToken + fallback for mobile
 */

import { setLocalItem, getLocalItem, removeLocalItem } from './storage.js';

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const STORAGE_KEY_TOKEN = 'googleAuthToken';
const STORAGE_KEY_USER = 'googleUserProfile';
const STORAGE_KEY_TOKEN_TIME = 'googleAuthTokenTime';

// Token validity period (55 minutes, tokens usually valid for 1 hour)
const TOKEN_VALIDITY_MS = 55 * 60 * 1000;

// OAuth2 config - different client IDs for desktop and mobile
// IMPORTANT: Both client IDs must have the redirect URI registered in Google Cloud Console:
// Redirect URI format: https://[EXTENSION_ID].chromiumapp.org/
// Get your extension ID from: chrome://extensions → Developer mode → ID
const OAUTH2_CLIENT_IDS = {
  // Desktop: Use "Chrome app" type OR "Web application" with redirect URI registered
  desktop: '861059574565-gvp72f1nri3l2fhpnls1eu7dtot87dl4.apps.googleusercontent.com',
  // Mobile: MUST be "Web application" type with redirect URI registered
  mobile: '861059574565-og5nk13so332lvrjfgcpi05dr05hc1e9.apps.googleusercontent.com'
};

const OAUTH2_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file'
];

/**
 * Get the appropriate client ID based on device type
 */
function getClientId() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  return isMobile ? OAUTH2_CLIENT_IDS.mobile : OAUTH2_CLIENT_IDS.desktop;
}

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
  const token = await getLocalItem(STORAGE_KEY_TOKEN);
  const tokenTime = await getLocalItem(STORAGE_KEY_TOKEN_TIME);
  
  // Check if token is expired
  if (token && tokenTime) {
    const elapsed = Date.now() - tokenTime;
    if (elapsed > TOKEN_VALIDITY_MS) {
      console.log('[Google Auth] Token expired, clearing...');
      await removeLocalItem(STORAGE_KEY_TOKEN);
      await removeLocalItem(STORAGE_KEY_TOKEN_TIME);
      return null;
    }
  }
  
  return token;
}

/**
 * Get auth token with fallback for mobile browsers
 * Tries chrome.identity.getAuthToken first, falls back to launchWebAuthFlow on mobile
 * @param {boolean} interactive - Whether to show UI if needed
 * @returns {Promise<string>} Access token
 */
async function getAuthTokenWithFallback(interactive = true) {
  console.log('[Google Auth] getAuthTokenWithFallback called, interactive:', interactive);
  
  // Detect mobile - use launchWebAuthFlow directly on mobile for better compatibility
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isTabMode = window.innerWidth > 500 || window.outerHeight > 800;
  
  console.log('[Google Auth] isMobile:', isMobile, 'isTabMode:', isTabMode, 'innerWidth:', window.innerWidth);
  
  // On mobile, always use launchWebAuthFlow - getAuthToken doesn't work on mobile browsers
  if (isMobile) {
    console.log('[Google Auth] Mobile detected, using launchWebAuthFlow directly');
    if (!interactive) {
      throw new Error('Non-interactive auth not available on mobile');
    }
    return await getTokenViaWebAuthFlow();
  }
  
  // Desktop: use launchWebAuthFlow for popup mode, tab auth for tab mode
  if (!interactive) {
    throw new Error('Non-interactive auth not available');
  }
  
  // Detect if running in popup or tab mode
  const isPopupMode = window.innerWidth <= 500 && window.outerWidth <= 600;
  
  if (isPopupMode) {
    console.log('[Google Auth] Desktop popup mode detected, using launchWebAuthFlow');
    return await getTokenViaWebAuthFlow();
  } else {
    console.log('[Google Auth] Desktop tab mode detected, using tab-based auth');
    return await getTokenViaWebAuthFlow();
  }
}

/**
 * Get token using launchWebAuthFlow (fallback for mobile browsers)
 * Constructs OAuth2 URL manually and extracts token from redirect URL
 * @returns {Promise<string>} Access token
 */
async function getTokenViaWebAuthFlow() {
  console.log('[Google Auth] getTokenViaWebAuthFlow starting...');
  
  // Check if chrome.identity is available
  if (!chrome.identity) {
    console.error('[Google Auth] chrome.identity API not available!');
    throw new Error('chrome.identity API not available');
  }
  console.log('[Google Auth] chrome.identity available');
  
  // Check if running in mobile browser where launchWebAuthFlow may not work
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  // Get the appropriate client ID for this device
  const clientId = getClientId();
  
  // Use the standard chromiumapp.org URL for both mobile and desktop
  // Google requires https:// redirect URIs, not chrome-extension://
  const redirectUri = chrome.identity.getRedirectURL();
  const state = Math.random().toString(36).substring(2, 15);
  
  console.log('[Google Auth] ===========================================');
  console.log('[Google Auth] Extension ID:', chrome.runtime.id);
  console.log('[Google Auth] Is Mobile:', isMobile);
  console.log('[Google Auth] Client ID:', clientId);
  console.log('[Google Auth] Redirect URI:', redirectUri);
  console.log('[Google Auth] ===========================================');
  console.log('[Google Auth] IMPORTANT: Register this Redirect URI in Google Cloud Console:');
  console.log('[Google Auth] 1. Go to https://console.cloud.google.com/apis/credentials');
  console.log('[Google Auth] 2. Find OAuth 2.0 Client ID:', clientId);
  console.log('[Google Auth] 3. Add this EXACT URI to "Authorized redirect URIs":');
  console.log('[Google Auth]    ', redirectUri);
  console.log('[Google Auth] ===========================================');
  
  // Show alert on mobile to help debugging
  if (isMobile && typeof window !== 'undefined' && window.alert) {
    console.log('[Google Auth] If login fails with "redirect_uri_mismatch", register this URI in Google Cloud Console:', redirectUri);
  }
  
  // Build OAuth2 URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH2_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  // Force consent screen to ensure all scopes are granted
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  
  const authUrlString = authUrl.toString();
  console.log('[Google Auth] Auth URL:', authUrlString.substring(0, 100) + '...');
  
  // On mobile, use tab-based auth instead of launchWebAuthFlow
  if (isMobile) {
    return getTokenViaTabAuth(authUrlString, redirectUri, state, clientId);
  }
  
  // Desktop: use launchWebAuthFlow
  return getTokenViaLaunchWebAuthFlow(authUrlString, state, clientId);
}

/**
 * Get token using chrome.tabs API for mobile browsers
 * launchWebAuthFlow doesn't work reliably on mobile
 * 
 * Uses chrome.webRequest to intercept redirect to the chromiumapp.org URL
 */
async function getTokenViaTabAuth(authUrlString, redirectUri, state, clientId) {
  console.log('[Google Auth] Using tab-based authentication for mobile...');
  
  return new Promise((resolve, reject) => {
    let authTabId = null;
    let errorDetected = false;
    
    // Set timeout
    const timeoutMs = 120000; // 2 minutes
    const timeoutId = setTimeout(() => {
      cleanup();
      console.error('[Google Auth] Tab auth timed out after', timeoutMs, 'ms');
      reject(new Error('Authentication timed out. Please try again.'));
    }, timeoutMs);
    
    // Clean up listeners and close tab
    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      if (authTabId) {
        chrome.tabs.get(authTabId, (tab) => {
          if (!chrome.runtime.lastError && tab) {
            chrome.tabs.remove(authTabId).catch(() => {});
          }
        });
      }
    }
    
    // Listen for tab updates
    function onTabUpdated(tabId, changeInfo, tab) {
      if (tabId !== authTabId) return;
      
      if (!changeInfo.url) return;
      
      console.log('[Google Auth] Tab URL updated:', changeInfo.url.substring(0, 100) + '...');
      
      // Check for error page on Google
      if (changeInfo.url.includes('accounts.google.com') && changeInfo.url.includes('error=')) {
        try {
          const url = new URL(changeInfo.url);
          const errorParam = url.searchParams.get('error');
          const errorDescription = url.searchParams.get('error_description');
          
          if (errorParam) {
            console.error('[Google Auth] OAuth error detected:', errorParam, errorDescription);
            errorDetected = true;
            cleanup();
            
            if (errorParam === 'redirect_uri_mismatch') {
              reject(new Error(
                `Redirect URI mismatch! Please register this URI in Google Cloud Console:\n${redirectUri}\n\n` +
                `1. Go to https://console.cloud.google.com/apis/credentials\n` +
                `2. Find your OAuth 2.0 Client ID:\n${clientId}\n` +
                `3. Add the above URI to "Authorized redirect URIs"\n\n` +
                `Then reload the extension and try again.`
              ));
            } else {
              reject(new Error(errorDescription || errorParam));
            }
            return;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      // Check if URL matches redirect URI (success case)
      // The URL will be like: https://[extension-id].chromiumapp.org/#access_token=...&state=...
      if (changeInfo.url.startsWith(redirectUri)) {
        console.log('[Google Auth] Detected redirect to extension callback URL');
        
        try {
          const url = new URL(changeInfo.url);
          const hash = url.hash.substring(1); // Remove leading #
          
          if (!hash) {
            cleanup();
            reject(new Error('No hash in redirect URL'));
            return;
          }
          
          const params = new URLSearchParams(hash);
          const accessToken = params.get('access_token');
          const returnedState = params.get('state');
          const errorParam = params.get('error');
          const errorDescription = params.get('error_description');
          
          console.log('[Google Auth] Parsed params - access_token:', accessToken ? 'present' : 'missing', 'state:', returnedState, 'error:', errorParam);
          
          if (errorParam) {
            errorDetected = true;
            cleanup();
            reject(new Error(errorDescription || errorParam));
            return;
          }
          
          if (!accessToken) {
            cleanup();
            reject(new Error('No access token in response'));
            return;
          }
          
          // Verify state to prevent CSRF
          if (returnedState !== state) {
            cleanup();
            console.error('[Google Auth] State mismatch! Expected:', state, 'Got:', returnedState);
            reject(new Error('State mismatch - possible CSRF attack'));
            return;
          }
          
          console.log('[Google Auth] Successfully got access token!');
          cleanup();
          resolve(accessToken);
        } catch (err) {
          cleanup();
          reject(new Error('Failed to parse redirect URL: ' + err.message));
        }
      }
    }
    
    // Listen for tab close (user cancelled)
    function onTabRemoved(removedTabId) {
      if (removedTabId === authTabId) {
        cleanup();
        if (!errorDetected) {
          reject(new Error('Authentication cancelled by user'));
        }
      }
    }
    
    // Add listeners
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    
    // Open auth tab
    console.log('[Google Auth] Opening auth tab...');
    chrome.tabs.create({ url: authUrlString, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup();
        console.error('[Google Auth] Failed to create tab:', chrome.runtime.lastError.message);
        reject(new Error('Failed to open authentication: ' + chrome.runtime.lastError.message));
        return;
      }
      
      authTabId = tab.id;
      console.log('[Google Auth] Auth tab created with ID:', authTabId);
    });
  });
}

/**
 * Get token using launchWebAuthFlow (for desktop browsers)
 */
async function getTokenViaLaunchWebAuthFlow(authUrlString, state, clientId) {
  console.log('[Google Auth] Using launchWebAuthFlow for desktop...');
  
  return new Promise((resolve, reject) => {
    // Set timeout
    const timeoutMs = 60000; // 1 minute
    const timeoutId = setTimeout(() => {
      console.error('[Google Auth] launchWebAuthFlow timed out after', timeoutMs, 'ms');
      reject(new Error('Authentication timed out. Please try again.'));
    }, timeoutMs);
    
    chrome.identity.launchWebAuthFlow(
      { url: authUrlString, interactive: true },
      (redirectUrl) => {
        clearTimeout(timeoutId);
        
        console.log('[Google Auth] launchWebAuthFlow callback fired');
        console.log('[Google Auth] redirectUrl:', redirectUrl ? 'present' : 'null/empty');
        console.log('[Google Auth] lastError:', chrome.runtime.lastError ? chrome.runtime.lastError.message : 'none');
        
        if (chrome.runtime.lastError) {
          console.error('[Google Auth] launchWebAuthFlow error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        
        if (!redirectUrl) {
          console.error('[Google Auth] No redirect URL received');
          reject(new Error('No redirect URL received'));
          return;
        }
        
        // Parse access token from redirect URL hash
        const hash = redirectUrl.split('#')[1];
        if (!hash) {
          console.error('[Google Auth] No hash in redirect URL:', redirectUrl);
          reject(new Error('No hash in redirect URL'));
          return;
        }
        
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const returnedState = params.get('state');
        const errorParam = params.get('error');
        
        console.log('[Google Auth] Parsed params - access_token:', accessToken ? 'present' : 'missing', 'state:', returnedState, 'error:', errorParam);
        
        if (!accessToken) {
          const error = errorParam || 'No access token in response';
          console.error('[Google Auth] No access token:', error);
          reject(new Error(error));
          return;
        }
        
        // Verify state to prevent CSRF
        if (returnedState !== state) {
          console.error('[Google Auth] State mismatch! Expected:', state, 'Got:', returnedState);
          reject(new Error('State mismatch - possible CSRF attack'));
          return;
        }
        
        console.log('[Google Auth] Successfully got access token!');
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

    // Store token and timestamp
    await setLocalItem(STORAGE_KEY_TOKEN, token);
    await setLocalItem(STORAGE_KEY_TOKEN_TIME, Date.now());

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
    await removeLocalItem(STORAGE_KEY_TOKEN_TIME);
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
      // Update timestamp on successful validation
      await setLocalItem(STORAGE_KEY_TOKEN_TIME, Date.now());
      return { success: true, user };
    }

    // Token might be expired, try to get new token non-interactively
    // Note: On mobile, this will likely fail, requiring re-login
    try {
      const newToken = await getAuthTokenWithFallback(false);
      await setLocalItem(STORAGE_KEY_TOKEN, newToken);
      await setLocalItem(STORAGE_KEY_TOKEN_TIME, Date.now());
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
    await removeLocalItem(STORAGE_KEY_TOKEN_TIME);
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
 * Makes an actual API call to verify token is not expired/revoked
 * @returns {Promise<boolean>}
 */
export async function validateToken() {
  const token = await getLocalItem(STORAGE_KEY_TOKEN);
  if (!token) return false;

  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    // If token is expired or invalid, clear it
    if (response.status === 401) {
      console.log('[Google Auth] Token invalidated (401), clearing...');
      await clearInvalidToken();
      return false;
    }
    
    return response.ok;
  } catch (error) {
    console.error('[Google Auth] Token validation error:', error);
    return false;
  }
}

/**
 * Clear invalid token from storage
 * Called when token is expired, revoked, or invalid
 * @returns {Promise<void>}
 */
export async function clearInvalidToken() {
  console.log('[Google Auth] Clearing invalid token...');
  await removeLocalItem(STORAGE_KEY_TOKEN);
  await removeLocalItem(STORAGE_KEY_TOKEN_TIME);
  await removeLocalItem(STORAGE_KEY_USER);
}

/**
 * Get valid auth token with validation
 * Validates token before returning, clears if invalid
 * @returns {Promise<string|null>} - Valid token or null if invalid/not found
 */
export async function getValidAuthToken() {
  const token = await getLocalItem(STORAGE_KEY_TOKEN);
  const tokenTime = await getLocalItem(STORAGE_KEY_TOKEN_TIME);
  
  if (!token) return null;
  
  // Check if token is expired based on timestamp
  if (tokenTime) {
    const elapsed = Date.now() - tokenTime;
    if (elapsed > TOKEN_VALIDITY_MS) {
      console.log('[Google Auth] Token expired based on timestamp, clearing...');
      await clearInvalidToken();
      return null;
    }
  }
  
  // Additional validation: make sure token is still valid with Google
  const isValid = await validateToken();
  if (!isValid) {
    return null;
  }
  
  return token;
}
