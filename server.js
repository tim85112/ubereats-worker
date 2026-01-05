const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

let COOKIE_JAR = null;

// health check
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// 更新 cookies（你每 7 天一次）
app.post("/cookies", (req, res) => {
  const { cookies } = req.body || {};
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ ok: false, error: "cookies must be array" });
  }
  COOKIE_JAR = cookies;
  res.json({ ok: true, count: cookies.length });
});

function cleanText(text = "") {
  return text
    .replace(/\(\s*\$[0-9.]+\s*\)/g, "")   // 移除加價
    .replace(/[A-Za-z]/g, "")               // 移除英文
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

async function scrapeGroup(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({ locale: "zh-TW" });
  if (COOKIE_JAR) await context.addCookies(COOKIE_JAR);

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const rawText = await page.locator("body").innerText();
  await browser.close();

  return {
    url,
    preview: cleanText(rawText).slice(0, 2000)
  };
}

// 主抓取 API
app.post("/scrape", async (req, res) => {
  if (!COOKIE_JAR) {
    return res.status(400).json({ ok: false, error: "no cookies set" });
  }

  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ ok: false, error: "urls required" });
  }

  const results = [];
  for (const url of urls) {
    results.push(await scrapeGroup(url));
  }

  res.json({ ok: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ubereats-worker listening on", PORT);
});
