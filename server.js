import express from "express";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import RecaptchaPlugin from "puppeteer-extra-plugin-recaptcha";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

chromium.use(stealthPlugin());
chromium.use(
  RecaptchaPlugin({
    provider: { id: "2captcha", token: process.env.TWOCAPTCHA_TOKEN || "" },
    throwOnError: false,
  })
);

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "";
const PORT = process.env.PORT || 3000;
const CONCURRENCY = Math.max(1, Math.min(3, parseInt(process.env.CONCURRENCY || "1", 10)));
const HEADLESS = process.env.HEADLESS !== "false";
const MAX_PER_CYCLE = parseInt(process.env.MAX_PER_CYCLE || "30", 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "60000", 10);
const FUNCTION_COOLDOWN_MS = parseInt(process.env.FUNCTION_COOLDOWN_MS || "30000", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

let browser = null;
let context = null;
let isBusy = false;
let lastRunAt = 0;
let queue = [];

async function getBrowser() {
  if (browser && context) {
    try {
      const pages = await context.pages();
      if (pages.length > 0) return { browser, context };
    } catch (e) {
      console.log("[browser] context rusak, reset");
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--js-flags=--max-old-space-size=512",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    bypassCSP: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
  return { browser, context };
}

async function resetBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  browser = null;
  context = null;
}

function signPayload(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", REFRESH_SECRET).update(body).digest("hex");
  return { body, sig };
}

async function pushToSupabase(payload) {
  const { body, sig } = signPayload(payload);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/leonardo-refresher-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-refresh-signature": sig,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sync ${res.status}: ${text}`);
  return JSON.parse(text || "{}");
}

async function fetchAccounts(status = "needs_refresh", limit = MAX_PER_CYCLE) {
  const { data, error } = await supabase
    .from("leonardo_accounts")
    .select("*")
    .eq("status", status)
    .order("last_refreshed_at", { nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function fetchAllProblemAccounts(limit = MAX_PER_CYCLE) {
  const { data, error } = await supabase
    .from("leonardo_accounts")
    .select("*")
    .in("status", ["needs_refresh", "expired", "error"])
    .order("last_refreshed_at", { nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function setAccountStatus(id, status, details = {}) {
  const update = {
    status,
    last_refreshed_at: new Date().toISOString(),
    refresh_error: details.error || null,
    refresh_details: details,
  };
  const { error } = await supabase.from("leonardo_accounts").update(update).eq("id", id);
  if (error) console.error("[setAccountStatus]", error);
}

function buildCookies(account) {
  const raw = account.raw_cookies || account.raw || {};
  const fallback = account.cookies || {};
  const out = [];
  const names = new Set([...Object.keys(raw), ...Object.keys(fallback)]);
  for (const name of names) {
    const r = raw[name] || {};
    const f = fallback[name] || {};
    const value = r.value ?? f.value ?? f;
    if (value === undefined || value === null || value === "") continue;
    out.push({
      name,
      value: String(value),
      domain: r.domain ?? ".leonardo.ai",
      path: r.path ?? "/",
      expires: r.expires ?? -1,
      httpOnly: r.httpOnly ?? false,
      secure: r.secure ?? true,
      sameSite: r.sameSite ?? "Lax",
    });
  }
  return out;
}

async function captureBearer(page, account, attempt = 1) {
  const url = "https://app.leonardo.ai/";
  console.log(`[capture] ${account.email} membuka ${url} (attempt ${attempt})`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

  // Tunggu checkpoint Vercel selesai (maks 60 detik)
  for (let i = 0; i < 30; i++) {
    const currentUrl = page.url();
    const title = await page.title().catch(() => "");
    const body = await page.content().catch(() => "");
    if (
      currentUrl.includes("app.leonardo.ai") &&
      !body.includes("Vercel Security Checkpoint") &&
      !body.includes("Just a moment") &&
      !title.includes("Security")
    ) {
      break;
    }
    console.log(`[capture] ${account.email} menunggu checkpoint... (${i + 1}/30)`);
    await sleep(2000);
  }

  // Scroll & tunggu API call
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
  await sleep(3000);

  let bearer = null;
  for (let i = 0; i < 40; i++) {
    const entries = await page.evaluate(() => {
      try {
        return performance.getEntriesByType("resource")
          .filter((r) => r.name.includes("api/"))
          .map((r) => r.name);
      } catch {
        return [];
      }
    });
    for (const name of entries) {
      const found = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, { credentials: "include" });
          const token = res.headers.get("authorization") || "";
          return token.startsWith("Bearer ") ? token.replace("Bearer ", "") : null;
        } catch {
          return null;
        }
      }, name);
      if (found) {
        bearer = found;
        break;
      }
    }
    if (bearer) break;
    const cookies = await page.context().cookies(["https://app.leonardo.ai"]);
    const authCookie = cookies.find((c) => c.name === "__auth__token" || c.name === "authToken");
    if (authCookie?.value?.startsWith("Bearer ")) {
      bearer = authCookie.value.replace("Bearer ", "");
      break;
    }
    await sleep(1500);
  }
  if (!bearer) throw new Error("bearer tidak tertangkap (checkpoint atau cookie mati)");
  return bearer;
}

async function refreshAccount(account, { force = false } = {}) {
  const { context } = await getBrowser();
  const cookies = buildCookies(account);
  const page = await context.newPage();
  try {
    await page.context().addCookies(cookies);
    const bearer = await captureBearer(page, account, force ? 2 : 1);

    // Ambil info user dasar
    let userId = account.user_id || null;
    let username = account.username || null;
    try {
      const res = await page.evaluate(async (token) => {
        const r = await fetch("https://api.leonardo.ai/v1/me", {
          headers: { authorization: `Bearer ${token}` },
        });
        return r.json();
      }, bearer);
      userId = res?.id || userId;
      username = res?.username || username;
    } catch (e) {
      console.log("[me] gagal ambil info user:", e.message);
    }

    await pushToSupabase({
      email: account.email,
      user_id: userId,
      username,
      bearer_token: bearer,
      cookies: cookies.reduce((acc, c) => {
        acc[c.name] = { value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite };
        return acc;
      }, {}),
      raw_cookies: cookies,
      status: "active",
      pool: account.pool || null,
      force,
    });

    await setAccountStatus(account.id, "active", { ok: true, refreshed_at: now() });
    console.log(`[refresh] ✅ ${account.email} sukses`);
    return { ok: true };
  } catch (err) {
    console.error(`[refresh] ❌ ${account.email}: ${err.message}`);
    await setAccountStatus(account.id, "needs_refresh", { error: err.message, at: now() });
    return { ok: false, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runCycle({ force = false, all = false } = {}) {
  if (isBusy) {
    console.log("[cycle] masih sibuk, ditolak");
    return { queued: true };
  }
  isBusy = true;
  const start = Date.now();
  let success = 0;
  let failed = 0;
  try {
    const accounts = all
      ? await fetchAllProblemAccounts(MAX_PER_CYCLE)
      : await fetchAccounts("needs_refresh", MAX_PER_CYCLE);

    console.log(`[cycle] ${accounts.length} akun diproses (force=${force}, all=${all})`);
    if (accounts.length === 0) {
      isBusy = false;
      return { ok: true, processed: 0, success: 0, failed: 0 };
    }

    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
      const batch = accounts.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((a) => refreshAccount(a, { force }))
      );
      results.forEach((r) => {
        if (r.status === "fulfilled" && r.value.ok) success++;
        else failed++;
      });
      if (i + CONCURRENCY < accounts.length) await sleep(2000);
    }

    // Sapuan kedua untuk yang gagal
    if (failed > 0 && force) {
      console.log("[cycle] sapuan kedua untuk akun gagal");
      const problem = await fetchAllProblemAccounts(MAX_PER_CYCLE);
      const secondBatch = problem.filter((a) => a.status !== "active").slice(0, MAX_PER_CYCLE);
      for (let i = 0; i < secondBatch.length; i += CONCURRENCY) {
        const batch = secondBatch.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((a) => refreshAccount(a, { force: true }))
        );
        results.forEach((r) => {
          if (r.status === "fulfilled" && r.value.ok) success++;
          else failed++;
        });
      }
    }

    return { ok: true, processed: accounts.length, success, failed, duration_ms: Date.now() - start };
  } catch (err) {
    console.error("[cycle] error:", err);
    return { ok: false, error: err.message };
  } finally {
    isBusy = false;
    lastRunAt = Date.now();
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, busy: isBusy, last_run_at: lastRunAt, queue_length: queue.length });
});

app.post("/refresh", async (req, res) => {
  const { force, all, secret } = req.body || {};
  if (secret !== REFRESH_SECRET) return res.status(401).json({ error: "unauthorized" });
  const result = await runCycle({ force: !!force, all: !!all });
  res.json(result);
});

app.post("/queue", async (req, res) => {
  const { secret } = req.body || {};
  if (secret !== REFRESH_SECRET) return res.status(401).json({ error: "unauthorized" });
  if (isBusy) {
    queue.push(req.body);
    return res.json({ queued: true, position: queue.length });
  }
  const result = await runCycle({ force: !!req.body.force, all: !!req.body.all });
  res.json(result);
});

async function backgroundLoop() {
  while (true) {
    try {
      if (!isBusy && Date.now() - lastRunAt > COOLDOWN_MS) {
        await runCycle({ all: true });
      }
      await sleep(FUNCTION_COOLDOWN_MS);
    } catch (err) {
      console.error("[backgroundLoop] crash:", err);
      await resetBrowser();
      await sleep(10000);
    }
  }
}

app.listen(PORT, () => {
  console.log(`[server] VPS Leonardo Refresher berjalan di port ${PORT}`);
  backgroundLoop();
});
