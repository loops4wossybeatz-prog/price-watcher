import { google } from "googleapis";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GMAIL_USER = process.env.GMAIL_USER; // example: yourmail@gmail.com
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_TO = process.env.EMAIL_TO; // can be same as GMAIL_USER

const PRICES_SHEET = "Prices";
const HISTORY_SHEET = "History";

function normalizePriceNumber(text) {
  if (!text) return null;
  // Keep digits, comma, dot; then unify.
  const cleaned = String(text).replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  // Heuristic: if both comma and dot exist, assume dot is thousands separator and comma is decimal (or vice versa)
  // For marketplaces usually integer rubles -> we keep only integer part.
  const digitsOnly = cleaned.replace(/[.,]/g, "");
  if (!digitsOnly) return null;

  const value = parseInt(digitsOnly, 10);
  return Number.isFinite(value) ? value : null;
}

function detectMarketplace(url) {
  const u = url.toLowerCase();
  if (u.includes("wildberries.ru")) return "wb";
  if (u.includes("ozon.ru")) return "ozon";
  if (u.includes("market.yandex.ru")) return "yandex";
  return "unknown";
}

async function fetchText(page, selectors) {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      if (await locator.count()) {
        const txt = (await locator.innerText({ timeout: 2000 })).trim();
        if (txt) return txt;
      }
    } catch {}
  }
  return null;
}

async function scrapePriceAndTitle(page, url, marketplace) {
  // Load page
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // A bit of breathing room for JS-rendered prices
  await page.waitForTimeout(1500);

  let priceText = null;
  let titleText = null;

  if (marketplace === "wb") {
    // Wildberries: price often exists in JSON, but simplest is to look for common price nodes
    titleText = await fetchText(page, ["h1", "h1[data-link]"]);
    priceText = await fetchText(page, [
      "[data-tag='product-price']",
      "[class*='price'] [class*='current']",
      "[class*='price']",
      "span:has-text('₽')"
    ]);
  } else if (marketplace === "ozon") {
    titleText = await fetchText(page, ["h1", "[data-widget='webProductHeading'] h1"]);
    priceText = await fetchText(page, [
      "[data-widget='webPrice'] span",
      "[data-widget='webPrice']",
      "span:has-text('₽')"
    ]);
  } else if (marketplace === "yandex") {
    titleText = await fetchText(page, ["h1", "[data-auto='productCardTitle']"]);
    priceText = await fetchText(page, [
      "[data-auto='snippet-price-current']",
      "[data-auto='price-value']",
      "span:has-text('₽')"
    ]);
  } else {
    // fallback
    titleText = await fetchText(page, ["h1"]);
    priceText = await fetchText(page, ["span:has-text('₽')"]);
  }

  const price = normalizePriceNumber(priceText);
  return { price, title: titleText || null, rawPriceText: priceText || null };
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Telegram send failed: ${resp.status} ${t}`);
  }
}

async function sendGmail(subject, text) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !EMAIL_TO) return;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_TO,
    subject,
    text
  });
}

function makeAuth() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return auth;
}

async function getSheetValues(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${PRICES_SHEET}!A1:G`
  });
  return res.data.values || [];
}

async function updateRow(sheets, rowIndex1Based, updates) {
  // updates: {C,D,E,F,G} subset
  const range = `${PRICES_SHEET}!A${rowIndex1Based}:G${rowIndex1Based}`;
  const current = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range })).data.values?.[0] || [];
  const row = Array.from({ length: 7 }, (_, i) => current[i] ?? "");

  // Map columns
  const colIndex = { A:0,B:1,C:2,D:3,E:4,F:5,G:6 };
  for (const [col, val] of Object.entries(updates)) {
    row[colIndex[col]] = val;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function appendHistory(sheets, record) {
  // record: [checked_at, url, old, new, diff]
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HISTORY_SHEET}!A1:E1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [record] }
  });
}

function nowISO() {
  return new Date().toISOString();
}

async function main() {
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");

  const auth = makeAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const values = await getSheetValues(sheets);
  if (values.length < 2) {
    console.log("No rows found.");
    return;
  }

  // Find header indexes (we assume fixed order but keep tolerant)
  const header = values[0].map(v => String(v).trim().toLowerCase());
  const idxUrl = header.indexOf("url");
  const idxMarketplace = header.indexOf("marketplace");
  const idxPriceCur = header.indexOf("price_current");
  const idxPricePrev = header.indexOf("price_prev");
  const idxLastChecked = header.indexOf("last_checked");
  const idxStatus = header.indexOf("status");
  const idxTitle = header.indexOf("title");

  if (idxUrl === -1) throw new Error("Header must include 'url' column");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  });
  const page = await context.newPage();

  const changes = [];
  const errors = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const url = row[idxUrl]?.toString().trim();
    if (!url) continue;

    const rowNumber = i + 1; // 1-based in sheet

    const marketplace = (row[idxMarketplace] || detectMarketplace(url)).toString().trim();
    const oldPrice = row[idxPriceCur] ? parseInt(String(row[idxPriceCur]).replace(/[^\d]/g, ""), 10) : null;

    try {
      const mp = detectMarketplace(url);
      const { price, title, rawPriceText } = await scrapePriceAndTitle(page, url, mp);

      if (!price) {
        await updateRow(sheets, rowNumber, {
          B: mp,
          E: nowISO(),
          F: `error: no price (${rawPriceText || "empty"})`
        });
        errors.push({ url, reason: "no price found" });
        continue;
      }

      // Update title if empty
      const curTitle = idxTitle !== -1 ? (row[idxTitle] || "").toString().trim() : "";
      const titleToWrite = curTitle || title || "";

      const checkedAt = nowISO();

      if (oldPrice !== null && oldPrice === price) {
        await updateRow(sheets, rowNumber, {
          B: mp,
          E: checkedAt,
          F: "OK",
          ...(titleToWrite ? { G: titleToWrite } : {})
        });
        continue;
      }

      // Price changed (or first fill)
      const diff = oldPrice === null ? 0 : price - oldPrice;

      await updateRow(sheets, rowNumber, {
        B: mp,
        D: oldPrice === null ? "" : String(oldPrice),
        C: String(price),
        E: checkedAt,
        F: oldPrice === null ? "INIT" : "CHANGED",
        ...(titleToWrite ? { G: titleToWrite } : {})
      });

      if (oldPrice !== null) {
        await appendHistory(sheets, [checkedAt, url, String(oldPrice), String(price), String(diff)]);
        changes.push({ url, title: titleToWrite, oldPrice, newPrice: price, diff });
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      await updateRow(sheets, rowNumber, { E: nowISO(), F: `error: ${msg}` });
      errors.push({ url, reason: msg });
    }
  }

  await context.close();
  await browser.close();

  // Notifications
  if (changes.length) {
    const lines = changes.slice(0, 30).map((c, n) => {
      const name = c.title ? `\n${c.title}` : "";
      const sign = c.diff > 0 ? "+" : "";
      return `${n + 1}) ${c.oldPrice} → ${c.newPrice} (${sign}${c.diff})${name}\n${c.url}`;
    });

    const text =
      `Изменились цены (${changes.length}):\n\n` +
      lines.join("\n\n") +
      (changes.length > 30 ? `\n\n…и ещё ${changes.length - 30}` : "");

    await sendTelegram(text);
    await sendGmail(`Price Watcher: изменились цены (${changes.length})`, text);
  } else {
    const text = `Проверка завершена: изменений цен нет.\nОшибок: ${errors.length}.`;
    await sendTelegram(text);
    await sendGmail(`Price Watcher: без изменений`, text);
  }

  console.log(`Done. Changes: ${changes.length}, Errors: ${errors.length}`);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sendTelegram(`Price Watcher упал с ошибкой:\n${e?.message || e}`);
  } catch {}
  process.exit(1);
});
