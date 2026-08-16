# Panduan Upload Manual ke GitHub (Auto Refresh Leonardo)

Repo ini hanya butuh **6 file kecil** (total ~16 KB). Tidak ada file besar,
jadi pasti diterima GitHub.

## File yang diupload
```
Dockerfile
package.json
render.yaml
server.js
.env.example        (opsional)
README.md           (opsional)
```
JANGAN upload `node_modules`, `.env`, atau file `.exe`.

## Cara 1 — Lewat web GitHub (tanpa terminal)
1. Buka https://github.com/new
   - Repository name: `sultan-leonardo-refresher`
   - Pilih **Private** → Create repository
2. Di halaman repo baru, klik **creating a new file**.
3. Ketik nama file (misal `Dockerfile`), paste isinya, klik **Commit changes**.
4. Ulangi: klik **Add file → Create new file** untuk `package.json`,
   `render.yaml`, lalu `server.js`.
5. Selesai. Repo siap dipakai Render.

Isi tiap file bisa dicopy dari **Code Editor** Lovable di folder
`vps-leonardo-refresher/` (klik file → Ctrl+A → Ctrl+C).

## Cara 2 — Lewat terminal komputer
```sh
mkdir sultan-leonardo-refresher && cd sultan-leonardo-refresher
# buat 4 file di atas, lalu:
git init
git add .
git commit -m "leonardo auto refresher"
git branch -M main
git remote add origin https://github.com/<username>/sultan-leonardo-refresher.git
git push -u origin main
```

## Setelah repo jadi — deploy di Render
1. Render → **New +** → **Web Service** → Build and deploy from a Git repository
2. Pilih repo `sultan-leonardo-refresher`
3. Setting:
   - Root Directory: **(kosongkan)**
   - Language / Runtime: **Docker**
   - Instance Type: **Starter ($7/mo)** — jangan Free (tidur 15 menit)
   - Health Check Path: `/health`
4. Environment Variables:
   | Key | Value |
   |---|---|
   | `SYNC_URL` | `https://xhkpbgeyhgjooosmcjwo.supabase.co/functions/v1/leonardo-refresher-sync` |
   | `SUPABASE_ANON_KEY` | `sb_publishable_gggjLlNsMHluX6ZkAhZTKQ_zVj8-l1-` |
   | `REFRESHER_SECRET` | sama dengan `LEONARDO_REFRESH_SECRET` di backend |
   | `CYCLE_INTERVAL_MS` | `120000` |
   | `ACCOUNT_COOLDOWN_MS` | `900000` |
   | `MAX_PER_CYCLE` | `20` |
   | `CONCURRENCY` | `3` |
5. Create Web Service → tunggu build (5–8 menit, image Playwright besar).
6. Cek `https://<nama-service>.onrender.com/health` → harus `{"ok":true}`.

Catatan: cookie awal tiap akun Leonardo tetap harus di-capture sekali lewat
extension. Setelah itu VPS yang memperpanjang token 24/7.
