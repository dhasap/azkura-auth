/**
 * Azkura Auth — Service Worker (Manifest V3)
 * Handles: auto-lock alarm, badge updates, QR scan message relay
 */

// ─── On Install ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[Azkura] Extension installed');
  } else if (details.reason === 'update') {
    console.log('[Azkura] Extension updated to', chrome.runtime.getManifest().version);
  }
});

// ─── Alarm listener ─────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    // Clear session storage to lock the vault
    await chrome.storage.session.clear();
    console.log('[Azkura] Auto-locked vault');

    // Update badge to show lock icon
    chrome.action.setBadgeText({ text: '🔒' });
    chrome.action.setBadgeBackgroundColor({ color: '#333333' });
  }
});

// ─── Message relay (QR Scanner → Popup) ─────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'QR_SCANNED') {
    // Forward to popup if it's open
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup not open — store for when it opens
      chrome.storage.session.set({ pendingQR: message.data });
    });
  }

  if (message.type === 'RESET_AUTOLOCK') {
    const mins = message.minutes;
    if (mins && mins > 0) {
      chrome.alarms.create('auto-lock', { delayInMinutes: mins });
    }
  }

  return false; // synchronous response
});

// ─── Clear badge on popup open ───────────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});
