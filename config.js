// ============================================================
//  FuturePOS — App Configuration
//  Edit this file to customise your POS system.
//  Changes here apply instantly — no rebuild needed.
// ============================================================

window.APP_CONFIG = {
  // ── Branding ─────────────────────────────────────────────
  appName: "SD POS",
  appTagline: "smart computer store",

  // ── Business Details (shown on invoices) ─────────────────
  businessName: "SD COMPUTERS",
  businessAddress: "88V3+78G, Polgahawela",
  businessPhone: "+94 76 989 3057",
  businessEmail: "sdcomputers@gmail.com",

  // ── Timezone ─────────────────────────────────────────────
  // Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
  timezone: "Asia/Colombo",
  BASE_URL: "https://34ny5z-5000.csb.app/",

  // ── Currency ─────────────────────────────────────────────
  currencySymbol: "Rs",
  currencyCode: "LKR",
  currencyLocale: "si-LK",

  // ── Inventory ────────────────────────────────────────────
  lowStockThreshold: 5,

  // ── Billing Defaults ─────────────────────────────────────
  defaultTaxPercent: 0,

  // ── Invoice Footer ───────────────────────────────────────
  invoiceFooter: "Thank you for your purchase!",

  // ── AI Chatbot ───────────────────────────────────────────
  chatbotApiUrl: "https://rest-api-ebon-three.vercel.app/ai/openai?text="
};