// ===================== SD POS - ENHANCED POS SYSTEM =====================

// ==================== SESSION & AUTH ====================
const currentUser = sessionStorage.getItem("pos_logged_in");
if (!currentUser) {
  window.location.replace("/login");
}

let currentUserData = null;
try {
  const raw = sessionStorage.getItem("pos_user");
  currentUserData = raw ? JSON.parse(raw) : null;
} catch { currentUserData = null; }

// If logged in but no role data (old session), treat as admin for backward compat
const isAdmin = () => !currentUserData || currentUserData.role === "admin";
const hasPermission = (view) => {
  if (!currentUserData) return true; // backward compat: old sessions get full access
  if (currentUserData.role === "admin") return true;
  return Array.isArray(currentUserData.permissions) && currentUserData.permissions.includes(view);
};

const getStorageKey = (type) => `pos_${type}_${currentUser}`;

// ==================== GLOBAL STATE ====================
let products = [];
let customers = [];
let invoices = [];
let cart = [];
let expenses = [];
let categories = [];
let discountCodes = [];
let purchases = [];
let purchaseItems = [];

// Billing state
let selectedBillingCustomerId = null;

// Charts
let chartDaily = null, chartTop = null, chartCategory = null;

// ==================== UTILITY FUNCTIONS ====================
const $ = (sel) => document.querySelector(sel);
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));
const CFG = window.APP_CONFIG || {};
const CURRENCY_SYMBOL = CFG.currencySymbol || "Rs";
const CURRENCY_LOCALE = CFG.currencyLocale || "en-LK";
const CURRENCY_CODE = CFG.currencyCode || "LKR";
const LOW_STOCK_THRESH = CFG.lowStockThreshold ?? 5;
const DEFAULT_TAX = CFG.defaultTaxPercent ?? 0;
const APP_NAME = CFG.appName || "SD POS";
const APP_TAGLINE = CFG.appTagline || "Next-Gen Point of Sale";
const BIZ_NAME = CFG.businessName || "";
const BIZ_ADDRESS = CFG.businessAddress || "";
const BIZ_PHONE = CFG.businessPhone || "";
const BIZ_EMAIL = CFG.businessEmail || "";
const INVOICE_FOOTER = CFG.invoiceFooter || "Thank you for your purchase!";

const fmt = (n) => Number(n).toFixed(2);

let _toastTimer = null;
function showAppToast(msg, color = "#16a34a", duration = 4000) {
  let el = document.getElementById("app-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toast";
    el.style.cssText = "position:fixed;bottom:28px;right:28px;max-width:340px;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;z-index:99999;box-shadow:0 4px 24px #0005;transition:opacity .4s;pointer-events:none;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = color;
  el.style.opacity = "1";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.opacity = "0"; }, duration);
}

const fmtCurrency = (n) => {
  try {
    return "Rs.\u00a0" + Number(n).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return "Rs. " + Number(n).toFixed(2);
  }
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const timestamp = () => new Date().toISOString();
const genId = () => "id_" + Math.random().toString(36).slice(2, 9);
const TIMEZONE = CFG.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const _dtFmt = { timeZone: TIMEZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true };
const formatDate     = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: TIMEZONE, day: "2-digit", month: "short", year: "numeric" });
const formatTime     = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: true });
const formatDateTime = (iso) => new Date(iso).toLocaleString("en-GB", _dtFmt);

// ==================== DATA PERSISTENCE (FILE-BASED via API) ====================
async function apiGet(type) {
  const res = await fetch(`/api/data/${type}`);
  if (!res.ok) throw new Error(`Failed to load ${type}`);
  return res.json();
}

async function apiSave(type, data) {
  return fetch(`/api/data/${type}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(data),
  });
}

async function loadAllData() {
  try {
    // ── One-time migration: move localStorage data into files ──────────────
    const legacyProducts = localStorage.getItem(getStorageKey("products"));
    if (legacyProducts) {
      console.log("Migrating localStorage data to server files...");
      const lProducts      = JSON.parse(legacyProducts || "[]");
      const lInvoices      = JSON.parse(localStorage.getItem(getStorageKey("invoices"))   || "[]");
      const lCustomers     = JSON.parse(localStorage.getItem(getStorageKey("customers"))  || "[]");
      const lExpenses      = JSON.parse(localStorage.getItem(getStorageKey("expenses"))   || "[]");
      const lCategories    = JSON.parse(localStorage.getItem(getStorageKey("categories"))|| "[]");
      const lDiscounts     = JSON.parse(localStorage.getItem(getStorageKey("discounts"))  || "[]");
      const lPurchases     = JSON.parse(localStorage.getItem(getStorageKey("purchases"))  || "[]");

      await Promise.all([
        apiSave("products",   lProducts),
        apiSave("invoices",   lInvoices),
        apiSave("customers",  lCustomers),
        apiSave("expenses",   lExpenses),
        apiSave("categories", lCategories.length ? lCategories : ["General","Electronics","Accessories","Software","Services"]),
        apiSave("discounts",  lDiscounts),
        apiSave("purchasing", lPurchases),
      ]);

      // Clear legacy localStorage keys
      ["products","invoices","customers","expenses","categories","discounts","purchases"].forEach((t) => {
        localStorage.removeItem(getStorageKey(t));
      });
      console.log("Migration complete — data saved to database files.");
    }

    // ── Load all data from the server files ────────────────────────────────
    [products, invoices, customers, expenses, categories, discountCodes, purchases] =
      await Promise.all([
        apiGet("products"),
        apiGet("invoices"),
        apiGet("customers"),
        apiGet("expenses"),
        apiGet("categories"),
        apiGet("discounts"),
        apiGet("purchasing"),
      ]);

    // ── Normalise fields for older records ─────────────────────────────────
    products = products.map((p) => ({
      ...p,
      id:       p.id       || genId(),
      category: p.category || "General",
      sku:      p.sku      || p.code || genProductCode(),
    }));
    invoices = invoices.map((i) => ({
      ...i,
      customer:      i.customer      || null,
      paymentMethod: i.paymentMethod || "cash",
    }));

    if (categories.length === 0) {
      categories = ["General", "Electronics", "Accessories", "Software", "Services"];
    }

  } catch (err) {
    console.error("Failed to load data from server:", err);
    products = []; invoices = []; customers = [];
    expenses = []; categories = ["General","Electronics","Accessories","Software","Services"];
    discountCodes = []; purchases = [];
  }
}

function saveAllData() {
  // Fire-and-forget — saves run in the background without blocking the UI
  apiSave("products",   products);
  apiSave("invoices",   invoices);
  apiSave("customers",  customers);
  apiSave("expenses",   expenses);
  apiSave("categories", categories);
  apiSave("discounts",  discountCodes);
  apiSave("purchasing", purchases);
}

// ==================== PRODUCT MANAGEMENT ====================
function genProductCode() {
  let num = 1;
  const usedSkus = new Set([
    ...products.map((p) => p.sku),
    ...purchaseItems.map((i) => i.sku),
  ]);
  while (usedSkus.has(`ITEM${num.toString().padStart(4, "0")}`)) num++;
  return `ITEM${num.toString().padStart(4, "0")}`;
}

function updateSearchSuggestions() {
  const names = products.map((p) => p.name);
  const skus  = products.map((p) => p.sku);
  const suggestions = [...new Set([...names, ...skus])];
  const makeOptions = () => suggestions.map((s) => `<option value="${escapeHtml(s)}">`).join("");
  const dl1 = $("#product-search-suggestions");
  const dl2 = $("#billing-search-suggestions");
  const dl3 = $("#purchase-product-suggestions");
  if (dl1) dl1.innerHTML = makeOptions();
  if (dl2) dl2.innerHTML = makeOptions();
  if (dl3) dl3.innerHTML = makeOptions();
}

function renderProductsTable() {
  const tbody = $("#products-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  updateSearchSuggestions();

  const filtered = filterProducts();
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No products found</td></tr>';
    return;
  }

  filtered.forEach((p) => {
    const stockColor = p.stock <= LOW_STOCK_THRESH ? "color:var(--danger)" : "color:var(--muted)";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.sku)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td class="hide-mobile">${escapeHtml(p.category)}</td>
      <td>${fmtCurrency(p.price)}</td>
      <td style="${stockColor}">${p.stock}${p.stock <= LOW_STOCK_THRESH ? ' <span style="font-size:10px;">⚠️</span>' : ""}</td>
      <td>
        <button class="small edit-product" data-id="${p.id}">Edit</button>
        <button class="small danger delete-product" data-id="${p.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  attachProductTableListeners();
}

function filterProducts() {
  const category = $("#product-category-filter")?.value || "all";
  const search   = $("#product-search")?.value.toLowerCase().trim() || "";
  const low      = $("#show-low-stock")?.checked || false;

  return products.filter((p) => {
    const matchCategory = category === "all" || p.category === category;
    const matchSearch   = !search || p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search);
    const matchStock    = !low || p.stock <= LOW_STOCK_THRESH;
    return matchCategory && matchSearch && matchStock;
  });
}

function attachProductTableListeners() {
  qsa(".edit-product").forEach((btn) => btn.addEventListener("click", (e) => openEditProductModal(e.target.dataset.id)));
  qsa(".delete-product").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this product?")) {
        products = products.filter((p) => p.id !== e.target.dataset.id);
        saveAllData();
        renderProductsTable();
      }
    });
  });
}

// ==================== CUSTOMER MANAGEMENT ====================
function renderCustomersTable(filter = "") {
  const tbody = $("#customers-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const query = filter.toLowerCase();
  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      (c.email && c.email.toLowerCase().includes(query)) ||
      (c.phone && c.phone.toLowerCase().includes(query))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No matching customers</td></tr>';
    return;
  }

  filtered.forEach((c) => {
    const totalPurchases = invoices.filter((i) => i.customer === c.id).reduce((s, i) => s + i.total, 0);
    const hasPhone = !!(c.phone && c.phone.trim());
    const tagsHtml = (c.tags || []).map((t) =>
      `<span style="display:inline-block;background:rgba(124,58,237,0.15);color:#7c3aed;padding:2px 8px;border-radius:10px;font-size:11px;margin:1px;">${escapeHtml(t)}</span>`
    ).join("") || '<span style="color:var(--muted);font-size:11px;">—</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td class="hide-mobile">${c.email || "-"}</td>
      <td class="hide-mobile">${c.phone || "-"}</td>
      <td class="hide-sm">${tagsHtml}</td>
      <td class="hide-sm">${fmtCurrency(totalPurchases)}</td>
      <td style="white-space:nowrap;">
        <button class="small edit-customer" data-id="${c.id}">Edit</button>
        <button class="small danger delete-customer" data-id="${c.id}">Delete</button>
        <button class="small wa-customer" data-id="${c.id}" style="background:#25d366;color:#fff;border-color:#25d366;"
          ${!hasPhone ? 'disabled title="No phone number"' : ''}>
          <i class="fa-brands fa-whatsapp"></i> WhatsApp
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  qsa(".edit-customer").forEach((btn) => btn.addEventListener("click", (e) => openEditCustomerModal(e.target.dataset.id)));
  qsa(".delete-customer").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this customer?")) {
        customers = customers.filter((c) => c.id !== e.target.dataset.id);
        saveAllData();
        renderCustomersTable(filter);
      }
    });
  });
  qsa(".wa-customer").forEach((btn) => btn.addEventListener("click", (e) => openWAMessageModal(e.target.closest("button").dataset.id)));
}

// ==================== WHATSAPP MESSAGE MODAL ====================
let waTargetCustomerId = null;

function openWAMessageModal(customerId) {
  const c = customers.find((x) => x.id === customerId);
  if (!c) return;
  waTargetCustomerId = customerId;
  if ($("#wa-customer-name"))  $("#wa-customer-name").textContent  = c.name;
  if ($("#wa-customer-phone")) $("#wa-customer-phone").textContent = c.phone || "";
  if ($("#wa-message-text"))   $("#wa-message-text").value = `Hello ${c.name},\n\nThank you for being a valued customer of SD Computers.\n\n`;
  $("#wa-message-modal")?.classList.remove("hidden");
  setTimeout(() => $("#wa-message-text")?.focus(), 100);
}

function closeWAMessageModal() {
  waTargetCustomerId = null;
  $("#wa-message-modal")?.classList.add("hidden");
}

async function sendWAMessage() {
  const c = customers.find((x) => x.id === waTargetCustomerId);
  if (!c || !c.phone) return;
  const message = $("#wa-message-text")?.value.trim();
  if (!message) { alert("Please type a message first."); return; }

  const btn = $("#wa-modal-send");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  try {
    const res = await fetch("/api/whatsapp/send-message", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ phone: c.phone, message }),
    });
    const data = await res.json();
    if (data.ok) {
      alert(`✅ Message sent to ${c.name}!`);
      closeWAMessageModal();
    } else {
      alert("❌ Failed: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("❌ Error: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Send via WhatsApp"; }
  }
}

// ==================== BROADCAST WHATSAPP ====================
function getBroadcastTargets() {
  const tag = $("#broadcast-tag-filter")?.value || "";
  return customers.filter((c) => {
    if (!(c.phone && String(c.phone).trim())) return false;
    if (tag && !(Array.isArray(c.tags) && c.tags.includes(tag))) return false;
    return true;
  });
}

function refreshBroadcastCount() {
  const cnt = $("#broadcast-count");
  if (cnt) cnt.textContent = getBroadcastTargets().length;
}

function openBroadcastModal() {
  const sel = $("#broadcast-tag-filter");
  if (sel) {
    const allTags = Array.from(new Set(customers.flatMap((c) => c.tags || []))).sort();
    sel.innerHTML = '<option value="">All customers with phone</option>' +
      allTags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  }
  refreshBroadcastCount();
  const txt = $("#broadcast-text");
  if (txt && !txt.value) txt.value = `Hello {name},\n\nThank you for being a valued customer of ${BIZ_NAME || "our store"}.\n\n`;
  const prog = $("#broadcast-progress");
  if (prog) { prog.style.display = "none"; prog.textContent = ""; }
  $("#broadcast-modal")?.classList.remove("hidden");
  setTimeout(() => $("#broadcast-text")?.focus(), 100);
}

function closeBroadcastModal() {
  $("#broadcast-modal")?.classList.add("hidden");
}

async function sendBroadcast() {
  const template = ($("#broadcast-text")?.value || "").trim();
  if (!template) { alert("Please type a message first."); return; }
  const targets = getBroadcastTargets();
  if (targets.length === 0) { alert("No matching customers with phone numbers."); return; }
  if (!confirm(`Send this message to ${targets.length} customer(s)?`)) return;

  const btn  = $("#broadcast-send");
  const prog = $("#broadcast-progress");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  if (prog) { prog.style.display = "block"; }

  let ok = 0, fail = 0;
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    if (prog) prog.textContent = `Sending ${i + 1} of ${targets.length}: ${c.name}…`;
    const message = template.replace(/\{name\}/gi, c.name || "Customer");
    try {
      const res  = await fetch("/api/whatsapp/send-message", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ phone: c.phone, message }),
      });
      const data = await res.json();
      if (data.ok) ok++; else { fail++; failed.push(`${c.name}: ${data.error || "failed"}`); }
    } catch (err) {
      fail++; failed.push(`${c.name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  if (prog) prog.textContent = `Done. ✅ ${ok} sent, ❌ ${fail} failed.`;
  if (btn)  { btn.disabled = false; btn.textContent = "Send to All"; }
  alert(`Broadcast complete.\n✅ Sent: ${ok}\n❌ Failed: ${fail}` + (failed.length ? `\n\n${failed.slice(0, 10).join("\n")}` : ""));
}

// ==================== BILLING CUSTOMER SEARCH ====================
function initBillingCustomerSearch() {
  const input    = $("#customer-search");
  const dropdown = $("#customer-dropdown");
  if (!input || !dropdown) return;

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { dropdown.classList.add("hidden"); return; }

    const matches = customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.phone && c.phone.toLowerCase().includes(q))
    );

    if (matches.length === 0) { dropdown.classList.add("hidden"); return; }

    dropdown.innerHTML = matches.slice(0, 8).map((c) => `
      <div class="customer-dropdown-item" data-id="${c.id}">
        <strong>${escapeHtml(c.name)}</strong>
        <small>${c.phone || ""} ${c.email ? "· " + c.email : ""}</small>
      </div>
    `).join("");
    dropdown.classList.remove("hidden");

    dropdown.querySelectorAll(".customer-dropdown-item").forEach((item) => {
      item.addEventListener("click", () => selectBillingCustomer(item.dataset.id));
    });
  });

  input.addEventListener("blur", () => {
    setTimeout(() => dropdown.classList.add("hidden"), 200);
  });

  const clearBtn = $("#clear-customer-btn");
  if (clearBtn) clearBtn.addEventListener("click", clearBillingCustomer);
}

function selectBillingCustomer(id) {
  const c = customers.find((x) => x.id === id);
  if (!c) return;
  selectedBillingCustomerId = id;

  const wrapper  = $("#customer-search-wrapper");
  const dropdown = $("#customer-dropdown");
  const badge    = $("#selected-customer-badge");
  const nameSpan = $("#selected-customer-name");
  const input    = $("#customer-search");

  if (input)    input.value = "";
  if (dropdown) dropdown.classList.add("hidden");
  if (wrapper)  wrapper.classList.add("hidden");
  if (badge)    badge.classList.remove("hidden");
  if (nameSpan) nameSpan.textContent = `${c.name}${c.phone ? " · " + c.phone : ""}`;
}

function clearBillingCustomer() {
  selectedBillingCustomerId = null;
  const wrapper = $("#customer-search-wrapper");
  const badge   = $("#selected-customer-badge");
  const input   = $("#customer-search");
  if (input)   input.value = "";
  if (wrapper) wrapper.classList.remove("hidden");
  if (badge)   badge.classList.add("hidden");
}

// ==================== BILLING PRODUCT SEARCH ====================
function initBillingProductSearch() {
  const input    = $("#search-products");
  const dropdown = $("#billing-product-dropdown");
  if (!input || !dropdown) return;

  updateSearchSuggestions();

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { dropdown.classList.add("hidden"); return; }

    const matches = products
      .filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      .slice(0, 12);

    if (matches.length === 0) { dropdown.classList.add("hidden"); return; }

    dropdown.innerHTML = matches.map((p) => {
      const outOfStock = p.stock === 0;
      return `
        <div class="billing-product-item ${outOfStock ? "out-of-stock" : ""}" data-id="${p.id}">
          <div class="bpi-info">
            <strong>${escapeHtml(p.name)}</strong>
            <small>${escapeHtml(p.sku)} · ${fmtCurrency(p.price)}</small>
          </div>
          <div class="bpi-stock" style="color:${outOfStock ? "var(--danger)" : "var(--muted)"}">
            ${outOfStock ? "Out of stock" : "Stock: " + p.stock}
          </div>
        </div>
      `;
    }).join("");

    dropdown.classList.remove("hidden");

    dropdown.querySelectorAll(".billing-product-item:not(.out-of-stock)").forEach((item) => {
      item.addEventListener("click", () => {
        const qty = Math.max(1, Number($("#billing-add-qty")?.value) || 1);
        addToCart(item.dataset.id, qty);
        input.value = "";
        const qtyInput = $("#billing-add-qty");
        if (qtyInput) qtyInput.value = 1;
        dropdown.classList.add("hidden");
        input.focus();
      });
    });
  });

  input.addEventListener("blur", () => {
    setTimeout(() => dropdown.classList.add("hidden"), 200);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; dropdown.classList.add("hidden"); }
  });
}

function addToCart(id, qty) {
  const p = products.find((x) => x.id === id);
  if (!p) { alert("Product not found"); return; }
  if (p.stock < qty) { alert(`Insufficient stock! Available: ${p.stock}`); return; }

  const existing = cart.find((c) => c.id === id);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ id: p.id, sku: p.sku, name: p.name, price: p.price, qty, category: p.category, discountPct: 0, serialNo: "" });
  }
  renderCart();
}

function getItemLineTotal(item) {
  const gross = item.price * item.qty;
  const disc  = gross * (Math.max(0, Math.min(100, item.discountPct || 0)) / 100);
  return gross - disc;
}

function renderCart() {
  const el = $("#cart-items");
  if (!el) return;
  el.innerHTML = "";

  // Update badge and empty hint
  const badge = $("#cart-item-count");
  const hint  = $("#cart-empty-hint");
  if (badge) badge.textContent = cart.length + (cart.length === 1 ? " item" : " items");
  if (hint)  hint.style.display = cart.length === 0 ? "" : "none";

  if (cart.length > 0) {
    cart.forEach((item) => {
      const gross     = item.price * item.qty;
      const lineTotal = getItemLineTotal(item);
      const hasDisc   = item.discountPct > 0;

      const row = document.createElement("div");
      row.className = "cart-row";
      row.innerHTML = `
        <div class="cart-row-info">
          <strong>${escapeHtml(item.name)}</strong>
          <div class="cart-meta">${item.sku} · ${fmtCurrency(item.price)} each</div>
        </div>
        <div class="cart-row-controls">
          <div class="qty-control">
            <button class="qty-btn dec" data-id="${item.id}">−</button>
            <span>${item.qty}</span>
            <button class="qty-btn inc" data-id="${item.id}">+</button>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
            <span style="font-size:10px;color:var(--muted);">Disc %</span>
            <input class="item-discount-input" data-id="${item.id}" type="number" value="${item.discountPct || 0}" min="0" max="100" step="1" title="Item Discount %" />
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;">
            <span style="font-size:10px;color:var(--muted);">Serial No.</span>
            <input class="item-serial-input" data-id="${item.id}" type="text" value="${escapeHtml(item.serialNo || '')}" placeholder="e.g. SN12345" title="Company Serial Number" style="width:110px;" />
          </div>
          <div class="cart-row-total">
            ${hasDisc ? `<div class="original-total">${fmtCurrency(gross)}</div>` : ""}
            <div class="line-total">${fmtCurrency(lineTotal)}</div>
            <button class="small remove-item" data-id="${item.id}" style="margin-top:4px;">Remove</button>
          </div>
        </div>
      `;
      el.appendChild(row);
    });
  }

  qsa(".qty-btn.inc").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const it = cart.find((x) => x.id === e.target.dataset.id);
      if (it) { it.qty++; renderCart(); }
    });
  });
  qsa(".qty-btn.dec").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const it = cart.find((x) => x.id === e.target.dataset.id);
      if (it && it.qty > 1) { it.qty--; renderCart(); }
    });
  });
  qsa(".remove-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      cart = cart.filter((x) => x.id !== e.target.dataset.id);
      renderCart();
    });
  });
  qsa(".item-discount-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      const it = cart.find((x) => x.id === e.target.dataset.id);
      if (it) { it.discountPct = Math.max(0, Math.min(100, Number(e.target.value) || 0)); updateCartTotals(); }
    });
  });
  qsa(".item-serial-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      const it = cart.find((x) => x.id === e.target.dataset.id);
      if (it) it.serialNo = e.target.value;
    });
  });

  updateCartTotals();
}

function updateCartTotals() {
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const itemDiscountTotal = cart.reduce((s, c) => {
    const gross = c.price * c.qty;
    return s + gross * ((c.discountPct || 0) / 100);
  }, 0);
  const afterItemDisc = subtotal - itemDiscountTotal;

  const discountPct = Math.max(0, Number($("#discount-percent")?.value) || 0);
  const discountAmt = Math.max(0, Number($("#discount-amount-input")?.value) || 0);
  const taxPct      = Math.max(0, Number($("#tax-percent")?.value) || 0);

  const overallDiscount = Math.min(afterItemDisc, discountAmt + (afterItemDisc * discountPct / 100));
  const afterOverall    = afterItemDisc - overallDiscount;
  const tax             = afterOverall * (taxPct / 100);
  const total           = afterOverall + tax;

  const sub = $("#subtotal");
  const idd = $("#item-discount-display");
  const dd  = $("#discount-display");
  const td  = $("#tax-display");
  const gt  = $("#grand-total");

  if (sub) sub.textContent = fmt(subtotal);
  if (idd) idd.textContent = fmt(itemDiscountTotal);
  if (dd)  dd.textContent  = fmt(overallDiscount);
  if (td)  td.textContent  = fmt(tax);
  if (gt)  gt.textContent  = fmt(total);
}

function checkout() {
  if (cart.length === 0) { alert("Cart is empty"); return; }

  const docType       = $("#doc-type")?.value || "invoice";
  const paymentMethod = $("#payment-method")?.value || "cash";

  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const itemDiscountTotal = cart.reduce((s, c) => {
    const gross = c.price * c.qty;
    return s + gross * ((c.discountPct || 0) / 100);
  }, 0);
  const afterItemDisc = subtotal - itemDiscountTotal;

  const discountPct = Math.max(0, Number($("#discount-percent")?.value) || 0);
  const discountAmt = Math.max(0, Number($("#discount-amount-input")?.value) || 0);
  const taxPct      = Math.max(0, Number($("#tax-percent")?.value) || 0);

  const overallDiscount = Math.min(afterItemDisc, discountAmt + (afterItemDisc * discountPct / 100));
  const afterOverall    = afterItemDisc - overallDiscount;
  const tax             = afterOverall * (taxPct / 100);
  const total           = afterOverall + tax;

  cart.forEach((ci) => {
    const p = products.find((x) => x.id === ci.id);
    if (p) p.stock = Math.max(0, p.stock - ci.qty);
  });

  const prefix = docType === "receipt" ? "REC" : "INV";
  const existingNums = invoices
    .map(i => { const m = i.id && i.id.match(/^(?:INV|REC)-(\d+)$/); return m ? parseInt(m[1]) : 0; });
  const nextNum = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
  const invoiceId = `${prefix}-${String(nextNum).padStart(4, "0")}`;

  const invoice = {
    id: invoiceId,
    date: timestamp(),
    customer: selectedBillingCustomerId,
    docType,
    items: cart.map((c) => ({
      id: c.id, sku: c.sku, name: c.name, price: c.price, qty: c.qty, discountPct: c.discountPct || 0,
      serialNo: c.serialNo || "",
      lineTotal: getItemLineTotal(c),
    })),
    subtotal,
    itemDiscountTotal,
    discountPct,
    discountAmt: overallDiscount,
    taxPct,
    taxAmt: tax,
    total,
    paymentMethod,
    status: "completed",
    soldBy: currentUser || "unknown",
  };

  invoices.push(invoice);
  saveAllData();

  // Send via WhatsApp if customer has a phone number (invoice OR receipt)
  if (invoice.customer) {
    const customer = customers.find((c) => c.id === invoice.customer);
    if (customer && customer.phone) {
      const docLabel = invoice.docType === "receipt" ? "Receipt" : "Invoice";
      const html     = buildDocumentHTML(invoice);
      showAppToast(`📤 Sending ${docLabel} via WhatsApp…`, "#2563eb");
      fetch("/api/whatsapp/send-invoice-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: customer.phone,
          html,
          invoiceId: invoice.id,
          invoice,
          customerName: customer.name,
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            console.log(`✅ WA ${docLabel} sent:`, invoice.id);
            showAppToast(`✅ ${docLabel} sent via WhatsApp!`, "#16a34a");
          } else {
            console.warn("WA send failed:", d.error);
            showAppToast(`⚠️ WhatsApp send failed: ${d.error || "unknown"}`, "#dc2626");
          }
        })
        .catch((e) => {
          console.warn("WA send error:", e.message);
          showAppToast(`⚠️ WhatsApp error: ${e.message}`, "#dc2626");
        });
    } else if (customer && !customer.phone) {
      console.log("ℹ️ Customer has no phone — WhatsApp skipped");
    }
  }

  cart = [];
  clearBillingCustomer();
  const dpEl = $("#discount-percent");
  const daEl = $("#discount-amount-input");
  const tpEl = $("#tax-percent");
  const pmEl = $("#payment-method");
  if (dpEl) dpEl.value = 0;
  if (daEl) daEl.value = 0;
  if (tpEl) tpEl.value = 0;
  if (pmEl) pmEl.value = "cash";

  updateSearchSuggestions();
  renderCart();
  showInvoiceModal(invoice);
}

let _currentModalInvoice = null;

function showInvoiceModal(invoice) {
  const modal   = $("#invoice-modal");
  const content = $("#invoice-html");
  if (!modal || !content) return;
  _currentModalInvoice = invoice;
  content.innerHTML = buildDocumentHTML(invoice);
  modal.dataset.doctype = invoice.docType || "invoice";
  modal.classList.remove("hidden");
}

async function downloadInvoicePdf() {
  if (!_currentModalInvoice) return;
  const btn = $("#btn-download-invoice-pdf");
  if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }
  try {
    const html = buildDocumentHTML(_currentModalInvoice);
    const docLabel = _currentModalInvoice.docType === "receipt" ? "Receipt" : "Invoice";
    const filename = `${docLabel}-${_currentModalInvoice.id}.pdf`;
    const res = await fetch("/api/invoice-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, filename }),
    });
    if (!res.ok) { alert("❌ PDF generation failed"); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("❌ Error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇️ Download PDF"; }
  }
}

/* ── Live settings reader (always picks up latest saved values) ── */
function L(key, def) {
  const v = (window.APP_CONFIG || {})[key];
  return (v === undefined || v === null || v === "") ? def : v;
}

/* ── Thermal receipt (80 mm) ─────────────────────────────────── */
function buildReceiptHTML(inv) {
  const customer  = customers.find((c) => c.id === inv.customer);
  const bizName   = escapeHtml(L("businessName", "") || L("appName", "SD POS"));
  const bizAddr   = L("businessAddress", "");
  const bizPhone  = L("businessPhone", "");
  const bizEmail  = L("businessEmail", "");
  const headerCol = L("receiptHeaderColor", "#1a3a5c");
  const showTax   = L("receiptShowTax", true);
  const showDisc  = L("receiptShowDiscount", true);
  const showLogo  = L("invoiceShowLogo", true);
  const showQR    = L("invoiceShowQR", true);
  const rcptFoot  = L("receiptFooter", L("invoiceFooter", "Thank you! Please come again."));
  const rcptNote  = L("receiptNote", "");
  const totalDisc = (inv.itemDiscountTotal || 0) + (inv.discountAmt || 0);
  const terms     = (L("termsAndConditions", []) || []);

  const rows = inv.items.map((it) => {
    const unitDisc  = it.price * (it.discountPct || 0) / 100;
    const discPrice = it.price - unitDisc;
    const lineTotal = it.lineTotal !== undefined ? it.lineTotal : discPrice * it.qty;
    return `
      <tr>
        <td style="padding:3px 4px 3px 0;font-size:11px;line-height:1.4;">
          ${escapeHtml(it.name)}
          ${it.serialNo ? `<br/><span style="font-size:9px;color:#555;">S/N: ${escapeHtml(it.serialNo)}</span>` : ""}
        </td>
        <td style="padding:3px 2px;font-size:11px;text-align:center;white-space:nowrap;">${Number(it.qty).toFixed(0)}</td>
        <td style="padding:3px 0 3px 4px;font-size:11px;text-align:right;white-space:nowrap;">${fmtCurrency(lineTotal)}</td>
      </tr>`;
  }).join("");

  const termsLines = terms.length > 0
    ? terms.map((t) => `<div style="font-size:9px;color:#444;line-height:1.5;">• ${escapeHtml(t)}</div>`).join("")
    : "";

  const dashes = `<div style="border-top:1px dashed #555;margin:4px 0;"></div>`;

  return `
    <style>@media print { @page { size: 80mm auto; margin: 0; } }</style>
    <div style="font-family:'Courier New',Courier,monospace;background:#fff;color:#111;width:80mm;margin:0 auto;padding:4mm 4mm 6mm 4mm;box-sizing:border-box;font-size:11px;">

      <!-- Header -->
      <div style="text-align:center;margin-bottom:4px;">
        ${showLogo ? `<img src="/assets/logo.jpeg" alt="logo"
             style="width:16mm;height:16mm;object-fit:contain;display:block;margin:0 auto 3px;" />` : ""}
        <div style="font-size:13px;font-weight:700;letter-spacing:.03em;color:${headerCol};">${bizName}</div>
        ${bizAddr ? `<div style="font-size:9px;color:#444;">${escapeHtml(bizAddr)}</div>` : ""}
        ${bizPhone ? `<div style="font-size:9px;color:#444;">${escapeHtml(bizPhone)}</div>` : ""}
        ${bizEmail ? `<div style="font-size:9px;color:#444;">${escapeHtml(bizEmail)}</div>` : ""}
      </div>

      ${dashes}

      <div style="text-align:center;font-size:12px;font-weight:700;letter-spacing:.06em;margin-bottom:3px;color:${headerCol};">SALES RECEIPT</div>

      <!-- Meta -->
      <div style="font-size:10px;line-height:1.7;">
        <div style="display:flex;justify-content:space-between;">
          <span>Receipt#</span><span style="font-weight:700;">${escapeHtml(inv.id)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span>Date</span><span>${formatDateTime(inv.date)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span>Payment</span><span>${(inv.paymentMethod || "cash").toUpperCase()}</span>
        </div>
        ${customer ? `<div style="display:flex;justify-content:space-between;">
          <span>Customer</span><span style="font-weight:600;">${escapeHtml(customer.name)}</span>
        </div>` : ""}
      </div>

      ${dashes}

      <!-- Items -->
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="font-size:10px;text-align:left;padding:2px 4px 2px 0;border-bottom:1px solid #222;">Item</th>
            <th style="font-size:10px;text-align:center;padding:2px 2px;border-bottom:1px solid #222;">Qty</th>
            <th style="font-size:10px;text-align:right;padding:2px 0 2px 4px;border-bottom:1px solid #222;">Amt</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      ${dashes}

      <!-- Totals -->
      <div style="font-size:11px;line-height:1.8;">
        <div style="display:flex;justify-content:space-between;">
          <span>Subtotal</span><span>${fmtCurrency(inv.subtotal)}</span>
        </div>
        ${(showDisc && totalDisc > 0) ? `<div style="display:flex;justify-content:space-between;color:#c00;">
          <span>Discount</span><span>- ${fmtCurrency(totalDisc)}</span>
        </div>` : ""}
        ${(showTax && (inv.taxAmt || 0) > 0) ? `<div style="display:flex;justify-content:space-between;">
          <span>Tax (${inv.taxPct}%)</span><span>${fmtCurrency(inv.taxAmt)}</span>
        </div>` : ""}
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:800;border-top:1px solid #222;padding-top:3px;margin-top:2px;color:${headerCol};">
          <span>TOTAL</span><span>${fmtCurrency(inv.total)}</span>
        </div>
      </div>

      ${inv.notes ? `${dashes}<div style="font-size:9px;color:#444;line-height:1.5;"><strong>Note:</strong> ${escapeHtml(inv.notes)}</div>` : ""}

      ${rcptNote ? `${dashes}<div style="font-size:9px;color:#444;line-height:1.5;text-align:center;font-style:italic;">${escapeHtml(rcptNote)}</div>` : ""}

      ${termsLines ? `${dashes}<div>${termsLines}</div>` : ""}

      ${dashes}

      <!-- Footer -->
      <div style="text-align:center;margin-top:4px;">
        <div style="font-size:10px;font-weight:600;margin-bottom:4px;color:${headerCol};">${escapeHtml(rcptFoot)}</div>
        <div style="font-size:9px;color:#777;margin-bottom:4px;">${escapeHtml(inv.id)}</div>
        ${showQR ? `<img src="/api/qr/${escapeHtml(inv.id)}" alt="QR"
             style="width:18mm;height:18mm;display:block;margin:0 auto 2px;" />
        <div style="font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.04em;">Scan to verify</div>` : ""}
      </div>

    </div>`;
}

/* ── Invoice (A4) ────────────────────────────────────────────── */
function buildDocumentHTML(inv) {
  if (inv.docType === "receipt") return buildReceiptHTML(inv);

  const customer  = customers.find((c) => c.id === inv.customer);
  const isReceipt = false;
  const docTitle  = "INVOICE";
  const terms     = (L("termsAndConditions", []) || []);
  const totalDisc = (inv.itemDiscountTotal || 0) + (inv.discountAmt || 0);
  const bizName   = escapeHtml(L("businessName", "") || L("appName", "SD POS"));
  const bizAddr   = L("businessAddress", "");
  const bizPhone  = L("businessPhone", "");
  const bizEmail  = L("businessEmail", "");
  const headerCol = L("invoiceHeaderColor", "#1a3a5c");
  const watermark = L("invoiceWatermark", "");
  const showQR    = L("invoiceShowQR", true);
  const showLogo  = L("invoiceShowLogo", true);
  const invFoot   = L("invoiceFooter", "Thank you for your business!");

  const TH = `padding:10px 12px;font-size:12px;font-weight:700;border-bottom:2px solid ${headerCol};text-align:left;background:transparent;color:${headerCol};`;
  const TD = "padding:9px 12px;font-size:12px;border-bottom:1px solid #e0e0e0;vertical-align:top;";

  const rows = inv.items.map((it) => {
    const unitDisc  = it.price * (it.discountPct || 0) / 100;
    const discPct   = it.discountPct || 0;
    const discPrice = it.price - unitDisc;
    const lineTotal = it.lineTotal !== undefined ? it.lineTotal : discPrice * it.qty;
    return `
      <tr>
        <td style="${TD}">
          ${escapeHtml(it.name)}
          ${it.sku      ? `<div style="font-size:9px;color:#999;margin-top:2px;">SKU: ${escapeHtml(it.sku)}</div>` : ""}
          ${it.serialNo ? `<div style="font-size:9px;color:#999;margin-top:2px;">S/N: ${escapeHtml(it.serialNo)}</div>` : ""}
        </td>
        <td style="${TD}text-align:center;">${Number(it.qty).toFixed(2)}</td>
        <td style="${TD}text-align:right;">${fmtCurrency(it.price)}${discPct > 0 ? `<div style="font-size:9px;color:#e55;">-${discPct}%</div>` : ""}</td>
        <td style="${TD}text-align:right;font-weight:700;">${fmtCurrency(lineTotal)}</td>
      </tr>`;
  }).join("");

  const termsLines = terms.length > 0
    ? terms.map((t) => `<div style="font-size:10px;color:#444;margin-bottom:4px;line-height:1.6;">• ${escapeHtml(t)}</div>`).join("")
    : `<div style="font-size:10px;color:#888;font-style:italic;">No specific terms and conditions apply to this ${isReceipt ? "receipt" : "invoice"}.</div>`;

  return `
    <style>@media print { @page { size: A4 portrait; margin: 0; } }</style>
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#e8ecf0;color:#222;width:210mm;min-height:297mm;margin:0 auto;padding:0;box-sizing:border-box;">
      <div style="background:#fff;width:210mm;min-height:297mm;box-sizing:border-box;padding:14mm 14mm 0 14mm;display:flex;flex-direction:column;position:relative;overflow:hidden;">

        ${watermark ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:80pt;font-weight:900;color:${headerCol};opacity:0.06;pointer-events:none;white-space:nowrap;letter-spacing:.05em;z-index:0;">${escapeHtml(watermark)}</div>` : ""}

        <!-- ══ HEADER ══ -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10mm;position:relative;z-index:1;">
          <div style="flex-shrink:0;">
            ${showLogo ? `<img src="/assets/logo.jpeg" alt="${bizName}"
                 style="width:24mm;height:24mm;object-fit:contain;display:block;" />` : `<div style="font-size:18pt;font-weight:900;color:${headerCol};">${bizName}</div>`}
          </div>
          <div style="font-size:26pt;font-weight:900;letter-spacing:.06em;color:${headerCol};">${docTitle}</div>
        </div>

        <!-- ══ BILL TO + META ══ -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4mm;position:relative;z-index:1;">
          <div>
            <div style="font-size:8.5pt;color:#666;margin-bottom:1.5mm;">${isReceipt ? "Receipt for:" : "Invoice to:"}</div>
            <div style="font-size:12pt;font-weight:700;color:#111;">${customer ? escapeHtml(customer.name) : "Walk-in Customer"}</div>
            ${customer && customer.phone ? `<div style="font-size:9pt;color:#555;margin-top:1mm;">${escapeHtml(customer.phone)}</div>` : ""}
          </div>
          <div style="text-align:right;font-size:9pt;line-height:1.9;">
            <span style="color:#666;">${isReceipt ? "Receipt#" : "Invoice#"}</span>
            <span style="font-weight:700;margin-left:8mm;">${escapeHtml(inv.id)}</span><br/>
            <span style="color:#666;">Date</span>
            <span style="font-weight:600;margin-left:8mm;">${formatDate(inv.date)}</span><br/>
            <span style="color:#666;">Payment</span>
            <span style="font-weight:600;margin-left:8mm;">${(inv.paymentMethod || "cash").toUpperCase()}</span><br/>
            <span style="color:#666;">Sold By</span>
            <span style="font-weight:600;margin-left:8mm;">${escapeHtml(inv.soldBy || "—")}</span>
          </div>
        </div>

        <!-- biz info -->
        <div style="font-size:8.5pt;color:#666;margin-bottom:6mm;line-height:1.6;position:relative;z-index:1;">
          <span style="font-weight:700;color:${headerCol};">${bizName}</span>
          ${bizAddr ? ` &nbsp;|&nbsp; ${escapeHtml(bizAddr)}` : ""}
          ${bizPhone ? ` &nbsp;|&nbsp; ${escapeHtml(bizPhone)}` : ""}
          ${bizEmail ? ` &nbsp;|&nbsp; ${escapeHtml(bizEmail)}` : ""}
        </div>

        <!-- ══ ITEMS TABLE ══ -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:0;">
          <thead>
            <tr>
              <th style="${TH}">Item</th>
              <th style="${TH}text-align:center;">Quantity</th>
              <th style="${TH}text-align:right;">Unit Price</th>
              <th style="${TH}text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <!-- ══ TOTALS ══ -->
        <div style="display:flex;justify-content:flex-end;padding:4mm 0 5mm 0;">
          <table style="font-size:10pt;min-width:55mm;border-collapse:collapse;">
            <tr>
              <td style="padding:1.5mm 6mm 1.5mm 0;color:#555;">Subtotal</td>
              <td style="padding:1.5mm 0;text-align:right;">${fmtCurrency(inv.subtotal)}</td>
            </tr>
            ${totalDisc > 0 ? `<tr>
              <td style="padding:1.5mm 6mm 1.5mm 0;color:#c00;">Discount</td>
              <td style="padding:1.5mm 0;text-align:right;color:#c00;">- ${fmtCurrency(totalDisc)}</td>
            </tr>` : ""}
            <tr>
              <td style="padding:1.5mm 6mm 1.5mm 0;color:#555;">Tax (${inv.taxPct || 0}%)</td>
              <td style="padding:1.5mm 0;text-align:right;">${fmtCurrency(inv.taxAmt || 0)}</td>
            </tr>
            <tr>
              <td style="padding:3mm 6mm 1.5mm 0;font-size:12pt;font-weight:800;color:${headerCol};border-top:2px solid ${headerCol};">Total</td>
              <td style="padding:3mm 0 1.5mm 0;font-size:12pt;font-weight:800;text-align:right;color:${headerCol};border-top:2px solid ${headerCol};">${fmtCurrency(inv.total)}</td>
            </tr>
          </table>
        </div>

        ${inv.notes ? `
        <div style="margin-bottom:4mm;padding:2.5mm 3.5mm;background:#f5f5f5;border-left:2.5pt solid #1a6fc4;font-size:8.5pt;color:#444;">
          <strong>Notes:</strong> ${escapeHtml(inv.notes)}
        </div>` : ""}

        <!-- ══ TERMS & CONDITIONS ══ -->
        <div style="margin-bottom:5mm;padding-top:3mm;">
          <div style="font-size:8.5pt;font-weight:700;color:#333;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2mm;">Terms &amp; Conditions</div>
          ${termsLines}
        </div>

        <!-- ══ FOOTER: thank you + QR ══ -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4mm 0 8mm 0;margin-top:auto;position:relative;z-index:1;">
          <div>
            <div style="font-size:10pt;font-weight:600;color:${headerCol};">${escapeHtml(invFoot)}</div>
            <div style="width:50mm;border-bottom:1pt solid #aaa;margin-top:3mm;"></div>
            <div style="font-size:7.5pt;color:#aaa;margin-top:1.5mm;">${escapeHtml(inv.id)}</div>
          </div>
          ${(!isReceipt && showQR) ? `
          <div style="text-align:center;">
            <img src="/api/qr/${escapeHtml(inv.id)}" alt="QR" style="width:18mm;height:18mm;display:block;margin:0 auto 1.5mm;" />
            <div style="font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${headerCol};">SCAN TO VERIFY</div>
          </div>` : ""}
        </div>

      </div>
    </div>`;
}

// ==================== EXPENSES MANAGEMENT ====================
function renderExpensesTable() {
  const tbody = $("#expenses-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filtered = expenses.filter((e) => {
    const searchTerm = $("#expense-search")?.value.toLowerCase() || "";
    const category   = $("#expense-category-filter")?.value || "all";
    const matchSearch = !searchTerm || e.name.toLowerCase().includes(searchTerm) || e.description?.toLowerCase().includes(searchTerm);
    const matchCategory = category === "all" || e.category === category;
    return matchSearch && matchCategory;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No expenses</td></tr>';
    return;
  }

  filtered.forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="hide-mobile">${formatDate(e.date)}</td>
      <td>${escapeHtml(e.name)}</td>
      <td class="hide-mobile">${e.category}</td>
      <td>${fmtCurrency(e.amount)}</td>
      <td class="hide-sm">${e.description || "-"}</td>
      <td><button class="small delete-expense" data-id="${e.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });

  qsa(".delete-expense").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this expense?")) {
        expenses = expenses.filter((x) => x.id !== e.target.dataset.id);
        saveAllData();
        renderExpensesTable();
        updateDashboard();
      }
    });
  });
}

// ==================== PURCHASING SYSTEM ====================
function updatePurchaseProductSuggestions() {
  const dl = $("#purchase-product-suggestions");
  if (!dl) return;
  const opts = products.map((p) => `<option value="${escapeHtml(p.name)}" data-sku="${escapeHtml(p.sku)}">`).join("");
  dl.innerHTML = opts;
}

function addPurchaseItem() {
  const searchVal    = $("#purchase-item-search")?.value.trim();
  const qty          = Number($("#purchase-item-qty")?.value) || 1;
  const costPrice    = Number($("#purchase-item-cost")?.value) || 0;
  const retailPrice  = Number($("#purchase-item-retail")?.value) || 0;
  const supplierSerial = $("#purchase-item-serial")?.value.trim() || "";

  if (!searchVal) { alert("Please enter a product name or SKU"); return; }
  if (qty < 1)    { alert("Quantity must be at least 1"); return; }
  if (costPrice <= 0) { alert("Please enter a valid cost price"); return; }

  const existing = products.find(
    (p) => p.name.toLowerCase() === searchVal.toLowerCase() || p.sku.toLowerCase() === searchVal.toLowerCase()
  );

  const item = {
    id:             existing ? existing.id : genId(),
    sku:            existing ? existing.sku : genProductCode(),
    name:           existing ? existing.name : searchVal,
    qty,
    costPrice,
    retailPrice:    retailPrice || costPrice,
    supplierSerial,
    isNewProduct:   !existing,
  };

  purchaseItems.push(item);
  renderPurchaseCart();

  if ($("#purchase-item-search"))  $("#purchase-item-search").value  = "";
  if ($("#purchase-item-qty"))     $("#purchase-item-qty").value     = 1;
  if ($("#purchase-item-cost"))    $("#purchase-item-cost").value    = "";
  if ($("#purchase-item-retail"))  $("#purchase-item-retail").value  = "";
  if ($("#purchase-item-serial"))  $("#purchase-item-serial").value  = "";
  $("#purchase-item-search")?.focus();
}

function renderPurchaseCart() {
  const tbody = $("#purchase-cart-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (purchaseItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--muted);">No items added yet</td></tr>';
    updatePurchaseTotals();
    return;
  }

  purchaseItems.forEach((item, index) => {
    const totalCost = item.qty * item.costPrice;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.sku)}${item.isNewProduct ? ' <span style="font-size:10px; color:var(--success);">NEW</span>' : ""}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${item.supplierSerial ? escapeHtml(item.supplierSerial) : '<span style="color:var(--muted);font-size:11px;">—</span>'}</td>
      <td>${item.qty}</td>
      <td>${fmtCurrency(item.costPrice)}</td>
      <td>${fmtCurrency(item.retailPrice)}</td>
      <td>${fmtCurrency(totalCost)}</td>
      <td><button class="small danger remove-purchase-item" data-index="${index}">Remove</button></td>
    `;
    tbody.appendChild(tr);
  });

  qsa(".remove-purchase-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.target.dataset.index);
      purchaseItems.splice(idx, 1);
      renderPurchaseCart();
    });
  });

  updatePurchaseTotals();
}

function updatePurchaseTotals() {
  const totalItems = purchaseItems.reduce((s, i) => s + i.qty, 0);
  const totalCost  = purchaseItems.reduce((s, i) => s + i.qty * i.costPrice, 0);
  const tiEl = $("#purchase-total-items");
  const tcEl = $("#purchase-total-cost");
  if (tiEl) tiEl.textContent = totalItems;
  if (tcEl) tcEl.textContent = fmtCurrency(totalCost);
}

function savePurchase() {
  const supplier = $("#purchase-supplier")?.value.trim();
  const date     = $("#purchase-date")?.value || todayISO();
  const ref      = $("#purchase-ref")?.value.trim() || "";
  const payment  = $("#purchase-payment")?.value || "cash";
  const notes    = $("#purchase-notes")?.value.trim() || "";

  if (!supplier) { alert("Please enter a supplier name"); return; }
  if (purchaseItems.length === 0) { alert("Please add at least one item"); return; }

  const totalCost = purchaseItems.reduce((s, i) => s + i.qty * i.costPrice, 0);

  const purchase = {
    id:        "PO_" + Date.now(),
    date:      new Date(date).toISOString(),
    supplier,
    ref,
    payment,
    notes,
    items:     [...purchaseItems],
    totalCost,
    status:    "completed",
  };

  // Update inventory
  purchaseItems.forEach((item) => {
    const existing = products.find((p) => p.id === item.id || p.sku === item.sku);
    if (existing) {
      existing.stock += item.qty;
      if (item.retailPrice > 0) existing.price = item.retailPrice;
    } else {
      products.push({
        id:       item.id,
        sku:      item.sku,
        name:     item.name,
        category: "General",
        price:    item.retailPrice || item.costPrice,
        stock:    item.qty,
        code:     item.sku,
      });
    }
  });

  purchases.push(purchase);
  saveAllData();
  renderProductsTable();
  renderPurchasesHistory();

  // Reset form
  purchaseItems = [];
  renderPurchaseCart();
  if ($("#purchase-supplier")) $("#purchase-supplier").value = "";
  if ($("#purchase-ref"))      $("#purchase-ref").value = "";
  if ($("#purchase-notes"))    $("#purchase-notes").value = "";
  if ($("#purchase-date"))     $("#purchase-date").value = todayISO();
  if ($("#purchase-payment"))  $("#purchase-payment").value = "cash";

  showPurchaseDetailModal(purchase);
}

function showPurchaseDetailModal(p) {
  const modal   = $("#purchase-modal");
  const content = $("#purchase-detail-html");
  if (!modal || !content) return;
  content.innerHTML = buildPurchaseDetailHTML(p);
  modal.classList.remove("hidden");
}

function buildPurchaseDetailHTML(p) {
  const rows = p.items.map((it) => `
    <tr>
      <td style="border:1px solid #ddd; padding:6px;">${escapeHtml(it.sku)}</td>
      <td style="border:1px solid #ddd; padding:6px;">${escapeHtml(it.name)}</td>
      <td style="border:1px solid #ddd; padding:6px;">${it.supplierSerial ? escapeHtml(it.supplierSerial) : "—"}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:right;">${it.qty}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:right;">${fmtCurrency(it.costPrice)}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:right;">${fmtCurrency(it.retailPrice)}</td>
      <td style="border:1px solid #ddd; padding:6px; text-align:right;">${fmtCurrency(it.qty * it.costPrice)}</td>
    </tr>
  `).join("");

  return `
    <div style="font-family:Arial,sans-serif; background:#fff; color:#000; padding:20px; border-radius:8px;">
      <div style="text-align:center; margin-bottom:20px;">
        <h2 style="margin:0;">${escapeHtml(BIZ_NAME || APP_NAME)}</h2>
        <h3 style="text-decoration:underline; margin-top:10px;">Purchase Order</h3>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom:15px; font-size:13px;">
        <div>
          <p><strong>PO ID:</strong> ${p.id}</p>
          <p><strong>Date:</strong> ${formatDateTime(p.date)}</p>
          <p><strong>Payment:</strong> ${p.payment.toUpperCase()}</p>
        </div>
        <div style="text-align:right;">
          <p><strong>Supplier:</strong> ${escapeHtml(p.supplier)}</p>
          ${p.ref ? `<p><strong>Ref:</strong> ${escapeHtml(p.ref)}</p>` : ""}
        </div>
      </div>
      <table style="width:100%; border-collapse:collapse; margin-bottom:15px; font-size:13px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="border:1px solid #ddd; padding:6px;">SKU</th>
            <th style="border:1px solid #ddd; padding:6px;">Product</th>
            <th style="border:1px solid #ddd; padding:6px;">Supplier Serial No.</th>
            <th style="border:1px solid #ddd; padding:6px; text-align:right;">Qty</th>
            <th style="border:1px solid #ddd; padding:6px; text-align:right;">Cost Price</th>
            <th style="border:1px solid #ddd; padding:6px; text-align:right;">Retail Price</th>
            <th style="border:1px solid #ddd; padding:6px; text-align:right;">Total Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="text-align:right; font-size:15px;">
        <strong>Total Cost: ${fmtCurrency(p.totalCost)}</strong>
      </div>
      ${p.notes ? `<p style="margin-top:15px; font-size:12px; color:#555;"><strong>Notes:</strong> ${escapeHtml(p.notes)}</p>` : ""}
    </div>
  `;
}

function renderPurchasesHistory() {
  const tbody = $("#purchases-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const search = $("#purchase-search")?.value.toLowerCase() || "";
  const filtered = purchases.filter(
    (p) =>
      !search ||
      p.supplier.toLowerCase().includes(search) ||
      (p.ref && p.ref.toLowerCase().includes(search)) ||
      p.id.toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px;">No purchases yet</td></tr>';
    return;
  }

  [...filtered].reverse().forEach((p) => {
    const totalItems = p.items.reduce((s, i) => s + i.qty, 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.id}</td>
      <td class="hide-mobile">${formatDate(p.date)}</td>
      <td>${escapeHtml(p.supplier)}</td>
      <td class="hide-sm">${totalItems} item(s)</td>
      <td>${fmtCurrency(p.totalCost)}</td>
      <td class="hide-mobile">${p.payment.toUpperCase()}</td>
      <td>
        <button class="small view-purchase" data-id="${p.id}">View</button>
        <button class="small danger delete-purchase" data-id="${p.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  qsa(".view-purchase").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const p = purchases.find((x) => x.id === e.target.dataset.id);
      if (p) showPurchaseDetailModal(p);
    });
  });

  qsa(".delete-purchase").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this purchase record?")) {
        purchases = purchases.filter((x) => x.id !== e.target.dataset.id);
        saveAllData();
        renderPurchasesHistory();
      }
    });
  });
}

function showPurchaseForm() {
  const formSection = $("#purchase-form-section");
  const histSection = $("#purchase-history-section");
  if (formSection) formSection.classList.remove("hidden");
  purchaseItems = [];
  renderPurchaseCart();
  if ($("#purchase-date")) $("#purchase-date").value = todayISO();
  formSection?.scrollIntoView({ behavior: "smooth" });
}

function hidePurchaseForm() {
  const formSection = $("#purchase-form-section");
  if (formSection) formSection.classList.add("hidden");
  purchaseItems = [];
}

// ==================== ANALYTICS & REPORTS ====================
function updateDashboard() {
  const today     = todayISO();
  const thisMonth = new Date().toISOString().slice(0, 7);

  const todaySales  = invoices.filter((i) => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
  const monthSales  = invoices.filter((i) => i.date.slice(0, 7) === thisMonth).reduce((s, i) => s + i.total, 0);
  const totalSales  = invoices.reduce((s, i) => s + i.total, 0);
  const todayExpenses = expenses.filter((e) => e.date.slice(0, 10) === today).reduce((s, e) => s + e.amount, 0);

  const ss = $("#stat-today-sales");
  const ms = $("#stat-month-sales");
  const ts = $("#stat-total-sales");
  const tp = $("#stat-today-profit");
  const si = $("#stat-invoices");
  if (ss) ss.textContent = fmtCurrency(todaySales);
  if (ms) ms.textContent = fmtCurrency(monthSales);
  if (ts) ts.textContent = fmtCurrency(totalSales);
  if (tp) tp.textContent = fmtCurrency(todaySales - todayExpenses);
  if (si) si.textContent = invoices.length;

  const lowStockItems = products.filter((p) => p.stock <= LOW_STOCK_THRESH).sort((a, b) => a.stock - b.stock);
  const stockAlert = $("#low-stock-alert");
  if (stockAlert) {
    if (lowStockItems.length > 0) {
      stockAlert.innerHTML = lowStockItems.slice(0, 6).map((p) =>
        `<div style="padding:8px; background:rgba(239,68,68,0.1); border-left:3px solid var(--danger); margin-bottom:5px;">
           <strong>${escapeHtml(p.name)}</strong> — Only ${p.stock} left
         </div>`
      ).join("");
    } else {
      stockAlert.innerHTML = '<div style="color:var(--muted); padding:10px;">✅ All stock levels normal</div>';
    }
  }

  renderCharts();
}

function renderCharts() {
  const days   = [];
  const dayMap = {};
  for (let i = 6; i >= 0; i--) {
    const dt  = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dt.toISOString().slice(0, 10);
    dayMap[key] = 0;
    days.push(key);
  }
  invoices.forEach((inv) => { const d = inv.date.slice(0, 10); if (d in dayMap) dayMap[d] += inv.total; });

  const ctx1 = $("#chart-daily")?.getContext("2d");
  if (ctx1) {
    if (chartDaily) chartDaily.destroy();
    chartDaily = new Chart(ctx1, {
      type: "bar",
      data: {
        labels: days.map((d) => new Date(d).toLocaleDateString(CURRENCY_LOCALE, { month: "short", day: "numeric", timeZone: TIMEZONE })),
        datasets: [{ label: "Daily Sales", data: days.map((d) => dayMap[d]), backgroundColor: "#8b5cf6", borderRadius: 6 }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  const salesMap = {};
  invoices.forEach((inv) => inv.items.forEach((it) => { salesMap[it.name] = (salesMap[it.name] || 0) + it.qty; }));
  const topItems = Object.keys(salesMap).sort((a, b) => salesMap[b] - salesMap[a]).slice(0, 6);

  const ctx2 = $("#chart-top")?.getContext("2d");
  if (ctx2) {
    if (chartTop) chartTop.destroy();
    chartTop = new Chart(ctx2, {
      type: "doughnut",
      data: {
        labels: topItems,
        datasets: [{ data: topItems.map((k) => salesMap[k]), backgroundColor: ["#7c3aed","#06b6d4","#f97316","#ef4444","#10b981","#eab308"] }],
      },
      options: { responsive: true, plugins: { legend: { position: "bottom" } } },
    });
  }

  const categoryMap = {};
  invoices.forEach((inv) => {
    inv.items.forEach((it) => {
      const p = products.find((x) => x.id === it.id);
      if (p) categoryMap[p.category] = (categoryMap[p.category] || 0) + (it.lineTotal || it.price * it.qty);
    });
  });
  const catLabels = Object.keys(categoryMap);

  const ctx3 = $("#chart-category")?.getContext("2d");
  if (ctx3) {
    if (chartCategory) chartCategory.destroy();
    chartCategory = new Chart(ctx3, {
      type: "bar",
      data: {
        labels: catLabels,
        datasets: [{ label: "Category Sales", data: catLabels.map((c) => categoryMap[c]), backgroundColor: "#06b6d4", borderRadius: 6 }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, indexAxis: "y" },
    });
  }
}

function populateEmployeeFilter() {
  const sel = $("#invoice-filter-employee");
  if (!sel) return;
  const prev = sel.value;
  const employees = Array.from(new Set(invoices.map((i) => i.soldBy).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">All Employees</option>' +
    employees.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
  if (prev) sel.value = prev;
}

function renderInvoicesTable() {
  const tbody = $("#invoices-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  populateEmployeeFilter();

  const search    = ($("#invoice-search")?.value || "").toLowerCase();
  const empFilter = $("#invoice-filter-employee")?.value || "";
  const docFilter = $("#invoice-filter-doctype")?.value || "";
  const fromStr   = $("#invoice-filter-from")?.value || "";
  const toStr     = $("#invoice-filter-to")?.value || "";
  const fromTime  = fromStr ? new Date(fromStr + "T00:00:00").getTime() : null;
  const toTime    = toStr   ? new Date(toStr   + "T23:59:59").getTime() : null;

  const filtered = invoices.filter((i) => {
    if (empFilter && i.soldBy !== empFilter) return false;
    if (docFilter && (i.docType || "invoice") !== docFilter) return false;
    if (fromTime !== null || toTime !== null) {
      const t = new Date(i.date).getTime();
      if (fromTime !== null && t < fromTime) return false;
      if (toTime   !== null && t > toTime)   return false;
    }
    if (search) {
      const cust = customers.find((c) => c.id === i.customer);
      const matches =
        i.id.toLowerCase().includes(search) ||
        (cust && cust.name.toLowerCase().includes(search)) ||
        (i.soldBy && String(i.soldBy).toLowerCase().includes(search)) ||
        (i.items || []).some((it) =>
          (it.name && it.name.toLowerCase().includes(search)) ||
          (it.sku && it.sku.toLowerCase().includes(search)) ||
          (it.serialNo && String(it.serialNo).toLowerCase().includes(search))
        );
      if (!matches) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No invoices</td></tr>';
    return;
  }

  [...filtered].reverse().forEach((i) => {
    const customer = customers.find((c) => c.id === i.customer);
    const docLabel = i.docType === "receipt" ? "🧾 Receipt" : "📄 Invoice";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i.id} <span style="font-size:11px; color:var(--muted);">${docLabel}</span></td>
      <td class="hide-mobile">${formatDate(i.date)}</td>
      <td class="hide-sm">${customer ? escapeHtml(customer.name) : "Walk-in"}</td>
      <td class="hide-sm">${escapeHtml(i.soldBy || "—")}</td>
      <td>${fmtCurrency(i.total)}</td>
      <td>
        <button class="small view-invoice" data-id="${i.id}">View</button>
        <button class="small resend-invoice" data-id="${i.id}" title="Resend via WhatsApp">📲 Resend</button>
        <button class="small danger delete-invoice" data-id="${i.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  qsa(".view-invoice").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const inv = invoices.find((i) => i.id === e.target.dataset.id);
      if (inv) showInvoiceModal(inv);
    });
  });

  qsa(".resend-invoice").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.id;
      const inv = invoices.find((i) => i.id === id);
      if (inv) resendInvoiceWhatsApp(inv, e.target);
    });
  });

  qsa(".delete-invoice").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this invoice?")) {
        invoices = invoices.filter((i) => i.id !== e.target.dataset.id);
        saveAllData();
        renderInvoicesTable();
        updateDashboard();
      }
    });
  });
}

async function resendInvoiceWhatsApp(invoice, btn) {
  const docLabel = invoice.docType === "receipt" ? "Receipt" : "Invoice";
  const customer = customers.find((c) => c.id === invoice.customer);

  if (!customer) {
    alert("⚠️ This invoice has no linked customer (Walk-in). Cannot resend.");
    return;
  }
  if (!customer.phone) {
    alert(`⚠️ Customer "${customer.name}" has no phone number saved. Add a phone number first.`);
    return;
  }
  if (!confirm(`Resend ${docLabel} ${invoice.id} to ${customer.name} (${customer.phone}) via WhatsApp?`)) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    const html = buildDocumentHTML(invoice);
    const res = await fetch("/api/whatsapp/send-invoice-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: customer.phone,
        html,
        invoiceId: invoice.id,
        invoice,
        customerName: customer.name,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      showAppToast(`✅ ${docLabel} resent to ${customer.name}!`, "#16a34a");
    } else {
      showAppToast(`⚠️ Resend failed: ${data.error || res.statusText}`, "#dc2626");
    }
  } catch (err) {
    showAppToast(`⚠️ Resend error: ${err.message}`, "#dc2626");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ==================== MODALS ====================
let editingProductId  = null;
let editingCustomerId = null;

function populateCategorySelect() {
  const sel = $("#p-category");
  if (!sel) return;
  sel.innerHTML = "";
  categories.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    sel.appendChild(opt);
  });
}

function openAddProductModal() {
  editingProductId = null;
  populateCategorySelect();
  $("#modal-title").textContent = "Add Product";
  if ($("#p-id"))       $("#p-id").value = "";
  if ($("#p-sku"))      $("#p-sku").value = genProductCode();
  if ($("#p-name"))     $("#p-name").value = "";
  if ($("#p-price"))    $("#p-price").value = "";
  if ($("#p-stock"))    $("#p-stock").value = "";
  if ($("#p-category")) $("#p-category").value = categories[0] || "General";
  $("#modal")?.classList.remove("hidden");
}

function openEditProductModal(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  editingProductId = id;
  populateCategorySelect();
  $("#modal-title").textContent = "Edit Product";
  if ($("#p-id"))       $("#p-id").value = id;
  if ($("#p-sku"))      $("#p-sku").value = p.sku;
  if ($("#p-name"))     $("#p-name").value = p.name;
  if ($("#p-price"))    $("#p-price").value = p.price;
  if ($("#p-stock"))    $("#p-stock").value = p.stock;
  if ($("#p-category")) $("#p-category").value = p.category;
  $("#modal")?.classList.remove("hidden");
}

function closeModal() {
  $("#modal")?.classList.add("hidden");
  editingProductId = null;
}

function saveProduct() {
  const name     = $("#p-name")?.value.trim();
  const sku      = $("#p-sku")?.value.trim();
  const price    = Number($("#p-price")?.value) || 0;
  const stock    = Number($("#p-stock")?.value) || 0;
  const category = $("#p-category")?.value || "General";

  if (!name || !sku) { alert("Name and SKU are required"); return; }

  if (editingProductId) {
    const p = products.find((x) => x.id === editingProductId);
    if (p) { p.sku = sku; p.name = name; p.price = price; p.stock = stock; p.category = category; }
  } else {
    products.push({ id: genId(), sku, name, price, stock, category, code: sku });
  }
  saveAllData();
  closeModal();
  renderProductsTable();
  updateDashboard();
}

function openAddCustomerModal() {
  editingCustomerId = null;
  $("#customer-modal-title").textContent = "Add Customer";
  if ($("#c-name"))    $("#c-name").value = "";
  if ($("#c-email"))   $("#c-email").value = "";
  if ($("#c-phone"))   $("#c-phone").value = "";
  if ($("#c-tags"))    $("#c-tags").value = "";
  if ($("#c-address")) $("#c-address").value = "";
  $("#customer-modal")?.classList.remove("hidden");
}

function openEditCustomerModal(id) {
  const c = customers.find((x) => x.id === id);
  if (!c) return;
  editingCustomerId = id;
  $("#customer-modal-title").textContent = "Edit Customer";
  if ($("#c-name"))    $("#c-name").value = c.name;
  if ($("#c-email"))   $("#c-email").value = c.email || "";
  if ($("#c-phone"))   $("#c-phone").value = c.phone || "";
  if ($("#c-tags"))    $("#c-tags").value = (c.tags || []).join(", ");
  if ($("#c-address")) $("#c-address").value = c.address || "";
  $("#customer-modal")?.classList.remove("hidden");
}

function closeCustomerModal() {
  $("#customer-modal")?.classList.add("hidden");
  editingCustomerId = null;
}

function saveCustomer() {
  const name    = $("#c-name")?.value.trim();
  const email   = $("#c-email")?.value.trim();
  const phone   = $("#c-phone")?.value.trim();
  const address = $("#c-address")?.value.trim();
  const tagsRaw = $("#c-tags")?.value.trim() || "";
  const tags    = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);

  if (!name) { alert("Name is required"); return; }

  if (editingCustomerId) {
    const c = customers.find((x) => x.id === editingCustomerId);
    if (c) { c.name = name; c.email = email; c.phone = phone; c.address = address; c.tags = tags; }
  } else {
    customers.push({ id: genId(), name, email, phone, address, tags, createdAt: timestamp() });
  }
  saveAllData();
  closeCustomerModal();
  renderCustomersTable();
}

// ==================== EXPENSES MODAL ====================
function openAddExpenseModal() {
  if ($("#expense-name"))             $("#expense-name").value = "";
  if ($("#expense-amount"))           $("#expense-amount").value = "";
  if ($("#expense-category-input"))   $("#expense-category-input").value = "";  // resets select to "-- Select Category --"
  if ($("#expense-description"))      $("#expense-description").value = "";
  if ($("#expense-date"))             $("#expense-date").valueAsDate = new Date();
  $("#expense-modal")?.classList.remove("hidden");
}

function closeExpenseModal() { $("#expense-modal")?.classList.add("hidden"); }

function saveExpense() {
  const name        = $("#expense-name")?.value.trim();
  const amount      = Number($("#expense-amount")?.value) || 0;
  const category    = $("#expense-category-input")?.value.trim();
  const description = $("#expense-description")?.value.trim();
  const date        = $("#expense-date")?.value;

  if (!name || !category) { alert("Name and category are required"); return; }

  expenses.push({ id: genId(), name, amount, category, description, date, createdAt: timestamp() });
  saveAllData();
  closeExpenseModal();
  renderExpensesTable();
  updateDashboard();
}

// ==================== UTILITIES ====================
function switchView(view) {
  qsa(".view").forEach((s) => s.classList.remove("active"));
  const viewEl = $(`#view-${view}`);
  if (viewEl) viewEl.classList.add("active");

  closeMobileMenu();

  if (view === "analytics")   updateDashboard();
  else if (view === "invoices")   renderInvoicesTable();
  else if (view === "products")   renderProductsTable();
  else if (view === "customers")  renderCustomersTable();
  else if (view === "expenses")   renderExpensesTable();
  else if (view === "purchasing") { renderPurchasesHistory(); updatePurchaseProductSuggestions(); }
  else if (view === "billing")    { updateSearchSuggestions(); renderCart(); }
  else if (view === "settings")   loadSettingsView();
}

function seedSampleData() {
  fetch("database/products.json")
    .then((res) => res.json())
    .then((sample) => {
      products = sample.map((p) => ({ ...p, id: p.id || genId(), category: p.category || "General", sku: p.sku || p.code }));
      saveAllData();
      renderProductsTable();
      updateDashboard();
      alert("✅ Sample data loaded!");
    })
    .catch(() => alert("Could not load sample data"));
}

function clearAllData() {
  if (confirm("⚠️ Delete ALL data? This cannot be undone!")) {
    products = []; invoices = []; customers = []; expenses = []; cart = []; purchases = [];
    saveAllData();
    renderProductsTable();
    renderCart();
    updateDashboard();
    alert("All data cleared");
  }
}

function logout() {
  sessionStorage.removeItem("pos_logged_in");
  window.location.replace("/login");
}

// ==================== MOBILE MENU ====================
function openMobileMenu() {
  const sidebar  = $("#sidebar");
  const overlay  = $("#sidebar-overlay");
  if (sidebar)  sidebar.classList.add("open");
  if (overlay)  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeMobileMenu() {
  const sidebar  = $("#sidebar");
  const overlay  = $("#sidebar-overlay");
  if (sidebar)  sidebar.classList.remove("open");
  if (overlay)  overlay.classList.remove("active");
  document.body.style.overflow = "";
}

// ==================== HELPER ====================
function on(id, event, handler) {
  const el = $("#" + id);
  if (el) el.addEventListener(event, handler);
}

// ==================== EMPLOYER MANAGEMENT ====================
const ROLE_PRESETS = {
  admin:   ["products","billing","customers","invoices","expenses","purchasing","analytics","settings"],
  manager: ["products","billing","customers","invoices","expenses","purchasing","analytics"],
  cashier: ["billing","invoices"],
  custom:  [],
};

function applyAccessControl() {
  document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
    const view = btn.dataset.view;
    if (view === "settings") {
      btn.style.display = hasPermission("settings") ? "" : "none";
    } else {
      btn.style.display = hasPermission(view) ? "" : "none";
    }
  });
  if (isAdmin()) {
    document.querySelectorAll(".admin-only").forEach(el => el.style.display = "");
  }
}

async function loadEmployersTable() {
  const tbody = document.getElementById("employers-tbody");
  if (!tbody) return;
  try {
    const res = await fetch("/api/employers", {
      headers: { "x-pos-user": currentUser },
    });
    const data = await res.json();
    if (!data.ok) { tbody.innerHTML = `<tr><td colspan="5" style="color:#f87171;">${data.error}</td></tr>`; return; }
    tbody.innerHTML = "";
    data.users.forEach((u) => {
      const perms = u.role === "admin" ? "All sections" : (u.permissions || []).join(", ") || "None";
      const date  = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "-";
      const isSelf = u.username === currentUser;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><i class="fas fa-user" style="color:#7c3aed;margin-right:6px;"></i>${escapeHtml(u.username)}${isSelf ? ' <span style="font-size:10px;background:#7c3aed33;color:#c084fc;padding:1px 6px;border-radius:8px;">You</span>' : ""}</td>
        <td><span class="role-badge role-${u.role}">${u.role}</span></td>
        <td style="font-size:12px;color:#9ca3af;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(perms)}</td>
        <td style="font-size:12px;color:#6b7280;">${date}</td>
        <td style="text-align:right;">
          <button class="small" onclick="openEditEmployerModal('${u.id}')" style="margin-right:4px;"><i class="fas fa-edit"></i></button>
          ${!isSelf ? `<button class="small danger" onclick="deleteEmployer('${u.id}','${escapeHtml(u.username)}')"><i class="fas fa-trash"></i></button>` : ""}
        </td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#f87171;">Failed to load employers</td></tr>`;
  }
}

let allEmployersList = [];

async function getAllEmployers() {
  try {
    const res = await fetch("/api/employers", { headers: { "x-pos-user": currentUser } });
    const data = await res.json();
    allEmployersList = data.ok ? data.users : [];
  } catch { allEmployersList = []; }
}

function openAddEmployerModal() {
  document.getElementById("employer-modal-title").textContent = "Add Employer";
  document.getElementById("emp-id").value = "";
  document.getElementById("emp-username").value = "";
  document.getElementById("emp-password").value = "";
  document.getElementById("emp-role").value = "cashier";
  document.getElementById("emp-username").readOnly = false;
  setEmpPermissions(ROLE_PRESETS.cashier);
  document.getElementById("employer-modal").classList.remove("hidden");
}

async function openEditEmployerModal(id) {
  await getAllEmployers();
  const user = allEmployersList.find(u => u.id === id);
  if (!user) return;
  document.getElementById("employer-modal-title").textContent = "Edit Employer";
  document.getElementById("emp-id").value = user.id;
  document.getElementById("emp-username").value = user.username;
  document.getElementById("emp-username").readOnly = true;
  document.getElementById("emp-password").value = "";
  document.getElementById("emp-role").value = user.role;
  setEmpPermissions(user.permissions || []);
  document.getElementById("employer-modal").classList.remove("hidden");
}

function setEmpPermissions(perms) {
  document.querySelectorAll(".emp-perm").forEach((cb) => {
    cb.checked = perms.includes(cb.value);
  });
}

function getEmpPermissions() {
  return [...document.querySelectorAll(".emp-perm:checked")].map(cb => cb.value);
}

function closeEmployerModal() {
  document.getElementById("employer-modal").classList.add("hidden");
}

async function saveEmployer() {
  const id       = document.getElementById("emp-id").value;
  const username = document.getElementById("emp-username").value.trim();
  const password = document.getElementById("emp-password").value;
  const role     = document.getElementById("emp-role").value;
  let   permissions = role === "admin" ? ROLE_PRESETS.admin : getEmpPermissions();

  if (!username) { alert("Username is required"); return; }
  if (!id && !password) { alert("Password is required for new accounts"); return; }

  const isEdit = !!id;
  const url    = isEdit ? `/api/employers/${id}` : "/api/employers";
  const method = isEdit ? "PUT" : "POST";
  const body   = isEdit
    ? { role, permissions, ...(password ? { password } : {}) }
    : { username, password, role, permissions };

  try {
    const res  = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "x-pos-user": currentUser },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      closeEmployerModal();
      showSettingsToast(isEdit ? "✅ Employer updated!" : "✅ Employer added!");
      loadEmployersTable();
    } else {
      alert("❌ " + (data.error || "Failed to save"));
    }
  } catch (e) {
    alert("❌ Error: " + e.message);
  }
}

async function deleteEmployer(id, username) {
  if (!confirm(`Delete account "${username}"? This cannot be undone.`)) return;
  try {
    const res  = await fetch(`/api/employers/${id}`, {
      method: "DELETE",
      headers: { "x-pos-user": currentUser },
    });
    const data = await res.json();
    if (data.ok) {
      showSettingsToast("✅ Employer deleted");
      loadEmployersTable();
    } else {
      alert("❌ " + (data.error || "Failed to delete"));
    }
  } catch (e) {
    alert("❌ Error: " + e.message);
  }
}

// ==================== SETTINGS ====================
async function loadSettingsView() {
  try {
    const res = await fetch("/api/settings");
    const cfg = await res.json();
    const appCfg = window.APP_CONFIG || {};
    const get = (key, fallback = "") => cfg[key] !== undefined ? cfg[key] : (appCfg[key] !== undefined ? appCfg[key] : fallback);

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) { if (el.type === "checkbox") el.checked = !!val; else el.value = val; } };

    setVal("cfg-businessName",     get("businessName", "SD COMPUTERS"));
    setVal("cfg-appTagline",       get("appTagline", "smart computer store"));
    setVal("cfg-businessAddress",  get("businessAddress", ""));
    setVal("cfg-businessPhone",    get("businessPhone", ""));
    setVal("cfg-businessEmail",    get("businessEmail", ""));
    setVal("cfg-timezone",         get("timezone", "Asia/Colombo"));
    setVal("cfg-currencySymbol",   get("currencySymbol", "Rs"));
    setVal("cfg-currencyCode",     get("currencyCode", "LKR"));
    setVal("cfg-currencyLocale",   get("currencyLocale", "si-LK"));

    const invColor = get("invoiceHeaderColor", "#1a3a5c");
    setVal("cfg-invoiceHeaderColor",    invColor);
    setVal("cfg-invoiceHeaderColorHex", invColor);
    setVal("cfg-invoiceFooter",    get("invoiceFooter", "Thank you for your purchase!"));
    setVal("cfg-invoiceWatermark", get("invoiceWatermark", "Verified Invoice"));
    setVal("cfg-invoiceShowQR",    get("invoiceShowQR", true));
    setVal("cfg-invoiceShowLogo",  get("invoiceShowLogo", false));
    const terms = Array.isArray(cfg.termsAndConditions) ? cfg.termsAndConditions.join("\n") : (cfg.termsAndConditions || "");
    setVal("cfg-termsAndConditions", terms);

    const rcpColor = get("receiptHeaderColor", "#1a3a5c");
    setVal("cfg-receiptHeaderColor",    rcpColor);
    setVal("cfg-receiptHeaderColorHex", rcpColor);
    setVal("cfg-receiptFooter",    get("receiptFooter", "Thank you! Please come again."));
    setVal("cfg-receiptNote",      get("receiptNote", ""));
    setVal("cfg-receiptShowTax",      get("receiptShowTax", true));
    setVal("cfg-receiptShowDiscount", get("receiptShowDiscount", true));

    setVal("cfg-defaultTaxPercent",  get("defaultTaxPercent", 0));
    setVal("cfg-lowStockThreshold",  get("lowStockThreshold", 5));
    setVal("cfg-appName",            get("appName", "SD POS"));
    setVal("cfg-chatbotApiUrl",      get("chatbotApiUrl", ""));
    setVal("cfg-mistralApiKey",      get("mistralApiKey", ""));
    setVal("cfg-mistralModel",       get("mistralModel", "mistralai/mistral-7b-instruct-v0.3"));
    setVal("cfg-aiFallbackEnabled",  get("aiFallbackEnabled", true));

    // GitHub backup fields
    setVal("cfg-githubBackupEnabled",  get("githubBackupEnabled", false));
    setVal("cfg-githubToken",          get("githubToken", ""));
    setVal("cfg-githubRepo",           get("githubRepo", ""));
    setVal("cfg-githubBranch",         get("githubBranch", "main"));
    setVal("cfg-githubBackupSchedule", get("githubBackupSchedule", "0 3 * * *"));
    refreshGithubBackupStatus();

    // Sync color pickers ↔ hex inputs
    const syncColor = (pickerId, hexId) => {
      const picker = document.getElementById(pickerId);
      const hex    = document.getElementById(hexId);
      if (!picker || !hex) return;
      picker.addEventListener("input", () => { hex.value = picker.value; });
      hex.addEventListener("input", () => {
        if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) picker.value = hex.value;
      });
    };
    syncColor("cfg-invoiceHeaderColor", "cfg-invoiceHeaderColorHex");
    syncColor("cfg-receiptHeaderColor", "cfg-receiptHeaderColorHex");
  } catch (e) {
    console.error("Settings load error:", e);
  }
}

async function saveSettingsData() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return Number(el.value);
    return el.value.trim();
  };

  const termsRaw = getVal("cfg-termsAndConditions") || "";
  const terms = termsRaw.split("\n").map(s => s.trim()).filter(Boolean);

  const payload = {
    businessName:      getVal("cfg-businessName"),
    appTagline:        getVal("cfg-appTagline"),
    businessAddress:   getVal("cfg-businessAddress"),
    businessPhone:     getVal("cfg-businessPhone"),
    businessEmail:     getVal("cfg-businessEmail"),
    timezone:          getVal("cfg-timezone"),
    currencySymbol:    getVal("cfg-currencySymbol"),
    currencyCode:      getVal("cfg-currencyCode"),
    currencyLocale:    getVal("cfg-currencyLocale"),
    invoiceHeaderColor: getVal("cfg-invoiceHeaderColor"),
    invoiceFooter:     getVal("cfg-invoiceFooter"),
    invoiceWatermark:  getVal("cfg-invoiceWatermark"),
    invoiceShowQR:     getVal("cfg-invoiceShowQR"),
    invoiceShowLogo:   getVal("cfg-invoiceShowLogo"),
    termsAndConditions: terms,
    receiptHeaderColor: getVal("cfg-receiptHeaderColor"),
    receiptFooter:     getVal("cfg-receiptFooter"),
    receiptNote:       getVal("cfg-receiptNote"),
    receiptShowTax:    getVal("cfg-receiptShowTax"),
    receiptShowDiscount: getVal("cfg-receiptShowDiscount"),
    defaultTaxPercent: getVal("cfg-defaultTaxPercent"),
    lowStockThreshold: getVal("cfg-lowStockThreshold"),
    appName:           getVal("cfg-appName"),
    chatbotApiUrl:     getVal("cfg-chatbotApiUrl"),
    mistralApiKey:     getVal("cfg-mistralApiKey"),
    mistralModel:      getVal("cfg-mistralModel"),
    aiFallbackEnabled: getVal("cfg-aiFallbackEnabled"),
    githubBackupEnabled:  getVal("cfg-githubBackupEnabled"),
    githubToken:          getVal("cfg-githubToken"),
    githubRepo:           getVal("cfg-githubRepo"),
    githubBranch:         getVal("cfg-githubBranch") || "main",
    githubBackupSchedule: getVal("cfg-githubBackupSchedule") || "0 3 * * *",
  };

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      // Update in-memory APP_CONFIG so frontend reflects changes immediately
      if (window.APP_CONFIG) {
        Object.assign(window.APP_CONFIG, payload);
      }
      // Re-render invoice/receipt modal if it's open, so user sees changes live
      const modal = document.getElementById("invoice-modal");
      if (modal && !modal.classList.contains("hidden") && _currentModalInvoice) {
        const content = document.getElementById("invoice-html");
        if (content) content.innerHTML = buildDocumentHTML(_currentModalInvoice);
      }
      showSettingsToast("✅ Settings saved successfully!");
    } else {
      alert("❌ Failed to save: " + (data.error || "Unknown error"));
    }
  } catch (e) {
    alert("❌ Save error: " + e.message);
  }
}

// ──────────── Template preview (uses unsaved form values) ──────
function previewTemplate(kind) {
  const getVal = (id) => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return Number(el.value);
    return el.value.trim();
  };
  const termsRaw = getVal("cfg-termsAndConditions") || "";
  const terms = termsRaw.split("\n").map(s => s.trim()).filter(Boolean);

  // Snapshot real config, override with current form values
  const original = window.APP_CONFIG || {};
  const overrides = {
    businessName:       getVal("cfg-businessName") ?? original.businessName,
    businessAddress:    getVal("cfg-businessAddress") ?? original.businessAddress,
    businessPhone:      getVal("cfg-businessPhone") ?? original.businessPhone,
    businessEmail:      getVal("cfg-businessEmail") ?? original.businessEmail,
    invoiceHeaderColor: getVal("cfg-invoiceHeaderColor") ?? original.invoiceHeaderColor,
    invoiceFooter:      getVal("cfg-invoiceFooter") ?? original.invoiceFooter,
    invoiceWatermark:   getVal("cfg-invoiceWatermark") ?? original.invoiceWatermark,
    invoiceShowQR:      getVal("cfg-invoiceShowQR"),
    invoiceShowLogo:    getVal("cfg-invoiceShowLogo"),
    termsAndConditions: terms.length ? terms : original.termsAndConditions,
    receiptHeaderColor: getVal("cfg-receiptHeaderColor") ?? original.receiptHeaderColor,
    receiptFooter:      getVal("cfg-receiptFooter") ?? original.receiptFooter,
    receiptNote:        getVal("cfg-receiptNote") ?? original.receiptNote,
    receiptShowTax:     getVal("cfg-receiptShowTax"),
    receiptShowDiscount:getVal("cfg-receiptShowDiscount"),
  };
  const backup = { ...original };
  Object.assign(window.APP_CONFIG, overrides);

  // Sample invoice
  const sample = {
    id: "PREVIEW-" + new Date().toISOString().slice(0,10),
    docType: kind === "receipt" ? "receipt" : "invoice",
    date: new Date().toISOString(),
    customer: null,
    paymentMethod: "cash",
    soldBy: "Demo User",
    status: "completed",
    items: [
      { name: "Sample Product A", sku: "SKU001", qty: 2, price: 1500, discountPct: 0 },
      { name: "Sample Product B", sku: "SKU002", qty: 1, price: 2750, discountPct: 10, serialNo: "SN-12345" },
      { name: "Sample Product C", sku: "SKU003", qty: 3, price: 500, discountPct: 0 },
    ],
    subtotal: 7725,
    itemDiscountTotal: 275,
    discountAmt: 0,
    taxPct: 5,
    taxAmt: 372.5,
    total: 7822.5,
    notes: "This is a preview using your current settings.",
  };

  try {
    _currentModalInvoice = sample;
    const modal = document.getElementById("invoice-modal");
    const content = document.getElementById("invoice-html");
    if (modal && content) {
      content.innerHTML = buildDocumentHTML(sample);
      modal.dataset.doctype = sample.docType;
      modal.classList.remove("hidden");
    }
  } finally {
    // Restore real config (but keep override visible until modal close — actually restore now, modal HTML is already rendered)
    // We need to KEEP overrides for re-renders; safer: just keep overrides since user is previewing.
    // Actually restore so unrelated screens use real config:
    Object.keys(overrides).forEach(k => { delete window.APP_CONFIG[k]; });
    Object.assign(window.APP_CONFIG, backup);
  }
}

// ──────────── GitHub Backup helpers ─────────────────────────────
async function refreshGithubBackupStatus() {
  const box = document.getElementById("github-backup-status");
  if (!box) return;
  try {
    const r = await fetch("/api/github-backup/status");
    const s = await r.json();
    const last = s.last || {};
    const lastTime = last.time ? new Date(last.time).toLocaleString() : "never";
    let lastLine = "Never run";
    if (last.status === "ok") {
      const link = last.htmlUrl ? `<a href="${last.htmlUrl}" target="_blank" style="color:#60a5fa">${last.file}</a>` : last.file;
      lastLine = `✅ Last backup: <strong>${lastTime}</strong> — ${link}`;
    } else if (last.status === "error") {
      lastLine = `❌ Last attempt: <strong>${lastTime}</strong> — ${escapeHtml(last.error || "unknown error")}`;
    } else if (last.status === "running") {
      lastLine = `⏳ Running… (started ${lastTime})`;
    }
    const stateBadge = s.enabled
      ? `<span style="background:#16a34a;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">SCHEDULED</span>`
      : `<span style="background:#6b7280;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">DISABLED</span>`;
    const tokenBadge = s.tokenSet
      ? `<span style="color:#16a34a;">🔑 token saved</span>`
      : `<span style="color:#9ca3af;">no token</span>`;
    box.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
        ${stateBadge}
        <span style="font-size:12px; color:#9ca3af;">Schedule: <code>${escapeHtml(s.schedule)}</code></span>
        <span style="font-size:12px;">${tokenBadge}</span>
      </div>
      <div style="font-size:13px;">${lastLine}</div>
    `;
  } catch (e) {
    box.innerHTML = `<span style="color:#dc2626;">Status load failed: ${e.message}</span>`;
  }
}

async function testGithubBackup() {
  const btn = document.getElementById("btn-github-test");
  if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }
  try {
    // Save current form values first so server uses fresh credentials
    await saveSettingsData();
    const r = await fetch("/api/github-backup/test", { method: "POST" });
    const d = await r.json();
    if (r.ok && d.ok) {
      const perms = d.permissions ? Object.keys(d.permissions).filter(k => d.permissions[k]).join(", ") : "—";
      alert(`✅ Connection OK!\n\nRepo: ${d.repo}\nPrivate: ${d.private ? "Yes" : "No"}\nDefault branch: ${d.defaultBranch}\nYour permissions: ${perms}`);
    } else {
      alert("❌ Connection failed:\n\n" + (d.error || "Unknown error"));
    }
  } catch (e) {
    alert("❌ Test error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔌 Test Connection"; }
  }
}

async function runGithubBackupNow() {
  const btn = document.getElementById("btn-github-backup-now");
  if (!confirm("Save the current data to GitHub now?")) return;
  if (btn) { btn.disabled = true; btn.textContent = "Backing up…"; }
  try {
    await saveSettingsData();
    const r = await fetch("/api/github-backup/run", { method: "POST" });
    const d = await r.json();
    if (r.ok && d.ok) {
      showSettingsToast("✅ Backup committed to GitHub!");
      refreshGithubBackupStatus();
    } else {
      alert("❌ Backup failed:\n\n" + (d.error || "Unknown error"));
    }
  } catch (e) {
    alert("❌ Backup error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "☁️ Backup Now"; }
  }
}

async function listGithubBackups() {
  const list = document.getElementById("github-backup-list");
  const btn = document.getElementById("btn-github-list");
  if (!list) return;
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  list.innerHTML = `<div style="font-size:12px; color:#9ca3af; padding:8px;">Loading backups…</div>`;
  try {
    const r = await fetch("/api/github-backup/list?limit=30");
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "List failed");
    if (!d.backups.length) {
      list.innerHTML = `<div style="font-size:12px; color:#9ca3af; padding:8px;">No backups yet — click "Backup Now" to create the first one.</div>`;
      return;
    }
    const rows = d.backups.map((b) => {
      const sizeKb = (b.size / 1024).toFixed(1);
      return `
        <div style="display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid rgba(255,255,255,0.06); font-size:13px;">
          <a href="${b.htmlUrl}" target="_blank" style="color:#60a5fa; flex:1; word-break:break-all;">${escapeHtml(b.name)}</a>
          <span style="color:#9ca3af; font-size:11px; white-space:nowrap;">${sizeKb} KB</span>
          <button class="small github-restore-btn" data-path="${escapeHtml(b.path)}" data-name="${escapeHtml(b.name)}" style="background:#dc2626;color:white;">♻️ Restore</button>
        </div>`;
    }).join("");
    list.innerHTML = `
      <div style="margin-top:10px; max-height:300px; overflow-y:auto; background:rgba(0,0,0,0.2); border-radius:6px;">
        <div style="padding:8px; font-size:12px; color:#9ca3af; border-bottom:1px solid rgba(255,255,255,0.06);">
          📜 ${d.backups.length} backup${d.backups.length === 1 ? "" : "s"} found (newest first):
        </div>
        ${rows}
      </div>`;
    list.querySelectorAll(".github-restore-btn").forEach((b) => {
      b.addEventListener("click", () => restoreGithubBackup(b.dataset.path, b.dataset.name));
    });
  } catch (e) {
    list.innerHTML = `<div style="color:#dc2626; padding:8px; font-size:13px;">❌ ${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "📜 List Backups"; }
  }
}

async function restoreGithubBackup(filePath, name) {
  if (!confirm(`⚠️ RESTORE WARNING\n\nThis will REPLACE all current data (products, customers, invoices, etc.) with the backup:\n\n${name}\n\nThis cannot be undone except by another restore. Continue?`)) return;
  if (!confirm("Are you absolutely sure? Type-equivalent final check.")) return;
  try {
    const r = await fetch("/api/github-backup/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    const d = await r.json();
    if (r.ok && d.ok) {
      alert(`✅ Restored ${d.filesRestored} file(s) from ${name}.\n\nThe page will now reload.`);
      location.reload();
    } else {
      alert("❌ Restore failed:\n\n" + (d.error || "Unknown error") + (d.rolledBack ? "\n\n(Previous data was rolled back.)" : ""));
    }
  } catch (e) {
    alert("❌ Restore error: " + e.message);
  }
}

function showSettingsToast(msg) {
  let toast = document.getElementById("settings-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "settings-toast";
    toast.style.cssText = "position:fixed;bottom:28px;right:28px;background:#16a34a;color:#fff;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 24px #0005;transition:opacity .4s;";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = "0"; }, 2800);
}

// ==================== INITIALIZATION ====================
document.addEventListener("DOMContentLoaded", async () => {
  if (!currentUser) return;

  try {
    await loadAllData();

    const greet = $("#user-greeting");
    if (greet) greet.innerHTML = `<i class="fa fa-user"></i> ${escapeHtml(currentUser)}`;

    // Mobile menu
    on("mobile-menu-toggle", "click", openMobileMenu);
    on("sidebar-close", "click", closeMobileMenu);
    on("sidebar-overlay", "click", closeMobileMenu);

    // Navigation
    qsa(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        qsa(".nav-btn").forEach((x) => x.classList.remove("active"));
        this.classList.add("active");
        const view = this.dataset.view;
        if (view) switchView(view);
      });
    });

    // Products
    on("btn-add-product", "click", openAddProductModal);
    on("modal-cancel", "click", closeModal);
    on("modal-save", "click", saveProduct);
    on("product-category-filter", "change", renderProductsTable);
    on("product-search", "input", renderProductsTable);
    on("show-low-stock", "change", renderProductsTable);

    // Customers
    on("btn-add-customer", "click", openAddCustomerModal);
    on("customer-modal-cancel", "click", closeCustomerModal);
    on("customer-modal-save",   "click", saveCustomer);
    on("wa-modal-cancel",       "click", closeWAMessageModal);
    on("wa-modal-send",         "click", sendWAMessage);
    on("btn-broadcast-customers","click", openBroadcastModal);
    on("broadcast-cancel",       "click", closeBroadcastModal);
    on("broadcast-send",         "click", sendBroadcast);
    on("broadcast-tag-filter",   "change", refreshBroadcastCount);

    // Billing
    initBillingProductSearch();

    // Sync payment-method radio pills → hidden select
    document.querySelectorAll("input[name='payment-method-radio']").forEach((radio) => {
      radio.addEventListener("change", () => {
        const sel = $("#payment-method");
        if (sel) sel.value = radio.value;
      });
    });

    on("btn-clear-cart", "click", () => { cart = []; renderCart(); });
    on("discount-percent", "input", updateCartTotals);
    on("discount-amount-input", "input", updateCartTotals);
    on("tax-percent", "input", updateCartTotals);
    on("btn-checkout", "click", checkout);
    on("btn-print-invoice", "click", () => {
      if (cart.length === 0) { alert("Cart is empty"); return; }
      const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
      const itemDiscountTotal = cart.reduce((s, c) => { const g = c.price * c.qty; return s + g * ((c.discountPct || 0) / 100); }, 0);
      const afterItemDisc = subtotal - itemDiscountTotal;
      const dPct = Number($("#discount-percent")?.value) || 0;
      const dAmt = Number($("#discount-amount-input")?.value) || 0;
      const tPct = Number($("#tax-percent")?.value) || 0;
      const overallDiscount = Math.min(afterItemDisc, dAmt + (afterItemDisc * dPct / 100));
      const afterOverall    = afterItemDisc - overallDiscount;
      const tax             = afterOverall * (tPct / 100);
      showInvoiceModal({
        id: "PREVIEW",
        date: timestamp(),
        customer: selectedBillingCustomerId,
        docType: $("#doc-type")?.value || "invoice",
        items: cart.map((c) => ({ ...c, lineTotal: getItemLineTotal(c) })),
        subtotal,
        itemDiscountTotal,
        discountPct: dPct,
        discountAmt: overallDiscount,
        taxPct: tPct,
        taxAmt: tax,
        total: afterOverall + tax,
        paymentMethod: $("#payment-method")?.value || "cash",
      });
    });
    on("invoice-modal-close", "click", () => $("#invoice-modal")?.classList.add("hidden"));
    on("btn-download-invoice-pdf", "click", downloadInvoicePdf);

    // Billing customer search
    initBillingCustomerSearch();

    // Expenses
    on("btn-add-expense", "click", openAddExpenseModal);
    on("expense-modal-cancel", "click", closeExpenseModal);
    on("expense-modal-save", "click", saveExpense);
    on("expense-search", "input", renderExpensesTable);
    on("expense-category-filter", "change", renderExpensesTable);

    // Invoices
    on("invoice-search", "input", renderInvoicesTable);
    on("invoice-filter-employee", "change", renderInvoicesTable);
    on("invoice-filter-doctype", "change", renderInvoicesTable);
    on("invoice-filter-from", "change", renderInvoicesTable);
    on("invoice-filter-to", "change", renderInvoicesTable);
    on("invoice-filter-clear", "click", () => {
      const ids = ["invoice-search","invoice-filter-employee","invoice-filter-doctype","invoice-filter-from","invoice-filter-to"];
      ids.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
      renderInvoicesTable();
    });

    // Purchasing
    on("btn-new-purchase", "click", showPurchaseForm);
    on("btn-cancel-purchase", "click", hidePurchaseForm);
    on("btn-save-purchase", "click", savePurchase);
    on("btn-add-purchase-item", "click", addPurchaseItem);
    on("purchase-search", "input", renderPurchasesHistory);
    on("purchase-modal-close", "click", () => $("#purchase-modal")?.classList.add("hidden"));

    // Backup
    on("btn-backup", "click", async () => {
      const btn   = document.getElementById("btn-backup");
      const label = document.getElementById("backup-label");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      if (label) label.textContent = "Backing up...";
      try {
        const res  = await fetch("/api/backup/run", { method: "POST" });
        const data = await res.json();
        if (data.ok) {
          const t = data.time ? new Date(data.time).toLocaleString() : "";
          alert(`✅ Backup successful!\n📁 ${data.file || ""}\n🕒 ${t}`);
          if (label) label.textContent = "Backup Now";
        } else {
          alert(`❌ Backup failed: ${data.error || "Unknown error"}`);
          if (label) label.textContent = "Backup Now";
        }
      } catch (e) {
        alert(`❌ Backup error: ${e.message}`);
        if (label) label.textContent = "Backup Now";
      } finally {
        btn.disabled = false;
      }
    });

    on("btn-restore", "click", async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,.json,application/zip,application/json";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const btn = document.getElementById("btn-restore");
        const label = document.getElementById("restore-label");
        if (btn) btn.disabled = true;
        if (label) label.textContent = "Restoring...";
        try {
          const res = await fetch("/api/backup/restore", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: await file.arrayBuffer(),
          });
          const data = await res.json();
          if (data.ok) {
            alert("✅ Restore complete");
            await loadAllData();
            updateDashboard();
            renderProductsTable();
            renderCustomersTable();
            renderExpensesTable();
            renderPurchasesHistory();
          } else {
            alert(`❌ Restore failed: ${data.error || "Unknown error"}`);
          }
        } catch (e) {
          alert(`❌ Restore error: ${e.message}`);
        } finally {
          if (btn) btn.disabled = false;
          if (label) label.textContent = "Restore Backup";
        }
      };
      input.click();
    });

    // Access control
    applyAccessControl();

    // Settings
    on("btn-save-settings", "click", saveSettingsData);

    // GitHub backup
    on("btn-github-test",        "click", testGithubBackup);
    on("btn-github-backup-now",  "click", runGithubBackupNow);
    on("btn-github-list",        "click", listGithubBackups);

    // Template previews
    on("btn-preview-invoice",    "click", () => previewTemplate("invoice"));
    on("btn-preview-receipt",    "click", () => previewTemplate("receipt"));
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
        this.classList.add("active");
        const panel = document.getElementById("stab-" + this.dataset.tab);
        if (panel) panel.classList.add("active");
        if (this.dataset.tab === "employers") loadEmployersTable();
      });
    });

    // Employer modal
    on("btn-add-employer", "click", openAddEmployerModal);
    on("emp-modal-cancel", "click", closeEmployerModal);
    on("emp-modal-save",   "click", saveEmployer);
    const empRoleSelect = document.getElementById("emp-role");
    if (empRoleSelect) {
      empRoleSelect.addEventListener("change", function () {
        const preset = ROLE_PRESETS[this.value] || [];
        setEmpPermissions(preset);
      });
    }

    // General
    on("btn-seed", "click", seedSampleData);
    on("btn-clear-data", "click", clearAllData);
    on("btn-logout", "click", logout);

    // Populate category filter
    const catSelect = $("#product-category-filter");
    if (catSelect) {
      categories.forEach((cat) => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
      });
    }

    // Initialize views
    renderProductsTable();
    renderCustomersTable();
    renderExpensesTable();
    renderPurchasesHistory();
    updateDashboard();
    switchView("products");

  } catch (err) {
    console.error("SD POS init error:", err);
  }
});
