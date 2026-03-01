/**
 * Azkura Auth — Main Popup Controller
 * Features: TOTP generation, PIN optional, Google login, Drive backup
 */

import { generateTOTP, getRemainingSeconds, formatCode, isValidSecret } from '../core/totp.js';
import { setupPin, verifyPin, encrypt, getDefaultKey } from '../core/crypto.js';
import { parseOtpauthURI } from '../core/uri-parser.js';
import { isLoggedIn, loginGoogle, logoutGoogle, getUserProfile, refreshUserProfile } from '../core/google-auth.js';
import { uploadBackupToDrive } from '../core/google-drive.js';
import {
  unlockVault,
  lockVault,
  addAccount,
  updateAccount,
  deleteAccount,
  deleteAllAccounts,
  wipeAllData,
  exportBackup,
  importBackup,
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
} from '../core/storage.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentPassword = null; // in-memory PIN for re-encryption (null if using default key)
let tickInterval = null;
let currentAccounts = [];
let prefs = {};
let pendingImportFile = null;
let createPinValue = null;
let googleUser = null;

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
  if (meta.emoji) {
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
    if (prefs.closeAfterCopy) {
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

  if (!accounts || accounts.length === 0) {
    const query = $('#searchInput')?.value || '';
    list.innerHTML = `
      <div class="accounts-empty">
        <div class="accounts-empty-icon">${query ? '🔍' : '🔐'}</div>
        <div class="accounts-empty-title">${query ? 'No results' : 'No accounts yet'}</div>
        <div class="accounts-empty-sub">${query ? `No accounts match "${escHtml(query)}"` : 'Tap the + button to add your first TOTP account'}</div>
      </div>
    `;
    return;
  }

  accounts.forEach(account => {
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
    // Trigger file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) scanQRFromFile(file);
    });
    input.click();
  });

  $('#btnScanQR').addEventListener('click', () => {
    menu.classList.remove('open');
    fab.classList.remove('open');
    // Open scanner tab
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

  btnProfile.addEventListener('click', () => {
    const isOpen = overlay.classList.toggle('open');
    if (isOpen) {
      refreshProfileUI();
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
    const result = await loginGoogle();
    if (result.success) {
      showToast(`Welcome, ${result.user.name}!`, 'success');
      await refreshProfileUI();
      overlay.classList.remove('open');
    } else {
      showToast('Login failed: ' + result.error, 'error');
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

  // Backup from settings
  $('#btnBackupDriveSettings')?.addEventListener('click', async () => {
    closeModal('#modalSettings');
    await backupToDrive();
  });
}

async function refreshProfileUI() {
  const loggedOutView = $('#profileMenuLoggedOut');
  const loggedInView = $('#profileMenuLoggedIn');
  const settingsBackupBtn = $('#btnBackupDriveSettings');

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
  } else {
    googleUser = null;
    loggedOutView.style.display = 'block';
    loggedInView.style.display = 'none';
    if (settingsBackupBtn) settingsBackupBtn.style.display = 'none';

    // Reset header avatar
    $('#profileAvatar').innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    `;
  }
}

async function backupToDrive() {
  if (!(await isLoggedIn())) {
    showToast('Please sign in with Google first', 'error');
    return;
  }

  showToast('Backing up to Drive...', 'info');

  const result = await uploadBackupToDrive(currentAccounts);
  if (result.success) {
    showToast(`Backup saved: ${result.fileName}`, 'success', 3000);
  } else {
    showToast('Backup failed: ' + result.error, 'error');
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

  // Export
  $('#btnExportData').addEventListener('click', () => {
    $('#exportPassword').value = '';
    $('#exportPasswordConfirm').value = '';
    $('#exportPasswordError').classList.remove('visible');
    openModal('#modalExportPassword');
  });

  $('#closeModalExport').addEventListener('click', () => closeModal('#modalExportPassword'));

  $('#btnExportConfirm').addEventListener('click', async () => {
    const pw1 = $('#exportPassword').value;
    const pw2 = $('#exportPasswordConfirm').value;
    const errEl = $('#exportPasswordError');

    if (!pw1) {
      errEl.textContent = 'Please enter a password';
      errEl.classList.add('visible');
      return;
    }
    if (pw1 !== pw2) {
      errEl.textContent = 'Passwords do not match';
      errEl.classList.add('visible');
      return;
    }

    try {
      $('#btnExportConfirm').disabled = true;
      const json = await exportBackup(pw1);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `azkura-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      closeModal('#modalExportPassword');
      showToast('Backup exported!', 'success');
    } catch (err) {
      errEl.textContent = 'Export failed: ' + err.message;
      errEl.classList.add('visible');
    } finally {
      $('#btnExportConfirm').disabled = false;
    }
  });

  // Import
  $('#importFileInput').addEventListener('change', (e) => {
    pendingImportFile = e.target.files[0];
    if (!pendingImportFile) return;
    $('#importPassword').value = '';
    $('#importPasswordError').classList.remove('visible');
    $('#importFileInfo').textContent = `File: ${pendingImportFile.name}. Enter the backup password.`;
    openModal('#modalImportPassword');
    e.target.value = ''; // reset so same file can be re-selected
  });

  $('#closeModalImport').addEventListener('click', () => closeModal('#modalImportPassword'));

  $('#btnImportConfirm').addEventListener('click', async () => {
    if (!pendingImportFile) return;
    const pw = $('#importPassword').value;
    const errEl = $('#importPasswordError');

    if (!pw) {
      errEl.textContent = 'Please enter the backup password';
      errEl.classList.add('visible');
      return;
    }

    try {
      $('#btnImportConfirm').disabled = true;
      const text = await pendingImportFile.text();
      const result = await importBackup(text, pw, currentPassword);
      currentAccounts = await getAccounts();
      renderAccounts(currentAccounts);
      closeModal('#modalImportPassword');
      closeModal('#modalSettings');
      showToast(`Imported ${result.imported} account(s)!`, 'success');
      pendingImportFile = null;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('visible');
    } finally {
      $('#btnImportConfirm').disabled = false;
    }
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

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
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

  // Check for pending QR scans
  chrome.storage.session.get('pendingQR', async (result) => {
    if (result.pendingQR) {
      chrome.storage.session.remove('pendingQR');
      const parsed = parseOtpauthURI(result.pendingQR);
      populateAddForm(parsed);
      openModal('#modalAddAccount');
    }
  });
}

// Start the app
init().catch(console.error);
