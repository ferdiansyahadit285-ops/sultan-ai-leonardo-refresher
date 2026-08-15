/**
 * Sultan AI — Leonardo Auto Refresher (VPS)
 *
 * Pengganti extension Chrome di PC: service ini jalan 24/7 di VPS, membuka
 * app.leonardo.ai dengan cookie sesi tiap akun pool memakai Chromium headless,
 * menyadap Bearer JWT asli, lalu menyimpannya kembali ke pool lewat Edge
 * Function `leonardo-refresher-sync`.
 *
 * Endpoint:
 *   GET  /health   -> status service + statistik siklus terakhir
 *   POST /run      -> jalankan siklus refresh sekarang (butuh Bearer secret)
 *
 * Env wajib:
 *   SYNC_URL          = https://<project>.supabase.co/functions/v1/leonardo-refresher-sync
 *   SUPABASE_ANON_KEY = publishable key proyek (dipakai sebagai apikey header)
 *   REFRESHER_SECRET  = nilai LEONARDO_REFRESH_SECRET di backend
 * Env opsional:
 *   CONTROL_SECRET    = secret untuk POST /run (default: REFRESHER_SECRET)
 *   CYCLE_INTERVAL_MS = jarak antar siklus (default 120000)
 *   ACCOUNT_COOLDOWN_MS = cooldown per akun setelah sukses (default 900000)
 *   PAGE_WAIT_MS      = lama menunggu halaman mencetak bearer (default 25000)
 *   MAX_PER_CYCLE     = maksimal akun diproses per siklus otomatis (default 20)
 */
const express = require("express");
// playwright di-require malas (lazy) supaya service tetap hidup & /health tetap
// menjawab walaupun browser Chromium belum tersedia di platform hosting.
let chromium = null;
function loadChromium() {
  if (!chromium) chromium = require("playwright").chromium;
  return chromium;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const SYNC_URL = (process.env.SYNC_URL || "").replace(/\/+$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const REFRESHER_SECRET = process.env.REFRESHER_SECRET || "";
const CONTROL_SECRET = process.env.CONTROL_SECRET || REFRESHER_SECRET;
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || 120000);
const ACCOUNT_COOLDOWN_MS = Number(process.env.ACCOUNT_COOLDOWN_MS || 15 * 60 * 1000);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 25000);
const MAX_PER_CYCLE = Math.max(1, Number(process.env.MAX_PER_CYCLE || 20));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/;

let browserPromise = null;
let running = false;
const cooldown = new Map(); // account_id -> timestamp boleh diproses lagi
const state = { last_cycle_at: null, last_result: [], cycles: 0, errors: 0 };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function bearerExpIso(token) {
  const d = decodeJwt(token);
  if (!d?.exp) return null;
  return new Date(d.exp * 1000).toISOString();
}

function bearerEmail(token) {
  const d = decodeJwt(token) || {};
  return String(d.email || d.auth0Email || d.preferred_username || "").toLowerCase();
}

/**
 * Hanya JWT yang benar-benar diterima backend Leonardo (Hasura) yang boleh
 * disimpan. Token session better-auth juga berbentuk JWT dan masa berlakunya
 * lebih panjang, sehingga kalau ikut dipilih provider membalas
 * "Could not verify JWT: JWSError JWSInvalidSignature".
 */
function isLeonardoApiJwt(token) {
  const d = decodeJwt(token);
  if (!d || !d.exp) return false;
  if (d["https://hasura.io/jwt/claims"]) return true;
  const iss = String(d.iss || "");
  // Token Cognito/Auth0 milik Leonardo — dipakai sebagai Authorization di API.
  if (/cognito|auth0|leonardo/i.test(iss)) return true;
  return false;
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
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* biarkan null */
  }
  if (!res.ok || json?.ok === false) {
    throw new Error(`sync ${path} gagal (${res.status}): ${json?.error || text.slice(0, 200)}`);
  }
  return json || {};
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = loadChromium().launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return b;
}

/** Ubah kolom `cookies` jsonb akun menjadi cookie Playwright untuk .leonardo.ai */
function buildCookies(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const expSec = c.cookies_exp ? Math.floor(new Date(c.cookies_exp).getTime() / 1000) : undefined;
  const pairs = [
    ["__Secure-better-auth.session_token", c.session_token],
    ["__Secure-better-auth.session_data.0", c.session_data_0],
    ["__Secure-better-auth.session_data.1", c.session_data_1],
  ];
  const cookies = [];
  for (const [name, value] of pairs) {
    if (!value) continue;
    cookies.push({
      name,
      value: String(value),
      domain: ".leonardo.ai",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      ...(expSec && expSec > Math.floor(Date.now() / 1000) ? { expires: expSec } : {}),
    });
  }
  // Dukung juga format array cookie mentah (hasil export extension lama).
  if (Array.isArray(c.raw)) {
    for (const item of c.raw) {
      if (!item?.name || !item?.value) continue;
      cookies.push({
        name: item.name,
        value: String(item.value),
        domain: item.domain || ".leonardo.ai",
        path: item.path || "/",
        httpOnly: item.httpOnly !== false,
        secure: item.secure !== false,
        sameSite: "Lax",
      });
    }
  }
  return cookies;
}

/** Buka Leonardo memakai cookie akun dan sadap bearer JWT terbaik. */
async function captureBearer(account) {
  const cookies = buildCookies(account.cookies);
  if (!cookies.length) throw new Error("akun belum punya cookie sesi (login ulang sekali via extension)");

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: account.user_agent || USER_AGENT,
    locale: "en-US",
    timezoneId: "Asia/Jakarta",
    viewport: { width: 1440, height: 900 },
  });

  const found = [];
  try {
    await context.addCookies(cookies);
    const page = await context.newPage();

    page.on("request", (req) => {
      const auth = req.headers()["authorization"];
      if (!auth) return;
      const target = req.url();
      // Abaikan header Authorization dari domain lain (analitik, dsb).
      if (!/leonardo\.ai/i.test(target)) return;
      const jwt = String(auth).replace(/^Bearer\s+/i, "").trim();
      if (JWT_RE.test(jwt) && isLeonardoApiJwt(jwt)) found.push(jwt);
    });

    await page.goto("https://app.leonardo.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });

    // Pancing panggilan API asli supaya Bearer Hasura muncul di header request.
    // Token dari /api/auth/session TIDAK dipakai: itu session better-auth dan
    // ditolak GraphQL Leonardo (JWSInvalidSignature).
    try {
      await page.evaluate(async () => {
        try { await fetch("/api/rest/getUserDetails", { credentials: "include" }); } catch {}
      });
    } catch {
      /* abaikan, andalkan sniff request */
    }

    const deadline = Date.now() + PAGE_WAIT_MS;
    while (Date.now() < deadline) {
      if (found.some((t) => bearerExpIso(t))) break;
      await page.waitForTimeout(1000);
    }

    // Pilih JWT dengan masa berlaku terpanjang.
    let best = null;
    let bestExp = 0;
    for (const t of found) {
      const iso = bearerExpIso(t);
      const ms = iso ? new Date(iso).getTime() : 0;
      if (ms > bestExp) {
        best = t;
        bestExp = ms;
      }
    }
    if (!best) throw new Error("bearer tidak tertangkap (cookie mungkin sudah mati)");
    if (bestExp < Date.now() + 60 * 1000) throw new Error("bearer yang tertangkap sudah kedaluwarsa");

    // Verifikasi pemilik: jangan menimpa akun lain kalau email tidak cocok.
    const email = bearerEmail(best);
    const expected = String(account.email || "").toLowerCase();
    if (email && expected && email !== expected) {
      throw new Error(`bearer milik ${email}, bukan ${expected}`);
    }

    // Ambil ulang cookie sesi (better-auth merotasi session_token).
    const fresh = await context.cookies("https://app.leonardo.ai/");
    const byName = new Map(fresh.map((c) => [c.name, c]));
    const pick = (...names) => names.map((n) => byName.get(n)).find(Boolean) || null;
    const tok = pick("__Secure-better-auth.session_token", "better-auth.session_token");
    const d0 = pick("__Secure-better-auth.session_data.0", "better-auth.session_data.0");
    const d1 = pick("__Secure-better-auth.session_data.1", "better-auth.session_data.1");
    const expSec = Math.max(0, ...fresh.map((c) => Number(c.expires || 0)).filter(Boolean));

    return {
      bearer_token: best,
      bearer_exp: new Date(bestExp).toISOString(),
      cookie_session_token: tok?.value || "",
      cookie_session_data_0: d0?.value || "",
      cookie_session_data_1: d1?.value || "",
      cookies_exp: expSec ? new Date(expSec * 1000).toISOString() : null,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function refreshAccount(account) {
  const captured = await captureBearer(account);
  await sync("", {
    method: "POST",
    body: JSON.stringify({
      action: "patch",
      table: "leonardo_accounts",
      id: account.id,
      patch: {
        ...captured,
        user_agent: account.user_agent || USER_AGENT,
        status: "active",
        is_active: true,
        last_error: null,
        last_refresh_at: new Date().toISOString(),
        refresh_attempts: 0,
      },
    }),
  });
  return captured.bearer_exp;
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

async function runCycle(reason = "timer", options = {}) {
  if (running) return { skipped: true, reason: "cycle sedang jalan" };
  running = true;
  const results = [];
  try {
    const requestedIds = Array.isArray(options.accountIds)
      ? [...new Set(options.accountIds.map(String))]
      : [];
    const forceSelected = options.force === true && requestedIds.length > 0;
    // POST /run adalah tindakan admin: bila versi dashboard lama belum mengirim
    // account_ids, tetap proses seluruh akun yang membutuhkan refresh tanpa
    // dipotong MAX_PER_CYCLE. Batas tersebut hanya berlaku untuk timer otomatis.
    const forceAllNeeded = reason === "manual" && !forceSelected;
    const { rows } = await sync(`?action=list&needs=${forceSelected ? "0" : "1"}`);
    const now = Date.now();
    const requested = new Set(requestedIds);
    const candidates = forceSelected ? (rows || []).filter((r) => requested.has(String(r.id))) : (rows || []);
    const queue = forceSelected || forceAllNeeded
      ? candidates
      : candidates.filter((r) => (cooldown.get(r.id) || 0) <= now).slice(0, MAX_PER_CYCLE);
    const mode = forceSelected ? "capture paksa terpilih" : forceAllNeeded ? "manual semua kandidat" : "otomatis";
    log(`siklus ${reason}: ${candidates.length} kandidat, proses ${queue.length} (${mode})`);

    // Proses beberapa akun sekaligus supaya pool besar tidak butuh puluhan menit.
    const pending = [...queue];
    const worker = async () => {
      while (pending.length) {
        const account = pending.shift();
        if (!account) return;
        const label = account.label || account.email || account.id;
        try {
          const exp = await refreshAccount(account);
          cooldown.set(account.id, Date.now() + ACCOUNT_COOLDOWN_MS);
          results.push({ id: account.id, label, status: "refreshed", expires_at: exp });
          log("✅ refresh", label, "->", exp);
        } catch (e) {
          await markFailure(account, e.message);
          cooldown.set(account.id, Date.now() + Math.min(ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000));
          results.push({ id: account.id, label, status: "failed", error: e.message });
          state.errors += 1;
          log("❌ refresh gagal", label, e.message);
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
    state.last_result = results;
  }
  return { ok: true, results };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "leonardo-auto-refresher",
    configured: !!(SYNC_URL && REFRESHER_SECRET),
    running,
    interval_ms: CYCLE_INTERVAL_MS,
    cooldown_ms: ACCOUNT_COOLDOWN_MS,
    max_per_cycle: MAX_PER_CYCLE,
    ...state,
  });
});

app.post("/run", async (req, res) => {
  if (CONTROL_SECRET) {
    const header = req.headers.authorization || "";
    if (header !== `Bearer ${CONTROL_SECRET}`) return res.status(401).json({ error: "unauthorized" });
  }
  const accountIds = Array.isArray(req.body?.account_ids) ? req.body.account_ids : [];
  const out = await runCycle("manual", {
    force: req.body?.force === true,
    accountIds,
  });
  res.json(out);
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Leonardo Auto Refresher listening on :${PORT}`);
  if (!SYNC_URL || !REFRESHER_SECRET) {
    log("⚠️  SYNC_URL / REFRESHER_SECRET belum diisi — siklus otomatis tidak dijalankan");
    return;
  }
  runCycle("boot").catch((e) => log("boot cycle error", e.message));
  setInterval(() => {
    runCycle("timer").catch((e) => log("timer cycle error", e.message));
  }, CYCLE_INTERVAL_MS);
});