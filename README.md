# Sultan AI — Leonardo Auto Refresher (VPS)

Pengganti extension Chrome di PC. Service ini jalan 24/7 di VPS/Render/Railway,
membuka app.leonardo.ai dengan cookie sesi tiap akun pool (Chromium headless),
menyadap Bearer JWT asli, lalu menyimpannya kembali ke pool lewat Edge Function
`leonardo-refresher-sync`. Jadi PC tidak perlu hidup terus.

## Deploy

1. Service baru bertipe Docker, root directory `vps-leonardo-refresher`
   (Render: sudah ada `render.yaml`). Di VPS sendiri:

   ```bash
   cd vps-leonardo-refresher
   docker build -t sultan-leo-refresher .
   docker run -d --restart=always -p 8090:8080 --env-file .env sultan-leo-refresher
   ```

2. Isi environment variables (lihat `.env.example`):
   - `SYNC_URL` = URL Edge Function `leonardo-refresher-sync`
   - `SUPABASE_ANON_KEY` = publishable key proyek
   - `REFRESHER_SECRET` = nilai `LEONARDO_REFRESH_SECRET` di backend
3. Cek `GET /health` sampai `configured: true` dan `last_cycle_at` terisi.

## Endpoint

- `GET /health` — status + hasil siklus terakhir (tanpa auth)
- `POST /run` — jalankan siklus sekarang, header `Authorization: Bearer <CONTROL_SECRET>`

## Cara kerja

1. Tiap `CYCLE_INTERVAL_MS` (default 2 menit) service memanggil
   `?action=list&needs=1`: akun berstatus needs_refresh/expired/error atau
   token kedaluwarsa < 10 menit.
2. Maksimal `MAX_PER_CYCLE` akun per siklus, tiap akun punya cooldown
   `ACCOUNT_COOLDOWN_MS` supaya polanya tidak mencurigakan.
3. Bearer diverifikasi: JWT valid, belum kedaluwarsa, dan email di dalam JWT
   sama dengan email akun — mencegah token salah sasaran.
4. Cookie sesi hasil rotasi disimpan ulang; token disebar ke duplikat pool oleh
   Edge Function.

## Catatan

- Cookie sesi awal tetap perlu sekali diambil dari browser login (extension
  Auto Refresher). Setelah cookie tersimpan di pool, service ini yang meneruskan.
- Layer kedua tetap aktif: cron `leonardo-refresh` tiap 10 menit mencoba refresh
  Cognito tanpa browser.
- Kalau cookie akun benar-benar mati (logout paksa), akun ditandai
  `needs_refresh` dengan `last_error` jelas sehingga perlu login ulang sekali.
