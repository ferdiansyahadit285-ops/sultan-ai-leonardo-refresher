# Sultan AI Leonardo Auto Refresher (Render)

Upload 4 file ini ke repo GitHub baru (private): `Dockerfile`, `package.json`, `render.yaml`, `server.js`.
Jangan upload `node_modules` atau `.env`.

## Deploy di Render
- New + -> Web Service -> pilih repo
- Root Directory: (kosong)
- Runtime: Docker
- Plan: Starter ($7/mo) — jangan Free (tidur 15 menit)
- Health Check Path: `/health`

## Environment Variables
| Key | Value |
|---|---|
| SYNC_URL | https://xhkpbgeyhgjooosmcjwo.supabase.co/functions/v1/leonardo-refresher-sync |
| SUPABASE_ANON_KEY | sb_publishable_gggjLlNsMHluX6ZkAhZTKQ_zVj8-l1- |
| REFRESHER_SECRET | sama dengan LEONARDO_REFRESH_SECRET di backend |
| CYCLE_INTERVAL_MS | 120000 |
| ACCOUNT_COOLDOWN_MS | 900000 |
| MAX_PER_CYCLE | 4 |

Cek `https://<nama-service>.onrender.com/health` -> harus `{"ok":true}`.
