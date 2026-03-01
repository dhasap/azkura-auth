# 🔐 Azkura Auth

Chrome Extension untuk Two-Factor Authentication (2FA) dengan fitur backup ke Google Drive dan PIN optional.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-orange)

## ✨ Fitur

- **🔢 TOTP Generation** - Generate kode 2FA menggunakan algoritma RFC 6238 (via otplib)
- **📷 QR Scanner** - Scan QR code untuk menambahkan akun baru
- **🔒 PIN Optional** - Enkripsi vault dengan PIN (bisa di-skip)
- **☁️ Google Drive Backup** - Backup & restore data ke Google Drive
- **👤 Google Sign-In** - Login dengan akun Google untuk backup
- **📱 Responsive UI** - Tampilan modern dan responsif

## 🚀 Cara Install (Development)

### 1. Clone & Install Dependencies

```bash
git clone <repository-url>
cd authenticator-azkura
npm install
```

### 2. Build Extension

```bash
npm run build
```

### 3. Load ke Chrome

1. Buka `chrome://extensions/`
2. Aktifkan **Developer mode** (toggle kanan atas)
3. Klik **Load unpacked**
4. Pilih folder `dist/`

## ⚙️ Konfigurasi Google OAuth2 (Wajib untuk Backup)

Agar fitur Google Login & Backup berfungsi, Anda perlu setup di Google Cloud Console:

### 1. Buat Project di Google Cloud Console
- Kunjungi [Google Cloud Console](https://console.cloud.google.com/)
- Buat project baru atau gunakan existing

### 2. Enable APIs
- **Google Drive API**
- **Google Identity Toolkit API**

### 3. Buat OAuth2 Credentials
- Go to **APIs & Services > Credentials**
- Klik **Create Credentials > OAuth client ID**
- Pilih **Chrome Extension**
- Masukkan **Application ID** extension (lihat di `chrome://extensions/`)

### 4. Tambahkan Redirect URI

Setelah extension di-load pertama kali, dapatkan Extension ID dari Chrome, lalu tambahkan redirect URI:

```
https://<EXTENSION_ID>.chromiumapp.org/
```

Contoh:
```
https://abc123defghijklmnop.chromiumapp.org/
```

### 5. Update Client ID (Jika Perlu)

Jika menggunakan Client ID sendiri, update di `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.file"
  ]
}
```

## 📁 Struktur Folder

```
authenticator-azkura/
├── src/
│   ├── popup/           # Popup UI (HTML, CSS, JS)
│   ├── core/            # Core logic
│   │   ├── totp.js      # TOTP generation (otplib)
│   │   ├── crypto.js    # Encryption/decryption
│   │   ├── google-auth.js   # Google OAuth
│   │   └── google-drive.js  # Drive API
│   ├── scanner/         # QR Scanner
│   └── background.js    # Service worker
├── icons/               # Extension icons
├── dist/                # Build output
├── manifest.json        # Extension manifest
└── vite.config.js       # Build config
```

## 🛠️ Tech Stack

- **Build Tool**: [Vite](https://vitejs.dev/) v7.3.1
- **CRX Plugin**: [@crxjs/vite-plugin](https://crxjs.dev/)
- **TOTP Library**: [otplib](https://github.com/yeojz/otplib) v13
- **QR Scanner**: html5-qrcode
- **Manifest**: Chrome Extension Manifest V3

## 📝 Scripts

| Command | Deskripsi |
|---------|-----------|
| `npm run build` | Build extension ke folder `dist/` |
| `npm run dev` | Development mode dengan HMR |
| `npm run generate-icons` | Generate icon dari logo.jpg |

## 🔐 Keamanan

- **Enkripsi**: AES-256-GCM dengan PBKDF2 key derivation
- **PIN Hash**: SHA-256 dengan salt unik per user
- **Data Storage**: Chrome Storage API (local)
- **Backup**: Data dienkripsi sebelum diupload ke Drive

## 🐛 Troubleshooting

### Google Login tidak berfungsi
- Pastikan Extension ID sudah didaftarkan di Google Cloud Console
- Cek apakah redirect URI sudah benar
- Verifikasi client_id di `manifest.json`

### Build gagal
```bash
rm -rf node_modules dist
npm install
npm run build
```

### Extension ID berubah
Extension ID akan konsisten jika menggunakan key di manifest. Untuk development, Extension ID bisa berubah jika:
- Extension di-remove dan di-load ulang
- Tidak menggunakan `key` di manifest.json

## 📄 License

MIT License - lihat file LICENSE untuk detail.

---

**Azkura Auth** - Authenticator sederhana dengan backup cloud. ☁️🔐
