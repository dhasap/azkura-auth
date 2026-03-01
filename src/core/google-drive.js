/**
 * Google Drive API module for Azkura Auth
 * Handles backup/restore operations to Google Drive
 */

import { getAuthToken } from './google-auth.js';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/**
 * Upload backup file to Google Drive
 * @param {object} accountsData - The accounts data to backup
 * @param {string} [filename] - Optional custom filename
 * @returns {Promise<{success: boolean, fileId?: string, fileName?: string, error?: string}>}
 */
export async function uploadBackupToDrive(accountsData, filename = null) {
  try {
    const token = await getAuthToken();
    if (!token) {
      return { success: false, error: 'Not authenticated with Google' };
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = filename || `azkura-backup-${timestamp}.json`;

    // Prepare backup data structure
    const backupData = {
      app: 'azkura-auth',
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      accountCount: accountsData.length,
      accounts: accountsData
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

    // Upload to Drive
    const response = await fetch(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
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
    const token = await getAuthToken();
    if (!token) {
      return { success: false, error: 'Not authenticated with Google' };
    }

    // Search for Azkura Auth backup files
    const query = encodeURIComponent("name contains 'azkura-backup' and mimeType = 'application/json' and trashed = false");
    const url = `${DRIVE_FILES_URL}?q=${query}&pageSize=${maxResults}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
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
    const token = await getAuthToken();
    if (!token) {
      return { success: false, error: 'Not authenticated with Google' };
    }

    const url = `${DRIVE_FILES_URL}/${fileId}?alt=media`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
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
    const token = await getAuthToken();
    if (!token) {
      return { success: false, error: 'Not authenticated with Google' };
    }

    const url = `${DRIVE_FILES_URL}/${fileId}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
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
