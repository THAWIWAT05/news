require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WATCHLIST_FILE)) {
  const initial = (process.env.DEFAULT_WATCHLIST || "NVDA,TSLA,AVGO,EOSE,JEPQ,VOO")
    .split(",").map(x => x.trim().toUpperCase()).filter(Boolean);
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(initial, null, 2));
}

const cache = new Map();
const CACHE_MS = 60_000;
const NEWS_CACHE_MS = 5 * 60_000;
const PREPOST_CACHE_MS = 60_000;
const prePostCache = new Map();
const seenNews = new Map();
let telegramJobRunning = false;
const newsCache = new Map();
const SYMBOL_RE = /^[A-Z0-9.^=-]{1,15}$/;

function getWatchlist() {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8")); }
  catch { return ["NVDA", "TSLA", "AVGO", "EOSE", "JEPQ", "VOO"]; }
}
function saveWatchlist(items) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(items, null, 2));
}
function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = mean(values.slice(0, period));
  for (const v of values.slice(period)) result = v * k + result * (1 - k);
  return result;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function macd(values) {
  if (values.length < 35) return { macd: null, signal: null, histogram: null };
  const fast = [], slow = [];
  for (let i = 0; i < values.length; i++) {
    fast.push(ema(values.slice(0, i + 1), 12));
    slow.push(ema(values.slice(0, i + 1), 26));
  }
  const line = fast.map((v, i) => v == null || slow[i] == null ? null : v - slow[i]);
  const clean = line.filter(Number.isFinite);
  const signal = ema(clean, 9);
  const current = clean.at(-1);
  return { macd: current, signal, histogram: signal == null ? null : current - signal };
}
function calculateLevels(closes) {
  const last = closes.at(-1);
  const recent = closes.slice(-20);
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  return { support, resistance, sma20: mean(closes.slice(-20)), sma50: closes.length >= 50 ? mean(closes.slice(-50)) : null,
    sma200: closes.length >= 200 ? mean(closes.slice(-200)) : null };
}
function round(v) { return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)); }

async function fetchPrePost(symbol) {
  const hit = prePostCache.get(symbol);
  if (hit && Date.now() - hit.time < PREPOST_CACHE_MS) return hit.data;
  // ใช้ข้อมูลช่วง 5 นาทีและเปิด includePrePost เพื่อให้ Yahoo ส่งข้อมูลนอกเวลาตลาดเมื่อมี
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 NEXUSStock/1.0" } });
  if (!response.ok) throw new Error(`ข้อมูลก่อน/หลังตลาดตอบกลับ ${response.status}`);
  const json = await response.json();
  const meta = json.chart?.result?.[0]?.meta || {};
  const data = {
    preMarketPrice: round(meta.preMarketPrice),
    preMarketChange: round(meta.preMarketChange),
    preMarketChangePercent: round(meta.preMarketChangePercent),
    postMarketPrice: round(meta.postMarketPrice),
    postMarketChange: round(meta.postMarketChange),
    postMarketChangePercent: round(meta.postMarketChangePercent),
    marketState: meta.marketState || "UNKNOWN"
  };
  prePostCache.set(symbol, { time: Date.now(), data });
  return data;
}

async function fetchQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div%2Csplits&includePrePost=true`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 NEXUSStock/1.0" } });
  if (!response.ok) throw new Error(`ผู้ให้บริการข้อมูลราคาตอบกลับ ${response.status}`);
  const json = await response.json();
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(json.chart?.error?.description || "ไม่พบข้อมูลหุ้นนี้ หรือผู้ให้บริการยังไม่มีข้อมูล");
  const quote = result.indicators.quote[0];
  const rows = (result.timestamp || []).map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: quote.open?.[i], high: quote.high?.[i], low: quote.low?.[i],
    close: quote.close?.[i], volume: quote.volume?.[i]
  })).filter(x => Number.isFinite(x.close));
  if (rows.length < 2) throw new Error("ข้อมูลราคาย้อนหลังไม่เพียงพอ");
  const closes = rows.map(x => x.close);
  const last = rows.at(-1), prev = rows.at(-2);
  const indicators = {
    rsi14: round(rsi(closes)),
    ema20: round(ema(closes, 20)),
    ema50: round(ema(closes, 50)),
    ...Object.fromEntries(Object.entries(calculateLevels(closes)).map(([k,v]) => [k, round(v)])),
    ...Object.fromEntries(Object.entries(macd(closes)).map(([k,v]) => [k, round(v)]))
  };
  const change = last.close - prev.close;
  let prePost = {};
  try { prePost = await fetchPrePost(symbol); } catch (e) { console.warn(`[PREPOST] ${symbol}: ${e.message}`); }
  const data = {
    symbol, currency: result.meta.currency || "USD", exchange: result.meta.exchangeName || "",
    name: result.meta.longName || result.meta.shortName || symbol,
    price: round(last.close), previousClose: round(prev.close), change: round(change),
    changePercent: round(change / prev.close * 100), volume: last.volume || null,
    ...prePost,
    preMarketPrice: prePost.preMarketPrice ?? round(result.meta.preMarketPrice),
    preMarketChange: prePost.preMarketChange ?? round(result.meta.preMarketChange),
    preMarketChangePercent: prePost.preMarketChangePercent ?? round(result.meta.preMarketChangePercent),
    postMarketPrice: prePost.postMarketPrice ?? round(result.meta.postMarketPrice),
    postMarketChangePercent: prePost.postMarketChangePercent ?? round(result.meta.postMarketChangePercent),
    marketState: prePost.marketState || result.meta.marketState || "UNKNOWN",
    marketTime: new Date((result.meta.regularMarketTime || result.timestamp.at(-1)) * 1000).toISOString(),
    indicators, history: rows.slice(-120).map(x => ({ ...x, close: round(x.close), volume: x.volume || 0 }))
  };
  cache.set(symbol, { time: Date.now(), data });
  return data;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "NEXUS STOCK INTELLIGENCE" }));
app.get("/api/watchlist", (_req, res) => res.json({ symbols: getWatchlist() }));
app.put("/api/watchlist", (req, res) => {
  const symbols = Array.isArray(req.body.symbols) ? [...new Set(req.body.symbols.map(x => String(x).trim().toUpperCase()))] : null;
  if (!symbols || !symbols.length || symbols.length > 30 || symbols.some(x => !SYMBOL_RE.test(x))) {
    return res.status(400).json({ error: "ส่งสัญลักษณ์หุ้น 1–30 รายการ รูปแบบไม่ถูกต้อง" });
  }
  saveWatchlist(symbols);
  res.json({ symbols });
});
app.get("/api/quote/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: "รูปแบบสัญลักษณ์หุ้นไม่ถูกต้อง" });
  try { res.json(await fetchQuote(symbol)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/market", async (_req, res) => {
  const symbols = getWatchlist();
  const results = await Promise.allSettled(symbols.map(fetchQuote));
  res.json({ results: results.map((r, i) => r.status === "fulfilled"
    ? { ok: true, data: r.value } : { ok: false, symbol: symbols[i], error: r.reason.message }) });
});
const COMPANY_TERMS = {
  NVDA: "NVIDIA",
  TSLA: "Tesla",
  AVGO: "Broadcom",
  EOSE: "Energy offtake Eos Energy",
  JEPQ: "JPMorgan Nasdaq Equity Premium Income ETF",
  VOO: "Vanguard S&P 500 ETF"
};
function decodeXml(value = "") {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}
function summarizeHeadline(title = "") {
  const t = title.toLowerCase();
  const positive = ["beats", "surge", "rises", "gains", "upgrade", "record", "growth", "profit", "กำไร", "เติบโต", "พุ่ง", "เพิ่มขึ้น", "ปรับขึ้น", "ซื้อ", "ชนะคาด"];
  const negative = ["misses", "falls", "drops", "slumps", "downgrade", "cuts", "warning", "lawsuit", "decline", "loss", "ลดลง", "ร่วง", "ขาดทุน", "เตือน", "ฟ้อง", "ขาย", "ลดคาดการณ์"];
  const highRisk = ["sec", "investigation", "fraud", "bankruptcy", "default", "offering", "dilution", "recall", "ฟ้องร้อง", "สอบสวน", "ล้มละลาย", "เพิ่มทุน", "ผิดนัด"];
  const pos = positive.filter(k => t.includes(k)).length;
  const neg = negative.filter(k => t.includes(k)).length;
  const high = highRisk.some(k => t.includes(k));
  if (pos > neg) return { tone: "positive", label: "ประเด็นเชิงบวก", impact: "อาจหนุนราคา", impactLevel: high ? "สูง — ต้องตรวจสอบ" : pos >= 2 ? "ปานกลาง" : "ต่ำ", direction: "เอนเอียงเชิงบวก", summary: "พาดหัวมีคำที่สื่อถึงปัจจัยบวก อาจช่วยหนุนแรงซื้อ แต่ยังไม่ยืนยันผลต่อราคา ต้องอ่านเนื้อหาข่าวและตรวจสอบตัวเลข" };
  if (neg > pos) return { tone: "negative", label: "ประเด็นเชิงลบ", impact: "อาจกดดันราคา", impactLevel: high ? "สูง — ต้องตรวจสอบ" : neg >= 2 ? "ปานกลาง" : "ต่ำ", direction: "เอนเอียงเชิงลบ", summary: "พาดหัวมีคำที่สื่อถึงความเสี่ยง อาจเพิ่มแรงขายหรือความผันผวน แต่ต้องตรวจสอบความน่าเชื่อถือและผลกระทบต่อธุรกิจจริง" };
  return { tone: "neutral", label: "ยังไม่ชัดเจน", impact: "ทิศทางยังไม่ชัด", impactLevel: "ประเมินไม่ได้", direction: "ยังไม่มีทิศทางชัดเจน", summary: "พาดหัวไม่ชี้ทิศทางชัดเจน จึงยังประเมินแรงกระทบไม่ได้ ควรอ่านข่าวต้นฉบับและดูปฏิกิริยาราคาประกอบ" };
}
app.get("/api/news", async (req, res) => {
  const symbol = String(req.query.symbol || "NVDA").toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: "รูปแบบสัญลักษณ์หุ้นไม่ถูกต้อง" });
  try { res.json(await getNewsData(symbol)); }
  catch (e) { res.status(502).json({ error: e.name === "AbortError" ? "แหล่งข่าวใช้เวลาตอบสนองนานเกินไป กรุณาลองใหม่" : e.message }); }
});

app.post("/api/telegram/test", async (_req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.status(400).json({ error: "กรุณาตั้ง TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID ในไฟล์ .env ก่อน" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "✅ NEXUS STOCK INTELLIGENCE เชื่อมต่อ Telegram สำเร็จ" })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description || "Telegram error");
    res.json({ ok: true, message: "ส่งข้อความทดสอบแล้ว" });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/api/telegram/send", async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Telegram ใน .env" });
  const message = String(req.body.message || "").slice(0, 3900);
  if (!message.trim()) return res.status(400).json({ error: "ข้อความว่าง" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description || "Telegram error");
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

async function telegramSend(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("ยังไม่ได้ตั้งค่า TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const chunk of chunks) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }) });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description || "Telegram error");
  }
}
function priceLine(q) {
  const pre = q.preMarketPrice != null ? ` | ก่อนเปิด $${q.preMarketPrice} (${q.preMarketChangePercent ?? "—"}%)` : " | ก่อนเปิด: ไม่มีข้อมูลจากผู้ให้บริการ";
  const post = q.postMarketPrice != null ? ` | หลังปิด $${q.postMarketPrice} (${q.postMarketChangePercent ?? "—"}%)` : "";
  const i = q.indicators || {};
  return `${q.symbol}: $${q.price} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent}%) | RSI ${i.rsi14 ?? "—"} | MACD ${i.histogram == null ? "—" : i.histogram > 0 ? "บวก" : "ลบ"} | แนวรับ ${i.support ?? "—"} / แนวต้าน ${i.resistance ?? "—"}${pre}${post}`;
}
async function buildTelegramReport() {
  const symbols = getWatchlist();
  const quotes = await Promise.allSettled(symbols.map(fetchQuote));
  const lines = ["📊 NEXUS STOCK — รายงานติดตามหุ้น", `เวลาไทย: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`, ""];
  quotes.forEach((r, idx) => {
    if (r.status === "fulfilled") { lines.push(priceLine(r.value)); }
    else lines.push(`${symbols[idx]}: โหลดราคาไม่สำเร็จ (${r.reason.message})`);
  });
  lines.push("", "📰 ข่าวล่าสุดและผลกระทบจากพาดหัว");
  const newsResults = await Promise.allSettled(symbols.map(async symbol => ({ symbol, data: await getNewsData(symbol) })));
  for (const item of newsResults) {
    if (item.status !== "fulfilled") continue;
    const { symbol, data } = item.value;
    const top = data.items.slice(0, 2);
    lines.push(`
[${symbol}]`);
    if (!top.length) lines.push("ยังไม่พบข่าวใหม่");
    for (const n of top) lines.push(`• ${n.label} / ผลกระทบ ${n.impactLevel}: ${n.title}
  ${n.summary}`);
  }
  lines.push("", "หมายเหตุ: ราคา/ข่าวขึ้นกับผู้ให้บริการและอาจล่าช้า; ทิศทางข่าวเป็นการคัดคำจากพาดหัว ไม่ใช่โอกาสขึ้นลงจริงหรือคำแนะนำลงทุน");
  return lines.join("\n");
}
async function getNewsData(symbol) {
  const cached = newsCache.get(symbol);
  if (cached && Date.now() - cached.time < NEWS_CACHE_MS) return cached.data;
  const terms = COMPANY_TERMS[symbol] || symbol;
  const query = `(${symbol} OR "${terms}") stock OR shares`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=th&gl=TH&ceid=TH:th`;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  let r; try { r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 NEXUSStock/1.1" } }); } finally { clearTimeout(timeout); }
  if (!r.ok) throw new Error(`แหล่งข่าวตอบกลับรหัส ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 20).map(m => {
    const block = m[1], title = xmlTag(block, "title"), link = xmlTag(block, "link"), pubDate = xmlTag(block, "pubDate"), source = xmlTag(block, "source");
    return { title, link, pubDate, source: source || "Google News", ...summarizeHeadline(title) };
  }).filter(x => x.title && /^https?:\/\//i.test(x.link));
  const data = { symbol, items, fetchedAt: new Date().toISOString(), note: "ทิศทางและระดับผลกระทบเป็นการคัดคำจากพาดหัวข่าวเท่านั้น ไม่ใช่ความน่าจะเป็นหรือการประเมินเชิงสถิติ และระบบยังไม่ได้อ่านเนื้อหาข่าวฉบับเต็ม" };
  newsCache.set(symbol, { time: Date.now(), data }); return data;
}
async function sendImportantNewsAlerts() {
  const symbols = getWatchlist();
  for (const symbol of symbols) {
    try {
      const data = await getNewsData(symbol);
      for (const n of data.items.slice(0, 12)) {
        const key = `${symbol}:${n.link}`;
        if (seenNews.has(key)) continue;
        seenNews.set(key, Date.now());
        const isImportant = n.impactLevel.startsWith("สูง") || (n.tone !== "neutral" && /earnings|guidance|forecast|fed|rate|chip|export|sanction|lawsuit|investigation|เพิ่มทุน|งบการเงิน|ดอกเบี้ย|ส่งออก|ฟ้องร้อง|สอบสวน/i.test(n.title));
        if (isImportant) await telegramSend(`🚨 ข่าวสำคัญ ${symbol}\n${n.label} | ${n.impactLevel}\n${n.title}\n${n.summary}\n${n.link}\n\nหมายเหตุ: ประเมินจากพาดหัว ไม่ใช่สัญญาณซื้อขาย`);
      }
    } catch (e) { console.warn(`[NEWS ALERT] ${symbol}: ${e.message}`); }
  }
  // จำกัดหน่วยความจำของรายการข่าวที่แจ้งแล้ว
  if (seenNews.size > 1500) { const oldest = [...seenNews.entries()].sort((a,b) => a[1]-b[1]).slice(0,500); oldest.forEach(([k]) => seenNews.delete(k)); }
}
async function runTelegramCycle() {
  if (telegramJobRunning || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  telegramJobRunning = true;
  try { await telegramSend(await buildTelegramReport()); await sendImportantNewsAlerts(); console.log("[TELEGRAM] ส่งรายงานรอบอัตโนมัติสำเร็จ"); }
  catch (e) { console.error("[TELEGRAM] ส่งรายงานไม่สำเร็จ:", e.message); }
  finally { telegramJobRunning = false; }
}
app.post("/api/telegram/report", async (_req, res) => {
  try { await telegramSend(await buildTelegramReport()); res.json({ ok: true, message: "ส่งรายงานหุ้นทั้งหมดเข้า Telegram แล้ว" }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => {
  console.log(`NEXUS STOCK INTELLIGENCE พร้อมใช้งานที่ http://localhost:${PORT}`);
  const intervalMinutes = Math.max(5, Number(process.env.TELEGRAM_INTERVAL_MINUTES || 5));
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_AUTO_REPORT !== "false") {
    console.log(`เปิดรายงาน Telegram อัตโนมัติทุก ${intervalMinutes} นาที`);
    setTimeout(runTelegramCycle, 15_000);
    setInterval(runTelegramCycle, intervalMinutes * 60_000);
  } else console.log("Telegram อัตโนมัติยังไม่ทำงาน: กรุณาตั้งค่า Token และ Chat ID ใน .env");
});
