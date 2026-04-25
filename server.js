const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const archiver = require("archiver");
const cron = require("node-cron");
const unzipper = require("unzipper");
const backupCfg = require("./backup.config.js");
const { askAI, setBotEnabled, getBotEnabled } = require("./chatbot");
const PDFDocument = require("pdfkit");
const puppeteer = require("puppeteer");

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const DB = path.join(__dirname, "database");

let sock;
let waStatus = "disconnected"; // "disconnected" | "connecting" | "qr" | "pairing" | "connected"
let waQRData = null;
let waPairingCode = null;
let reconnectTimer = null;
let pairingPhoneNumber = null;

// ── WhatsApp BOT START ────────────────────────────────────────
async function startBot(phoneNumber = null) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  waStatus = "connecting";
  waQRData = null;
  waPairingCode = null;

  try {
    const baileys = await import("@whiskeysockets/baileys");
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      Browsers,
      fetchLatestBaileysVersion,
    } = baileys;

    const { version } = await fetchLatestBaileysVersion();
    console.log("🔧 Using Baileys WA version:", version.join("."));

    const { state, saveCreds } = await useMultiFileAuthState("auth");

    sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.windows("Chrome"),
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 3000,
      maxMsgRetryCount: 5,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    // ── Request pairing code for phone number ──────────────────
    if (phoneNumber && !state.creds?.registered) {
      pairingPhoneNumber = phoneNumber;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          waPairingCode = code;
          waStatus = "pairing";
          console.log(`🔑 Pairing code for ${phoneNumber}: ${code}`);
        } catch (e) {
          console.error("❌ Failed to get pairing code:", e.message);
        }
      }, 3000);
    }

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr && !phoneNumber) {
        waStatus = "qr";
        qrcodeTerminal.generate(qr, { small: true });
        console.log("📱 QR Ready — scan in the app or terminal");
        try {
          waQRData = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
        } catch (e) {
          console.error("QR generate error:", e.message);
        }
      }

      if (connection === "open") {
        waStatus = "connected";
        waQRData = null;
        waPairingCode = null;
        pairingPhoneNumber = null;
        console.log("✅ WhatsApp Connected");
      }

      if (connection === "close") {
        waStatus = "disconnected";
        waQRData = null;
        waPairingCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === 401) {
          console.log("🚪 Logged out — clearing session");
          fs.rmSync(path.join(__dirname, "auth"), { recursive: true, force: true });
        }

        console.log("🔁 Reconnecting in 6s...");
        reconnectTimer = setTimeout(() => startBot(), 6000);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // ── Auto-reply incoming WhatsApp messages with AI ──────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";

        if (!text.trim()) continue;

        const from = msg.key.remoteJid;

        console.log(`💬 WA message from ${from}: ${text.substring(0, 80)}`);

        try {
          const reply = await askAI(text.trim(), from);
          if (reply && String(reply).trim()) {
            await sock.sendMessage(from, { text: reply }, { quoted: msg });
            console.log(`📤 WA auto-reply sent to ${from}`);
          } else {
            console.log(`🤐 No good answer for "${text.substring(0, 60)}" — staying silent`);
          }
        } catch (err) {
          console.error("❌ WA auto-reply error:", err.message);
        }
      }
    });

  } catch (err) {
    console.error("❌ BOT ERROR:", err.message);
    waStatus = "disconnected";
    console.log("🔁 Retrying in 10s...");
    reconnectTimer = setTimeout(() => startBot(), 10000);
  }
}

startBot();

// ── Read config.js for server-side settings ────────────────────
function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const get = (key) => {
      const m = raw.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`));
      return m ? m[1] : null;
    };
    // Parse the termsAndConditions array
    const termsMatch = raw.match(/termsAndConditions\s*:\s*\[([\s\S]*?)\]/);
    const terms = termsMatch
      ? [...termsMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
      : [];
    return {
      timezone:        get("timezone")        || "Asia/Colombo",
      businessName:    get("businessName")    || "SD COMPUTERS",
      businessAddress: get("businessAddress") || "",
      businessPhone:   get("businessPhone")   || "",
      businessEmail:   get("businessEmail")   || "",
      currencyLocale:  get("currencyLocale")  || "en-LK",
      currencyCode:    get("currencyCode")    || "LKR",
      currencySymbol:  get("currencySymbol")  || "Rs",
      invoiceFooter:   get("invoiceFooter")   || "Thank you for your purchase!",
      terms,
    };
  } catch {
    return {
      timezone: "Asia/Colombo",
      businessName: "SD COMPUTERS",
      businessAddress: "", businessPhone: "", businessEmail: "",
      currencyLocale: "en-LK", currencyCode: "LKR", currencySymbol: "Rs",
      invoiceFooter: "Thank you for your purchase!",
      terms: [],
    };
  }
}

// ── PDF GENERATOR ─────────────────────────────────────────────
function getBiz() {
  const cfg = readConfig();
  return {
    name:       cfg.businessName,
    address:    cfg.businessAddress,
    phone:      cfg.businessPhone,
    email:      cfg.businessEmail,
    tz:         cfg.timezone,
    locale:     cfg.currencyLocale,
    curCode:    cfg.currencyCode,
    curSymbol:  cfg.currencySymbol,
    footer:     cfg.invoiceFooter,
    terms:      cfg.terms,
  };
}

function fmtRs(n) {
  return "Rs. " + Number(n).toFixed(2);
}

function getBaseUrl(req = null) {
  if (req) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${protocol}://${host}`;
  }
  return "https://34ny5z-5000.csb.app";
}

async function generateInvoicePDF(invoice, customer) {
  const isInvoice = invoice.docType !== "receipt";
  let qrBuffer = null;
  if (isInvoice) {
    try {
      const verifyUrl = `${getBaseUrl()}/verify/${invoice.id}`;
      qrBuffer = await QRCode.toBuffer(verifyUrl, { width: 90, margin: 1, color: { dark: "#1a3a5c", light: "#ffffff" } });
    } catch (e) { console.error("QR buffer error:", e.message); }
  }

  return new Promise((resolve, reject) => {
    const biz = getBiz();
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const sym = biz.curSymbol || "Rs";
    const blue = "#1a3a5c";
    const gray = "#555555";
    const light = "#f5f5f5";
    const pageW = doc.page.width - 100; // usable width

    // ── Header ─────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 100).fill(blue);
    doc.fillColor("white").fontSize(22).font("Helvetica-Bold")
      .text(biz.name, 50, 28, { width: pageW });
    doc.fontSize(9).font("Helvetica").fillColor("#ccd6e0");
    const headerLines = [biz.address, biz.phone, biz.email].filter(Boolean).join("  |  ");
    doc.text(headerLines, 50, 58, { width: pageW });

    // ── Invoice Title ──────────────────────────────────────────
    const docLabel = (invoice.docType === "receipt" ? "SALES RECEIPT" : "INVOICE").toUpperCase();
    doc.moveDown(2);
    doc.fillColor(blue).fontSize(16).font("Helvetica-Bold").text(docLabel, { align: "center" });
    doc.moveDown(0.3);
    doc.strokeColor("#dddddd").lineWidth(1).moveTo(50, doc.y).lineTo(50 + pageW, doc.y).stroke();
    doc.moveDown(0.5);

    // ── Invoice Meta ───────────────────────────────────────────
    const metaTop = doc.y;
    doc.fillColor(gray).fontSize(9).font("Helvetica-Bold").text("Invoice No:", 50, metaTop);
    doc.font("Helvetica").text(invoice.id, 130, metaTop);
    doc.font("Helvetica-Bold").text("Date:", 50, metaTop + 16);
    const dateStr = new Date(invoice.date).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: biz.tz || "Asia/Colombo",
    });
    doc.font("Helvetica").text(dateStr, 130, metaTop + 16);
    if (customer) {
      doc.font("Helvetica-Bold").text("Customer:", 50, metaTop + 32);
      doc.font("Helvetica").text(customer.name || "", 130, metaTop + 32);
      if (customer.phone) {
        doc.font("Helvetica-Bold").text("Phone:", 50, metaTop + 48);
        doc.font("Helvetica").text(customer.phone, 130, metaTop + 48);
      }
    }
    doc.font("Helvetica-Bold").text("Payment:", 350, metaTop);
    doc.font("Helvetica").text((invoice.paymentMethod || "CASH").toUpperCase(), 415, metaTop);
    doc.font("Helvetica-Bold").text("Status:", 350, metaTop + 16);
    doc.font("Helvetica").fillColor(invoice.status === "completed" ? "#27ae60" : gray)
      .text((invoice.status || "completed").toUpperCase(), 415, metaTop + 16);

    doc.moveDown(4.5);

    // ── Items Table Header ─────────────────────────────────────
    const tableTop = doc.y;
    const col = { name: 50, qty: 290, price: 350, disc: 420, total: 480 };

    doc.rect(50, tableTop, pageW, 20).fill(blue);
    doc.fillColor("white").fontSize(9).font("Helvetica-Bold");
    doc.text("ITEM", col.name + 4, tableTop + 5);
    doc.text("QTY", col.qty, tableTop + 5);
    doc.text("PRICE", col.price, tableTop + 5);
    doc.text("DISC%", col.disc, tableTop + 5);
    doc.text("TOTAL", col.total, tableTop + 5);

    // ── Items Rows ─────────────────────────────────────────────
    let rowY = tableTop + 22;
    (invoice.items || []).forEach((item, i) => {
      const bg = i % 2 === 0 ? "#ffffff" : light;
      const lineTotal = item.lineTotal !== undefined
        ? item.lineTotal
        : (item.price * item.qty * (1 - (item.discountPct || 0) / 100));
      doc.rect(50, rowY, pageW, 18).fill(bg);
      doc.fillColor("#222222").fontSize(8.5).font("Helvetica");
      doc.text(String(item.name || "").substring(0, 38), col.name + 4, rowY + 4, { width: 230 });
      doc.text(String(item.qty), col.qty, rowY + 4, { width: 50 });
      doc.text(`${sym}.${Number(item.price).toFixed(2)}`, col.price, rowY + 4, { width: 65 });
      doc.text(item.discountPct > 0 ? `${item.discountPct}%` : "—", col.disc, rowY + 4, { width: 55 });
      doc.text(`${sym}.${Number(lineTotal).toFixed(2)}`, col.total, rowY + 4, { width: 65 });
      rowY += 18;
    });

    // Bottom border of table
    doc.strokeColor("#dddddd").lineWidth(0.5).moveTo(50, rowY).lineTo(50 + pageW, rowY).stroke();
    rowY += 10;

    // ── Totals ─────────────────────────────────────────────────
    const totalsX = 380;
    const valX = 480;
    const addTotal = (label, value, bold = false, color = "#222222") => {
      doc.fillColor(color).fontSize(9)
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .text(label, totalsX, rowY, { width: 90, align: "right" });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica")
        .text(value, valX, rowY, { width: 70, align: "right" });
      rowY += 16;
    };

    addTotal("Subtotal:", `${sym}.${Number(invoice.subtotal || 0).toFixed(2)}`);
    if ((invoice.itemDiscountTotal || 0) > 0)
      addTotal("Item Discounts:", `-${sym}.${Number(invoice.itemDiscountTotal).toFixed(2)}`, false, "#e74c3c");
    if ((invoice.discountAmt || 0) > 0)
      addTotal("Discount:", `-${sym}.${Number(invoice.discountAmt).toFixed(2)}`, false, "#e74c3c");
    if ((invoice.taxAmt || 0) > 0)
      addTotal(`Tax (${invoice.taxPct}%):`, `${sym}.${Number(invoice.taxAmt).toFixed(2)}`);

    rowY += 4;
    doc.rect(totalsX - 10, rowY - 4, pageW - totalsX + 60, 24).fill(blue);
    doc.fillColor("white").fontSize(11).font("Helvetica-Bold")
      .text("TOTAL", totalsX, rowY + 3, { width: 90, align: "right" });
    doc.text(`${sym}.${Number(invoice.total).toFixed(2)}`, valX, rowY + 3, { width: 70, align: "right" });
    rowY += 36;

    // ── Terms & Conditions ─────────────────────────────────────
    if (biz.terms && biz.terms.length > 0) {
      doc.fillColor(gray).fontSize(8).font("Helvetica-Bold").text("Terms & Conditions:", 50, rowY);
      rowY += 12;
      biz.terms.forEach((t) => {
        doc.font("Helvetica").text(`• ${t}`, 50, rowY, { width: pageW });
        rowY += 11;
      });
      rowY += 5;
    }

    // ── Footer ─────────────────────────────────────────────────
    // ── QR Verification Block (invoices only) ──────────────────
    if (isInvoice && qrBuffer) {
      rowY += 6;
      doc.strokeColor("#dddddd").lineWidth(0.5).moveTo(50, rowY).lineTo(50 + pageW, rowY).stroke();
      rowY += 10;
      const qrSize = 70;
      const qrX = 50 + pageW - qrSize;
      doc.image(qrBuffer, qrX, rowY, { width: qrSize, height: qrSize });
      doc.fillColor(blue).fontSize(8).font("Helvetica-Bold")
        .text("SCAN TO VERIFY", qrX, rowY + qrSize + 3, { width: qrSize, align: "center" });
      doc.fillColor(gray).fontSize(7.5).font("Helvetica")
        .text("This QR confirms invoice authenticity", 50, rowY + 4, { width: pageW - qrSize - 10 });
      doc.fillColor(gray).fontSize(7).font("Helvetica")
        .text(`Verify at: ${getBaseUrl()}/verify/${invoice.id}`, 50, rowY + 16, { width: pageW - qrSize - 10 });
      rowY += qrSize + 18;
    }

    doc.strokeColor("#dddddd").lineWidth(0.5).moveTo(50, rowY).lineTo(50 + pageW, rowY).stroke();
    rowY += 8;
    doc.fillColor(gray).fontSize(9).font("Helvetica-BoldOblique")
      .text(biz.footer || "Thank you for your purchase!", 50, rowY, { align: "center", width: pageW });

    doc.end();
  });
}

// Resolve a Chromium executable for Puppeteer.
// Order of precedence:
//   1. PUPPETEER_EXECUTABLE_PATH env var (recommended on Heroku/Render/Railway)
//   2. GOOGLE_CHROME_BIN env var (Heroku buildpack convention)
//   3. `which chromium` / `chromium-browser` / `google-chrome` on PATH (Replit/Nix, Docker)
//   4. Puppeteer's bundled Chrome (npm install + `npx puppeteer browsers install chrome`)
//   5. undefined → puppeteer.launch() will try its own default
let CHROMIUM_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.GOOGLE_CHROME_BIN ||
  "";

if (!CHROMIUM_PATH) {
  try {
    CHROMIUM_PATH = require("child_process")
      .execSync(
        "command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || command -v google-chrome 2>/dev/null || command -v google-chrome-stable 2>/dev/null"
      )
      .toString()
      .trim();
  } catch {
    CHROMIUM_PATH = "";
  }
}

if (!CHROMIUM_PATH) {
  try {
    const candidate = puppeteer.executablePath();
    if (candidate && fs.existsSync(candidate)) CHROMIUM_PATH = candidate;
  } catch { /* puppeteer browser not downloaded */ }
}

console.log("🖨️  Chromium for PDFs:", CHROMIUM_PATH || "(not found — PDF disabled, text-only WhatsApp invoices)");

// ── HTML → PDF via Puppeteer (matches system invoice exactly) ─
async function htmlToPdf(htmlFragment) {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <base href="${baseUrl}">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: white; font-family: Arial, sans-serif; }
    img { max-width: 100%; }
  </style>
</head>
<body>${htmlFragment}</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 20000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

// ── BUILD TEXT SUMMARY ─────────────────────────────────────────
function buildWhatsAppMessage(invoice, customer) {
  const biz = getBiz();
  const lines = [];
  lines.push(`🧾 *${biz.name}*`);
  lines.push(`📍 ${biz.address}`);
  lines.push(`📞 ${biz.phone}`);
  lines.push("─────────────────────");
  lines.push(`*${invoice.docType === "receipt" ? "SALES RECEIPT" : "INVOICE"}*`);
  lines.push(`ID: ${invoice.id}`);
  lines.push(`Date: ${new Date(invoice.date).toLocaleString(biz.locale, { timeZone: biz.tz })}`);
  if (customer) lines.push(`Customer: ${customer.name}`);
  lines.push("─────────────────────");
  lines.push("*Items:*");
  (invoice.items || []).forEach((item) => {
    const lineTotal = item.lineTotal !== undefined
      ? item.lineTotal
      : (item.price * item.qty * (1 - (item.discountPct || 0) / 100));
    let line = `• ${item.name} x${item.qty} — Rs.${Number(lineTotal).toFixed(2)}`;
    if (item.discountPct > 0) line += ` _(${item.discountPct}% off)_`;
    lines.push(line);
  });
  lines.push("─────────────────────");
  if ((invoice.itemDiscountTotal || 0) > 0)
    lines.push(`Item Discounts: -Rs.${Number(invoice.itemDiscountTotal).toFixed(2)}`);
  if ((invoice.discountAmt || 0) > 0)
    lines.push(`Discount: -Rs.${Number(invoice.discountAmt).toFixed(2)}`);
  if ((invoice.taxAmt || 0) > 0)
    lines.push(`Tax (${invoice.taxPct}%): Rs.${Number(invoice.taxAmt).toFixed(2)}`);
  lines.push(`*💰 Total: Rs.${Number(invoice.total).toFixed(2)}*`);
  lines.push(`Payment: ${(invoice.paymentMethod || "cash").toUpperCase()}`);
  lines.push("─────────────────────");
  lines.push(`_${biz.footer} 🙏_`);
  return lines.join("\n");
}

// ── SEND WHATSAPP INVOICE (text + HTML document) ──────────────
async function sendWhatsAppInvoice(phone, invoice, customer, htmlString) {
  console.log(`📱 WA send attempt → phone:${phone} id:${invoice?.id} status:${waStatus}`);
  try {
    if (!sock || waStatus !== "connected") {
      console.log("⚠️ WhatsApp not connected — skipping invoice send");
      return;
    }

    // Clean phone: digits only, remove leading 0
    const raw     = String(phone).replace(/\D/g, "");
    const cleaned = raw.startsWith("0") ? raw.slice(1) : raw;
    const withCC  = cleaned.startsWith("94") ? cleaned : "94" + cleaned;
    const jid = withCC + "@s.whatsapp.net";
    console.log(`📞 JID resolved: ${jid}`);

    // 1. Send text summary first
    const textMsg = buildWhatsAppMessage(invoice, customer);
    await sock.sendMessage(jid, { text: textMsg });
    console.log("📨 WhatsApp text sent to", phone);

    // 2. Convert the exact same invoice HTML (from frontend) to PDF and send
    if (htmlString) {
      try {
        const pdfBuffer = await htmlToPdf(htmlString);
        const docLabel = (invoice.docType === "receipt") ? "Receipt" : "Invoice";
        await sock.sendMessage(jid, {
          document: pdfBuffer,
          mimetype: "application/pdf",
          fileName: `${docLabel}-${invoice.id}.pdf`,
          caption: `📄 ${docLabel} ${invoice.id} — attached`,
        });
        console.log("✅ WhatsApp PDF sent to", phone);
      } catch (pdfErr) {
        console.error("❌ PDF generation error:", pdfErr.message);
      }
    }

  } catch (err) {
    console.error("❌ WhatsApp send error:", err.message);
  }
}

// ── Ensure all DB files exist ─────────────────────────────────
const VALID_TYPES = [
  "products",
  "customers",
  "invoices",
  "expenses",
  "categories",
  "discounts",
  "purchasing",
];

if (!fs.existsSync(DB)) fs.mkdirSync(DB, { recursive: true });

VALID_TYPES.forEach((type) => {
  const file = path.join(DB, `${type}.json`);
  if (!fs.existsSync(file)) {
    const defaults =
      type === "categories"
        ? ["General", "Electronics", "Accessories", "Software", "Services"]
        : [];
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2), "utf8");
  }
});

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname)));

// ── API: WhatsApp status ──────────────────────────────────────
app.get("/api/whatsapp/status", (req, res) => {
  res.json({
    status: waStatus,
    qr: waQRData,
    pairingCode: waPairingCode,
    pairingPhone: pairingPhoneNumber,
  });
});

// Start pairing with a phone number
app.post("/api/whatsapp/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length < 7) return res.status(400).json({ error: "Invalid phone number" });

  if (sock) { try { sock.end(undefined); } catch {} }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  startBot(cleaned);
  res.json({ ok: true, phone: cleaned });
});

app.post("/api/whatsapp/logout", async (req, res) => {
  try {
    if (sock) { try { sock.end(undefined); } catch {} }
    waStatus = "disconnected";
    waQRData = null;
    waPairingCode = null;
    pairingPhoneNumber = null;
    fs.rmSync(path.join(__dirname, "auth"), { recursive: true, force: true });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => startBot(), 1000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: send plain WhatsApp message to a customer ───────────
app.post("/api/whatsapp/send-message", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });

  if (!sock || waStatus !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const cleaned = String(phone).replace(/\D/g, "").replace(/^0+/, "");
    const jid = cleaned + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });
    console.log(`📨 Custom WA message sent to ${phone}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("WA send-message error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: read ────────────────────────────────────────────────
app.get("/api/data/:type", (req, res) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type))
    return res.status(400).json({ error: "Invalid type" });

  try {
    const raw = fs.readFileSync(path.join(DB, `${type}.json`), "utf8");
    res.json(JSON.parse(raw || "[]"));
  } catch {
    res.json([]);
  }
});

// ── API: save ─────────────────────────────────────────────────
app.post("/api/data/:type", async (req, res) => {
  const { type } = req.params;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: "Invalid type" });
  }

  try {
    const filePath = path.join(DB, `${type}.json`);
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error(`Error saving ${type}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: convert invoice HTML → PDF download ──────────────────
app.post("/api/invoice-pdf", express.json({ limit: "2mb" }), async (req, res) => {
  const { html, filename } = req.body || {};
  if (!html) return res.status(400).json({ error: "html is required" });
  try {
    const pdfBuffer = await htmlToPdf(html);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename || "invoice.pdf"}"`,
      "Content-Length": pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (e) {
    console.error("invoice-pdf error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: send invoice via WhatsApp (HTML from client) ─────────
app.post("/api/whatsapp/send-invoice-html", async (req, res) => {
  const { phone, html, invoiceId, invoice, customerName } = req.body;

  if (!phone || !html) {
    return res.status(400).json({ error: "phone and html are required" });
  }

  if (!sock || waStatus !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const customer = customerName ? { name: customerName } : null;
    await sendWhatsAppInvoice(phone, invoice || { id: invoiceId || "INV" }, customer, html);
    res.json({ ok: true });
  } catch (err) {
    console.error("send-invoice-html error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BACKUP SYSTEM ─────────────────────────────────────────────
let lastBackup = { status: "never", time: null, file: null, error: null };

function validateBackupBuffer(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!Array.isArray(parsed)) return { ok: false, error: "Backup must be a JSON array" };
    for (const item of parsed) {
      if (!item || typeof item !== "object" || !item.type || !Array.isArray(item.data)) {
        return { ok: false, error: "Invalid backup entry format" };
      }
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: "Backup file is not valid JSON" };
  }
}

function snapshotCurrentData() {
  const snapshot = {};
  for (const type of VALID_TYPES) {
    const file = path.join(DB, `${type}.json`);
    snapshot[type] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "[]";
  }
  return snapshot;
}

function restoreSnapshot(snapshot) {
  for (const type of VALID_TYPES) {
    const file = path.join(DB, `${type}.json`);
    fs.writeFileSync(file, snapshot[type] ?? "[]", "utf8");
  }
}

function parseBackupPayload(buffer) {
  const validated = validateBackupBuffer(buffer);
  if (!validated.ok) throw new Error(validated.error);
  const out = {};
  for (const entry of validated.data) out[entry.type] = entry.data;
  return out;
}

async function parseZipBackup(buffer) {
  const files = {};
  const directory = await unzipper.Open.buffer(buffer);
  for (const file of directory.files) {
    if (!file.path.endsWith(".json")) continue;
    const type = path.basename(file.path, ".json");
    const content = await file.buffer();
    files[type] = JSON.parse(content.toString("utf8"));
  }
  return files;
}

function zipDatabaseToBuffer() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    const dbFiles = fs.readdirSync(DB).filter((f) => f.endsWith(".json"));
    dbFiles.forEach((f) => {
      archive.file(path.join(DB, f), { name: f });
    });

    archive.finalize();
  });
}

function dropboxUpload(buffer, remotePath) {
  return new Promise((resolve, reject) => {
    const apiArg = JSON.stringify({
      path: remotePath,
      mode: "add",
      autorename: true,
      mute: false,
    });

    const options = {
      hostname: "content.dropboxapi.com",
      path: "/2/files/upload",
      method: "POST",
      headers: {
        Authorization: `Bearer ${backupCfg.DROPBOX_TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg,
        "Content-Length": buffer.length,
      },
    };

    if (!backupCfg.DROPBOX_TOKEN || backupCfg.DROPBOX_TOKEN.trim().length < 20) {
      reject(new Error("Dropbox token is missing or invalid"));
      return;
    }

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Dropbox API error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

async function runBackup() {
  try {
    console.log("☁️  Starting Dropbox backup...");
    lastBackup = { status: "running", time: new Date().toISOString(), file: null, error: null };

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const fileName = `SD-POS-Backup-${stamp}.zip`;
    const remotePath = `${backupCfg.DROPBOX_FOLDER}/${fileName}`;

    const buf = await zipDatabaseToBuffer();
    const result = await dropboxUpload(buf, remotePath);

    lastBackup = { status: "ok", time: new Date().toISOString(), file: result.path_display || remotePath, error: null };
    console.log(`✅ Backup uploaded: ${lastBackup.file}`);
    return lastBackup;
  } catch (err) {
    lastBackup = { status: "error", time: new Date().toISOString(), file: null, error: err.message };
    console.error("❌ Backup failed:", err.message);
    throw err;
  }
}

// Monthly cron schedule
cron.schedule(backupCfg.BACKUP_SCHEDULE, () => {
  console.log("🗓️  Monthly backup triggered by scheduler");
  runBackup().catch(() => {});
});

// ── Backup API endpoints ───────────────────────────────────────
app.post("/api/backup/run", async (req, res) => {
  try {
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/backup/status", (req, res) => {
  res.json(lastBackup);
});

app.post("/api/backup/restore", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  const backupSnapshot = snapshotCurrentData();
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: "Backup file is required" });
    }
    const restored = await parseZipBackup(req.body);
    const restoredTypes = Object.keys(restored);
    if (restoredTypes.length === 0) {
      throw new Error("Backup archive is empty or invalid");
    }
    for (const type of VALID_TYPES) {
      const file = path.join(DB, `${type}.json`);
      const data = restored[type] ?? [];
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    }
    res.json({ ok: true });
  } catch (err) {
    try {
      restoreSnapshot(backupSnapshot);
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr.message);
    }
    res.status(400).json({ ok: false, error: err.message, rolledBack: true });
  }
});

// ── AI Chatbot API ────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  try {
    const reply = await askAI(message, ip);
    res.json({ reply: reply || "" });
  } catch (err) {
    console.error("Chat API error:", err.message);
    res.status(500).json({ error: "AI error", reply: "Sorry, something went wrong. Please try again." });
  }
});

app.get("/api/chat/status", (req, res) => {
  res.json({ enabled: getBotEnabled() });
});

app.post("/api/chat/toggle", (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
  setBotEnabled(enabled);
  console.log(`🤖 AI Chatbot ${enabled ? "enabled" : "disabled"}`);
  res.json({ ok: true, enabled: getBotEnabled() });
});

// ── Invoice QR Code Image ─────────────────────────────────────
app.get("/api/qr/:id", async (req, res) => {
  try {
    const verifyUrl = `${getBaseUrl(req)}/verify/${req.params.id}`;
    const buf = await QRCode.toBuffer(verifyUrl, { width: 120, margin: 1, color: { dark: "#1a3a5c", light: "#ffffff" } });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invoice Verification Page ─────────────────────────────────
app.get("/verify/:id", (req, res) => {
  const id = req.params.id;
  try {
    const invoicesRaw = fs.readFileSync(path.join(DB, "invoices.json"), "utf8");
    const invoices = JSON.parse(invoicesRaw || "[]");
    const invoice = invoices.find((i) => i.id === id);

    if (!invoice) {
      return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice Not Found</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;font-family:Arial,sans-serif;background:#f0f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh;}
        .box{background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px;}
        .icon{font-size:60px;margin-bottom:16px;} h2{color:#e74c3c;} p{color:#555;}</style></head>
        <body><div class="box"><div class="icon">❌</div><h2>Invoice Not Found</h2>
        <p>No invoice found with ID <strong>${id}</strong>.</p></div></body></html>`);
    }

    if (invoice.docType === "receipt") {
      return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Available</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;font-family:Arial,sans-serif;background:#f0f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh;}
        .box{background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px;}
        .icon{font-size:60px;margin-bottom:16px;} h2{color:#e67e22;} p{color:#555;}</style></head>
        <body><div class="box"><div class="icon">🧾</div><h2>Receipts Not Verifiable</h2>
        <p>Verification is only available for official invoices.</p></div></body></html>`);
    }

    const customersRaw = fs.readFileSync(path.join(DB, "customers.json"), "utf8");
    const customers = JSON.parse(customersRaw || "[]");
    const customer = customers.find((c) => c.id === invoice.customer);
    const biz = getBiz();

    const itemRows = (invoice.items || []).map((it, i) => {
      const lineTotal = it.lineTotal !== undefined ? it.lineTotal : it.price * it.qty * (1 - (it.discountPct || 0) / 100);
      const bg = i % 2 === 0 ? "#f8fafc" : "#fff";
      return `<tr style="background:${bg}">
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${it.name}${it.serialNo ? `<br><small style="color:#888">S/N: ${it.serialNo}</small>` : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${Number(it.qty).toFixed(2)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${biz.curSymbol || "Rs"}.${Number(it.price).toFixed(2)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${biz.curSymbol || "Rs"}.${Number(lineTotal).toFixed(2)}</td>
      </tr>`;
    }).join("");

    const dateStr = new Date(invoice.date).toLocaleString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice Verified — ${invoice.id}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#1a3a5c 0%,#2563a8 100%);min-height:100vh;padding:20px;}
    .wrap{max-width:600px;margin:auto;}
    .badge{background:#fff;border-radius:16px 16px 0 0;padding:28px 28px 20px;text-align:center;border-bottom:3px solid #22c55e;}
    .badge-icon{font-size:56px;margin-bottom:8px;}
    .badge h1{color:#15803d;font-size:22px;margin-bottom:4px;}
    .badge p{color:#555;font-size:13px;}
    .inv-id{display:inline-block;background:#f0fdf4;border:1px solid #86efac;color:#15803d;padding:4px 16px;border-radius:999px;font-size:13px;font-weight:700;margin-top:8px;}
    .card{background:#fff;padding:24px 28px;margin-top:0;}
    .card+.card{border-top:1px solid #f0f0f0;}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:12px;}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
    .info-item label{display:block;font-size:11px;color:#9ca3af;margin-bottom:2px;}
    .info-item span{font-size:14px;color:#111;font-weight:600;}
    table{width:100%;border-collapse:collapse;font-size:13px;}
    thead tr{background:#1a3a5c;color:#fff;}
    thead th{padding:10px 12px;text-align:left;font-weight:600;}
    thead th:last-child,thead th:nth-child(3),thead th:nth-child(2){text-align:right;text-align:center;}
    thead th:last-child{text-align:right;}
    .totals{margin-top:8px;display:flex;justify-content:flex-end;}
    .totals table{width:auto;min-width:200px;}
    .totals td{padding:5px 0 5px 20px;font-size:13px;}
    .totals .grand td{font-size:16px;font-weight:700;color:#1a3a5c;border-top:2px solid #1a3a5c;padding-top:8px;}
    .footer{background:#fff;border-radius:0 0 16px 16px;padding:18px 28px;text-align:center;border-top:1px solid #e5e7eb;}
    .footer p{color:#9ca3af;font-size:11px;}
    .watermark{text-align:center;padding:16px 0 0;color:rgba(255,255,255,.5);font-size:11px;}
  </style>
</head>
<body>
<div class="wrap">
  <!-- Verified Badge -->
  <div class="badge">
    <div class="badge-icon">✅</div>
    <h1>Invoice Verified</h1>
    <p>This is an authentic invoice from <strong>${biz.name || "SD COMPUTERS"}</strong></p>
    <span class="inv-id">${invoice.id}</span>
  </div>

  <!-- Business & Invoice Info -->
  <div class="card">
    <div class="section-title">Invoice Details</div>
    <div class="info-grid">
      <div class="info-item"><label>Invoice Number</label><span>${invoice.id}</span></div>
      <div class="info-item"><label>Date</label><span>${dateStr}</span></div>
      <div class="info-item"><label>Customer</label><span>${customer ? customer.name : "Walk-in Customer"}</span></div>
      <div class="info-item"><label>Payment Method</label><span>${(invoice.paymentMethod || "Cash").toUpperCase()}</span></div>
      <div class="info-item"><label>Status</label><span style="color:#15803d;">${(invoice.status || "Completed").toUpperCase()}</span></div>
      ${customer && customer.phone ? `<div class="info-item"><label>Phone</label><span>${customer.phone}</span></div>` : ""}
    </div>
  </div>

  <!-- Items Table -->
  <div class="card">
    <div class="section-title">Items Purchased</div>
    <table>
      <thead><tr>
        <th>Item</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Price</th>
        <th style="text-align:right;">Total</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div class="totals">
      <table>
        ${(invoice.itemDiscountTotal || 0) > 0 ? `<tr><td style="color:#6b7280;">Item Discounts</td><td style="text-align:right;color:#dc2626;">-${biz.curSymbol || "Rs"}.${Number(invoice.itemDiscountTotal).toFixed(2)}</td></tr>` : ""}
        ${(invoice.discountAmt || 0) > 0 ? `<tr><td style="color:#6b7280;">Discount</td><td style="text-align:right;color:#dc2626;">-${biz.curSymbol || "Rs"}.${Number(invoice.discountAmt).toFixed(2)}</td></tr>` : ""}
        ${(invoice.taxAmt || 0) > 0 ? `<tr><td style="color:#6b7280;">Tax (${invoice.taxPct}%)</td><td style="text-align:right;">${biz.curSymbol || "Rs"}.${Number(invoice.taxAmt).toFixed(2)}</td></tr>` : ""}
        <tr class="grand"><td><strong>Grand Total</strong></td><td style="text-align:right;"><strong>${biz.curSymbol || "Rs"}.${Number(invoice.total).toFixed(2)}</strong></td></tr>
      </table>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <p>${biz.footer || "Thank you for your purchase!"}</p>
    <p style="margin-top:6px;">${biz.name} &bull; ${biz.phone || ""} &bull; ${biz.email || ""}</p>
  </div>

  <div class="watermark">Verified by ${biz.name} Invoice System</div>
</div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<h3>Error: ${err.message}</h3>`);
  }
});

// ── User / Auth helpers ──────────────────────────────────────
const USERS_FILE = path.join(__dirname, "database", "users.json");

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return []; }
}

function saveUsersDb(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function genUserId() {
  return "usr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Ensure default admin exists on first run
(function ensureAdmin() {
  const users = loadUsers();
  if (users.length === 0) {
    saveUsersDb([{
      id: "usr_admin", username: "admin", password: "admin123",
      role: "admin",
      permissions: ["products","billing","customers","invoices","expenses","purchasing","analytics","settings"],
      createdAt: new Date().toISOString(),
    }]);
  }
})();

// POST /api/auth/login
app.post("/api/auth/login", express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ ok: false, error: "Missing credentials" });
  const users = loadUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid username or password" });
  const { password: _pw, ...safe } = user;
  res.json({ ok: true, user: safe });
});

// Middleware: require caller to be an admin
function requireAdmin(req, res, next) {
  const callerUsername = req.headers["x-pos-user"] || "";
  const users = loadUsers();
  const caller = users.find(u => u.username === callerUsername && u.role === "admin");
  if (!caller) return res.status(403).json({ ok: false, error: "Admin access required" });
  req.callerUser = caller;
  next();
}

// GET /api/employers — list all users (admin only)
app.get("/api/employers", requireAdmin, (req, res) => {
  const users = loadUsers().map(({ password: _pw, ...u }) => u);
  res.json({ ok: true, users });
});

// POST /api/employers — add new user (admin only)
app.post("/api/employers", requireAdmin, express.json(), (req, res) => {
  const { username, password, role, permissions } = req.body || {};
  if (!username || !password || !role)
    return res.status(400).json({ ok: false, error: "username, password and role are required" });
  const users = loadUsers();
  if (users.some(u => u.username === username))
    return res.status(409).json({ ok: false, error: "Username already exists" });
  const newUser = {
    id: genUserId(), username, password, role,
    permissions: permissions || [],
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  saveUsersDb(users);
  const { password: _pw, ...safe } = newUser;
  res.json({ ok: true, user: safe });
});

// PUT /api/employers/:id — update user (admin only)
app.put("/api/employers/:id", requireAdmin, express.json(), (req, res) => {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "User not found" });
  const { password, role, permissions } = req.body || {};
  if (password) users[idx].password = password;
  if (role)     users[idx].role = role;
  if (permissions) users[idx].permissions = permissions;
  saveUsersDb(users);
  const { password: _pw, ...safe } = users[idx];
  res.json({ ok: true, user: safe });
});

// DELETE /api/employers/:id — delete user (admin only, can't delete self or last admin)
app.delete("/api/employers/:id", requireAdmin, (req, res) => {
  const users = loadUsers();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "User not found" });
  if (target.username === req.callerUser.username)
    return res.status(400).json({ ok: false, error: "Cannot delete your own account" });
  const admins = users.filter(u => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1)
    return res.status(400).json({ ok: false, error: "Cannot delete the last admin" });
  saveUsersDb(users.filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

// ── Settings API ─────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, "database", "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ── GITHUB BACKUP ────────────────────────────────────────────
// Daily snapshot of all DB JSON files committed to a private GitHub repo.
let lastGithubBackup = { status: "never", time: null, file: null, sha: null, error: null };
let githubCronJob = null;

// Keys whose values must NEVER be committed to GitHub (secret scanning
// will otherwise reject the push with "Repository rule violations found").
const BACKUP_REDACT_KEYS = new Set([
  "githubToken",
  "mistralApiKey",
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "twilioAuthToken",
  "twilioAccountSid",
  "stripeSecretKey",
  "dropboxToken",
  "dropboxRefreshToken",
  "dropboxAppSecret",
  "smtpPassword",
  "sessionSecret",
  "jwtSecret",
  "apiKey",
  "secret",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "privateKey",
]);

function isLikelySecretValue(v) {
  if (typeof v !== "string" || v.length < 20) return false;
  // Common API key prefixes
  return /^(sk-|pk_|nvapi-|AIza|ghp_|github_pat_|xox[abp]-|gho_|ghu_|ghs_|ghr_|AKIA|ASIA|hf_)/.test(v);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (BACKUP_REDACT_KEYS.has(k) && v) {
        out[k] = "***REDACTED***";
      } else if (typeof v === "string" && isLikelySecretValue(v)) {
        out[k] = "***REDACTED***";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function buildBackupSnapshotJson() {
  const dbFiles = fs.readdirSync(DB).filter((f) => f.endsWith(".json"));
  const snapshot = {
    app: "SD POS",
    version: 1,
    createdAt: new Date().toISOString(),
    redacted: true,
    note: "Secret values (API keys, tokens, passwords) have been redacted before upload. Restore them from your secure store or .env after restoring.",
    files: {},
  };
  for (const f of dbFiles) {
    try {
      const content = fs.readFileSync(path.join(DB, f), "utf8");
      const parsed = JSON.parse(content);
      snapshot.files[f] = redactSecrets(parsed);
    } catch (e) {
      snapshot.files[f] = { _error: e.message };
    }
  }
  return JSON.stringify(snapshot, null, 2);
}

async function ghRequest(token, urlPath, options = {}) {
  const url = urlPath.startsWith("http") ? urlPath : `https://api.github.com${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "SD-POS-Backup",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body.message || body.raw || res.statusText;
    const err = new Error(`GitHub ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function parseRepo(repoStr) {
  if (!repoStr) throw new Error("Repo is required (format: owner/name)");
  const m = String(repoStr).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").match(/^([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('Repo must be in "owner/name" format');
  return { owner: m[1], repo: m[2] };
}

async function githubBackupRun() {
  const cfg = loadSettings();
  if (!cfg.githubToken) throw new Error("GitHub token not configured");
  if (!cfg.githubRepo) throw new Error("GitHub repo not configured");
  const { owner, repo } = parseRepo(cfg.githubRepo);
  const branch = cfg.githubBranch || "main";

  lastGithubBackup = { status: "running", time: new Date().toISOString(), file: null, sha: null, error: null };
  console.log(`☁️  GitHub backup starting → ${owner}/${repo}@${branch}`);

  try {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const filePath = `backups/SD-POS-${stamp}.json`;
    const content = buildBackupSnapshotJson();
    const contentB64 = Buffer.from(content, "utf8").toString("base64");

    const result = await ghRequest(
      cfg.githubToken,
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `SD POS auto-backup ${stamp}`,
          content: contentB64,
          branch,
        }),
      }
    );

    lastGithubBackup = {
      status: "ok",
      time: new Date().toISOString(),
      file: filePath,
      sha: result.content?.sha || null,
      htmlUrl: result.content?.html_url || null,
      error: null,
    };
    console.log(`✅ GitHub backup committed: ${filePath}`);
    return lastGithubBackup;
  } catch (err) {
    lastGithubBackup = { status: "error", time: new Date().toISOString(), file: null, sha: null, error: err.message };
    console.error("❌ GitHub backup failed:", err.message);
    throw err;
  }
}

async function githubBackupList(limit = 50) {
  const cfg = loadSettings();
  if (!cfg.githubToken || !cfg.githubRepo) throw new Error("GitHub backup not configured");
  const { owner, repo } = parseRepo(cfg.githubRepo);
  const branch = cfg.githubBranch || "main";
  try {
    const list = await ghRequest(
      cfg.githubToken,
      `/repos/${owner}/${repo}/contents/backups?ref=${encodeURIComponent(branch)}`
    );
    if (!Array.isArray(list)) return [];
    return list
      .filter((f) => f.type === "file" && f.name.endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, limit)
      .map((f) => ({ name: f.name, path: f.path, sha: f.sha, size: f.size, htmlUrl: f.html_url, downloadUrl: f.download_url }));
  } catch (err) {
    if (err.status === 404) return []; // no backups folder yet
    throw err;
  }
}

async function githubBackupRestore(filePath) {
  const cfg = loadSettings();
  if (!cfg.githubToken || !cfg.githubRepo) throw new Error("GitHub backup not configured");
  if (!filePath) throw new Error("filePath is required");
  const { owner, repo } = parseRepo(cfg.githubRepo);
  const branch = cfg.githubBranch || "main";

  // Snapshot current state for rollback
  const currentSnapshot = snapshotCurrentData();

  try {
    const fileMeta = await ghRequest(
      cfg.githubToken,
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`
    );
    if (!fileMeta.content) throw new Error("File has no content");
    const decoded = Buffer.from(fileMeta.content, fileMeta.encoding || "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed.files || typeof parsed.files !== "object") throw new Error("Invalid backup format");

    // Merge: restore non-secret data, but preserve any *currently saved* secret
    // values rather than overwriting them with "***REDACTED***" placeholders.
    let preservedSecrets = 0;
    for (const [fname, data] of Object.entries(parsed.files)) {
      const target = path.join(DB, fname);
      let merged = data;
      if (data && typeof data === "object" && !Array.isArray(data) && fs.existsSync(target)) {
        try {
          const current = JSON.parse(fs.readFileSync(target, "utf8"));
          merged = { ...data };
          for (const [k, v] of Object.entries(data)) {
            if (v === "***REDACTED***" && current[k] && current[k] !== "***REDACTED***") {
              merged[k] = current[k];
              preservedSecrets++;
            }
          }
        } catch { /* fall through to plain restore */ }
      }
      fs.writeFileSync(target, JSON.stringify(merged, null, 2), "utf8");
    }
    console.log(`♻️  Restored ${Object.keys(parsed.files).length} files from ${filePath}` + (preservedSecrets ? ` (${preservedSecrets} secret(s) preserved)` : ""));
    return { ok: true, filesRestored: Object.keys(parsed.files).length, secretsPreserved: preservedSecrets };
  } catch (err) {
    try { restoreSnapshot(currentSnapshot); } catch (e) { console.error("Rollback failed:", e.message); }
    throw err;
  }
}

async function githubBackupTest() {
  const cfg = loadSettings();
  if (!cfg.githubToken) throw new Error("GitHub token not configured");
  if (!cfg.githubRepo) throw new Error("GitHub repo not configured");
  const { owner, repo } = parseRepo(cfg.githubRepo);
  const repoInfo = await ghRequest(cfg.githubToken, `/repos/${owner}/${repo}`);
  return {
    ok: true,
    repo: repoInfo.full_name,
    private: repoInfo.private,
    defaultBranch: repoInfo.default_branch,
    permissions: repoInfo.permissions,
  };
}

function scheduleGithubBackup() {
  if (githubCronJob) {
    try { githubCronJob.stop(); } catch {}
    githubCronJob = null;
  }
  const cfg = loadSettings();
  if (!cfg.githubBackupEnabled) {
    console.log("📵 GitHub backup scheduler: disabled");
    return;
  }
  const schedule = cfg.githubBackupSchedule || "0 3 * * *";
  if (!cron.validate(schedule)) {
    console.error("❌ Invalid GitHub backup cron schedule:", schedule);
    return;
  }
  githubCronJob = cron.schedule(
    schedule,
    () => {
      console.log("🗓️  GitHub backup triggered by scheduler");
      githubBackupRun().catch(() => {});
    },
    { timezone: cfg.githubBackupTimezone || "Asia/Colombo" }
  );
  console.log(`⏰ GitHub backup scheduled: "${schedule}" (${cfg.githubBackupTimezone || "Asia/Colombo"})`);
}

// Endpoints
app.get("/api/github-backup/status", (req, res) => {
  const cfg = loadSettings();
  res.json({
    enabled: !!cfg.githubBackupEnabled,
    repo: cfg.githubRepo || "",
    branch: cfg.githubBranch || "main",
    schedule: cfg.githubBackupSchedule || "0 3 * * *",
    timezone: cfg.githubBackupTimezone || "Asia/Colombo",
    tokenSet: !!(cfg.githubToken && cfg.githubToken.length > 10),
    last: lastGithubBackup,
  });
});

app.post("/api/github-backup/run", async (req, res) => {
  try {
    const result = await githubBackupRun();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/github-backup/test", async (req, res) => {
  try {
    const r = await githubBackupTest();
    res.json(r);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/github-backup/list", async (req, res) => {
  try {
    const list = await githubBackupList(parseInt(req.query.limit, 10) || 50);
    res.json({ ok: true, backups: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/github-backup/restore", express.json(), async (req, res) => {
  const { filePath } = req.body || {};
  try {
    const r = await githubBackupRestore(filePath);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function saveSettings(data) {
  const current = loadSettings();
  const merged = { ...current, ...data };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  // Sync back to config.js so the frontend picks up changes
  const cfgPath = path.join(__dirname, "config.js");
  try {
    let raw = fs.readFileSync(cfgPath, "utf8");
    const strFields = [
      "appName","appTagline","businessName","businessAddress","businessPhone",
      "businessEmail","timezone","currencySymbol","currencyCode","currencyLocale",
      "invoiceFooter","chatbotApiUrl","invoiceHeaderColor","invoiceWatermark",
      "receiptFooter","receiptNote","receiptHeaderColor",
    ];
    strFields.forEach((key) => {
      if (merged[key] !== undefined) {
        raw = raw.replace(
          new RegExp(`(${key}\\s*:\\s*)(['"][^'"]*['"])`),
          `$1"${String(merged[key]).replace(/"/g, '\\"')}"`
        );
      }
    });
    const numFields = ["defaultTaxPercent","lowStockThreshold"];
    numFields.forEach((key) => {
      if (merged[key] !== undefined) {
        raw = raw.replace(
          new RegExp(`(${key}\\s*:\\s*)(\\d+(\\.\\d+)?)`),
          `$1${Number(merged[key])}`
        );
      }
    });
    fs.writeFileSync(cfgPath, raw);
  } catch (e) {
    console.error("Config sync error:", e.message);
  }
  return merged;
}

app.get("/api/settings", (req, res) => {
  res.json(loadSettings());
});

app.post("/api/settings", express.json(), (req, res) => {
  try {
    const saved = saveSettings(req.body);
    // Re-arm GitHub backup cron if any of its fields changed
    if (req.body && (
      "githubBackupEnabled" in req.body ||
      "githubBackupSchedule" in req.body ||
      "githubBackupTimezone" in req.body
    )) {
      scheduleGithubBackup();
    }
    res.json({ ok: true, settings: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Initialise GitHub backup scheduler at startup
scheduleGithubBackup();

// ── Routes ───────────────────────────────────────────────────
app.get("/login", (req, res) =>
  res.sendFile(path.join(__dirname, "login.html"))
);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/{*path}", (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🚀 SD POS running on ${PORT}`);
});
