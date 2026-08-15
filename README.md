# Sultan AI — Leonardo Auto Refresher (VPS/Railway) v4

Service 24/7 yang menjaga bearer JWT semua akun pool Leonardo tetap hidup tanpa
PC user. Membuka `app.leonardo.ai` dengan cookie sesi tiap akun memakai Chromium
stealth + proxy residensial sticky, menyadap Bearer asli, lalu menyimpannya lewat
Edge Function `leonardo-refresher-sync`.

## Yang diperbaiki di v4

| Masalah lama | Perbaikan v4 |
|---|---|
| Selalu kena "Vercel Security Checkpoint" → `bearer tidak tertangkap` | `playwright-extra` + plugin stealth, script/CSS/WASM tidak diblokir, tunggu challenge sampai 75 s |
| Semua akun keluar dari 1 IP datacenter Railway | Proxy residensial **sticky per akun** dari pool `proxy_credentials`; percobaan ulang otomatis ganti IP |
| Push ulang dari dashboard timeout 150 s | `POST /run` balas **202 seketika**, kerja di latar belakang |
| Push manual 0 sukses 0 gagal | Antrian manual prioritas, tanpa cooldown & tanpa `MAX_PER_CYCLE` |
| Chromium reuse → OOM "Page crashed" | 1 browser per akun, ditutup rapi tiap selesai |
| Cookie lama disimpan tanpa atribut | Menyimpan `raw_cookies` lengkap (host-only benar) |

## Deploy (Railway lewat GitHub)

1. Upload isi folder `vps-leonardo-refresher/` ke repo GitHub (ganti file lama).
2. Railway → service Docker, root directory `vps-leonardo-refresher`.
3. Environment variables (lihat `.env.example`):
   - `SYNC_URL` = URL Edge Function `leonardo-refresher-sync`
   - `SUPABASE_ANON_KEY` = publishable key proyek
   - `REFRESHER_SECRET` = nilai `LEONARDO_REFRESH_SECRET`
   - opsional: `CONCURRENCY=2`, `USE_PROXY=1`
4. Tunggu deploy, buka `GET /health` sampai `configured: true`.

VPS sendiri:

```bash
cd vps-leonardo-refresher
docker build -t sultan-leo-refresher .
docker run -d --restart=always -p 8090:8080 --env-file .env sultan-leo-refresher
```

## Endpoint

- `GET /health` — status, `refreshed_total`, hasil siklus terakhir (tanpa auth)
- `POST /run` — `{ account_ids?: string[], force?: boolean }`, header
  `Authorization: Bearer <REFRESHER_SECRET>`; balas 202 lalu kerja di background

## Cara kerja

1. Tiap `CYCLE_INTERVAL_MS` (2 menit) memanggil `?action=list&needs=1`: akun
   `needs_refresh`/`expired`/`error` atau token kedaluwarsa < 10 menit.
2. Prioritas: akun rusak lebih dulu, lalu token paling cepat mati.
3. Tiap akun: ambil proxy sticky (`?action=proxy_pick`), buka Leonardo dengan
   cookie sesi, lewati checkpoint, sadap Bearer dari header CDP.
4. Bearer diverifikasi: JWT Hasura/Cognito, belum kedaluwarsa, email cocok.
5. Cookie hasil rotasi disimpan ulang (termasuk `raw_cookies`); token disebar ke
   duplikat pool oleh Edge Function.

## Catatan

- Cookie sesi awal tetap perlu diambil sekali dari browser login (extension
  capture). Sesudah tersimpan, service ini yang meneruskan selamanya.
- Akun login lewat **Canva/Google (federated)** tidak punya `refresh_token`,
  jadi cron `leonardo-refresh` (Cognito) tidak bisa menolong — hanya service ini.
- Kalau satu akun tetap gagal dengan pesan `security checkpoint tidak selesai`,
  proxy-nya sedang diblokir; percobaan berikutnya otomatis memakai IP lain.
