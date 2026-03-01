/**
 * Azkura Auth — QR Scanner Tab
 * Uses native BarcodeDetector API (Chrome 88+) for camera scanning
 */

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusText = document.getElementById('statusText');
const permissionError = document.getElementById('permissionError');
const videoWrapper = document.getElementById('videoWrapper');

let stream = null;
let scanActive = false;

window.startScanner = startScanner;

async function startScanner() {
  permissionError.classList.remove('visible');
  statusText.textContent = 'Initializing camera...';

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
    statusText.textContent = 'Scanning for QR code...';
    requestAnimationFrame(scanFrame);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusText.textContent = '';
      permissionError.classList.add('visible');
      videoWrapper.style.display = 'none';
    } else {
      statusText.textContent = 'Camera error: ' + err.message;
      statusText.className = 'status-text error';
    }
  }
}

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
    onQRFound(qrData);
    return;
  }

  requestAnimationFrame(scanFrame);
}

function onQRFound(data) {
  scanActive = false;

  // Stop camera
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  statusText.textContent = '✓ QR Code detected!';
  statusText.className = 'status-text success';

  // Validate it's an otpauth URI
  if (!data.startsWith('otpauth://')) {
    statusText.textContent = '⚠ QR code found, but not a valid TOTP code';
    statusText.className = 'status-text error';
    setTimeout(startScanner, 2000); // retry
    return;
  }

  // Send to popup
  chrome.runtime.sendMessage({ type: 'QR_SCANNED', data });

  statusText.textContent = '✓ Account added! You can close this tab.';
  setTimeout(() => window.close(), 1500);
}

// Auto-start
startScanner();

// Clean up on tab close
window.addEventListener('beforeunload', () => {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
});
