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

// Tab switching
window.switchTab = function(tabName) {
  // Update tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`).classList.add('active');
  document.getElementById(`content${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`).classList.add('active');
  
  // Stop camera if switching away
  if (tabName !== 'camera' && stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    scanActive = false;
  }
  
  // Start camera if switching to camera
  if (tabName === 'camera' && !stream) {
    startScanner();
  }
};

// Camera scanning
window.startScanner = async function() {
  permissionError.classList.remove('visible');
  videoWrapper.style.display = 'block';
  statusTextCamera.textContent = 'Initializing camera...';

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
    statusTextCamera.textContent = 'Scanning for QR code...';
    requestAnimationFrame(scanFrame);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusTextCamera.textContent = '';
      videoWrapper.style.display = 'none';
      permissionError.classList.add('visible');
    } else {
      statusTextCamera.textContent = 'Camera error: ' + err.message;
      statusTextCamera.className = 'status-text error';
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
uploadArea.addEventListener('click', () => fileInput.click());

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

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) processImage(file);
});

async function processImage(file) {
  statusTextUpload.textContent = 'Processing image...';
  statusTextUpload.className = 'status-text';

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
      statusTextUpload.textContent = '⚠ No QR code found in image';
      statusTextUpload.className = 'status-text error';
    }
  } catch (err) {
    statusTextUpload.textContent = 'Error: ' + err.message;
    statusTextUpload.className = 'status-text error';
  }
}

function onQRFound(data, source) {
  scanActive = false;

  // Stop camera
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  // Validate it's an otpauth URI
  if (!data.startsWith('otpauth://')) {
    const msg = '⚠ QR code found, but not a valid TOTP code';
    if (source === 'camera') {
      statusTextCamera.textContent = msg;
      statusTextCamera.className = 'status-text error';
      setTimeout(startScanner, 2000);
    } else {
      statusTextUpload.textContent = msg;
      statusTextUpload.className = 'status-text error';
    }
    return;
  }

  // Send to popup
  chrome.runtime.sendMessage({ type: 'QR_SCANNED', data });

  if (source === 'camera') {
    statusTextCamera.textContent = '✓ Account added! Closing...';
    statusTextCamera.className = 'status-text success';
  } else {
    statusTextUpload.textContent = '✓ Account added! Closing...';
    statusTextUpload.className = 'status-text success';
  }
  
  setTimeout(() => window.close(), 1500);
}

// Check URL params for initial tab
const urlParams = new URLSearchParams(window.location.search);
const initialTab = urlParams.get('tab');
if (initialTab === 'upload') {
  switchTab('upload');
} else {
  // Auto-start camera if camera tab is active
  if (document.getElementById('contentCamera').classList.contains('active')) {
    startScanner();
  }
}

// Clean up on tab close
window.addEventListener('beforeunload', () => {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
});
