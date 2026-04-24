const fs = require("fs");
const path = require("path");
const Fuse = require("fuse.js");

let botEnabled = true;

// ── Session memory (5 min) ──────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 5 * 60 * 1000;
function setContext(user, data) {
  sessions.set(user, { ...data, _t: Date.now() });
  setTimeout(() => {
    const s = sessions.get(user);
    if (s && Date.now() - s._t >= SESSION_TTL) sessions.delete(user);
  }, SESSION_TTL + 100);
}
function getContext(user) {
  const s = sessions.get(user);
  if (!s) return null;
  if (Date.now() - s._t > SESSION_TTL) { sessions.delete(user); return null; }
  return s;
}

// ── Rate limiting ───────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_MESSAGE_LENGTH = 500;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return { limited: true, retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000) };
  }
  return { limited: false };
}

// ── Data loaders (re-read each time so edits show up) ───────
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8") || "null") ?? def; }
  catch { return def; }
}
const getProducts  = () => readJson("database/products.json",  []);
const getCustomers = () => readJson("database/customers.json", []);
const getInvoices  = () => readJson("database/invoices.json",  []);
const getSettings  = () => readJson("database/settings.json",  {});

function getConfig() {
  const s = getSettings();
  return {
    businessName:    s.businessName    || "SD COMPUTERS",
    businessAddress: s.businessAddress || "",
    businessPhone:   s.businessPhone   || "",
    businessEmail:   s.businessEmail   || "",
    currencySymbol:  s.currencySymbol  || "Rs",
    chatbotApiUrl:   s.chatbotApiUrl   || "",
    mistralApiKey:   s.mistralApiKey   || "",
    mistralModel:    s.mistralModel    || "mistralai/mistral-7b-instruct-v0.3",
    aiFallbackEnabled: s.aiFallbackEnabled !== false,
  };
}

// ── Fuse.js fuzzy search over products ──────────────────────
let fuseCache = { ts: 0, fuse: null, count: 0 };
function getFuse() {
  const now = Date.now();
  if (fuseCache.fuse && now - fuseCache.ts < 30_000) return fuseCache.fuse;
  const products = getProducts();
  const fuse = new Fuse(products, {
    keys: [
      { name: "name", weight: 0.6 },
      { name: "sku", weight: 0.2 },
      { name: "category", weight: 0.2 },
    ],
    threshold: 0.5,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
  });
  fuseCache = { ts: now, fuse, count: products.length };
  return fuse;
}

function searchProducts(query, limit = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const fuse = getFuse();
  return fuse.search(q).slice(0, limit).map((r) => r.item);
}

// ── Phone normalization (Sri Lanka friendly) ────────────────
function normalizePhone(p) {
  if (!p) return "";
  const digits = String(p).replace(/\D/g, "");
  // strip leading 94 (LK country code) or leading zero so we compare consistently
  return digits.replace(/^94/, "").replace(/^0+/, "");
}

function findCustomerByJid(jid) {
  if (!jid) return null;
  const phoneFromJid = normalizePhone(String(jid).split("@")[0]);
  if (!phoneFromJid) return null;
  return getCustomers().find((c) => normalizePhone(c.phone) === phoneFromJid) || null;
}

// ── Intent detection (Singlish + English) ───────────────────
function detectIntent(text) {
  const q = text.toLowerCase().trim();

  if (/^(hi|hello|hey|helo|ayubowan|kohomada|hari|machan\s*|ආයුබෝවන්)\b/.test(q))
    return "greet";

  if (/\b(order|ordara|orderak|tracking|invoice|bill|delivery|mage.*(order|bill|invoice)|my.*(order|bill|invoice)|order.*status|status.*order)\b/.test(q))
    return "order_status";

  if (/recommend|suggest|best|hoda|honda.*ekak|which.*buy|good\s+(product|laptop|phone|cpu|ram)|popular|aluth|new/.test(q))
    return "recommend";

  if (/stock|available|thiyenawada|thiyenwada|thiyenavada|thiyenwa|thiyenava|in\s*stock|in\s*shop|tiyenawada/.test(q))
    return "stock";

  if (/price|cost|how\s*much|gana|gaana|kiyada|kiyak|මිල|ගාන/.test(q))
    return "price";

  if (/list|all\s*products|catalog|catalogue|items|mokakda thiyenne|monawada thiyenne/.test(q))
    return "list";

  if (/contact|phone|call|number|address|location|where|kohenda|koheda/.test(q))
    return "contact";

  if (/help|menu|options|mokak|mokakda|mona|monawada/.test(q))
    return "help";

  return "unknown";
}

function extractProductTerms(q) {
  return q
    .toLowerCase()
    .replace(/price|cost|how much|of|for|the|is|are|stock|available|in|shop|gana|gaana|kiyada|kiyak|thiyenawada|thiyenwada|මිල|ගාන|please|me|can|you|tell|do|does|have/g, " ")
    .replace(/[?.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Reply builders ──────────────────────────────────────────
function fmtPriceLine(p, sym) {
  const stockTxt = Number(p.stock) > 0 ? `✅ ${p.stock} in stock` : "❌ Out of stock";
  return `📦 *${p.name}*\n   💰 ${sym}.${Number(p.price).toFixed(2)}\n   ${stockTxt}${p.category ? `\n   🏷️ ${p.category}` : ""}`;
}

function replyPrice(text, sym) {
  const term = extractProductTerms(text);
  const matches = term ? searchProducts(term, 5) : [];
  if (!matches.length) return `Mona item eke price da oyata oni? Product eke nama type karanna 😊\nE wage *list* kiyala type karanna full catalog ekata.`;
  return matches.map((p) => fmtPriceLine(p, sym)).join("\n\n");
}

function replyStock(text, sym) {
  const term = extractProductTerms(text);
  const matches = term ? searchProducts(term, 5) : [];
  if (!matches.length) return `Mokakda check karanna oni? Product eke nama type karanna 🙂`;
  return matches.map((p) => {
    if (Number(p.stock) > 0) return `✅ *${p.name}* — ${p.stock} thiyenawa @ ${sym}.${Number(p.price).toFixed(2)}`;
    return `❌ *${p.name}* — Stock out (call karala check karanna)`;
  }).join("\n");
}

function replyRecommend(text, sym) {
  const products = getProducts().filter((p) => Number(p.stock) > 0);
  if (!products.length) return "Sorry, dan stock walin mokuth na.🙏";
  const term = extractProductTerms(text);
  let pool = products;
  if (term) {
    const found = searchProducts(term, 10);
    if (found.length) pool = found.filter((p) => Number(p.stock) > 0);
  }
  const top = pool.slice(0, 3);
  return `⭐ *Mage suggestion:*\n\n${top.map((p) => fmtPriceLine(p, sym)).join("\n\n")}\n\nMila gana adjust karanna oni nam kiyanna 😊`;
}

function replyList(sym) {
  const inStock = getProducts().filter((p) => Number(p.stock) > 0);
  if (!inStock.length) return "Dan stock walin mokuth na 😔";
  const list = inStock.slice(0, 12).map((p) => `• ${p.name} — ${sym}.${Number(p.price).toFixed(2)}`).join("\n");
  return `🛍️ *Available products:*\n\n${list}${inStock.length > 12 ? `\n\n...and ${inStock.length - 12} more.` : ""}`;
}

function replyContact(cfg) {
  return `🏪 *${cfg.businessName}*\n📍 ${cfg.businessAddress || "—"}\n📞 ${cfg.businessPhone || "—"}\n📧 ${cfg.businessEmail || "—"}`;
}

function replyHelp(cfg) {
  return `🤖 *${cfg.businessName} Smart Assistant*\n\nMata help karanna puluwan:\n• 💰 *Price* check — "i5 cpu price?"\n• 📦 *Stock* check — "ram thiyenawada?"\n• ⭐ *Recommend* — "50000ta hoda laptop ekak"\n• 📋 *Order status* — "mage order kohomada?"\n• 📞 *Contact* — shop info\n• Type *list* — all products\n\nMonawa hari ahanna 😊`;
}

function replyOrderStatus(user) {
  const customer = findCustomerByJid(user);
  if (!customer) {
    return `📋 Order check karanna oyage phone number eka customer record eke save wela thiyenna oni.\n\nShop ekata call karanna: order ID dela check karannam.`;
  }
  const myInvoices = getInvoices()
    .filter((i) => i.customer === customer.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 3);
  if (!myInvoices.length) {
    return `Hi ${customer.name}! 👋\n\nObe records walin order/invoice ekak hambena ne. Shop ekata call karanna details ganna.`;
  }
  const sym = getConfig().currencySymbol;
  const lines = myInvoices.map((i) => {
    const d = new Date(i.date).toLocaleDateString("en-GB");
    const itemsTxt = (i.items || []).slice(0, 3).map((it) => `   • ${it.name} x${it.qty}`).join("\n");
    const more = (i.items || []).length > 3 ? `\n   • ...and ${(i.items || []).length - 3} more` : "";
    return `🧾 *${i.id}* — ${d}\n${itemsTxt}${more}\n   💰 Total: ${sym}.${Number(i.total).toFixed(2)}\n   📌 Status: ${i.status || "completed"}`;
  }).join("\n\n");
  return `Hi ${customer.name}! 👋 Obe last orders:\n\n${lines}`;
}

// ── Local intent-router ─────────────────────────────────────
function buildLocalReply(text, user) {
  const cfg = getConfig();
  const sym = cfg.currencySymbol;
  const intent = detectIntent(text);

  switch (intent) {
    case "greet":        return `👋 Welcome to *${cfg.businessName}*!\n\nMata price, stock, recommendations, order status check karanna puluwan. Mokakda oni? 😊`;
    case "price":        return replyPrice(text, sym);
    case "stock":        return replyStock(text, sym);
    case "recommend":    return replyRecommend(text, sym);
    case "list":         return replyList(sym);
    case "contact":      return replyContact(cfg);
    case "order_status": return replyOrderStatus(user);
    case "help":         return replyHelp(cfg);
    default:             return null; // unknown → let AI handle
  }
}

// ── Mistral / NVIDIA NIM fallback ───────────────────────────
async function askMistral(message, cfg) {
  if (!cfg.mistralApiKey) return null;
  // Build short context: top 8 in-stock products so the model can answer
  const products = getProducts().filter((p) => Number(p.stock) > 0).slice(0, 12);
  const productCtx = products.map((p) => `- ${p.name} (${p.category || "general"}): ${cfg.currencySymbol}.${Number(p.price).toFixed(2)} | stock ${p.stock}`).join("\n");

  const systemPrompt = `You are a friendly sales assistant for ${cfg.businessName}, a shop in Sri Lanka. Reply in Singlish (mix of English + Sinhala in Latin letters), short and casual, like WhatsApp chat. Be helpful, suggest products from this catalog if relevant, and never invent prices. If unsure, ask the customer to call ${cfg.businessPhone || "the shop"}.

Current in-stock products:
${productCtx || "(no live data right now)"}`;

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.mistralApiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: cfg.mistralModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.4,
        max_tokens: 350,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error("Mistral HTTP", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content;
    return txt ? String(txt).trim() : null;
  } catch (err) {
    console.error("Mistral error:", err.message);
    return null;
  }
}

// ── MAIN ENTRY ──────────────────────────────────────────────
async function askAI(message, user = "unknown") {
  if (!botEnabled) return "🤖 Bot is currently OFF.";
  if (!message || typeof message !== "string") return "Please send a valid message.";

  const trimmed = message.trim();
  if (!trimmed) return "Please send a non-empty message.";
  if (trimmed.length > MAX_MESSAGE_LENGTH) return `❌ Message too long (max ${MAX_MESSAGE_LENGTH} chars).`;

  const rate = checkRateLimit(user);
  if (rate.limited) return `⏳ Too many messages. Wait ${rate.retryAfter}s and try again.`;

  const cfg = getConfig();

  // 1. Local intent-based reply (fast, accurate)
  const local = buildLocalReply(trimmed, user);
  if (local) return local;

  // 2. AI fallback (Mistral via NVIDIA NIM)
  if (cfg.aiFallbackEnabled && cfg.mistralApiKey) {
    const ai = await askMistral(trimmed, cfg);
    if (ai) return ai;
  }

  // 3. Last-resort fallback to legacy external API (if configured)
  if (cfg.chatbotApiUrl) {
    try {
      const url = `${cfg.chatbotApiUrl}${cfg.chatbotApiUrl.includes("?") && !cfg.chatbotApiUrl.endsWith("=") ? "&text=" : ""}${encodeURIComponent(trimmed)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const t = d.result || d.reply || d.response || d.message || d.text || d.answer;
      if (t && String(t).trim()) return String(t).trim();
    } catch (err) {
      console.error("Legacy chatbot API error:", err.message);
    }
  }

  return `🤤 Sorry, ekata uttara denna bari una.\n\nType *help* — mokak karanna puluwanda balanna.\nNathnam call karanna: ${cfg.businessPhone || "shop"} 📞`;
}

function setBotEnabled(val) { botEnabled = !!val; }
function getBotEnabled() { return botEnabled; }

module.exports = { askAI, setBotEnabled, getBotEnabled };
