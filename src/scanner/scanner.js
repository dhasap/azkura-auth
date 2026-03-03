/**
 * Azkura Auth — QR Scanner Tab
 * Uses native BarcodeDetector API (Chrome 88+) for camera and file scanning
 */

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusTextCamera = document.getElementById('statusTextCamera');
const statusTextUpload = document.getElementById('statusTextUpload');
const permissionError = document.getElementById('permissionError');
const videoWrapper = document.getElementById('videoWrapper');
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');

let stream = null;
let scanActive = false;

// Tab switching - Fixed for mobile
window.switchTab = function(tabName) {
  console.log('[Scanner] switchTab called:', tabName);
  
  // Update tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  const tabId = `tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
  const contentId = `content${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
  
  console.log('[Scanner] Looking for elements:', tabId, contentId);
  
  const tabEl = document.getElementById(tabId);
  const contentEl = document.getElementById(contentId);
  
  console.log('[Scanner] Found elements:', tabEl ? 'tab yes' : 'tab no', contentEl ? 'content yes' : 'content no');
  
  if (tabEl) tabEl.classList.add('active');
  if (contentEl) contentEl.classList.add('active');
  
  // Stop camera if switching away
  if (tabName !== 'camera' && stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    scanActive = false;
    console.log('[Scanner] Camera stopped');
  }
  
  // Start camera if switching to camera
  if (tabName === 'camera' && !stream) {
    console.log('[Scanner] Starting camera...');
    startScanner();
  }
};

// Camera scanning
window.startScanner = async function() {
  permissionError.classList.remove('visible');
  if (videoWrapper) videoWrapper.style.display = 'block';
  if (statusTextCamera) statusTextCamera.textContent = 'Initializing camera...';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    video.srcObject = stream;
    await video.play();
    scanActive = true;
    if (statusTextCamera) {
      statusTextCamera.textContent = 'Scanning for QR code...';
      statusTextCamera.className = 'status-text';
    }
    requestAnimationFrame(scanFrame);
  } catch (err) {
    if (statusTextCamera) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        statusTextCamera.textContent = '';
        if (videoWrapper) videoWrapper.style.display = 'none';
        permissionError.classList.add('visible');
      } else {
        statusTextCamera.textContent = 'Camera error: ' + err.message;
        statusTextCamera.className = 'status-text error';
      }
    }
  }
};

async function scanFrame() {
  if (!scanActive) return;

  if (video.readyState < video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(scanFrame);
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  let qrData = null;

  // Try native BarcodeDetector (Chrome 88+)
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(video);
      if (codes.length > 0) {
        qrData = codes[0].rawValue;
      }
    } catch {
      // BarcodeDetector not available, continue
    }
  }

  if (qrData) {
    onQRFound(qrData, 'camera');
    return;
  }

  requestAnimationFrame(scanFrame);
}

// File upload handling
if (uploadArea) {
  uploadArea.addEventListener('click', () => fileInput?.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = 'var(--accent)';
    uploadArea.style.background = 'rgba(0,229,255,0.1)';
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '';
    uploadArea.style.background = '';
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '';
    uploadArea.style.background = '';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      processImage(file);
    }
  });
}

if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processImage(file);
  });
}

async function processImage(file) {
  if (statusTextUpload) {
    statusTextUpload.textContent = 'Processing image...';
    statusTextUpload.className = 'status-text';
  }

  try {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    await new Promise((res, rej) => { 
      img.onload = res; 
      img.onerror = () => rej(new Error('Failed to load image')); 
    });

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    let qrData = null;

    // Try native BarcodeDetector
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const codes = await detector.detect(img);
        if (codes.length > 0) qrData = codes[0].rawValue;
      } catch { /* fallthrough */ }
    }

    if (qrData) {
      onQRFound(qrData, 'upload');
    } else {
      if (statusTextUpload) {
        statusTextUpload.textContent = '⚠ No QR code found in image';
        statusTextUpload.className = 'status-text error';
      }
    }
  } catch (err) {
    if (statusTextUpload) {
      statusTextUpload.textContent = 'Error: ' + err.message;
      statusTextUpload.className = 'status-text error';
    }
  }
}

async function onQRFound(data, source) {
  scanActive = false;

  // Stop camera
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  // Validate it's an otpauth URI
  if (!data || !data.startsWith('otpauth://')) {
    const msg = '⚠ QR code found, but not a valid TOTP code. Data: ' + (data ? data.substring(0, 50) : 'empty');
    console.log('[Scanner] Invalid QR data:', data);
    if (source === 'camera') {
      if (statusTextCamera) {
        statusTextCamera.textContent = msg;
        statusTextCamera.className = 'status-text error';
      }
      setTimeout(() => {
        scanActive = true;
        startScanner();
      }, 3000);
    } else {
      if (statusTextUpload) {
        statusTextUpload.textContent = msg;
        statusTextUpload.className = 'status-text error';
      }
    }
    return;
  }
  
  // Show raw data for debugging
  console.log('[Scanner] QR Data:', data.substring(0, 100));

  // Show success immediately
  if (source === 'camera') {
    if (statusTextCamera) {
      statusTextCamera.textContent = '✓ QR code found! Processing...';
      statusTextCamera.className = 'status-text success';
    }
  } else {
    if (statusTextUpload) {
      statusTextUpload.textContent = '✓ QR code found! Processing...';
      statusTextUpload.className = 'status-text success';
    }
  }

  // Save to storage first, then redirect back
  try {
    // Store QR data temporarily
    await chrome.storage.session.set({ pendingQR: data });
    
    // Show success message
    setTimeout(() => {
      if (source === 'camera') {
        if (statusTextCamera) statusTextCamera.textContent = '✓ Account saved! Redirecting...';
      } else {
        if (statusTextUpload) statusTextUpload.textContent = '✓ Account saved! Redirecting...';
      }
      
      // Redirect back to app after short delay
      setTimeout(() => {
        const appUrl = chrome.runtime.getURL('src/app/index.html');
        window.location.href = appUrl;
      }, 800);
    }, 300);
    
  } catch (error) {
    console.error('Failed to process QR:', error);
    
    if (source === 'camera') {
      if (statusTextCamera) {
        statusTextCamera.textContent = '✗ Failed to save: ' + error.message;
        statusTextCamera.className = 'status-text error';
      }
      setTimeout(() => {
        scanActive = true;
        startScanner();
      }, 2000);
    } else {
      if (statusTextUpload) {
        statusTextUpload.textContent = '✗ Failed to save: ' + error.message;
        statusTextUpload.className = 'status-text error';
      }
    }
  }
}

// Check URL params for initial tab
const urlParams = new URLSearchParams(window.location.search);
const initialTab = urlParams.get('tab');

// Close/Back button handler
document.getElementById('btnCloseTab')?.addEventListener('click', () => {
  const appUrl = chrome.runtime.getURL('src/app/index.html');
  window.location.href = appUrl;
});

// Tab button handlers
document.getElementById('tabCamera')?.addEventListener('click', () => {
  console.log('[Scanner] Camera tab clicked');
  switchTab('camera');
});

document.getElementById('tabUpload')?.addEventListener('click', () => {
  console.log('[Scanner] Upload tab clicked');
  switchTab('upload');
});

// Initial setup
function init() {
  console.log('[Scanner] Initializing, initialTab:', initialTab);
  if (initialTab === 'upload') {
    switchTab('upload');
  } else {
    // Auto-start camera if camera tab is active
    const cameraContent = document.getElementById('contentCamera');
    if (cameraContent && cameraContent.classList.contains('active')) {
      startScanner();
    }
  }
}

// Clean up on tab close
window.addEventListener('beforeunload', () => {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
