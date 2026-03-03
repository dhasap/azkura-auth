/**
 * Azkura Auth — Main Popup Controller
 * Features: TOTP generation, PIN optional, Google login, Drive backup
 */

// ─── Mobile Detection & Redirect ─────────────────────────────────────────────
// If mobile device detected, open app in new tab instead of popup
// IMPORTANT: Only check userAgent, NOT screen size! Desktop popup is 400px wide.
(function checkMobile() {
  // Check if already running in tab mode (not popup)
  // Popup window is small (~400px), tab is full browser window
  const isLikelyPopup = window.innerWidth <= 500 && window.outerWidth <= 600;
  const isLikelyTab = window.innerWidth > 500 || window.outerHeight > 800;
  
  // Skip if already in tab mode
  if (isLikelyTab && !isLikelyPopup) {
    return;
  }
  
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  if (isMobile) {
    const appUrl = chrome.runtime.getURL('src/app/index.html');
    
    // Check if we're already on the app page
    if (window.location.href.includes('/app/')) {
      return; // Already in tab mode
    }
    
    // Open app in new tab
    chrome.tabs.query({ url: appUrl }, (tabs) => {
      if (tabs.length > 0) {
        // Tab already exists, just focus it
        chrome.tabs.update(tabs[0].id, { active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            console.log('Tab focus error:', chrome.runtime.lastError);
            // Try creating new tab
            chrome.tabs.create({ url: appUrl });
            return;
          }
          chrome.windows.update(tabs[0].windowId, { focused: true });
        });
      } else {
        // Create new tab
        chrome.tabs.create({ url: appUrl }, (tab) => {
          if (chrome.runtime.lastError) {
            console.error('Tab create error:', chrome.runtime.lastError);
          }
        });
      }
    });
    
    // Close popup after a short delay to allow tab to open
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {
        console.log('Could not close window:', e);
      }
    }, 300);
    
    // Prevent further execution
    return;
  }
})();

import { generateTOTP, getRemainingSeconds, formatCode, isValidSecret } from '../core/totp.js';
import { setupPin, verifyPin, encrypt, getDefaultKey } from '../core/crypto.js';
import { parseOtpauthURI } from '../core/uri-parser.js';
import { isLoggedIn, loginGoogle, logoutGoogle, getUserProfile, refreshUserProfile } from '../core/google-auth.js';
import { uploadBackupToDrive, listBackupsFromDrive, downloadBackupFromDrive, deleteBackupFromDrive } from '../core/google-drive.js';
import {
  unlockVault,
  lockVault,
  addAccount,
  updateAccount,
  deleteAccount,
  deleteAllAccounts,
  wipeAllData,
  exportBackup,
  exportPlainBackup,
  importBackup,
  importPlainBackup,
  restoreFromDriveBackup,
  getAccounts,
  searchAccounts,
  getServiceMeta,
} from '../core/accounts.js';
import {
  isPinSetup,
  isPinEnabled,
  setPinEnabled,
  isUnlocked,
  isFirstTimeSetup,
  getLocalItem,
  setLocalItem,
  removeLocalItem,
  getPreferences,
  setPreference,
  setPreferences,
  getSessionAccounts,
  getFolders,
  createFolder,
  deleteFolder,
  moveAccountToFolder,
  isUncategorizedHidden,
  setUncategorizedHidden,
} from '../core/storage.js';
import {
  trackAccountCopy,
  trackBackup,
  trackFirstAccount,
  getDashboardStats,
  getTimeAgo,
  getSecurityStatus
} from '../core/stats.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentPassword = null; // in-memory PIN for re-encryption (null if using default key)
let tickInterval = null;
let currentAccounts = [];
let prefs = {};
let pendingImportFile = null;
let createPinValue = null;
let googleUser = null;
let currentFolderFilter = 'all'; // 'all', 'uncategorized', or folderId
let folders = [];

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showView(id) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

function openModal(id) {
  $(id).classList.add('open');
}

function closeModal(id) {
  $(id).classList.remove('open');
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 2500) {
  const container = $('#toastContainer');
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span class="toast-text">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ─── PIN Keypad ───────────────────────────────────────────────────────────────
function buildKeypad(containerId, dotsId, onComplete, errorId) {
  const container = $(`#${containerId}`);
  const dotsEl = $(`#${dotsId}`);
  const errorEl = errorId ? $(`#${errorId}`) : null;
  let value = '';
  const maxLen = 6;

  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  const subTexts = {
    '2':'ABC','3':'DEF','4':'GHI','5':'JKL','6':'MNO',
    '7':'PQRS','8':'TUV','9':'WXYZ','0':'+',
  };

  container.innerHTML = '';

  keys.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'pin-key';
    if (!k) {
      btn.style.visibility = 'hidden';
      container.appendChild(btn);
      return;
    }
    btn.innerHTML = `<span>${k}</span>${subTexts[k] ? `<span class="pin-key-sub">${subTexts[k]}</span>` : ''}`;
    btn.addEventListener('click', () => {
      if (k === '⌫') {
        value = value.slice(0, -1);
      } else if (value.length < maxLen) {
        value += k;
      }
      updateDots();
      if (value.length === maxLen) {
        setTimeout(() => {
          onComplete(value);
          value = '';
          updateDots();
        }, 80);
      }
    });
    container.appendChild(btn);
  });

  function updateDots() {
    const dots = dotsEl.querySelectorAll('.pin-dot');
    dots.forEach((d, i) => {
      d.classList.toggle('filled', i < value.length);
      d.classList.remove('error');
    });
    if (errorEl) errorEl.classList.remove('visible');
  }

  function flashError(msg) {
    value = '';
    updateDots();
    const dots = dotsEl.querySelectorAll('.pin-dot');
    dots.forEach(d => d.classList.add('error'));
    if (errorEl && msg) {
      errorEl.textContent = msg;
      errorEl.classList.add('visible');
    }
    setTimeout(() => dots.forEach(d => d.classList.remove('error')), 600);
  }

  return { flashError };
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function initOnboarding() {
  const step1 = $('#onboardStep1');
  const step2 = $('#onboardStep2');
  const step3 = $('#onboardStep3');

  // Step dots
  function updateStepDots(step) {
    ['#step1dot','#step2dot','#step3dot'].forEach((sel, i) => {
      const el = $(sel);
      el.classList.remove('active', 'done');
      if (i + 1 === step) el.classList.add('active');
      if (i + 1 < step) el.classList.add('done');
    });
  }

  // Set up PIN flow
  $('#btnOnboardStart').addEventListener('click', () => {
    step1.style.display = 'none';
    step2.style.display = 'flex';
    updateStepDots(2);
  });

  // Back to welcome
  $('#btnBackToWelcome').addEventListener('click', () => {
    step2.style.display = 'none';
    step1.style.display = 'flex';
    updateStepDots(1);
    createPinValue = null;
  });

  // Skip PIN - go directly to main
  $('#btnSkipPin').addEventListener('click', async () => {
    // Disable PIN protection
    await setPinEnabled(false);
    // Use default key
    currentPassword = null;
    // Create empty vault
    await unlockVault(null);
    showView('#viewMain');
    await loadMainView();
    showToast('PIN skipped. You can enable it later in Settings.', 'info', 3000);
  });

  // Create PIN keypad
  const { flashError: flashCreate } = buildKeypad(
    'pinKeypadCreate', 'pinDotsCreate',
    (pin) => {
      createPinValue = pin;
      step2.style.display = 'none';
      step3.style.display = 'flex';
      updateStepDots(3);
    },
    'pinCreateError'
  );

  // Confirm PIN keypad
  const { flashError: flashConfirm } = buildKeypad(
    'pinKeypadConfirm', 'pinDotsConfirm',
    async (pin) => {
      if (pin !== createPinValue) {
        flashConfirm('PINs do not match. Try again.');
        createPinValue = null;
        setTimeout(() => {
          step3.style.display = 'none';
          step2.style.display = 'flex';
          updateStepDots(2);
        }, 700);
        return;
      }
      // Save PIN
      const pinData = await setupPin(pin);
      await setLocalItem('pinData', pinData);
      await setPinEnabled(true);
      currentPassword = pin;
      // Unlock/create empty vault
      await unlockVault(pin).catch(() => {});
      updateStepDots(3);
      showView('#viewMain');
      await loadMainView();
    },
    'pinConfirmError'
  );
}

// ─── Lock Screen ─────────────────────────────────────────────────────────────
function initLockScreen() {
  const { flashError } = buildKeypad(
    'pinKeypadLock', 'pinDotsLock',
    async (pin) => {
      try {
        const pinData = await getLocalItem('pinData');
        const valid = await verifyPin(pin, pinData.hash, pinData.salt);
        if (!valid) {
          flashError('Incorrect PIN. Try again.');
          return;
        }
        currentPassword = pin;
        await unlockVault(pin);
        showView('#viewMain');
        await loadMainView();
        setupAutoLock();
      } catch (err) {
        flashError('Unlock failed. Try again.');
      }
    },
    'pinLockError'
  );
}

// ─── Auto-lock ────────────────────────────────────────────────────────────────
function setupAutoLock() {
  const mins = prefs.autoLockMinutes;
  if (!mins || mins === 0) return;
  chrome.alarms.create('auto-lock', { delayInMinutes: mins });
}

function resetAutoLock() {
  if (prefs.autoLockMinutes && prefs.autoLockMinutes > 0) {
    chrome.alarms.create('auto-lock', { delayInMinutes: prefs.autoLockMinutes });
  }
}

// ─── Apply preferences ────────────────────────────────────────────────────────
function applyPreferences() {
  // Accent color
  document.documentElement.style.setProperty('--accent', prefs.accentColor || '#00E5FF');

  // Adjust related accent-dim colors
  const accent = prefs.accentColor || '#00E5FF';
  document.documentElement.style.setProperty('--accent-dim', `${accent}26`);
  document.documentElement.style.setProperty('--accent-dim2', `${accent}14`);
  document.documentElement.style.setProperty('--border-accent', `${accent}4D`);

  // Privacy mode
  document.getElementById('app').classList.toggle('privacy-mode', !!prefs.privacyMode);

  // Compact layout
  document.getElementById('app').classList.toggle('layout-compact', !!prefs.compactLayout);

  // Sync toggles in settings
  const pmToggle = $('#privacyModeToggle');
  const clToggle = $('#compactLayoutToggle');
  const cacToggle = $('#closeAfterCopyToggle');
  const afsToggle = $('#autoFocusSearchToggle');
  const alSelect = $('#autoLockSelect');
  const pinToggle = $('#pinProtectionToggle');

  if (pmToggle) pmToggle.checked = !!prefs.privacyMode;
  if (clToggle) clToggle.checked = !!prefs.compactLayout;
  if (cacToggle) cacToggle.checked = prefs.closeAfterCopy !== false;
  if (afsToggle) afsToggle.checked = prefs.autoFocusSearch !== false;
  if (alSelect) alSelect.value = String(prefs.autoLockMinutes ?? 5);
  if (pinToggle) pinToggle.checked = !!prefs.pinEnabled;

  // Sync color swatches
  $$('#accentColorPicker .color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === accent);
  });

  // Update PIN-related UI visibility
  updatePinUI();
}

// Update PIN-related UI elements based on PIN enabled status
function updatePinUI() {
  const pinEnabled = prefs.pinEnabled;
  const pinChangeBtn = $('#btnChangePIN');
  const autoLockItem = $('#autoLockItem');
  const pinWarning = $('#pinDisabledWarning');

  if (pinChangeBtn) pinChangeBtn.style.display = pinEnabled ? 'flex' : 'none';
  if (autoLockItem) autoLockItem.style.display = pinEnabled ? 'flex' : 'none';
  if (pinWarning) pinWarning.style.display = pinEnabled ? 'none' : 'flex';
}

// ─── Progress Ring ────────────────────────────────────────────────────────────
function createProgressRingEl(period) {
  const size = 32;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const wrapper = document.createElement('div');
  wrapper.className = 'progress-ring';
  wrapper.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="progress-ring-track" cx="${size/2}" cy="${size/2}" r="${radius}" stroke-width="${strokeWidth}"/>
      <circle class="progress-ring-fill" cx="${size/2}" cy="${size/2}" r="${radius}" stroke-width="${strokeWidth}"
        stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}" stroke="var(--totp-normal)"/>
    </svg>
    <div class="progress-ring-text">30</div>
  `;

  wrapper._circumference = circumference;
  wrapper._period = period;
  return wrapper;
}

function updateProgressRing(ringEl, remaining, period) {
  const fill = ringEl.querySelector('.progress-ring-fill');
  const text = ringEl.querySelector('.progress-ring-text');
  const circ = ringEl._circumference;

  const fraction = remaining / period;
  const offset = circ * (1 - fraction);
  fill.style.strokeDashoffset = offset;

  // Color
  let color, cls;
  if (remaining > 10) {
    color = 'var(--totp-normal)';
    cls = '';
  } else if (remaining > 5) {
    color = 'var(--totp-warning)';
    cls = 'warning';
  } else {
    color = 'var(--totp-danger)';
    cls = 'danger';
  }

  fill.style.stroke = color;
  text.textContent = remaining;
  text.className = `progress-ring-text ${cls}`;
}

// ─── Account Card ─────────────────────────────────────────────────────────────
function createAccountCard(account) {
  const meta = getServiceMeta(account.issuer);
  const card = document.createElement('div');
  card.className = 'account-card';
  card.dataset.id = account.id;

  // Service icon
  const iconEl = document.createElement('div');
  iconEl.className = 'service-icon';
  iconEl.style.background = meta.bg;
  
  if (meta.hasLogo && meta.svg) {
    // Use SVG logo
    iconEl.innerHTML = meta.svg;
    iconEl.classList.add('has-logo');
  } else if (meta.emoji) {
    iconEl.textContent = meta.emoji;
  } else {
    const letter = document.createElement('span');
    letter.className = 'service-icon-letter';
    letter.textContent = (account.issuer || account.account || '?')[0].toUpperCase();
    iconEl.appendChild(letter);
  }

  // Info
  const infoEl = document.createElement('div');
  infoEl.className = 'account-info';
  infoEl.innerHTML = `
    <div class="account-issuer">${escHtml(account.issuer || 'Unknown')}</div>
    <div class="account-label">${escHtml(account.account || '')}</div>
  `;

  // Code wrapper
  const codeWrapper = document.createElement('div');
  codeWrapper.className = 'account-code-wrapper';

  const codeEl = document.createElement('div');
  codeEl.className = 'account-code';
  codeEl.textContent = '--- ---';

  // Progress ring
  const ringEl = createProgressRingEl(account.period || 30);

  codeWrapper.appendChild(codeEl);
  codeWrapper.appendChild(ringEl);

  // Copy flash
  const flashEl = document.createElement('div');
  flashEl.className = 'copy-flash';

  // Action buttons (shown on hover)
  const actionsEl = document.createElement('div');
  actionsEl.className = 'card-actions';
  actionsEl.innerHTML = `
    <button class="card-action-btn" data-action="folder" title="Move to folder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    </button>
    <button class="card-action-btn" data-action="edit" title="Edit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <button class="card-action-btn delete" data-action="delete" title="Delete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
    </button>
  `;

  card.appendChild(iconEl);
  card.appendChild(infoEl);
  card.appendChild(codeWrapper);
  card.appendChild(flashEl);
  card.appendChild(actionsEl);

  // Click to copy
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return;
    copyCode(account.id, codeEl, flashEl, card);
  });

  // Action buttons
  actionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.action === 'folder') openMoveToFolderModal(account.id);
    if (btn.dataset.action === 'edit') openEditModal(account.id);
    if (btn.dataset.action === 'delete') openDeleteModal(account.id, account.issuer, account.account);
  });

  card._codeEl = codeEl;
  card._ringEl = ringEl;
  card._account = account;

  return card;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function copyCode(accountId, codeEl, flashEl, cardEl) {
  const text = codeEl.textContent.replace(/\s/g, '');
  try {
    await navigator.clipboard.writeText(text);
    flashEl.classList.remove('animate');
    void flashEl.offsetWidth; // reflow
    flashEl.classList.add('animate');
    cardEl.classList.add('copied');
    setTimeout(() => cardEl.classList.remove('copied'), 800);
    showToast('Code copied!', 'success', 1500);
    resetAutoLock();
    
    // Track this copy event for statistics
    await trackAccountCopy(accountId);
    
    // Only close window if running in popup mode (not in tab mode)
    // Popup mode: window is small (around 400px wide)
    // Tab mode: window is full browser window
    const isPopupMode = window.innerWidth <= 500 && window.outerWidth <= 500;
    if (prefs.closeAfterCopy && isPopupMode) {
      setTimeout(() => window.close(), 700);
    }
  } catch {
    showToast('Failed to copy', 'error');
  }
}

// ─── Main View ────────────────────────────────────────────────────────────────
async function loadMainView() {
  prefs = await getPreferences();
  applyPreferences();
  
  // Load folders
  await loadFolders();
  await renderFolderChips();
  
  currentAccounts = await getAccounts();
  renderAccounts(currentAccounts);
  startTick();

  if (prefs.autoFocusSearch) {
    setTimeout(() => $('#searchInput')?.focus(), 100);
  }

  // Refresh Google user profile
  await refreshProfileUI();
}

function renderAccounts(accounts) {
  const list = $('#accountsList');
  list.innerHTML = '';

  // Filter by folder
  let filteredAccounts = accounts;
  if (currentFolderFilter === 'uncategorized') {
    filteredAccounts = accounts.filter(a => !a.folderId);
  } else if (currentFolderFilter !== 'all') {
    filteredAccounts = accounts.filter(a => a.folderId === currentFolderFilter);
  }

  if (!filteredAccounts || filteredAccounts.length === 0) {
    const query = $('#searchInput')?.value || '';
    const folderName = currentFolderFilter === 'all' ? '' : 
      currentFolderFilter === 'uncategorized' ? ' in Uncategorized' :
      ' in this folder';
    list.innerHTML = `
      <div class="accounts-empty">
        <div class="accounts-empty-icon">${query ? '🔍' : '🔐'}</div>
        <div class="accounts-empty-title">${query ? 'No results' : 'No accounts'}</div>
        <div class="accounts-empty-sub">${query ? `No accounts match "${escHtml(query)}"` : `No accounts${folderName} yet`}</div>
      </div>
    `;
    return;
  }

  filteredAccounts.forEach(account => {
    const card = createAccountCard(account);
    list.appendChild(card);
  });

  // Immediately update codes
  updateAllCodes();
}

async function updateAllCodes() {
  const cards = $$('.account-card');
  for (const card of cards) {
    const account = card._account;
    if (!account) continue;
    const remaining = getRemainingSeconds(account.period || 30);
    try {
      const code = await generateTOTP(account.secret, {
        digits: account.digits || 6,
        period: account.period || 30,
        algorithm: account.algorithm || 'SHA1',
      });
      card._codeEl.textContent = formatCode(code);

      // Color based on remaining
      card._codeEl.classList.remove('warning', 'danger');
      if (remaining <= 5) card._codeEl.classList.add('danger');
      else if (remaining <= 10) card._codeEl.classList.add('warning');

      updateProgressRing(card._ringEl, remaining, account.period || 30);
    } catch {
      card._codeEl.textContent = 'Error';
    }
  }
}

function startTick() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(updateAllCodes, 1000);
}

// ─── Search ───────────────────────────────────────────────────────────────────
function initSearch() {
  const input = $('#searchInput');
  const clearBtn = $('#searchClear');

  input.addEventListener('input', async () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('visible', q.length > 0);
    const results = await searchAccounts(q);
    renderAccounts(results);
    resetAutoLock();
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('visible');
    renderAccounts(currentAccounts);
    input.focus();
  });
}

// ─── FAB ─────────────────────────────────────────────────────────────────────
function initFAB() {
  const fab = $('#fabBtn');
  const menu = $('#fabMenu');

  fab.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    fab.classList.toggle('open', open);
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#fabContainer')) {
      menu.classList.remove('open');
      fab.classList.remove('open');
    }
  });

  $('#btnManualEntry').addEventListener('click', () => {
    menu.classList.remove('open');
    fab.classList.remove('open');
    clearAddForm();
    openModal('#modalAddAccount');
  });

  $('#btnUploadQR').addEventListener('click', () => {
    menu.classList.remove('open');
    fab.classList.remove('open');
    // Open scanner tab with upload tab active
    chrome.tabs.create({ 
      url: chrome.runtime.getURL('src/scanner/scanner.html?tab=upload') 
    });
  });

  $('#btnScanQR').addEventListener('click', () => {
    menu.classList.remove('open');
    fab.classList.remove('open');
    // Open scanner tab with camera tab active
    chrome.tabs.create({ url: chrome.runtime.getURL('src/scanner/scanner.html') });
  });
}

// ─── QR Scanning ─────────────────────────────────────────────────────────────
async function scanQRFromFile(file) {
  try {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    let qrData = null;

    // Try native BarcodeDetector first
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const codes = await detector.detect(img);
        if (codes.length > 0) qrData = codes[0].rawValue;
      } catch { /* fallthrough */ }
    }

    // Fallback: no jsQR bundled, show manual entry
    if (!qrData) {
      showToast('QR scan failed. Try manual entry.', 'error');
      clearAddForm();
      openModal('#modalAddAccount');
      return;
    }

    // Parse otpauth URI
    const parsed = parseOtpauthURI(qrData);
    populateAddForm(parsed);
    openModal('#modalAddAccount');
  } catch (err) {
    showToast('Could not read QR code: ' + err.message, 'error');
    clearAddForm();
    openModal('#modalAddAccount');
  }
}

function populateAddForm(parsed) {
  $('#addIssuer').value = parsed.issuer || '';
  $('#addAccount').value = parsed.account || '';
  $('#addSecret').value = parsed.secret || '';
  $('#addAlgorithm').value = parsed.algorithm || 'SHA1';
  $('#addDigits').value = String(parsed.digits || 6);
  $('#addPeriod').value = String(parsed.period || 30);
}

function clearAddForm() {
  $('#addIssuer').value = '';
  $('#addAccount').value = '';
  $('#addSecret').value = '';
  $('#addAlgorithm').value = 'SHA1';
  $('#addDigits').value = '6';
  $('#addPeriod').value = '30';
  $('#addSecretError').classList.remove('visible');
}

// ─── Add Account ──────────────────────────────────────────────────────────────
function initAddAccountModal() {
  $('#closeModalAdd').addEventListener('click', () => closeModal('#modalAddAccount'));

  $('#modalAddAccount').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalAddAccount');
  });

  // Secret validation on blur
  $('#addSecret').addEventListener('blur', () => {
    const val = $('#addSecret').value;
    const err = $('#addSecretError');
    if (val && !isValidSecret(val)) {
      $('#addSecret').classList.add('error');
      err.classList.add('visible');
    } else {
      $('#addSecret').classList.remove('error');
      err.classList.remove('visible');
    }
  });

  $('#btnAddAccountSubmit').addEventListener('click', async () => {
    const issuer = $('#addIssuer').value.trim();
    const account = $('#addAccount').value.trim();
    const secret = $('#addSecret').value.trim();
    const algorithm = $('#addAlgorithm').value;
    const digits = parseInt($('#addDigits').value);
    const period = parseInt($('#addPeriod').value);

    if (!secret || !isValidSecret(secret)) {
      $('#addSecret').classList.add('error');
      $('#addSecretError').classList.add('visible');
      return;
    }

    if (!account && !issuer) {
      showToast('Please enter an account name or issuer', 'error');
      return;
    }

    try {
      $('#btnAddAccountSubmit').disabled = true;
      const newAccount = await addAccount({ issuer, account, secret, algorithm, digits, period }, currentPassword);
      currentAccounts = await getAccounts();
      
      // Track first account creation
      await trackFirstAccount();
      
      renderAccounts(currentAccounts);
      closeModal('#modalAddAccount');
      clearAddForm();
      showToast(`${issuer || account} added!`, 'success');
      resetAutoLock();
    } catch (err) {
      showToast('Failed to add account: ' + err.message, 'error');
    } finally {
      $('#btnAddAccountSubmit').disabled = false;
    }
  });
}

// ─── Edit Account ─────────────────────────────────────────────────────────────
function openEditModal(accountId) {
  const account = currentAccounts.find(a => a.id === accountId);
  if (!account) return;

  $('#editAccountId').value = account.id;
  $('#editIssuer').value = account.issuer || '';
  $('#editAccountName').value = account.account || '';
  $('#editSecret').value = account.secret || '';
  $('#editAlgorithm').value = account.algorithm || 'SHA1';
  $('#editDigits').value = String(account.digits || 6);

  openModal('#modalEditAccount');
}

function initEditAccountModal() {
  $('#closeModalEdit').addEventListener('click', () => closeModal('#modalEditAccount'));

  $('#modalEditAccount').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalEditAccount');
  });

  $('#toggleSecretVisibility').addEventListener('click', () => {
    const inp = $('#editSecret');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  $('#btnEditAccountSubmit').addEventListener('click', async () => {
    const id = $('#editAccountId').value;
    const issuer = $('#editIssuer').value.trim();
    const account = $('#editAccountName').value.trim();
    const secret = $('#editSecret').value.trim();
    const algorithm = $('#editAlgorithm').value;
    const digits = parseInt($('#editDigits').value);

    if (!secret || !isValidSecret(secret)) {
      showToast('Invalid secret key', 'error');
      return;
    }

    try {
      $('#btnEditAccountSubmit').disabled = true;
      await updateAccount(id, { issuer, account, secret, algorithm, digits }, currentPassword);
      currentAccounts = await getAccounts();
      renderAccounts(currentAccounts);
      closeModal('#modalEditAccount');
      showToast('Account updated!', 'success');
      resetAutoLock();
    } catch (err) {
      showToast('Failed to update: ' + err.message, 'error');
    } finally {
      $('#btnEditAccountSubmit').disabled = false;
    }
  });
}

// ─── Delete Account ───────────────────────────────────────────────────────────
let pendingDeleteId = null;

function openDeleteModal(id, issuer, account) {
  pendingDeleteId = id;
  const text = `Delete <strong>${escHtml(issuer || account)}</strong>? This will permanently remove the account and its TOTP secret.`;
  $('#deleteConfirmText').innerHTML = text;
  $('#deleteAccountId').value = id;
  openModal('#modalDeleteConfirm');
}

function initDeleteModal() {
  $('#btnDeleteCancel').addEventListener('click', () => {
    closeModal('#modalDeleteConfirm');
    pendingDeleteId = null;
  });

  $('#modalDeleteConfirm').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalDeleteConfirm');
  });

  $('#btnDeleteConfirm').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    try {
      await deleteAccount(pendingDeleteId, currentPassword);
      currentAccounts = await getAccounts();
      renderAccounts(currentAccounts);
      closeModal('#modalDeleteConfirm');
      showToast('Account deleted', 'info');
      pendingDeleteId = null;
      resetAutoLock();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  });
}

// ─── Profile Menu & Google Auth ───────────────────────────────────────────────
function initProfileMenu() {
  const btnProfile = $('#btnProfile');
  const overlay = $('#profileMenuOverlay');

  btnProfile.addEventListener('click', async () => {
    const isOpen = overlay.classList.toggle('open');
    if (isOpen) {
      await refreshProfileUI();
      await refreshProfileStats();
    }
  });

  // Close when clicking outside
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('open');
    }
  });

  // Login
  $('#btnLoginGoogle').addEventListener('click', async () => {
    showToast('Connecting to Google...', 'info');
    try {
      console.log('[Google Login] Starting...');
      const result = await loginGoogle();
      console.log('[Google Login] Result:', result);
      if (result.success) {
        showToast(`Welcome, ${result.user.name}!`, 'success');
        await refreshProfileUI();
        overlay.classList.remove('open');
      } else {
        showToast('Login failed: ' + result.error, 'error', 5000);
      }
    } catch (err) {
      console.error('[Google Login] Error:', err);
      showToast('Login error: ' + err.message, 'error', 5000);
    }
  });

  // Logout
  $('#btnLogoutGoogle').addEventListener('click', async () => {
    const result = await logoutGoogle();
    if (result.success) {
      showToast('Signed out', 'info');
      await refreshProfileUI();
      overlay.classList.remove('open');
    }
  });

  // Backup to Drive
  $('#btnBackupToDrive').addEventListener('click', async () => {
    overlay.classList.remove('open');
    await backupToDrive();
  });

  // Restore from Drive (profile menu)
  $('#btnRestoreFromDriveMenu')?.addEventListener('click', async () => {
    overlay.classList.remove('open');
    await restoreFromDrive();
  });

  // Backup from settings
  $('#btnBackupDriveSettings')?.addEventListener('click', async () => {
    closeModal('#modalSettings');
    await backupToDrive();
  });

  // Restore from settings
  $('#btnRestoreDriveSettings')?.addEventListener('click', async () => {
    closeModal('#modalSettings');
    await restoreFromDrive();
  });

  // Close restore drive modal
  $('#closeModalRestoreDrive')?.addEventListener('click', () => closeModal('#modalRestoreDrive'));
  $('#modalRestoreDrive')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalRestoreDrive');
  });
}

async function refreshProfileUI() {
  const loggedOutView = $('#profileMenuLoggedOut');
  const loggedInView = $('#profileMenuLoggedIn');
  const settingsBackupBtn = $('#btnBackupDriveSettings');
  const settingsRestoreBtn = $('#btnRestoreDriveSettings');

  // Check login status
  const loggedIn = await isLoggedIn();

  if (loggedIn) {
    // Get user profile
    const user = await getUserProfile();
    if (user) {
      googleUser = user;
      $('#userDisplayName').textContent = user.name;
      $('#userEmail').textContent = user.email;
      
      const avatarImg = $('#userProfilePicture');
      if (user.picture) {
        avatarImg.src = user.picture;
        avatarImg.style.display = 'block';
      } else {
        avatarImg.style.display = 'none';
      }

      // Update header avatar
      const headerAvatar = $('#profileAvatar');
      if (user.picture) {
        headerAvatar.innerHTML = `<img src="${user.picture}" alt="Profile" />`;
      }
    }

    loggedOutView.style.display = 'none';
    loggedInView.style.display = 'block';
    if (settingsBackupBtn) settingsBackupBtn.style.display = 'flex';
    if (settingsRestoreBtn) settingsRestoreBtn.style.display = 'flex';
  } else {
    googleUser = null;
    loggedOutView.style.display = 'block';
    loggedInView.style.display = 'none';
    if (settingsBackupBtn) settingsBackupBtn.style.display = 'none';
    if (settingsRestoreBtn) settingsRestoreBtn.style.display = 'none';

    // Reset header avatar
    $('#profileAvatar').innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    `;
  }
}

/**
 * Refresh profile statistics dashboard
 */
async function refreshProfileStats() {
  const statsContainer = $('#profileStatsDashboard');
  if (!statsContainer) return;
  
  const hasPin = await isPinSetup();
  const pinEnabled = await isPinEnabled();
  const hasGoogleBackup = await isLoggedIn();
  
  const stats = await getDashboardStats(currentAccounts, folders, {
    hasPin,
    pinEnabled,
    hasGoogleBackup,
    accountCount: currentAccounts.length,
    hasFolders: folders.length > 0
  });
  
  // Update Quick Stats Cards
  animateCounter('#statTotalAccounts', stats.totalAccounts);
  animateCounter('#statSecurityScore', stats.securityScore, '%');
  $('#statLastBackup').textContent = stats.lastBackupAgo;
  animateCounter('#statTotalFolders', stats.totalFolders);
  
  // Update Security Status Badge
  const statusEl = $('#securityStatusBadge');
  if (statusEl) {
    statusEl.textContent = `${stats.securityStatus.icon} ${stats.securityStatus.text}`;
    statusEl.style.color = stats.securityStatus.color;
  }
  
  // Update Security Score Progress
  const scoreProgress = $('#securityScoreProgress');
  if (scoreProgress) {
    scoreProgress.style.width = `${stats.securityScore}%`;
    scoreProgress.style.backgroundColor = stats.securityStatus.color;
  }
  
  // Update Service Distribution
  renderServiceDistribution(stats.serviceDistribution, stats.totalAccounts);
  
  // Update Most Used Accounts
  renderMostUsedAccounts(stats.mostUsed);
  
  // Update Weekly Activity
  renderWeeklyActivity(stats.weeklyActivity);
  
  // Update Folder Distribution
  renderFolderDistribution(stats.folderDistribution);
}

/**
 * Animate counter from 0 to target value
 * @param {string} selector
 * @param {number} target
 * @param {string} suffix
 */
function animateCounter(selector, target, suffix = '') {
  const el = $(selector);
  if (!el) return;
  
  const duration = 800;
  const start = performance.now();
  const startValue = 0;
  
  function update(currentTime) {
    const elapsed = currentTime - start;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing function (ease-out)
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(startValue + (target - startValue) * easeOut);
    
    el.textContent = current + suffix;
    
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = target + suffix;
    }
  }
  
  requestAnimationFrame(update);
}

/**
 * Render service distribution donut chart
 * @param {Array} distribution
 * @param {number} total
 */
function renderServiceDistribution(distribution, total) {
  const container = $('#serviceDistributionChart');
  const list = $('#serviceDistributionList');
  if (!container || !list) return;
  
  // Clear previous
  list.innerHTML = '';
  
  if (distribution.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:12px;">No accounts yet</div>';
    return;
  }
  
  container.style.display = 'block';
  
  // Generate colors
  const colors = ['#00E5FF', '#30D158', '#FFD60A', '#FF9500', '#FF3B3B', '#7B3FE4', '#6C6C6C'];
  
  // Create SVG donut chart
  let svgSegments = '';
  let currentAngle = 0;
  const radius = 40;
  const cx = 50;
  const cy = 50;
  
  distribution.forEach((item, index) => {
    const percentage = item.count / total;
    const angle = percentage * 360;
    const color = colors[index % colors.length];
    
    // Calculate path
    const startAngle = (currentAngle - 90) * Math.PI / 180;
    const endAngle = (currentAngle + angle - 90) * Math.PI / 180;
    
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    
    const largeArc = angle > 180 ? 1 : 0;
    
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    svgSegments += `<path d="${path}" fill="${color}" />`;
    
    currentAngle += angle;
    
    // Add to list
    const percent = Math.round(percentage * 100);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';
    row.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${color};"></span>
      <span style="flex:1;color:var(--text-primary);">${escHtml(item.name)}</span>
      <span style="color:var(--text-secondary);">${item.count} (${percent}%)</span>
    `;
    list.appendChild(row);
  });
  
  // Inner circle (cutout)
  const innerCircle = `<circle cx="${cx}" cy="${cy}" r="25" fill="var(--bg-card)" />`;
  
  container.innerHTML = `
    <svg viewBox="0 0 100 100" style="width:80px;height:80px;">
      ${svgSegments}
      ${innerCircle}
    </svg>
  `;
}

/**
 * Render most used accounts
 * @param {Array} mostUsed
 */
function renderMostUsedAccounts(mostUsed) {
  const container = $('#mostUsedAccounts');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (mostUsed.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:12px;font-size:12px;">Start copying codes to see usage stats</div>';
    return;
  }
  
  const maxCount = mostUsed[0].copyCount;
  
  mostUsed.forEach((acc, index) => {
    const percentage = (acc.count / maxCount) * 100;
    const stars = '⭐'.repeat(Math.min(3, Math.ceil(acc.count / Math.max(1, maxCount / 3))));
    
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);';
    item.innerHTML = `
      <span style="font-weight:600;color:var(--accent);min-width:20px;">${index + 1}</span>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:500;color:var(--text-primary);">${escHtml(acc.issuer || acc.account || 'Unknown')}</div>
        <div style="height:4px;background:var(--border-subtle);border-radius:2px;margin-top:4px;overflow:hidden;">
          <div style="height:100%;width:${percentage}%;background:var(--accent);border-radius:2px;transition:width 0.5s ease;"></div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--text-secondary);">${acc.count}x</div>
        <div style="font-size:10px;">${stars}</div>
      </div>
    `;
    container.appendChild(item);
  });
}

/**
 * Render weekly activity mini bar chart
 * @param {Array} weeklyActivity
 */
function renderWeeklyActivity(weeklyActivity) {
  const container = $('#weeklyActivityChart');
  if (!container) return;
  
  const maxCount = Math.max(1, ...weeklyActivity.map(d => d.count));
  
  container.innerHTML = weeklyActivity.map(day => {
    const height = (day.count / maxCount) * 100;
    const isToday = day.date === new Date().toISOString().slice(0, 10);
    return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div style="width:100%;height:40px;background:var(--border-subtle);border-radius:4px;position:relative;overflow:hidden;">
          <div style="position:absolute;bottom:0;left:0;right:0;height:${height}%;background:${isToday ? 'var(--accent)' : 'var(--text-muted)'};border-radius:4px;transition:height 0.5s ease;"></div>
        </div>
        <span style="font-size:10px;color:${isToday ? 'var(--accent)' : 'var(--text-secondary)'};font-weight:${isToday ? '600' : '400'};">${day.day}</span>
      </div>
    `;
  }).join('');
}

/**
 * Render folder distribution
 * @param {Array} folderDistribution
 */
function renderFolderDistribution(folderDistribution) {
  const container = $('#folderDistribution');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (folderDistribution.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:12px;font-size:12px;">No folders yet</div>';
    return;
  }
  
  const total = folderDistribution.reduce((sum, f) => sum + f.count, 0);
  
  folderDistribution.forEach(folder => {
    const percentage = (folder.count / total) * 100;
    
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;';
    item.innerHTML = `
      <span style="width:12px;height:12px;border-radius:50%;background:${folder.color};"></span>
      <span style="flex:1;font-size:12px;color:var(--text-primary);">${escHtml(folder.name)}</span>
      <span style="font-size:11px;color:var(--text-secondary);">${folder.count} (${Math.round(percentage)}%)</span>
    `;
    container.appendChild(item);
  });
}

async function backupToDrive() {
  if (!(await isLoggedIn())) {
    showToast('Please sign in with Google first', 'error');
    return;
  }

  showToast('Backing up to Drive...', 'info');

  const result = await uploadBackupToDrive(currentAccounts);
  if (result.success) {
    // Track backup event
    await trackBackup();
    // Refresh stats if profile menu is open
    await refreshProfileStats();
    showToast(`Backup saved: ${result.fileName}`, 'success', 3000);
  } else {
    // Check if session expired
    if (result.error?.includes('Session expired') || result.error?.includes('sign in again')) {
      showToast('Session expired. Please sign in again.', 'error', 4000);
      // Refresh profile UI to show logged out state
      await refreshProfileUI();
    } else {
      showToast('Backup failed: ' + result.error, 'error');
    }
  }
}

// Restore from Google Drive
async function restoreFromDrive() {
  if (!(await isLoggedIn())) {
    showToast('Please sign in with Google first', 'error');
    return;
  }

  // Show modal
  openModal('#modalRestoreDrive');
  
  // Reset state
  $('#restoreDriveLoading').style.display = 'block';
  $('#restoreDriveEmpty').style.display = 'none';
  $('#restoreDriveList').style.display = 'none';
  $('#restoreDriveError').style.display = 'none';
  $('#restoreDriveFiles').innerHTML = '';

  // Fetch backups
  const result = await listBackupsFromDrive(10);
  
  $('#restoreDriveLoading').style.display = 'none';

  if (!result.success) {
    // Check if session expired
    if (result.error?.includes('Session expired') || result.error?.includes('sign in again')) {
      $('#restoreDriveError').textContent = 'Session expired. Please sign in again.';
      $('#restoreDriveError').style.display = 'block';
      // Refresh profile UI to show logged out state
      await refreshProfileUI();
    } else {
      $('#restoreDriveError').textContent = 'Failed to load backups: ' + result.error;
      $('#restoreDriveError').style.display = 'block';
    }
    return;
  }

  const files = result.files;
  if (!files || files.length === 0) {
    $('#restoreDriveEmpty').style.display = 'block';
    return;
  }

  // Show file list
  $('#restoreDriveList').style.display = 'block';
  const container = $('#restoreDriveFiles');
  
  files.forEach(file => {
    const date = new Date(file.createdTime).toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const size = file.size ? `(${(parseInt(file.size) / 1024).toFixed(1)} KB)` : '';
    
    const item = document.createElement('div');
    item.className = 'restore-file-item';
    item.innerHTML = `
      <div class="restore-file-icon">📦</div>
      <div class="restore-file-info">
        <div class="restore-file-name">${file.name}</div>
        <div class="restore-file-date">${date} ${size}</div>
      </div>
      <div class="restore-file-actions">
        <button class="restore-btn restore-btn-restore" title="Restore this backup">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </button>
        <button class="restore-btn restore-btn-delete" title="Delete this backup">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    `;
    
    // Restore button
    item.querySelector('.restore-btn-restore').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadAndRestore(file.id, file.name);
    });
    
    // Delete button
    item.querySelector('.restore-btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBackup(file.id, file.name, item);
    });
    
    container.appendChild(item);
  });
}

async function downloadAndRestore(fileId, fileName) {
  showToast('Downloading backup...', 'info');
  
  const result = await downloadBackupFromDrive(fileId);
  
  if (!result.success) {
    // Check if session expired
    if (result.error?.includes('Session expired') || result.error?.includes('sign in again')) {
      showToast('Session expired. Please sign in again.', 'error', 4000);
      closeModal('#modalRestoreDrive');
      await refreshProfileUI();
    } else {
      showToast('Download failed: ' + result.error, 'error');
    }
    return;
  }

  // Close restore modal
  closeModal('#modalRestoreDrive');
  
  try {
    // Get vault password (PIN or default)
    const vaultPw = currentPassword || await getDefaultKey();
    
    // Restore with folders if present (Drive backup is not encrypted with user password)
    const foldersData = result.data.folders || null;
    const restoreResult = await restoreFromDriveBackup(result.data.accounts, vaultPw, foldersData);
    
    currentAccounts = await getAccounts();
    
    // Reload folders after restore
    await loadFolders();
    await renderFolderChips();
    
    renderAccounts(currentAccounts);
    closeModal('#modalSettings');
    
    let msg = `Restored ${restoreResult.imported} account(s) from Drive`;
    if (restoreResult.foldersImported > 0) {
      msg += ` and ${restoreResult.foldersImported} folder(s)`;
    }
    showToast(msg + '!', 'success');
  } catch (err) {
    showToast('Restore failed: ' + err.message, 'error');
  }
}

async function deleteBackup(fileId, fileName, element) {
  if (!confirm(`Delete backup "${fileName}"?`)) return;
  
  showToast('Deleting backup...', 'info');
  
  const result = await deleteBackupFromDrive(fileId);
  
  if (result.success) {
    // Remove element from list
    element.style.opacity = '0';
    element.style.transform = 'translateX(-20px)';
    setTimeout(() => element.remove(), 300);
    
    showToast('Backup deleted', 'success');
    
    // Check if list is empty
    const container = $('#restoreDriveFiles');
    if (container.children.length === 0) {
      $('#restoreDriveList').style.display = 'none';
      $('#restoreDriveEmpty').style.display = 'block';
    }
  } else {
    // Check if session expired
    if (result.error?.includes('Session expired') || result.error?.includes('sign in again')) {
      showToast('Session expired. Please sign in again.', 'error', 4000);
      closeModal('#modalRestoreDrive');
      await refreshProfileUI();
    } else {
      showToast('Delete failed: ' + result.error, 'error');
    }
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function initSettings() {
  $('#btnSettings').addEventListener('click', () => {
    applyPreferences(); // sync toggles
    openModal('#modalSettings');
  });

  $('#closeModalSettings').addEventListener('click', () => closeModal('#modalSettings'));

  $('#modalSettings').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalSettings');
  });

  // PIN Protection Toggle
  $('#pinProtectionToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    
    if (enabled) {
      // Enabling PIN - require setup if no PIN exists
      const hasPin = await isPinSetup();
      if (!hasPin) {
        // Show PIN setup modal
        closeModal('#modalSettings');
        showPinSetupForEnable();
        return;
      }
    }
    
    prefs.pinEnabled = enabled;
    await setPinEnabled(enabled);
    applyPreferences();
    showToast(enabled ? 'PIN protection enabled' : 'PIN protection disabled', 'info');
  });

  // Other toggles
  $('#privacyModeToggle').addEventListener('change', async (e) => {
    prefs.privacyMode = e.target.checked;
    await setPreference('privacyMode', prefs.privacyMode);
    applyPreferences();
  });

  $('#compactLayoutToggle').addEventListener('change', async (e) => {
    prefs.compactLayout = e.target.checked;
    await setPreference('compactLayout', prefs.compactLayout);
    applyPreferences();
  });

  $('#closeAfterCopyToggle').addEventListener('change', async (e) => {
    prefs.closeAfterCopy = e.target.checked;
    await setPreference('closeAfterCopy', prefs.closeAfterCopy);
  });

  $('#autoFocusSearchToggle').addEventListener('change', async (e) => {
    prefs.autoFocusSearch = e.target.checked;
    await setPreference('autoFocusSearch', prefs.autoFocusSearch);
  });

  $('#autoLockSelect').addEventListener('change', async (e) => {
    prefs.autoLockMinutes = parseInt(e.target.value);
    await setPreference('autoLockMinutes', prefs.autoLockMinutes);
    setupAutoLock();
  });

  // Color picker
  $$('#accentColorPicker .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', async () => {
      const color = swatch.dataset.color;
      prefs.accentColor = color;
      await setPreference('accentColor', color);
      applyPreferences();
    });
  });

  // Lock now
  $('#btnLockNow').addEventListener('click', async () => {
    await lockVault();
    currentPassword = null;
    closeModal('#modalSettings');
    showView('#viewLock');
    if (tickInterval) clearInterval(tickInterval);
  });

  // Change PIN
  $('#btnChangePIN').addEventListener('click', () => {
    $('#currentPin').value = '';
    $('#newPin').value = '';
    $('#confirmNewPin').value = '';
    $('#changePinError').classList.remove('visible');
    openModal('#modalChangePin');
  });

  $('#closeModalChangePin').addEventListener('click', () => closeModal('#modalChangePin'));

  $('#btnChangePinConfirm').addEventListener('click', async () => {
    const current = $('#currentPin').value;
    const newPinVal = $('#newPin').value;
    const confirm = $('#confirmNewPin').value;
    const errorEl = $('#changePinError');

    if (newPinVal.length < 4) {
      errorEl.textContent = 'PIN must be at least 4 digits';
      errorEl.classList.add('visible');
      return;
    }
    if (newPinVal !== confirm) {
      errorEl.textContent = 'New PINs do not match';
      errorEl.classList.add('visible');
      return;
    }

    try {
      const pinData = await getLocalItem('pinData');
      const valid = await verifyPin(current, pinData.hash, pinData.salt);
      if (!valid) {
        errorEl.textContent = 'Current PIN is incorrect';
        errorEl.classList.add('visible');
        return;
      }

      // Re-encrypt vault with new PIN
      const accounts = await getSessionAccounts();
      const newPinData = await setupPin(newPinVal);
      await setLocalItem('pinData', newPinData);

      if (accounts) {
        const plaintext = JSON.stringify(accounts);
        const encrypted = await encrypt(plaintext, newPinVal);
        await setLocalItem('vault', encrypted);
      }

      currentPassword = newPinVal;
      closeModal('#modalChangePin');
      showToast('PIN updated successfully!', 'success');
    } catch (err) {
      errorEl.textContent = 'Failed: ' + err.message;
      errorEl.classList.add('visible');
    }
  });

  // Export (Plain text - no password)
  $('#btnExportData').addEventListener('click', async () => {
    try {
      const json = await exportPlainBackup();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `azkura-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Backup exported!', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });

  // Import/Restore - For popup mode: open app tab with import flag
  // For tab mode: process directly
  $('#importFileInput').addEventListener('change', async (e) => {
    pendingImportFile = e.target.files[0];
    if (!pendingImportFile) return;
    
    // Check if we're in the app page (tab mode) by checking URL
    const isAppPage = window.location.pathname.includes('/app/');
    
    if (isAppPage) {
      // Already in tab mode - process directly
      await processImportFile(pendingImportFile);
      e.target.value = '';
      return;
    }
    
    // This shouldn't happen in popup anymore since we redirect first
    // But keep as fallback
    console.warn('[Import] File selected in popup mode - unexpected');
    e.target.value = '';
  });
  
  // Handle import trigger - redirect to app tab first if in popup
  $('#importFileInput').addEventListener('click', (e) => {
    const isAppPage = window.location.pathname.includes('/app/');
    
    if (!isAppPage) {
      // In popup - prevent default file picker and open app tab instead
      e.preventDefault();
      const appUrl = chrome.runtime.getURL('src/app/index.html?selectImport=1');
      chrome.tabs.create({ url: appUrl });
      // Close popup
      setTimeout(() => window.close(), 50);
    }
    // In tab mode - allow default behavior (open file picker)
  });

  // Delete all
  $('#btnDeleteAll').addEventListener('click', () => {
    $('#deleteAllConfirmInput').value = '';
    $('#btnDeleteAllConfirm').disabled = true;
    openModal('#modalDeleteAll');
  });

  $('#btnDeleteAllCancel').addEventListener('click', () => closeModal('#modalDeleteAll'));

  $('#deleteAllConfirmInput').addEventListener('input', (e) => {
    $('#btnDeleteAllConfirm').disabled = e.target.value !== 'DELETE';
  });

  $('#btnDeleteAllConfirm').addEventListener('click', async () => {
    if ($('#deleteAllConfirmInput').value !== 'DELETE') return;
    try {
      await wipeAllData();
      currentAccounts = [];
      currentPassword = null;
      closeModal('#modalDeleteAll');
      closeModal('#modalSettings');
      showToast('All data deleted', 'info', 2000);
      setTimeout(() => {
        showView('#viewOnboarding');
        initOnboarding();
      }, 500);
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  });
}

// Process import file (used by both popup and tab mode)
async function processImportFile(file) {
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    
    // Check if it's a valid backup
    if (backup.accounts && Array.isArray(backup.accounts)) {
      // Plain backup - import directly without password
      const result = await importPlainBackup(text, currentPassword);
      currentAccounts = await getAccounts();
      
      // Reload folders after import
      await loadFolders();
      await renderFolderChips();
      
      renderAccounts(currentAccounts);
      closeModal('#modalSettings');
      
      let msg = `Restored ${result.imported} account(s)`;
      if (result.foldersImported > 0) {
        msg += ` and ${result.foldersImported} folder(s)`;
      }
      showToast(msg + '!', 'success');
      
      return true;
    } else if (backup.encrypted) {
      // Encrypted backup (old format) - show error
      showToast('This backup is encrypted. Please use a plain backup file.', 'error');
      return false;
    } else {
      showToast('Invalid backup file format', 'error');
      return false;
    }
  } catch (err) {
    showToast('Failed to read file: ' + err.message, 'error');
    return false;
  }
}

// Show PIN setup when enabling PIN protection
async function showPinSetupForEnable() {
  // For simplicity, use the existing change PIN modal but adapt it
  $('#currentPin').closest('.form-group').style.display = 'none';
  $('#newPin').placeholder = 'Create PIN';
  $('#confirmNewPin').placeholder = 'Confirm PIN';
  $('#changePinError').classList.remove('visible');
  
  // Store original handler
  const originalHandler = $('#btnChangePinConfirm').onclick;
  
  $('#btnChangePinConfirm').onclick = async () => {
    const newPinVal = $('#newPin').value;
    const confirm = $('#confirmNewPin').value;
    const errorEl = $('#changePinError');

    if (newPinVal.length < 4) {
      errorEl.textContent = 'PIN must be at least 4 digits';
      errorEl.classList.add('visible');
      return;
    }
    if (newPinVal !== confirm) {
      errorEl.textContent = 'PINs do not match';
      errorEl.classList.add('visible');
      return;
    }

    try {
      // Setup new PIN
      const pinData = await setupPin(newPinVal);
      await setLocalItem('pinData', pinData);
      await setPinEnabled(true);
      prefs.pinEnabled = true;
      currentPassword = newPinVal;
      
      // Re-encrypt vault if exists
      const accounts = await getSessionAccounts();
      if (accounts) {
        const plaintext = JSON.stringify(accounts);
        const encrypted = await encrypt(plaintext, newPinVal);
        await setLocalItem('vault', encrypted);
      }

      closeModal('#modalChangePin');
      showToast('PIN protection enabled!', 'success');
      applyPreferences();
      
      // Restore original handler
      setTimeout(() => {
        $('#currentPin').closest('.form-group').style.display = 'block';
        $('#newPin').placeholder = '';
        $('#confirmNewPin').placeholder = '';
      }, 300);
    } catch (err) {
      errorEl.textContent = 'Failed: ' + err.message;
      errorEl.classList.add('visible');
    }
  };

  openModal('#modalChangePin');
}

// ─── Folder Management ─────────────────────────────────────────────────────────
function initFolders() {
  // Folder chip click handlers
  $$('.folder-chip[data-folder]').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.folder-chip[data-folder]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFolderFilter = chip.dataset.folder;
      renderAccounts(currentAccounts);
    });
  });

  // Manage folders button
  $('#btnManageFolders').addEventListener('click', () => {
    openManageFoldersModal();
  });

  // Close modal handlers
  $('#closeModalFolders').addEventListener('click', () => closeModal('#modalManageFolders'));
  $('#closeModalMoveFolder').addEventListener('click', () => closeModal('#modalMoveToFolder'));
  $('#modalManageFolders').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalManageFolders');
  });
  $('#modalMoveToFolder').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('#modalMoveToFolder');
  });

  // Create folder
  $('#btnCreateFolder').addEventListener('click', async () => {
    const name = $('#newFolderName').value.trim();
    if (!name) {
      showToast('Please enter a folder name', 'error');
      return;
    }
    
    const selectedColor = $('#folderColorPicker .color-swatch.active');
    const color = selectedColor ? selectedColor.dataset.color : '#00E5FF';
    
    await createFolder(name, color);
    $('#newFolderName').value = '';
    await loadFolders();
    await renderFolderChips();
    showToast('Folder created!', 'success');
  });

  // Color picker
  $('#folderColorPicker')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-swatch')) {
      $$('#folderColorPicker .color-swatch').forEach(s => s.classList.remove('active'));
      e.target.classList.add('active');
    }
  });
}

async function loadFolders() {
  folders = await getFolders();
}

async function renderFolderChips() {
  const container = $('#folderList');
  if (!container) return;
  
  container.innerHTML = '';
  
  // Check if Uncategorized should be hidden
  const uncategorizedHidden = await isUncategorizedHidden();
  
  // Add Uncategorized chip if not hidden
  if (!uncategorizedHidden) {
    const uncategorizedChip = document.createElement('button');
    uncategorizedChip.className = 'folder-chip';
    uncategorizedChip.dataset.folder = 'uncategorized';
    uncategorizedChip.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:var(--border-medium);"></span>
      Uncategorized
    `;
    uncategorizedChip.addEventListener('click', () => {
      $$('.folder-chip[data-folder]').forEach(c => c.classList.remove('active'));
      uncategorizedChip.classList.add('active');
      currentFolderFilter = 'uncategorized';
      renderAccounts(currentAccounts);
    });
    container.appendChild(uncategorizedChip);
  }
  
  for (const folder of folders) {
    const chip = document.createElement('button');
    chip.className = 'folder-chip';
    chip.dataset.folder = folder.id;
    chip.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${folder.color};"></span>
      ${escHtml(folder.name)}
    `;
    chip.addEventListener('click', () => {
      $$('.folder-chip[data-folder]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFolderFilter = folder.id;
      renderAccounts(currentAccounts);
    });
    container.appendChild(chip);
  }
}

async function openManageFoldersModal() {
  await renderFoldersList();
  openModal('#modalManageFolders');
}

async function renderFoldersList() {
  const container = $('#foldersList');
  const currentFolders = await getFolders();
  const uncategorizedHidden = await isUncategorizedHidden();
  
  container.innerHTML = '';
  
  // Add Uncategorized folder item (virtual folder)
  const uncategorizedItem = document.createElement('div');
  uncategorizedItem.className = 'folder-item';
  uncategorizedItem.innerHTML = `
    <div class="folder-dot" style="background:var(--border-medium);"></div>
    <div class="folder-name">Uncategorized</div>
    <div class="folder-actions">
      <button class="folder-btn delete" title="${uncategorizedHidden ? 'Show Uncategorized filter' : 'Hide Uncategorized filter'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
          ${uncategorizedHidden 
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' // Eye icon (show)
            : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>' // Eye-off icon (hide)
          }
        </svg>
      </button>
    </div>
  `;
  
  uncategorizedItem.querySelector('.folder-btn.delete').addEventListener('click', async () => {
    const newHidden = !uncategorizedHidden;
    await setUncategorizedHidden(newHidden);
    await renderFoldersList();
    await renderFolderChips();
    showToast(newHidden ? 'Uncategorized filter hidden' : 'Uncategorized filter shown', 'info');
  });
  
  container.appendChild(uncategorizedItem);
  
  // Divider
  if (currentFolders.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    divider.style.margin = '8px 0';
    container.appendChild(divider);
  }
  
  if (currentFolders.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'text-align:center;color:var(--text-secondary);padding:12px;font-size:12px;';
    emptyMsg.textContent = 'No custom folders yet';
    container.appendChild(emptyMsg);
    return;
  }
  
  for (const folder of currentFolders) {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.innerHTML = `
      <div class="folder-dot" style="background:${folder.color};"></div>
      <div class="folder-name">${escHtml(folder.name)}</div>
      <div class="folder-actions">
        <button class="folder-btn delete" title="Delete folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    `;
    
    item.querySelector('.folder-btn.delete').addEventListener('click', async () => {
      if (confirm(`Delete folder "${folder.name}"? Accounts will be uncategorized.`)) {
        await deleteFolder(folder.id, currentPassword);
        await renderFoldersList();
        await renderFolderChips();
        renderAccounts(currentAccounts);
        showToast('Folder deleted', 'info');
      }
    });
    
    container.appendChild(item);
  }
}

async function openMoveToFolderModal(accountId) {
  const container = $('#moveFolderList');
  const currentFolders = await getFolders();
  const account = currentAccounts.find(a => a.id === accountId);
  
  container.innerHTML = '';
  
  // Add "Uncategorized" option
  const uncategorized = document.createElement('div');
  uncategorized.className = `move-folder-item ${!account?.folderId ? 'selected' : ''}`;
  uncategorized.innerHTML = `
    <div style="width:24px;height:8px;border-radius:50%;background:var(--border-medium);display:flex;align-items:center;justify-content:center;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
        <path d="M3 7v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>
      </svg>
    </div>
    <div style="flex:1;">Uncategorized</div>
  `;
  uncategorized.addEventListener('click', async () => {
    await moveAccountToFolder(accountId, null, currentPassword);
    currentAccounts = await getAccounts();
    renderAccounts(currentAccounts);
    closeModal('#modalMoveToFolder');
    showToast('Account moved', 'success');
  });
  container.appendChild(uncategorized);
  
  // Add folders
  for (const folder of currentFolders) {
    const item = document.createElement('div');
    item.className = `move-folder-item ${account?.folderId === folder.id ? 'selected' : ''}`;
    item.innerHTML = `
      <div style="width:24px;height:24px;border-radius:50%;background:${folder.color};"></div>
      <div style="flex:1;">${escHtml(folder.name)}</div>
    `;
    item.addEventListener('click', async () => {
      await moveAccountToFolder(accountId, folder.id, currentPassword);
      currentAccounts = await getAccounts();
      renderAccounts(currentAccounts);
      closeModal('#modalMoveToFolder');
      showToast('Account moved', 'success');
    });
    container.appendChild(item);
  }
  
  openModal('#modalMoveToFolder');
}

// ─── Initialization ───────────────────────────────────────────────────────────
function initAppElements() {
  // Initialize app-specific elements (fullscreen mode)
  const sidebarAddBtn = document.getElementById('btnAddAccountSidebar');
  if (sidebarAddBtn) {
    sidebarAddBtn.addEventListener('click', () => {
      clearAddForm();
      openModal('#modalAddAccount');
    });
  }

  const navSettings = document.getElementById('navSettings');
  const navAccounts = document.getElementById('navAccounts');
  
  if (navSettings) {
    navSettings.addEventListener('click', () => {
      navSettings.classList.add('active');
      if (navAccounts) navAccounts.classList.remove('active');
      openModal('#modalSettings');
    });
  }

  if (navAccounts) {
    navAccounts.addEventListener('click', () => {
      navAccounts.classList.add('active');
      if (navSettings) navSettings.classList.remove('active');
    });
  }
}

async function init() {
  try {
    // Initialize all components
    initOnboarding();
    initLockScreen();
    initSearch();
    initFAB();
    initAddAccountModal();
    initEditAccountModal();
    initDeleteModal();
    initSettings();
    initProfileMenu();
    initFolders();
    initAppElements(); // Initialize app-specific elements if present

    // Determine initial view
    const firstTime = await isFirstTimeSetup();
    const pinSetup = await isPinSetup();
    const pinEnabled = await isPinEnabled();
    const unlocked = await isUnlocked();

    if (firstTime) {
      // New user - show onboarding
      showView('#viewOnboarding');
    } else if (pinSetup && pinEnabled && !unlocked) {
      // Has PIN, PIN enabled, locked
      showView('#viewLock');
    } else {
      // Either no PIN, or PIN disabled, or already unlocked
      if (pinEnabled && pinSetup) {
        // Use stored PIN
        currentPassword = null; // Will be entered on lock
      } else {
        // Use default key
        currentPassword = null;
      }
      
      // Unlock with default key if needed
      if (!unlocked) {
        await unlockVault(null);
      }
      
      showView('#viewMain');
      await loadMainView();
      
      if (pinEnabled) {
        setupAutoLock();
      }
    }
  } catch (err) {
    console.error('Init error:', err);
    // Show error in UI for debugging
    const app = document.getElementById('app');
    if (app) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error-toast';
      errorDiv.textContent = 'Error: ' + err.message;
      app.appendChild(errorDiv);
    }
  }

  // Check for pending QR scans
  chrome.storage.session.get('pendingQR', async (result) => {
    if (result.pendingQR) {
      const qrData = result.pendingQR;
      chrome.storage.session.remove('pendingQR');
      
      console.log('[App] Processing QR data:', qrData.substring(0, 100));
      
      try {
        const parsed = parseOtpauthURI(qrData);
        console.log('[App] Parsed QR:', parsed);
        
        // Auto-add account directly
        if (parsed && parsed.secret) {
          const newAccount = await addAccount({
            issuer: parsed.issuer || '',
            account: parsed.account || '',
            secret: parsed.secret,
            algorithm: parsed.algorithm || 'SHA1',
            digits: parsed.digits || 6,
            period: parsed.period || 30
          }, currentPassword);
          
          // Refresh accounts list
          currentAccounts = await getAccounts();
          renderAccounts(currentAccounts);
          
          // Show success message
          showToast(`${newAccount.issuer || newAccount.account} added!`, 'success', 3000);
        } else {
          throw new Error('Parsed data missing secret');
        }
      } catch (e) {
        console.error('[App] QR parse error:', e);
        showToast('Failed to add QR: ' + e.message, 'error', 5000);
        // Also populate add form for manual entry
        try {
          populateAddForm({issuer: '', account: '', secret: ''});
          openModal('#modalAddAccount');
        } catch (modalErr) {
          console.error('[App] Modal error:', modalErr);
        }
      }
    }
  });
}

// Handle import from URL params (when redirected from popup)
async function handleImportFromParams() {
  const urlParams = new URLSearchParams(window.location.search);
  
  // Check if we should auto-trigger file picker
  if (urlParams.has('selectImport')) {
    // Small delay to let UI settle
    setTimeout(() => {
      $('#importFileInput').click();
    }, 300);
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    return true;
  }
  
  return false;
}

// Handle pending import data (legacy support)
async function handlePendingImport() {
  const { pendingImportData } = await chrome.storage.session.get('pendingImportData');
  if (pendingImportData) {
    // Clear pending data
    await chrome.storage.session.remove('pendingImportData');
    
    // Process the import
    try {
      const backup = JSON.parse(pendingImportData);
      if (backup.accounts && Array.isArray(backup.accounts)) {
        const result = await importPlainBackup(pendingImportData, currentPassword);
        currentAccounts = await getAccounts();
        
        // Reload folders after import
        await loadFolders();
        await renderFolderChips();
        
        renderAccounts(currentAccounts);
        
        let msg = `Restored ${result.imported} account(s)`;
        if (result.foldersImported > 0) {
          msg += ` and ${result.foldersImported} folder(s)`;
        }
        showToast(msg + '!', 'success');
        return true;
      }
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
  }
  return false;
}

// Start the app
init().then(async () => {
  // Check if there's pending import data (legacy)
  await handlePendingImport();
  // Check if we need to auto-trigger import (from popup redirect)
  await handleImportFromParams();
}).catch(console.error);
