# 🔐 Azkura Auth

Chrome Extension untuk Two-Factor Authentication (2FA) dengan fitur backup ke Google Drive dan PIN optional.

![Version](https://img.shields.io/badge/version-2.7.0-blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-orange)

## ✨ Fitur

- **🔢 TOTP Generation** - Generate kode 2FA menggunakan algoritma RFC 6238 (via otplib)
- **📷 QR Scanner** - Scan QR code untuk menambahkan akun baru
- **🔒 PIN Optional** - Enkripsi vault dengan PIN (bisa di-skip)
- **☁️ Google Drive Backup** - Backup & restore data ke Google Drive
- **👤 Google Sign-In** - Login dengan akun Google untuk backup
- **📱 Responsive UI** - Tampilan modern dan responsif untuk desktop & mobile
- **📊 Statistics** - Tracking statistik penggunaan akun
- **🎯 Standalone App** - Full-page app mode untuk pengalaman lebih baik di mobile

## 📥 Download

| Versi | Download |
|-------|----------|
| **v2.7.0 (Latest)** | [Source Code](https://github.com/dhasap/azkura-auth/releases/download/v2.7.0/azkura-auth-v2.7.0-source.tar.gz) · [Dist (Ready Install)](https://github.com/dhasap/azkura-auth/releases/download/v2.7.0/azkura-auth-v2.7.0-dist.tar.gz) |
| All Releases | [Releases Page](https://github.com/dhasap/azkura-auth/releases) |

## 🚀 Cara Install

### Install dari Release (Cepat)

1. Download `azkura-auth-v2.7.0-dist.tar.gz` dari [releases](https://github.com/dhasap/azkura-auth/releases)
2. Extract file
3. Buka `chrome://extensions/`
4. Aktifkan **Developer mode**
5. Klik **Load unpacked** → Pilih folder hasil extract

### Install dari Source (Development)

```bash
git clone https://github.com/dhasap/azkura-auth.git
cd azkura-auth
npm install
npm run build
```

Lalu load folder `dist/` ke Chrome extensions.

## ⚙️ Konfigurasi Google OAuth2 (Wajib untuk Backup)

Agar fitur Google Login & Backup berfungsi, Anda perlu setup di Google Cloud Console:

### 1. Buat Project di Google Cloud Console
- Kunjungi [Google Cloud Console](https://console.cloud.google.com/)
- Buat project baru atau gunakan existing

### 2. Enable APIs
- **Google Drive API**
- **Google Identity Toolkit API**

### 3. Buat OAuth2 Credentials

**Untuk Desktop:**
- Go to **APIs & Services > Credentials**
- Klik **Create Credentials > OAuth client ID**
- Pilih **Chrome Extension**
- Masukkan **Application ID** extension (lihat di `chrome://extensions/`)

**Untuk Mobile (Wajib Web Application type):**
- Pilih **Web application**
- Tambahkan **Authorized redirect URIs** (lihat langkah 4)

### 4. Tambahkan Redirect URI ⭐ Penting

Extension ID dapat berubah jika extension di-remove dan di-load ulang. Setelah extension di-load:

1. Buka extension popup → tekan F12 untuk buka DevTools
2. Cek console untuk melihat **Redirect URI** yang harus didaftarkan
3. Atau hitung manual: `https://<EXTENSION_ID>.chromiumapp.org/`

Contoh:
```
https://cgikfceghgefkafghdebelllfhlglpjd.chromiumapp.org/
```

**⚠️ Penting untuk Mobile:**
Jika login Google gagal di mobile dengan error *"redirect_uri_mismatch"*, daftarkan URI tersebut ke **Web application** OAuth client ID (bukan Chrome Extension type).

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

Dan update juga di `src/core/google-auth.js`:
```javascript
const OAUTH2_CLIENT_IDS = {
  desktop: 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com',
  mobile: 'YOUR_MOBILE_CLIENT_ID.apps.googleusercontent.com'
};
```

## 📁 Struktur Folder

```
azkura-auth/
├── src/
│   ├── popup/              # Popup UI (HTML, CSS, JS)
│   ├── app/                # Standalone app page
│   ├── scanner/            # QR Scanner page
│   ├── auth/               # Auth callback handler
│   ├── background/         # Service worker
│   └── core/               # Core logic
│       ├── totp.js         # TOTP generation (otplib)
│       ├── crypto.js       # Encryption/decryption
│       ├── storage.js      # Chrome storage wrapper
│       ├── accounts.js     # Account management
│       ├── google-auth.js  # Google OAuth (desktop & mobile)
│       ├── google-drive.js # Drive API integration
│       ├── service-icons.js # Service icon mapping
│       ├── stats.js        # Usage statistics
│       └── uri-parser.js   # TOTP URI parser
├── icons/                  # Extension icons
├── dist/                   # Build output
├── manifest.json           # Extension manifest
└── vite.config.js          # Build config
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
- **Data Storage**: Chrome Storage API (local & session)
- **Backup**: Data dienkripsi sebelum diupload ke Drive
- **Auto-lock**: Vault terkunci otomatis setelah idle

## 🐛 Troubleshooting

### Google Login tidak berfungsi di Mobile

**Error:** *"Anda tidak dapat login ke aplikasi ini karena aplikasi ini tidak mematuhi kebijakan OAuth 2.0 Google"*

**Solusi:**
1. Dapatkan Extension ID dari `chrome://extensions/`
2. Buka [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
3. Cari OAuth 2.0 Client ID untuk mobile (Web application type)
4. Tambahkan redirect URI: `https://<EXTENSION_ID>.chromiumapp.org/`
5. Tunggu 5-10 menit, lalu coba lagi

### Google Login tidak berfungsi di Desktop
- Pastikan Extension ID sudah didaftarkan di Google Cloud Console
- Untuk desktop, gunakan **Chrome Extension** type (bukan Web application)
- Cek apakah redirect URI sudah benar di console DevTools

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

**Solusi:** Set Extension ID permanen dengan menambahkan `key` di `manifest.json`:
```json
{
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
}
```

Generate key dengan: `openssl rsa -in key.pem -pubout -outform der | openssl base64 -A`

## 📝 Changelog

### v2.7.0
- ✨ Added support untuk semua layanan populer (300+ services)
- ✨ Added fitur hapus backup dari Google Drive
- ✨ Added folder management untuk backup files
- ✨ Added service logo otomatis berdasarkan nama layanan
- 🔧 Mobile compatibility dan UX improvements
- 🔧 Restore dari Drive tidak perlu password lagi
- 🔧 Profile menu dengan posisi yang lebih baik
- 🔧 QR upload via scanner tab
- 🔧 Settings scroll improvements
- 🔧 Popup layout fixes untuk berbagai ukuran layar
- 🔧 Enhanced OAuth error messages dan debugging info
- 🔧 Improved PIN hashing dengan salt unik

### v2.1.5
- ✨ Added standalone app page untuk mobile
- ✨ Added auth callback handler
- ✨ Added statistics tracking
- 🐛 Improved OAuth error handling untuk mobile
- 🔧 Enhanced QR scanner functionality
- 🔧 Updated service icons handling
- 🔧 Better storage management
- 🔧 Improved URI parser

### v1.0.0
- 🎉 Initial release
- 🔢 TOTP generation
- 📷 QR scanner
- 🔒 PIN encryption
- ☁️ Google Drive backup
- 👤 Google Sign-In

## 📄 License

MIT License - lihat file LICENSE untuk detail.

---

**Azkura Auth** - Authenticator sederhana dengan backup cloud. ☁️🔐

Made with ❤️ for secure 2FA management.
