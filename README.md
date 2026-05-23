# DeepSeek Multi-Account API Proxy

[![Vercel Ready](https://img.shields.io/badge/Vercel-Ready-000000?style=flat&logo=vercel)](https://vercel.com)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat&logo=docker)](https://www.docker.com)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI--Compatible-412991?style=flat&logo=openai)](https://platform.openai.com)

Proxy API berkinerja tinggi dan tangguh yang mengubah akun web/mobile DeepSeek menjadi endpoint **OpenAI-compatible** dengan dukungan streaming token-by-token yang sesungguhnya (real SSE). Dirancang khusus untuk memfasilitasi alur kerja **Vibe Coding** pada ekstensi VS Code seperti **Cline**, **Roo Code**, dan **Continue**, serta sepenuhnya kompatibel sebagai *custom provider* di **9router**.

---

## 📌 Daftar Isi

1. [Fitur Utama](#-fitur-utama)
2. [Arsitektur Alur Kerja](#-arsitektur-alur-kerja)
3. [Struktur Proyek](#-struktur-proyek)
4. [Persyaratan Sistem](#-persyaratan-sistem)
5. [Panduan Instalasi & Deployment](#-panduan-instalasi--deployment)
   - [Opsi A: Lokal / VPS (PM2)](#opsi-a-lokal--vps-pm2)
   - [Opsi B: Docker & Docker Compose](#opsi-b-docker--docker-compose)
   - [Opsi C: Vercel (Free Tier)](#opsi-c-vercel-free-tier)
6. [Konfigurasi Sistem](#-konfigurasi-sistem)
7. [Dokumentasi API Endpoint](#-dokumentasi-api-endpoint)
8. [Panduan Integrasi Klien](#-panduan-integrasi-klien)
   - [Integrasi dengan Cline (VS Code)](#integrasi-dengan-cline-vs-code)
   - [Integrasi dengan 9router](#integrasi-dengan-9router)
9. [Penanganan Masalah (Troubleshooting)](#-penanganan-masalah-troubleshooting)
10. [Praktik Keamanan (Security)](#-praktik-keamanan-security)

---

## ✨ Fitur Utama

- ⚡ **Real Streaming (SSE)**: Mengalirkan token satu per satu secara langsung (*realtime*). Mencegah Cline/klien mengalami *freeze* atau *timeout* akibat menunggu seluruh jawaban selesai di-buffer.
- 🧠 **Dukungan Blok Berpikir (Reasoning Content)**: Meneruskan blok berpikir asli dari model `deepseek-reasoner` ke field `delta.reasoning_content` (sesuai konvensi DeepSeek-R1), sehingga Cline dapat menampilkan kotak *thinking* secara elegan.
- 🛠️ **Kompatibilitas Penuh Tool-Call XML**: Menjaga integritas *system prompt* Cline tanpa modifikasi atau pembungkusan label tambahan, memastikan asisten AI menghasilkan format XML tool call yang valid.
- 🔄 **Dua Mode Autentikasi & Operasi**:
  - **Mode Tanpa File (Vercel/Stateless)**: Membaca kredensial `email:password` dinamis langsung dari header `Authorization: Bearer` yang dikirim 9router atau Cline.
  - **Mode Lokal (Round-Robin)**: Memutar akun secara otomatis menggunakan daftar akun yang disimpan di `accounts.txt`.
- 🔒 **Login Lock & Token Caching**: Mencegah akun di-ban atau terkena *rate-limit* DeepSeek akibat *race condition* (request paralel yang masuk bersamaan hanya akan memicu 1 kali siklus login, sisanya menggunakan token yang sama di dalam cache memori dengan TTL 1 jam).
- 🔄 **Auto-Retry & Refresh Token**: Otomatis mendeteksi token kedaluwarsa (401/403/Auth error), melakukan login ulang di background, lalu mencoba kembali request yang gagal tanpa memutus koneksi klien.
- 🛑 **Graceful Shutdown**: Menangkap sinyal `SIGTERM` / `SIGINT` dan menolak request baru, sembari menunggu seluruh proses streaming yang sedang aktif selesai dengan bersih sebelum mematikan server.
- 🏷️ **Log Request Detail & Tracing**: Logger terpusat dengan format profesional yang mencatat metode HTTP, route, model yang dipanggil, status response, dan estimasi waktu eksekusi.

---

## 🌐 Arsitektur Alur Kerja

Proxy ini dapat beroperasi dalam dua skenario utama:

### 1. Alur Terdistribusi (Cline → 9router → DeepSeek Bot)
Sangat direkomendasikan untuk produksi. 9router menangani *Round-Robin* multi-provider, penyeimbangan beban, dan manajemen kuota klien. DeepSeek Bot bertindak sebagai *stateless handler* di belakangnya.
```
┌───────────┐         ┌───────────┐         ┌──────────────┐         ┌───────────────┐
│ VS Code   │ ──────> │  9router  │ ──────> │ DeepSeek Bot │ ──────> │ DeepSeek Web  │
│ (Cline)   │         │ (Gateway) │         │ (API Proxy)  │         │  (Mobile API) │
└───────────┘         └───────────┘         └──────────────┘         └───────────────┘
```

### 2. Alur Langsung (Cline → DeepSeek Bot)
Sederhana dan cepat untuk penggunaan lokal pribadi.
```
┌───────────┐                 ┌──────────────┐                 ┌───────────────┐
│ VS Code   │ ──────────────> │ DeepSeek Bot │ ──────────────> │ DeepSeek Web  │
│ (Cline)   │                 │ (API Proxy)  │                 │  (Mobile API) │
└───────────┘                 └──────────────┘                 └───────────────┘
```

---

## 📁 Struktur Proyek

```
deepseek-bot/
├── api/
│   └── index.js              # Serverless entry point untuk Vercel
├── src/
│   ├── index.js              # Express app builder & route mounter
│   ├── config.js             # Validasi & pemetaan konfigurasi terpusat
│   ├── accounts/
│   │   └── manager.js        # Logika Round-Robin & manajemen token cache
│   ├── api/
│   │   ├── v1.js             # Endpoint OpenAI-compatible (/chat/completions)
│   │   ├── admin.js          # REST API manajemen akun (VPS only)
│   │   ├── health.js         # Endpoint status & readiness probe
│   │   └── debug.js          # Endpoint inspeksi request mentah
│   ├── chat/
│   │   └── service.js        # Siklus hidup request chat & auto-retry
│   ├── lib/
│   │   └── deepseek/
│   │       ├── index.js      # Wrapper komunikasi HTTP ke API DeepSeek
│   │       ├── constants.js  # Definisi endpoint, user-agent, dan header
│   │       └── pow.js        # Solver tantangan Proof-of-Work (PoW)
│   └── util/
│       ├── logger.js         # Format logging konsol terpadu
│       ├── promptBuilder.js  # Kompilasi messages[] menjadi prompt tunggal
│       ├── requestMiddleware.js # Penyelaras request & logger traffic
│       └── sse.js            # Helper standar SSE (Server-Sent Events)
├── vercel.json               # Konfigurasi serverless & routing Vercel
├── Dockerfile                # Instruksi build container standalone
├── docker-compose.yml        # Orkestrasi container
├── package.json              # Daftar modul & dependensi Node.js
└── README.md                 # Dokumentasi sistem
```

---

## 💻 Persyaratan Sistem

- **Node.js**: Versi `18.x` atau lebih tinggi (`module` type ESM).
- **RAM**: Minimal 64MB (Sangat ringan, alokasi memori rata-rata saat beroperasi hanya ~30MB - 80MB).
- **Konektivitas**: Server harus memiliki akses keluar langsung ke `https://chat.deepseek.com` tanpa diblokir oleh firewall atau geoblock.

---

## 🚀 Panduan Instalasi & Deployment

### Opsi A: Lokal / VPS (PM2)

Sangat cocok jika Anda ingin menjalankan proxy ini terus-menerus di server mandiri atau komputer lokal Anda.

#### 1. Persiapan Proyek
```bash
# Clone repository
git clone https://github.com/yourusername/deepseek-bot.git
cd deepseek-bot

# Instal dependensi
npm install
```

#### 2. Konfigurasi Environment
Salin template `.env.example` menjadi `.env` lalu sesuaikan isinya:
```bash
cp .env.example .env
```
Isi konfigurasi berikut pada file `.env`:
```env
PORT=3000
ADMIN_API_KEY=KunciAcakUntukManajemenAkunLokalAnda
LOG_LEVEL=info
```

#### 3. Tambahkan Akun DeepSeek
Buat file `accounts.txt` di root folder dan masukkan akun Anda dengan format `email:password` (satu akun per baris):
```text
akun_deepseek_satu@gmail.com:PasswordAkunSatu
akun_deepseek_dua@gmail.com:PasswordAkunDua
```

#### 4. Jalankan Server dengan PM2
Agar aplikasi tetap berjalan di background dan otomatis aktif kembali jika server restart:
```bash
# Instal PM2 secara global (jika belum ada)
npm install -g pm2

# Jalankan aplikasi
pm2 start src/index.js --name deepseek-proxy

# Simpan konfigurasi & buat startup script
pm2 save
pm2 startup
```

---

### Opsi B: Docker & Docker Compose

Jika Anda ingin menjalankan proxy ini secara terisolasi di dalam container Docker.

#### 1. Jalankan Menggunakan Docker Standalone
```bash
# Build image
docker build -t deepseek-proxy .

# Jalankan container
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/accounts.txt:/app/accounts.txt \
  -e PORT=3000 \
  -e LOG_LEVEL=info \
  --name deepseek-proxy-instance \
  deepseek-proxy
```

#### 2. Jalankan Menggunakan Docker Compose
Buat file `docker-compose.yml` di root proyek:
```yaml
version: '3.8'

services:
  deepseek-proxy:
    build: .
    container_name: deepseek-proxy
    ports:
      - "3000:3000"
    volumes:
      - ./accounts.txt:/app/accounts.txt
    environment:
      - PORT=3000
      - LOG_LEVEL=info
      - CHECK_ADMIN_ON_START=false
    restart: unless-stopped
```
Jalankan perintah:
```bash
docker-compose up -d
```

---

### Opsi C: Vercel (Free Tier)

Sangat praktis jika Anda tidak ingin menyewa VPS. Pada mode ini, **DeepSeek Bot akan otomatis berjalan dalam mode stateless (tanpa file)**. Anda tidak perlu menyertakan `accounts.txt` karena kredensial login akan dibaca langsung dari request header `Authorization: Bearer email:password` yang dikirim dari 9router/Cline.

#### 1. Persiapan GitHub
- Buat repositori baru di GitHub (bisa private).
- Commit dan push seluruh kode proyek Anda (pastikan `.env` dan `accounts.txt` tidak ikut di-commit).

#### 2. Hubungkan ke Vercel
1. Masuk ke [vercel.com](https://vercel.com).
2. Klik **Add New** > **Project** > Hubungkan akun GitHub Anda.
3. Import repositori proyek `deepseek-bot`.
4. Pada bagian **Environment Variables** (opsional), tambahkan variabel jika ingin mengubah level log:
   - `LOG_LEVEL` = `info`
5. Klik **Deploy**.
6. Server Anda kini aktif di alamat `https://nama-proyek.vercel.app`.

> ⚠️ **Catatan Batasan Vercel Free Tier**:
> - Filesystem bersifat *read-only*, sehingga endpoint manajemen `/admin/*` akan mengembalikan status `503 Service Unavailable`.
> - Batas durasi eksekusi serverless function gratis adalah **60 detik**. Response model `deepseek-reasoner` yang sangat panjang mungkin terpotong di tengah jalan.
> - Cache token disimpan di memori instans. Jika terjadi *cold-start* (instans baru dibuat), server akan melakukan login ulang secara otomatis pada request pertama (memakan waktu tambahan sekitar ~500ms).

---

## ⚙️ Konfigurasi Sistem

### File `.env` (Environment Variables)

| Variabel | Tipe | Default | Keterangan |
|----------|------|---------|------------|
| `PORT` | Number | `3000` | Port server lokal / VPS berjalan. |
| `ADMIN_API_KEY` | String | - | Token verifikasi untuk mengakses API manajemen akun `/admin/*`. |
| `LOG_LEVEL` | String | `info` | Tingkat detail log: `debug`, `info`, `warn`, `error`. |
| `CHECK_ADMIN_ON_START` | Boolean | `true` | Jika `true`, server akan memberikan peringatan jika `ADMIN_API_KEY` belum diset saat startup. |

---

## 📖 Dokumentasi API Endpoint

Semua request yang dikirimkan harus menyertakan header `Content-Type: application/json`.

### 1. Endpoint OpenAI-Compatible

#### `POST /v1/chat/completions`
Memulai sesi chat dan menghasilkan teks respons dengan metode streaming (SSE) atau non-streaming.

- **Header Opsional (Mode 9router/Stateless)**:
  `Authorization: Bearer email_akun_deepseek@gmail.com:PasswordAkunAnda`
  *(Jika tidak dikirim, proxy akan mengambil akun secara Round-Robin dari `accounts.txt` di VPS).*
- **Request Body (Contoh)**:
  ```json
  {
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": "Halo, siapa kamu?" }
    ],
    "stream": true
  }
  ```
- **Pilihan Model**:
  - `deepseek-chat` (Menggunakan antarmuka chat standar).
  - `deepseek-reasoner` (Menggunakan antarmuka chat R1 dengan menyertakan blok *thinking*).

---

#### `GET /v1/models`
Mengembalikan daftar model yang didukung oleh proxy ini. Hasil endpoint ini di-cache di tingkat CDN jika Anda menggunakan Vercel.

- **Response (Contoh)**:
  ```json
  {
    "object": "list",
    "data": [
      { "id": "deepseek-chat", "object": "model", "created": 1779530424, "owned_by": "deepseek" },
      { "id": "deepseek-reasoner", "object": "model", "created": 1779530424, "owned_by": "deepseek" }
    ]
  }
  ```

---

### 2. Endpoint Utilitas

#### `GET /health`
Digunakan untuk *ready probe* oleh 9router atau load balancer guna memantau kesehatan sistem.

- **Response (Contoh)**:
  ```json
  {
    "status": "active",
    "accounts_count": 2,
    "current_index": 0,
    "uptime": 1245.52,
    "accounts_status": [
      { "email": "akun1@gmail.com", "active": true, "errorCount": 0 },
      { "email": "akun2@gmail.com", "active": true, "errorCount": 0 }
    ]
  }
  ```

---

#### `POST /debug/request`
Mencatat dan memantau struktur request mentah yang masuk. Sangat berguna untuk menganalisis format modifikasi payload yang dikirim oleh 9router.

---

### 3. Endpoint Manajemen Akun (Lokal / VPS Only)
Semua request di bawah ini wajib menyertakan header `x-api-key: <ADMIN_API_KEY>`.

- `GET /admin/accounts`: Mengembalikan daftar seluruh akun yang terdaftar beserta status aktivitasnya.
- `POST /admin/accounts`: Menambahkan akun baru ke `accounts.txt`.
  - Body: `{"email": "baru@gmail.com", "password": "pass"}`
- `DELETE /admin/accounts/:email`: Menghapus akun tertentu dari sistem.

---

## 🛠️ Panduan Integrasi Klien

### Integrasi dengan Cline (VS Code)

Cline dapat diarahkan langsung ke proxy ini (baik lokal maupun deployment Vercel) tanpa perlu melalui 9router.

1. Buka pengaturan **Cline** di VS Code.
2. Pilih **API Provider**: `OpenAI Compatible`.
3. Masukkan **Base URL**: `http://localhost:3000/v1` (atau alamat URL Vercel Anda, akhiri dengan `/v1`).
4. Masukkan **API Key**: `email_kamu@gmail.com:password_kamu`.
5. Masukkan **Model ID**: `deepseek-chat` atau `deepseek-reasoner`.

Sekarang Cline akan berfungsi dengan lancar, menampilkan animasi berpikir (*thinking box*) saat Anda memilih `deepseek-reasoner`, dan dapat membaca serta menulis file lokal Anda secara *realtime* tanpa kendala timeout!

---

### Integrasi dengan 9router

Untuk menyebarkan beban permintaan ke beberapa akun DeepSeek secara terpusat:

1. Masuk ke dasbor **9router**.
2. Tambahkan **Custom Provider**:
   - **Name**: `DeepSeek-Bot-Proxy`
   - **Base URL**: `http://<ip-vps-anda>:3000/v1` (atau alamat URL Vercel Anda)
   - **API Key**: `email_akun@gmail.com:password_akun`
3. Aktifkan fitur **Round-Robin** di dalam dasbor 9router jika Anda mendaftarkan lebih dari satu *Custom Provider* dengan kredensial berbeda.

---

## 🔍 Penanganan Masalah (Troubleshooting)

### 1. Mengapa Cline/Roo Code Terlihat Diam (Freeze)?
- **Penyebab**: Format response dari server tidak mengalir (buffering) di proxy perantara.
- **Solusi**: Proxy ini sudah menyertakan header `X-Accel-Buffering: no` untuk bypass buffer Nginx/Cloudflare. Pastikan reverse-proxy Anda tidak memaksa kompresi gzip/brotli pada content-type `text/event-stream`.

### 2. Error: "You did not use a tool in your previous response" di Cline
- **Penyebab**: Prompt builder memodifikasi atau memberi label tambahan pada instruksi sistem milik Cline, sehingga model menghasilkan JSON biasa alih-alih tag XML `<tool_code>`.
- **Solusi**: Refactor pada file `src/util/promptBuilder.js` telah menonaktifkan pembungkusan system prompt. Perbarui kode DeepSeek Bot Anda ke versi terbaru.

### 3. Error 429 (Too Many Requests) dari DeepSeek
- **Penyebab**: Akun DeepSeek Anda sedang dibatasi oleh sistem web mereka karena aktivitas yang terlalu padat.
- **Solusi**: Tambahkan lebih banyak akun ke dalam `accounts.txt` atau dasbor 9router Anda agar distribusi beban lebih merata.

### 4. Respons Terpotong di Tengah Jalan di Vercel
- **Penyebab**: Batas timeout serverless gratis Vercel adalah 60 detik. Jawaban model `deepseek-reasoner` yang memakan waktu berpikir lama sering kali melebihi batas ini.
- **Solusi**: Gunakan model `deepseek-chat` yang lebih cepat untuk tugas-tugas penulisan kode panjang, atau deploy proxy ini di VPS menggunakan PM2/Docker agar terbebas dari limitasi timeout.

---

## 🔒 Praktik Keamanan (Security)

1. **Gunakan HTTPS**: Di lingkungan VPS produksi, selalu gunakan reverse-proxy seperti **Caddy** atau **Nginx** dengan sertifikat SSL gratis dari Let's Encrypt agar kredensial `email:password` Anda tidak dikirim dalam bentuk teks biasa (plain text) di jaringan publik.
2. **Amankan API Key Admin**: Jangan biarkan `ADMIN_API_KEY` menggunakan nilai bawaan pabrik atau kosong. Buat string acak yang panjang (minimal 32 karakter).
3. **Konfigurasi Git Ignore**: Pastikan file `.env` dan `accounts.txt` tidak secara tidak sengaja ter-commit ke dalam repositori publik.

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah [MIT License](LICENSE). Anda bebas memodifikasi, mendistribusikan, dan menggunakannya untuk kebutuhan komersial maupun personal.
