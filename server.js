/**
 * Sultan AI — Leonardo Auto Refresher (VPS / Railway) — REBUILD v4
 *
 * Tugas: menjaga bearer JWT semua akun pool Leonardo tetap hidup tanpa PC user.
 *
 * Perbedaan utama dari versi lama (penyebab "0 sukses"):
 *   1. Stealth penuh (playwright-extra + plugin stealth) supaya "Vercel Security
 *      Checkpoint" mau dijalankan dan lolos, bukan langsung 429.
 *   2. Tiap akun keluar lewat proxy residensial sticky (dari pool
 *      proxy_credentials) — bukan lagi 1 IP datacenter Railway untuk semua akun.
 *   3. POST /run membalas 202 seketika lalu bekerja di latar belakang, jadi
 *      edge function tidak pernah kena IDLE_TIMEOUT 150 s.
 *   4. Antrian tunggal + prioritas: push manual selalu di depan akun mati.
 *
 * Endpoint:
 *   GET  /health -> status + hasil siklus terakhir (tanpa auth)
 *   POST /run    -> { account_ids?: string[], force?: boolean }  (Bearer secret)
 *
 * Env wajib : SYNC_URL, SUPABASE_ANON_KEY, REFRESHER_SECRET
 * Env opsional: CONTROL_SECRET, CYCLE_INTERVAL_MS, ACCOUNT_COOLDOWN_MS,
 *   FAIL_COOLDOWN_MS, PAGE_WAIT_MS, MAX_PER_CYCLE, CONCURRENCY,
 *   ACCOUNT_RETRIES, BOOT_DELAY_MS, USE_PROXY, USER_AGENT
 */
const express = require("express");

// ---------------------------------------------------------------- konfigurasi
const PORT = process.env.PORT || 8080;
const SYNC_URL = (process.env.SYNC_URL || "").replace(/\/+$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const REFRESHER_SECRET = process.env.REFRESHER_SECRET || "";
const CONTROL_SECRET = process.env.CONTROL_SECRET || REFRESHER_SECRET;
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || 120000);
const ACCOUNT_COOLDOWN_MS = Number(process.env.ACCOUNT_COOLDOWN_MS || 15 * 60 * 1000);
const FAIL_COOLDOWN_MS = Number(process.env.FAIL_COOLDOWN_MS || 60 * 1000);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 30000);
const CHECKPOINT_WAIT_MS = Number(process.env.CHECKPOINT_WAIT_MS || 75000);
const MAX_PER_CYCLE = Math.max(1, Number(process.env.MAX_PER_CYCLE || 20));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const ACCOUNT_RETRIES = Math.max(1, Number(process.env.ACCOUNT_RETRIES || 3));
const BOOT_DELAY_MS = Math.max(5000, Number(process.env.BOOT_DELAY_MS || 15000));
const USE_PROXY = process.env.USE_PROXY !== "0";
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/;
const COOKIE_NAMES = {
  session: "__Secure-better-auth.session_token",
  data0: "__Secure-better-auth.session_data.0",
  data1: "__Secure-better-auth.session_data.1",
};

// ------------------------------------------------------- chromium + stealth
// playwright-extra dimuat malas supaya /health tetap menjawab walau paket
// browser belum siap di platform hosting.
let chromiumStealth = null;
function loadChromium() {
  if (chromiumStealth) return chromiumStealth;
  const { chromium } = require("playwright-extra");
  try {
    const stealth = require("puppeteer-extra-plugin-stealth")();
    // Plugin ini menulis banyak evasion; beberapa hanya relevan di puppeteer.
    stealth.enabledEvasions.delete("user-agent-override");
    chromium.use(stealth);
  } catch (e) {
    log("⚠️  plugin stealth tidak dimuat:", e.message);
  }
  chromiumStealth = chromium;
  return chromiumStealth;
}

// ------------------------------------------------------------------- state
const app = express();
app.use(express.json({ limit: "1mb" }));

let running = false;
const cooldown = new Map(); // account_id -> boleh diproses lagi (ms epoch)
const manualQueue = []; // account id yang diminta admin (prioritas)
let manualForce = false;
const state = {
  version: "4.0.0",
  last_cycle_at: null,
  last_reason: null,
  last_result: [],
  cycles: 0,
  errors: 0,
  refreshed_total: 0,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------------------ helpers
function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function bearerExpMs(token) {
  const d = decodeJwt(token);
  return d?.exp ? d.exp * 1000 : 0;
}

function bearerEmail(token) {
  const d = decodeJwt(token) || {};
  return String(d.email || d.auth0Email || d.preferred_username || "").toLowerCase();
}

/**
 * Hanya JWT yang diterima backend Leonardo (Hasura/Cognito) yang boleh disimpan.
 * Token session better-auth juga berbentuk JWT tapi ditolak GraphQL Leonardo
 * dengan "JWSError JWSInvalidSignature".
 */
function isLeonardoApiJwt(token) {
  const d = decodeJwt(token);
  if (!d || !d.exp) return false;
  if (d["https://hasura.io/jwt/claims"]) return true;
  return /cognito|auth0|leonardo/i.test(String(d.iss || ""));
}

async function sync(path, init = {}) {
  if (!SYNC_URL) throw new Error("SYNC_URL belum diisi");
  const res = await fetch(`${SYNC_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-refresher-secret": REFRESHER_SECRET,
      ...(ANON_KEY ? { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* biarkan null */
  }
  if (!res.ok || json?.ok === false) {
    throw new Error(`sync ${path || "/"} gagal (${res.status}): ${json?.error || text.slice(0, 200)}`);
  }
  return json || {};
}

const proxyCache = new Map(); // account_id -> { proxy, at }
const PROXY_TTL_MS = 30 * 60 * 1000;

/** Proxy residensial sticky per akun. null = keluar lewat IP VPS. */
async function pickProxy(accountId, attempt) {
  if (!USE_PROXY) return null;
  const cached = proxyCache.get(accountId);
  // Percobaan kedua/ketiga sengaja mengambil proxy baru (IP lama mungkin diblok).
  if (cached && attempt === 1 && Date.now() - cached.at < PROXY_TTL_MS) return cached.proxy;
  try {
    const salt = attempt > 1 ? `${accountId}-r${attempt}` : accountId;
    const { proxy } = await sync(`?action=proxy_pick&account_id=${encodeURIComponent(salt)}`);
    if (!proxy?.host || !proxy?.port) return null;
    const server = `${proxy.protocol || "http"}://${proxy.host}:${proxy.port}`;
    const out = {
      server,
      label: proxy.label || proxy.host,
      ...(proxy.username ? { username: proxy.username, password: proxy.password || "" } : {}),
    };
    proxyCache.set(accountId, { proxy: out, at: Date.now() });
    return out;
  } catch (e) {
    log("⚠️  gagal mengambil proxy, lanjut tanpa proxy:", e.message);
    return null;
  }
}

/** Kolom `cookies` jsonb akun -> cookie Playwright. */
function buildCookies(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = c.cookies_exp ? Math.floor(new Date(c.cookies_exp).getTime() / 1000) : 0;
  const cookies = [];

  // Sumber utama: cookie mentah lengkap dengan atributnya (capture v1.0.8+).
  if (Array.isArray(c.raw)) {
    for (const item of c.raw) {
      if (!item?.name || !item?.value) continue;
      const ss = String(item.sameSite || "Lax").toLowerCase();
      const expiration = Number(item.expirationDate || item.expires || 0);
      const hostOnly = item.hostOnly === true || !String(item.domain || "").startsWith(".");
      cookies.push({
        name: item.name,
        value: String(item.value),
        // hostOnly harus ditulis via url, bukan domain berawalan titik.
        ...(hostOnly
          ? { url: "https://app.leonardo.ai/" }
          : { domain: item.domain, path: item.path || "/" }),
        ...(hostOnly ? {} : {}),
        httpOnly: Boolean(item.httpOnly),
        secure: item.secure !== false,
        sameSite: ss === "none" ? "None" : ss === "strict" ? "Strict" : "Lax",
        ...(expiration > nowSec ? { expires: expiration } : {}),
      });
    }
  }

  // Fallback akun format lama: 3 token tanpa atribut → tulis host-only.
  if (!cookies.length) {
    const pairs = [
      [COOKIE_NAMES.session, c.session_token],
      [COOKIE_NAMES.data0, c.session_data_0],
      [COOKIE_NAMES.data1, c.session_data_1],
    ];
    for (const [name, value] of pairs) {
      if (!value) continue;
      cookies.push({
        name,
        value: String(value),
        url: "https://app.leonardo.ai/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        ...(expSec > nowSec ? { expires: expSec } : {}),
      });
    }
  }
  return cookies;
}

/** Tunggu "Vercel Security Checkpoint" selesai (proof-of-work WASM). */
async function passCheckpoint(page) {
  const deadline = Date.now() + CHECKPOINT_WAIT_MS;
  let sawCheckpoint = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("halaman tertutup saat melewati security checkpoint");
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    if (/security checkpoint|just a moment|attention required/i.test(title)) {
      sawCheckpoint = true;
      await page.waitForTimeout(2500);
      continue;
    }
    if (title) return sawCheckpoint;
    await page.waitForTimeout(1500);
  }
  throw new Error("security checkpoint tidak selesai dalam batas waktu (IP kemungkinan diblokir)");
}

// -------------------------------------------------------------- capture inti
async function captureBearer(account, attempt) {
  const cookies = buildCookies(account.cookies);
  if (!cookies.length) {
    throw new Error("akun belum punya cookie sesi — perlu capture sekali lewat extension");
  }

  const proxy = await pickProxy(String(account.id), attempt);
  const chromium = loadChromium();
  const browser = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--js-flags=--max-old-space-size=512",
    ],
  });

  const found = [];
  try {
    const context = await browser.newContext({
      userAgent: account.user_agent || USER_AGENT,
      locale: "en-US",
      timezoneId: "Asia/Jakarta",
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    // CDP menangkap header paling mentah — lebih andal daripada event request
    // Playwright ketika Authorization ditambahkan sesudah redirect checkpoint.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const scan = (headers) => {
      const auth = headers?.Authorization || headers?.authorization;
      if (!auth) return;
      const jwt = String(auth).replace(/^Bearer\s+/i, "").trim();
      if (JWT_RE.test(jwt) && isLeonardoApiJwt(jwt)) found.push(jwt);
    };
    cdp.on("Network.requestWillBeSent", (ev) => {
      if (!/leonardo\.ai/i.test(String(ev?.request?.url || ""))) return;
      scan(ev?.request?.headers);
    });

    // Hemat RAM tapi JANGAN blokir script/wasm/css: checkpoint membutuhkannya.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto("https://app.leonardo.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await passCheckpoint(page);

    // Pancing panggilan API asli agar Bearer Hasura muncul di header.
    try {
      await page.evaluate(async () => {
        const paths = ["/api/rest/getUserDetails", "/api/auth/get-session", "/api/rest/me"];
        await Promise.allSettled(paths.map((p) => fetch(p, { credentials: "include" })));
      });
    } catch {
      /* andalkan sniff request */
    }

    const deadline = Date.now() + PAGE_WAIT_MS;
    while (Date.now() < deadline) {
      if (found.length) break;
      if (page.isClosed()) throw new Error("halaman tertutup sebelum bearer tertangkap");
      await page.waitForTimeout(1000);
    }

    // Pilih JWT dengan masa berlaku terpanjang.
    let best = null;
    let bestExp = 0;
    for (const t of found) {
      const ms = bearerExpMs(t);
      if (ms > bestExp) {
        best = t;
        bestExp = ms;
      }
    }
    if (!best) {
      let diag = "";
      try {
        diag = ` url=${page.url()} title=${(await page.title()).slice(0, 60)}`;
      } catch {
        /* halaman hilang */
      }
      throw new Error(
        `bearer tidak tertangkap (proxy=${proxy?.label || "langsung"})${diag} — cookie mungkin sudah mati`,
      );
    }
    if (bestExp < Date.now() + 60_000) throw new Error("bearer yang tertangkap sudah kedaluwarsa");

    // Verifikasi pemilik supaya token tidak salah sasaran.
    const email = bearerEmail(best);
    const expected = String(account.email || "").toLowerCase();
    if (email && expected && email !== expected) {
      throw new Error(`bearer milik ${email}, bukan ${expected}`);
    }

    // Ambil ulang cookie (better-auth merotasi session_token) + simpan mentah.
    const fresh = await context.cookies("https://app.leonardo.ai/");
    const byName = new Map(fresh.map((c) => [c.name, c]));
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = Math.max(0, ...fresh.map((c) => Number(c.expires || 0)).filter((n) => n > nowSec));

    return {
      bearer_token: best,
      bearer_exp: new Date(bestExp).toISOString(),
      cookie_session_token: byName.get(COOKIE_NAMES.session)?.value || "",
      cookie_session_data_0: byName.get(COOKIE_NAMES.data0)?.value || "",
      cookie_session_data_1: byName.get(COOKIE_NAMES.data1)?.value || "",
      cookies_exp: expSec ? new Date(expSec * 1000).toISOString() : null,
      raw_cookies: fresh
        .filter((c) => c.name.includes("better-auth"))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          hostOnly: !String(c.domain || "").startsWith("."),
          expirationDate: c.expires,
        })),
      proxy_label: proxy?.label || null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function refreshAccount(account) {
  let captured = null;
  let lastError = null;
  for (let attempt = 1; attempt <= ACCOUNT_RETRIES; attempt++) {
    try {
      captured = await captureBearer(account, attempt);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (attempt === ACCOUNT_RETRIES) break;
      log(
        `↻ percobaan ${attempt}/${ACCOUNT_RETRIES}`,
        account.label || account.email || account.id,
        String(e?.message || e).slice(0, 140),
      );
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
  if (!captured) throw lastError || new Error("capture gagal tanpa detail");

  const { proxy_label, ...patch } = captured;
  await sync("", {
    method: "POST",
    body: JSON.stringify({
      action: "patch",
      table: "leonardo_accounts",
      id: account.id,
      patch: {
        ...patch,
        user_agent: account.user_agent || USER_AGENT,
        status: "active",
        is_active: true,
        last_error: null,
        last_refresh_at: new Date().toISOString(),
        refresh_attempts: 0,
      },
    }),
  });
  return { exp: captured.bearer_exp, proxy: proxy_label };
}

async function markFailure(account, message) {
  try {
    await sync("", {
      method: "POST",
      body: JSON.stringify({
        action: "patch",
        table: "leonardo_accounts",
        id: account.id,
        patch: {
          last_error: String(message).slice(0, 500),
          refresh_attempts: (account.refresh_attempts || 0) + 1,
          status: "needs_refresh",
        },
      }),
    });
  } catch (e) {
    log("gagal menandai error", account.id, e.message);
  }
}

// ------------------------------------------------------------------ siklus
function priority(r) {
  const st = String(r.status || "").toLowerCase();
  const broken = r.is_active === false || ["needs_refresh", "expired", "error", "invalid"].includes(st);
  return broken ? 0 : 1;
}

async function runCycle(reason = "timer") {
  if (running) return { ok: false, skipped: true, reason: "siklus lain masih berjalan" };
  running = true;
  const results = [];
  try {
    const requestedIds = [...new Set(manualQueue.splice(0, manualQueue.length).map(String))];
    const force = manualForce && requestedIds.length > 0;
    manualForce = false;

    const { rows } = await sync(`?action=list&needs=${force ? "0" : "1"}`);
    const all = rows || [];
    const requested = new Set(requestedIds);
    const candidates = requestedIds.length ? all.filter((r) => requested.has(String(r.id))) : all;

    const now = Date.now();
    const sorted = [...candidates].sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (a.expires_at ? new Date(a.expires_at).getTime() : 0) -
          (b.expires_at ? new Date(b.expires_at).getTime() : 0),
    );
    const queue = requestedIds.length
      ? sorted // push manual: tanpa cooldown & tanpa batas
      : sorted.filter((r) => (cooldown.get(r.id) || 0) <= now).slice(0, MAX_PER_CYCLE);

    log(
      `siklus ${reason}: ${candidates.length} kandidat → proses ${queue.length}` +
        `${requestedIds.length ? " (push manual)" : ""}`,
    );

    const pending = [...queue];
    const worker = async () => {
      while (pending.length) {
        const account = pending.shift();
        if (!account) return;
        const label = account.label || account.email || account.id;
        try {
          const { exp, proxy } = await refreshAccount(account);
          cooldown.set(account.id, Date.now() + ACCOUNT_COOLDOWN_MS);
          state.refreshed_total += 1;
          results.push({ id: account.id, label, status: "refreshed", expires_at: exp, proxy });
          log("✅", label, "->", exp, proxy ? `via ${proxy}` : "");
        } catch (e) {
          await markFailure(account, e.message);
          cooldown.set(account.id, Date.now() + FAIL_COOLDOWN_MS);
          results.push({ id: account.id, label, status: "failed", error: e.message });
          state.errors += 1;
          log("❌", label, e.message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, () => worker()),
    );
  } catch (e) {
    state.errors += 1;
    log("siklus gagal", e.message);
    results.push({ status: "cycle_error", error: e.message });
  } finally {
    running = false;
    state.cycles += 1;
    state.last_cycle_at = new Date().toISOString();
    state.last_reason = reason;
    state.last_result = results;
  }
  const refreshed = results.filter((r) => r.status === "refreshed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  log(`siklus ${reason} selesai: ${refreshed} sukses, ${failed} gagal`);
  return { ok: true, refreshed, failed, results };
}

/** Jalankan siklus di latar belakang; pemanggil tidak menunggu. */
function kickCycle(reason) {
  setImmediate(() => {
    runCycle(reason).catch((e) => log(`${reason} cycle error`, e.message));
  });
}

// --------------------------------------------------------------- endpoints
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "leonardo-auto-refresher",
    configured: !!(SYNC_URL && REFRESHER_SECRET),
    running,
    queued_manual: manualQueue.length,
    use_proxy: USE_PROXY,
    interval_ms: CYCLE_INTERVAL_MS,
    concurrency: CONCURRENCY,
    max_per_cycle: MAX_PER_CYCLE,
    ...state,
  });
});

app.post("/run", (req, res) => {
  if (CONTROL_SECRET && (req.headers.authorization || "") !== `Bearer ${CONTROL_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const ids = Array.isArray(req.body?.account_ids) ? req.body.account_ids.map(String) : [];
  for (const id of ids) if (!manualQueue.includes(id)) manualQueue.push(id);
  if (req.body?.force === true) manualForce = true;

  // Balas segera: proses bisa memakan menit-an, edge function tidak boleh menunggu.
  res.status(202).json({
    ok: true,
    accepted: true,
    queued: ids.length,
    running,
    note: "Perintah diterima. Refresh berjalan di latar belakang — cek /health atau pool 1–3 menit lagi.",
  });

  if (!running) kickCycle("manual");
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Leonardo Auto Refresher v${state.version} listening on :${PORT}`);
  if (!SYNC_URL || !REFRESHER_SECRET) {
    log("⚠️  SYNC_URL / REFRESHER_SECRET belum diisi — siklus otomatis tidak dijalankan");
    return;
  }
  // Beri Railway kesempatan lulus healthcheck sebelum Chromium memakai RAM.
  setTimeout(() => kickCycle("boot"), BOOT_DELAY_MS);
  setInterval(() => {
    if (!running) kickCycle("timer");
  }, CYCLE_INTERVAL_MS);
});
