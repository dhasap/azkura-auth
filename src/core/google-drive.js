/**
 * Google Drive API module for Azkura Auth
 * Handles backup/restore operations to Google Drive
 */

import { getAuthToken, getValidAuthToken, refreshUserProfile, logoutGoogle, clearInvalidToken } from './google-auth.js';
import { getFolders } from './storage.js';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Token refresh tracking to prevent infinite loops
let isRefreshingToken = false;
let tokenRefreshQueue = [];

/**
 * Handle token expiration by refreshing or prompting re-login
 * On mobile: clears invalid token since auto-refresh may not work
 * @returns {Promise<boolean>} - true if token was refreshed successfully
 */
async function handleTokenExpiration() {
  if (isRefreshingToken) {
    // Wait for ongoing refresh
    return new Promise((resolve) => {
      tokenRefreshQueue.push(resolve);
    });
  }

  isRefreshingToken = true;
  
  try {
    // Detect mobile - on mobile, auto-refresh often doesn't work reliably
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isMobile) {
      console.log('[Google Drive] Mobile detected, clearing invalid token instead of refresh');
      // On mobile, clear the invalid token and let user re-login
      await clearInvalidToken();
      tokenRefreshQueue.forEach(resolve => resolve(false));
      tokenRefreshQueue = [];
      return false;
    }
    
    // Try to refresh user profile (this will get a new token if possible)
    const result = await refreshUserProfile();
    
    if (result.success) {
      // Notify all waiting operations
      tokenRefreshQueue.forEach(resolve => resolve(true));
      tokenRefreshQueue = [];
      return true;
    } else {
      // Refresh failed, clear invalid token
      console.log('[Google Drive] Token refresh failed, clearing invalid token');
      await clearInvalidToken();
      tokenRefreshQueue.forEach(resolve => resolve(false));
      tokenRefreshQueue = [];
      return false;
    }
  } catch (error) {
    console.error('[Google Drive] Token refresh failed:', error);
    // Clear invalid token instead of full logout to preserve user profile info
    await clearInvalidToken();
    tokenRefreshQueue.forEach(resolve => resolve(false));
    tokenRefreshQueue = [];
    return false;
  } finally {
    isRefreshingToken = false;
  }
}

/**
 * Check if error is due to authentication failure
 * @param {Response} response 
 * @returns {boolean}
 */
function isAuthError(response) {
  return response.status === 401 || response.status === 403;
}

/**
 * Make authenticated request to Google Drive API with automatic token refresh
 * Validates token before use and handles token expiration gracefully
 * @param {string} url - API URL
 * @param {object} options - Fetch options
 * @param {boolean} [retry=true] - Whether to retry on 401
 * @returns {Promise<Response>}
 */
async function driveApiRequest(url, options = {}, retry = true) {
  // Use getValidAuthToken to ensure token is validated before use
  let token = await getValidAuthToken();
  
  // If no valid token, try to refresh once
  if (!token && retry) {
    console.log('[Google Drive] No valid token, attempting refresh...');
    const refreshed = await handleTokenExpiration();
    if (refreshed) {
      token = await getValidAuthToken();
    }
  }
  
  if (!token) {
    throw new Error('Session expired. Please sign in again.');
  }

  const authOptions = {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  };

  let response;
  try {
    response = await fetch(url, authOptions);
  } catch (fetchError) {
    throw new Error('Failed to fetch. Please check your internet connection.');
  }

  // Handle 401 Unauthorized - token expired
  if (isAuthError(response) && retry) {
    console.log('[Google Drive] Token expired, attempting refresh...');
    const refreshed = await handleTokenExpiration();
    
    if (refreshed) {
      // Retry the request with new token
      console.log('[Google Drive] Token refreshed, retrying request...');
      return driveApiRequest(url, options, false); // Don't retry again
    } else {
      throw new Error('Session expired. Please sign in again.');
    }
  }
  
  // Handle 401/403 without retry - token is truly invalid
  if (isAuthError(response) && !retry) {
    throw new Error('Session expired. Please sign in again.');
  }

  return response;
}

/**
 * Upload backup file to Google Drive
 * @param {object} accountsData - The accounts data to backup
 * @param {string} [filename] - Optional custom filename
 * @returns {Promise<{success: boolean, fileId?: string, fileName?: string, error?: string}>}
 */
export async function uploadBackupToDrive(accountsData, filename = null) {
  try {
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = filename || `azkura-backup-${timestamp}.json`;

    // Get folders data
    const foldersData = await getFolders();

    // Prepare backup data structure
    const backupData = {
      app: 'azkura-auth',
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      accountCount: accountsData.length,
      folderCount: foldersData.length,
      accounts: accountsData,
      folders: foldersData
    };

    const fileContent = JSON.stringify(backupData, null, 2);

    // Create multipart request body
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadata = {
      name: fileName,
      mimeType: 'application/json',
      description: 'Azkura Auth Backup - TOTP Authenticator Data'
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      fileContent +
      closeDelimiter;

    // Upload to Drive using authenticated request
    const response = await driveApiRequest(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary="${boundary}"`
      },
      body: multipartRequestBody
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `HTTP ${response.status}`);
    }

    const result = await response.json();
    
    return {
      success: true,
      fileId: result.id,
      fileName: fileName
    };

  } catch (error) {
    console.error('[Google Drive] Upload failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload backup'
    };
  }
}

/**
 * List backup files from Google Drive
 * @param {number} [maxResults=10] - Maximum number of files to return
 * @returns {Promise<{success: boolean, files?: Array, error?: string}>}
 */
export async function listBackupsFromDrive(maxResults = 10) {
  try {
    // Search for Azkura Auth backup files
    const query = encodeURIComponent("name contains 'azkura-backup' and mimeType = 'application/json' and trashed = false");
    const url = `${DRIVE_FILES_URL}?q=${query}&pageSize=${maxResults}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)`;

    const response = await driveApiRequest(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    
    return {
      success: true,
      files: result.files || []
    };

  } catch (error) {
    console.error('[Google Drive] List backups failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Download a backup file from Google Drive
 * @param {string} fileId - The Drive file ID
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function downloadBackupFromDrive(fileId) {
  try {
    const url = `${DRIVE_FILES_URL}/${fileId}?alt=media`;

    const response = await driveApiRequest(url, {
      method: 'GET'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const content = await response.text();
    const data = JSON.parse(content);
    
    // Validate backup format
    if (data.app !== 'azkura-auth' || !Array.isArray(data.accounts)) {
      throw new Error('Invalid backup file format');
    }

    return {
      success: true,
      data: data
    };

  } catch (error) {
    console.error('[Google Drive] Download failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Delete a backup file from Google Drive
 * @param {string} fileId - The Drive file ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteBackupFromDrive(fileId) {
  try {
    const url = `${DRIVE_FILES_URL}/${fileId}`;

    const response = await driveApiRequest(url, {
      method: 'DELETE'
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`HTTP ${response.status}`);
    }

    return { success: true };

  } catch (error) {
    console.error('[Google Drive] Delete failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
