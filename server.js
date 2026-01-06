/**
 * ubereats-worker (Express + Playwright)
 *
 * ✅ 修正內容：
 * 1) 補上 GET /，避免 Cannot GET /
 * 2) cookies 更新支援：
 *    - POST /cookies { cookies: [...] }  // Playwright cookies array
 *    - POST /cookies { cookieString: "a=b; c=d" }  // 直接貼 cookie 字串
 * 3) cleanText 不再把 L/M/S 刪掉
 * 4) /scrape 每個 url 都 try/catch，避免整批失敗
 * 5) 可選安全：設定 WORKER_TOKEN 後，呼叫需帶 header：x-worker-token
 */

const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

/**
 * 你可以在 Zeabur 環境變數加上：
 * WORKER_TOKEN=一串你自己設的密碼
 * 之後 n8n 呼叫需帶 header: x-worker-token: <WORKER_TOKEN>
 *
 * 如果你不想上鎖，就不要設定 WORKER_TOKEN。
 */
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";

/**
 * cookies 儲存
 * - COOKIE_JAR_ARRAY: Playwright addCookies 用的 array
 * - COOKIE_STRING: 你直接貼 cookie 字串時存這裡（會轉成 header 用）
 */
let COOKIE_JAR_ARRAY = null;
let COOKIE_STRING = null;

/**
 * ====== 共用：簡單驗證（可選）======
 */
function authGuard(req, res) {
  if (!WORKER_TOKEN) return true; // 沒設定就不驗證
  const token = req.headers["x-worker-token"];
  if (token !== WORKER_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * ====== 路由：首頁 / 健康檢查 ======
 * 你打開 https://xxx.zeabur.app/ 不會再看到 Cannot GET /
 */
app.get("/", (_, res) => {
  res.send("OK - ubereats-worker is running. Use GET /health");
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    hasCookieArray: Array.isArray(COOKIE_JAR_ARRAY) && COOKIE_JAR_ARRAY.length > 0,
    hasCookieString: typeof COOKIE_STRING === "string" && COOKIE_STRING.length > 0
  });
});

/**
 * ====== cookies 更新（你每 7 天人工一次）======
 * 方式 A: Playwright cookies array
 * POST /cookies
 * { "cookies": [ {name, value, domain, path, ...}, ... ] }
 *
 * 方式 B: cookie 字串（更簡單）
 * POST /cookies
 * { "cookieString": "a=b; c=d; ..." }
 */
app.post("/cookies", (req, res) => {
  if (!authGuard(req, res)) return;

  const body = req.body || {};
  const { cookies, cookieString } = body;

  // B) cookie string
  if (typeof cookieString === "string" && cookieString.trim().length > 0) {
    COOKIE_STRING = cookieString.trim();
    // 你用 cookieString 的話，就先把 array 清掉，避免混用造成誤判
    COOKIE_JAR_ARRAY = null;
    return res.json({ ok: true, mode: "cookieString", length: COOKIE_STRING.length });
  }

  // A) cookies array
  if (Array.isArray(cookies) && cookies.length > 0) {
    COOKIE_JAR_ARRAY = cookies;
    COOKIE_STRING = null;
    return res.json({ ok: true, mode: "cookiesArray", count: cookies.length });
  }

  return res.status(400).json({
    ok: false,
    error: "Provide { cookies: [...] } or { cookieString: 'a=b; c=d' }"
  });
});

/**
 * ====== 清理文字 ======
 * 你的需求：
 * - 移除加價：像「杯型 ($10.00)」括號內金額
 * - 英文內容可以刪掉，但不要把尺寸 L/M/S 刪掉
 *
 * 注意：你原本用 /[A-Za-z]/ 會把 L 也刪掉 => 這裡改成：
 * - 刪掉「較長的英文單字」，保留單一字母（L/M/S）或很短的縮寫
 */
function cleanText(text = "") {
  return String(text)
    // 1) 移除像 ($10.00) 這種加價括號
    .replace(/\(\s*\$[0-9]+(\.[0-9]+)?\s*\)/g, "")
    // 2) 移除長英文片段（保留單字母 L/M/S）
    //    例：Velvety Roasted Oolong Milk Tea -> 移除
    //    例：L -> 保留
    .replace(/\b[A-Za-z]{2,}\b/g, "")
    // 3) 多餘空白整理
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

/**
 * ====== Playwright 抓取 ======
 * 先用 body.innerText 做 MVP（你要的資料之後再做 selector 精準萃取）
 *
 * 若 Uber Eats 畫面是 SPA，建議 waitUntil 用 "networkidle" 可能更穩
 * 但也可能卡住，所以我用 domcontentloaded + 等一下時間的做法
 */
async function scrapeGroup(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    locale: "zh-TW",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    viewport: { width: 1280, height: 720 }
  });

  // cookies 注入（2 種模式）
  if (Array.isArray(COOKIE_JAR_ARRAY) && COOKIE_JAR_ARRAY.length > 0) {
    await context.addCookies(COOKIE_JAR_ARRAY);
  }

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // 如果你用 cookieString 模式，直接塞 header
  if (COOKIE_STRING) {
    await page.setExtraHTTPHeaders({
      cookie: COOKIE_STRING
    });
  }

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // 有時內容還在載入，多等一下（可視情況調整）
    // await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const rawText = await page.locator("body").innerText();
    const cleaned = cleanText(rawText);

    return {
      ok: true,
      url,
      // 先回傳 cleaned 的前 4000 字，避免 payload 太大
      preview: cleaned.slice(0, 4000)
    };
  } catch (err) {
    return {
      ok: false,
      url,
      error: String(err && err.message ? err.message : err)
    };
  } finally {
    await browser.close();
  }
}

/**
 * ====== 主抓取 API ======
 * POST /scrape
 * { "urls": ["https://eats.uber.com/.../join", ...] }
 *
 * Header（如果你有設 WORKER_TOKEN）：
 * x-worker-token: <你的 token>
 */
app.post("/scrape", async (req, res) => {
  if (!authGuard(req, res)) return;

  // 必須要有 cookies 其中一種
  const hasArray = Array.isArray(COOKIE_JAR_ARRAY) && COOKIE_JAR_ARRAY.length > 0;
  const hasString = typeof COOKIE_STRING === "string" && COOKIE_STRING.length > 0;
  if (!hasArray && !hasString) {
    return res.status(400).json({ ok: false, error: "no cookies set (POST /cookies first)" });
  }

  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ ok: false, error: "urls required" });
  }

  // 逐筆抓取（MVP：最穩、最好 debug）
  const results = [];
  for (const url of urls) {
    const r = await scrapeGroup(url);
    results.push(r);
  }

  res.json({ ok: true, count: results.length, results });
});

/**
 * ====== 啟動 ======
 * Zeabur 會注入 PORT（通常是 8080 / 或 WEB_PORT）
 */
const PORT = process.env.PORT || process.env.WEB_PORT || 8080;
app.listen(PORT, () => {
  console.log("ubereats-worker listening on", PORT);
});
