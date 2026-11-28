require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getConfiguredCouriers, bookParcel, trackParcel } = require("./services/couriers");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY || "aureva-admin-2026";

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const CONSULTATIONS_FILE = path.join(DATA_DIR, "consultations.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const DEFAULT_PRODUCTS_FILE = path.join(DATA_DIR, "default-products.json");
const SITE_CONFIG_FILE = path.join(DATA_DIR, "site-config.json");
const COUPONS_FILE = path.join(DATA_DIR, "coupons.json");
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_MAP = {
  [ORDERS_FILE]: "aureva:orders",
  [CONSULTATIONS_FILE]: "aureva:consultations",
  [SETTINGS_FILE]: "aureva:settings",
  [PRODUCTS_FILE]: "aureva:products",
  [SITE_CONFIG_FILE]: "aureva:site_config",
  [COUPONS_FILE]: "aureva:coupons",
  [CUSTOMERS_FILE]: "aureva:customers"
};

function hasUpstash() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function upstashCmd(cmdArray) {
  if (!hasUpstash()) return null;
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmdArray)
  });
  return res.json();
}

function writeJson(filePath, data) {
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, jsonStr, "utf-8");
  const rKey = REDIS_MAP[filePath];
  if (rKey && hasUpstash()) {
    upstashCmd(["SET", rKey, jsonStr]).catch(err => console.error("Upstash sync error:", err));
  }
}

async function initUpstashSync() {
  if (!hasUpstash()) return;
  for (const [filePath, rKey] of Object.entries(REDIS_MAP)) {
    try {
      const data = await upstashCmd(["GET", rKey]);
      if (data && typeof data.result === "string" && data.result.length > 0) {
        fs.writeFileSync(filePath, data.result, "utf-8");
      }
    } catch (err) {
      console.error("Upstash restore error for", rKey, err);
    }
  }
  console.log("Upstash permanent database synced!");
}

function getProducts() {
  if (fs.existsSync(PRODUCTS_FILE)) {
    return readJson(PRODUCTS_FILE, []);
  }
  const defaults = readJson(DEFAULT_PRODUCTS_FILE, []);
  if (defaults.length > 0) {
    writeJson(PRODUCTS_FILE, defaults);
  }
  return defaults;
}

function getSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return {
    SSLCOMMERZ_STORE_ID: saved.SSLCOMMERZ_STORE_ID || process.env.SSLCOMMERZ_STORE_ID || "",
    SSLCOMMERZ_STORE_PASSWD: saved.SSLCOMMERZ_STORE_PASSWD || process.env.SSLCOMMERZ_STORE_PASSWD || "",
    SSLCOMMERZ_IS_LIVE: saved.SSLCOMMERZ_IS_LIVE ?? process.env.SSLCOMMERZ_IS_LIVE ?? "false",
    COURIER_PROVIDER: saved.COURIER_PROVIDER || process.env.COURIER_PROVIDER || "auto",
    COURIER_AUTO_BOOK: saved.COURIER_AUTO_BOOK ?? process.env.COURIER_AUTO_BOOK ?? "true",
    STEADFAST_API_KEY: saved.STEADFAST_API_KEY || process.env.STEADFAST_API_KEY || "",
    STEADFAST_SECRET_KEY: saved.STEADFAST_SECRET_KEY || process.env.STEADFAST_SECRET_KEY || "",
    PATHAO_IS_LIVE: saved.PATHAO_IS_LIVE ?? process.env.PATHAO_IS_LIVE ?? "true",
    PATHAO_CLIENT_ID: saved.PATHAO_CLIENT_ID || process.env.PATHAO_CLIENT_ID || "",
    PATHAO_CLIENT_SECRET: saved.PATHAO_CLIENT_SECRET || process.env.PATHAO_CLIENT_SECRET || "",
    PATHAO_USERNAME: saved.PATHAO_USERNAME || process.env.PATHAO_USERNAME || "",
    PATHAO_PASSWORD: saved.PATHAO_PASSWORD || process.env.PATHAO_PASSWORD || "",
    PATHAO_STORE_ID: saved.PATHAO_STORE_ID || process.env.PATHAO_STORE_ID || "",
    REDX_IS_LIVE: saved.REDX_IS_LIVE ?? process.env.REDX_IS_LIVE ?? "true",
    REDX_API_TOKEN: saved.REDX_API_TOKEN || process.env.REDX_API_TOKEN || "",
    REDX_DEFAULT_AREA: saved.REDX_DEFAULT_AREA || process.env.REDX_DEFAULT_AREA || "Dhaka",
    REDX_DEFAULT_AREA_ID: saved.REDX_DEFAULT_AREA_ID || process.env.REDX_DEFAULT_AREA_ID || "1",
    ECOURIER_IS_LIVE: saved.ECOURIER_IS_LIVE ?? process.env.ECOURIER_IS_LIVE ?? "true",
    ECOURIER_API_KEY: saved.ECOURIER_API_KEY || process.env.ECOURIER_API_KEY || "",
    ECOURIER_API_SECRET: saved.ECOURIER_API_SECRET || process.env.ECOURIER_API_SECRET || "",
    ECOURIER_USER_ID: saved.ECOURIER_USER_ID || process.env.ECOURIER_USER_ID || "",
    ECOURIER_PACKAGE_CODE: saved.ECOURIER_PACKAGE_CODE || process.env.ECOURIER_PACKAGE_CODE || ""
  };
}

function getSslUrls(settings) {
  const isLive = String(settings.SSLCOMMERZ_IS_LIVE).toLowerCase() === "true";
  return {
    isLive,
    initUrl: isLive
      ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
      : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
    validateUrl: isLive
      ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
      : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php"
  };
}

async function autoBookOrder(orderRef, preferredProvider) {
  const orders = readJson(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.orderRef === orderRef);
  if (idx === -1) return { booked: false, reason: "Order not found" };

  const settings = getSettings();
  const result = await bookParcel(orders[idx], preferredProvider, settings);
  if (result.booked && result.courier) {
    orders[idx].courier = result.courier;
    writeJson(ORDERS_FILE, orders);
  }
  return result;
}

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/index.html" || req.path === "/admin") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
  next();
});
const INDEX_HTML_PATH = path.join(__dirname, "public", "index.html");
let cachedIndexHtml = null;
function getIndexHtmlTemplate() {
  if (!cachedIndexHtml && fs.existsSync(INDEX_HTML_PATH)) {
    cachedIndexHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  }
  return cachedIndexHtml || "";
}
function safeJsonForHtml(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

app.get(["/", "/index.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const tpl = getIndexHtmlTemplate();
  if (!tpl) return res.status(404).send("Not found");
  const cfg = readJson(SITE_CONFIG_FILE, {});
  const products = getProducts();
  const fbPixelId = String(getSettings().FB_PIXEL_ID || "").trim();
  const bootScript = `<script>window.__INITIAL_SITE_CONFIG__=${safeJsonForHtml(cfg)};window.__INITIAL_PRODUCTS__=${safeJsonForHtml(products)};window.__INITIAL_PIXEL_ID__=${safeJsonForHtml(fbPixelId)};</script>`;
  const out = tpl.includes("</head>") ? tpl.replace("</head>", bootScript + "\n</head>") : bootScript + tpl;
  res.type("html").send(out);
});

app.use(express.static(path.join(__dirname, "public")));

// Clean Control Panel route: /admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Health check
app.get("/api/health", (req, res) => {
  const s = getSettings();
  const isLive = String(s.SSLCOMMERZ_IS_LIVE).toLowerCase() === "true";
  res.json({
    ok: true,
    build: "v35",
    gatewayConfigured: Boolean(s.SSLCOMMERZ_STORE_ID && s.SSLCOMMERZ_STORE_PASSWD && s.SSLCOMMERZ_STORE_ID !== "your_store_id"),
    couriersConfigured: getConfiguredCouriers(s),
    mode: isLive ? "LIVE" : "SANDBOX",
    permanentDb: hasUpstash()
  });
});

// Public Frontend Design Config
app.get("/api/site-config", (req, res) => {
  res.json(readJson(SITE_CONFIG_FILE, {}));
});

app.post("/api/site-config", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const current = readJson(SITE_CONFIG_FILE, {});
  const updated = { ...current, ...(req.body || {}) };
  writeJson(SITE_CONFIG_FILE, updated);
  res.json({ status: "success", config: updated });
});

app.delete("/api/site-config", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  writeJson(SITE_CONFIG_FILE, {});
  res.json({ status: "success" });
});

// Public Products API
app.get("/api/products", (req, res) => {
  res.json(getProducts());
});

// Admin Product Management (Add & Delete)
function generateStructuredSku({ brand }, products) {
  const brandMap = {
    "cosrx": "COS", "skin1004": "SKI", "beauty of joseon": "BOJ", "anua": "ANU",
    "aplb": "APL", "the face shop": "TFS", "i'm from": "IMF", "dr. althea": "ALH",
    "ksecret": "KSC", "arencia": "ARE", "nella": "NEL"
  };
  const cb = String(brand || "").trim().toLowerCase();
  const bCode = brandMap[cb] || cb.replace(/[^a-z0-9]/g, "").slice(0, 3).toUpperCase() || "GEN";

  let maxNum = 0;
  const existing = new Set();
  (Array.isArray(products) ? products : []).forEach(p => {
    const id = String(p.id || "").trim().toUpperCase();
    existing.add(id);
    const m = id.match(/^AUR-[A-Z0-9]+-(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxNum) maxNum = n;
    }
  });
  let next = maxNum + 1;
  let candidate = `AUR-${bCode}-${String(next).padStart(3, "0")}`;
  while (existing.has(candidate)) {
    next++;
    candidate = `AUR-${bCode}-${String(next).padStart(3, "0")}`;
  }
  return candidate;
}

app.post("/api/products", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });

  const { id: customSku, name, brand, category, size, price, offerPrice, costPrice, isCombo, comboTag, stock, desc, imageUrl, images, ingredients, howToUse, skinType } = req.body || {};
  if (!name || !brand || !category || !price) {
    return res.status(400).json({ error: "Name, brand, category, and price are required." });
  }

  const products = getProducts();
  const parsedOffer = Number(offerPrice);
  const newProduct = {
    id: (customSku && String(customSku).trim() && !products.some(p => p.id.toUpperCase() === String(customSku).trim().toUpperCase())) ? String(customSku).trim().toUpperCase() : generateStructuredSku({ brand, name, size }, products),
    name: String(name).trim(),
    brand: String(brand).trim(),
    category: String(category).trim(),
    size: String(size || "").trim(),
    price: Number(price) || 0,
    offerPrice: parsedOffer > 0 ? parsedOffer : null,
    costPrice: Number(costPrice) > 0 ? Number(costPrice) : 0,
    isCombo: Boolean(isCombo === true || isCombo === "true" || isCombo === "on"),
    comboTag: String(comboTag || "").trim(),
    stock: Number(stock ?? 5),
    desc: String(desc || "").trim(),
    imageUrl: String(imageUrl || (Array.isArray(images) && images[0]) || "").trim(),
    images: Array.isArray(images) ? images.filter(Boolean) : (imageUrl ? [String(imageUrl).trim()] : []),
    ingredients: String(ingredients || "").trim(),
    howToUse: String(howToUse || "").trim(),
    skinType: String(skinType || "").trim()
  };
  products.unshift(newProduct);
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success", product: newProduct });
});

app.put("/api/products/:id", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const products = getProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ status: "error", message: "Product not found." });

  const b = req.body || {};
  const cur = products[idx];
  const parsedOffer = b.offerPrice !== undefined ? Number(b.offerPrice) : cur.offerPrice;
  products[idx] = {
    ...cur,
    name: b.name !== undefined ? String(b.name).trim() : cur.name,
    brand: b.brand !== undefined ? String(b.brand).trim() : cur.brand,
    category: b.category !== undefined ? String(b.category).trim() : cur.category,
    size: b.size !== undefined ? String(b.size).trim() : cur.size,
    price: b.price !== undefined ? Number(b.price) || 0 : cur.price,
    offerPrice: parsedOffer && parsedOffer > 0 ? parsedOffer : null,
    costPrice: b.costPrice !== undefined ? (Number(b.costPrice) || 0) : (cur.costPrice || 0),
    isCombo: b.isCombo !== undefined ? Boolean(b.isCombo === true || b.isCombo === "true" || b.isCombo === "on") : cur.isCombo,
    comboTag: b.comboTag !== undefined ? String(b.comboTag).trim() : cur.comboTag,
    stock: b.stock !== undefined ? Number(b.stock) : cur.stock,
    desc: b.desc !== undefined ? String(b.desc).trim() : cur.desc,
    ingredients: b.ingredients !== undefined ? String(b.ingredients).trim() : cur.ingredients,
    howToUse: b.howToUse !== undefined ? String(b.howToUse).trim() : cur.howToUse,
    skinType: b.skinType !== undefined ? String(b.skinType).trim() : cur.skinType
  };
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success", product: products[idx] });
});

app.patch("/api/products/:id/images", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const products = getProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ status: "error", message: "Product not found." });
  const imgs = Array.isArray(req.body?.images) ? req.body.images.filter(Boolean) : [];
  products[idx].images = imgs;
  if (imgs.length > 0) products[idx].imageUrl = imgs[0];
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success", product: products[idx] });
});

app.delete("/api/products/:id", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });

  const products = getProducts().filter(p => p.id !== req.params.id);
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success" });
});


function sha256Hex(val) {
  return crypto.createHash("sha256").update(String(val || "").trim().toLowerCase()).digest("hex");
}

async function sendFbCapiEvent(eventName, { orderRef, total, phone, email, items, eventId }) {
  try {
    const s = getSettings();
    const pixelId = String(s.FB_PIXEL_ID || "").trim();
    const token = String(s.FB_CAPI_TOKEN || "").trim();
    if (!pixelId || !token) return;
    const userData = {};
    if (phone) userData.ph = [sha256Hex(phone.replace(/[^0-9]/g, ""))];
    if (email) userData.em = [sha256Hex(email)];
    const body = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || orderRef || ("ev-" + Date.now()),
        action_source: "website",
        user_data: userData,
        custom_data: {
          currency: "BDT",
          value: Number(total) || 0,
          order_id: orderRef || "",
          num_items: Array.isArray(items) ? items.reduce((sum, i) => sum + (Number(i.qty) || 1), 0) : 1
        }
      }]
    };
    await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("FB CAPI error:", err.message);
  }
}

function enrichOrderItems(rawItems) {
  const products = getProducts();
  let modifiedStock = false;
  const enriched = (Array.isArray(rawItems) ? rawItems : []).map(it => {
    const prod = products.find(p => p.id === it.id);
    const qty = Math.max(1, Number(it.qty) || 1);
    const unitCost = prod ? (Number(prod.costPrice) || 0) : 0;
    if (prod && Number(prod.stock) > 0) {
      prod.stock = Math.max(0, Number(prod.stock) - qty);
      modifiedStock = true;
    }
    return { ...it, qty, costPrice: unitCost, lineCost: unitCost * qty };
  });
  if (modifiedStock) writeJson(PRODUCTS_FILE, products);
  return enriched;
}

function computeCouponDiscount(code, subtotal) {
  if (!code) return { valid: false, discount: 0, message: "Enter a promo code." };
  const coupons = readJson(COUPONS_FILE, []);
  const norm = String(code).trim().toUpperCase();
  const c = coupons.find(item => String(item.code).toUpperCase() === norm && item.active !== false);
  if (!c) return { valid: false, discount: 0, message: "Invalid or inactive promo code." };
  const sub = Number(subtotal) || 0;
  if (c.minOrder && sub < Number(c.minOrder)) {
    return { valid: false, discount: 0, message: `Minimum order ৳${Number(c.minOrder).toLocaleString()} required.` };
  }
  const val = Number(c.value) || 0;
  const discount = c.type === "percent" ? Math.round((sub * val) / 100) : Math.min(sub, Math.round(val));
  return { valid: true, code: norm, discount, finalSubtotal: Math.max(0, sub - discount), message: `Applied ${norm}: -৳${discount.toLocaleString()}` };
}

// Public & Admin Coupon Routes
app.post("/api/coupons/validate", (req, res) => {
  const { code, subtotal } = req.body || {};
  res.json(computeCouponDiscount(code, subtotal));
});

app.get("/api/coupons", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(COUPONS_FILE, []));
});

app.post("/api/coupons", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const { code, type, value, minOrder } = req.body || {};
  const cleanCode = String(code || "").trim().toUpperCase();
  if (!cleanCode || !value) return res.status(400).json({ error: "Code and value are required." });
  const coupons = readJson(COUPONS_FILE, []).filter(c => String(c.code).toUpperCase() !== cleanCode);
  const record = { code: cleanCode, type: type === "percent" ? "percent" : "fixed", value: Number(value) || 0, minOrder: Number(minOrder) || 0, active: true, createdAt: new Date().toISOString() };
  coupons.unshift(record);
  writeJson(COUPONS_FILE, coupons);
  res.json({ status: "success", coupon: record });
});

app.delete("/api/coupons/:code", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const target = String(req.params.code || "").trim().toUpperCase();
  const coupons = readJson(COUPONS_FILE, []).filter(c => String(c.code).toUpperCase() !== target);
  writeJson(COUPONS_FILE, coupons);
  res.json({ status: "success" });
});

// Customer Auth & Order History
function hashPassword(pwd, salt) {
  const s = salt || crypto.randomBytes(8).toString("hex");
  const hash = crypto.scryptSync(String(pwd), s, 32).toString("hex");
  return `${s}:${hash}`;
}
function verifyPassword(pwd, stored) {
  const [s, h] = String(stored || "").split(":");
  if (!s || !h) return false;
  return hashPassword(pwd, s) === `${s}:${h}`;
}
function signCustomerToken(phone) {
  const secret = getSettings().ADMIN_KEY || ADMIN_KEY;
  const sig = crypto.createHmac("sha256", secret).update(phone).digest("hex");
  return Buffer.from(`${phone}|${sig}`).toString("base64");
}
function verifyCustomerToken(token) {
  try {
    const raw = Buffer.from(String(token || ""), "base64").toString("utf8");
    const [phone, sig] = raw.split("|");
    if (!phone || !sig) return null;
    const secret = getSettings().ADMIN_KEY || ADMIN_KEY;
    const expected = crypto.createHmac("sha256", secret).update(phone).digest("hex");
    return sig === expected ? phone : null;
  } catch { return null; }
}

app.post("/api/customers/register", (req, res) => {
  const { name, phone, email, address, password } = req.body || {};
  const cleanPhone = String(phone || "").trim();
  if (!name || !cleanPhone || !password) return res.status(400).json({ error: "Name, phone, and password are required." });
  const customers = readJson(CUSTOMERS_FILE, []);
  if (customers.find(c => c.phone === cleanPhone)) return res.status(400).json({ error: "Phone number already registered. Please log in." });
  const customer = { name: String(name).trim(), phone: cleanPhone, email: String(email || "").trim(), address: String(address || "").trim(), passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  customers.push(customer);
  writeJson(CUSTOMERS_FILE, customers);
  res.json({ status: "success", token: signCustomerToken(cleanPhone), customer: { name: customer.name, phone: customer.phone, email: customer.email, address: customer.address } });
});

app.post("/api/customers/login", (req, res) => {
  const { phone, password } = req.body || {};
  const cleanPhone = String(phone || "").trim();
  const customers = readJson(CUSTOMERS_FILE, []);
  const c = customers.find(u => u.phone === cleanPhone);
  if (!c || !verifyPassword(password, c.passwordHash)) return res.status(401).json({ error: "Invalid phone number or password." });
  res.json({ status: "success", token: signCustomerToken(cleanPhone), customer: { name: c.name, phone: c.phone, email: c.email, address: c.address } });
});

app.get("/api/customers", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const customers = readJson(CUSTOMERS_FILE, []).map(c => ({
    name: c.name || "",
    phone: c.phone || "",
    email: c.email || "",
    address: c.address || "",
    createdAt: c.createdAt || ""
  }));
  res.json(customers);
});

app.get("/api/customers/orders", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query.token || "");
  const phone = verifyCustomerToken(token);
  if (!phone) return res.status(401).json({ error: "Unauthorized" });
  const orders = readJson(ORDERS_FILE, []).filter(o => String(o.phone || "").trim() === phone);
  res.json({ orders });
});

// Bulk Courier Booking
app.post("/api/courier/book-bulk", async (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const { orderRefs, provider } = req.body || {};
  const refs = Array.isArray(orderRefs) ? orderRefs : [];
  let bookedCount = 0;
  let failedCount = 0;
  const results = [];
  for (const ref of refs) {
    const r = await autoBookOrder(ref, provider);
    if (r.booked) bookedCount++;
    else failedCount++;
    results.push({ orderRef: ref, ...r });
  }
  res.json({ status: "success", bookedCount, failedCount, results });
});

function isOrderDelivered(o) {
  if (!o) return false;
  if (String(o.deliveryStatus || "").toUpperCase() === "DELIVERED") return true;
  const st = String(o.courier?.liveStatus || o.courier?.status || "").toLowerCase();
  return st.includes("delivered") && !st.includes("partial") && !st.includes("cancel") && !st.includes("return") && !st.includes("un") && !st.includes("not");
}

app.post("/api/orders/:orderRef/delivery-status", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const orders = readJson(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.orderRef === req.params.orderRef);
  if (idx === -1) return res.status(404).json({ error: "Order not found" });
  const nextStatus = String(req.body?.deliveryStatus || "DELIVERED").toUpperCase();
  orders[idx].deliveryStatus = nextStatus;
  if (orders[idx].courier) orders[idx].courier.status = nextStatus === "DELIVERED" ? "delivered" : nextStatus.toLowerCase();
  writeJson(ORDERS_FILE, orders);
  res.json({ status: "success", order: orders[idx] });
});

app.post("/api/reports/sync-deliveries", async (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const orders = readJson(ORDERS_FILE, []);
  const settings = getSettings();
  let checked = 0;
  let newlyDelivered = 0;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (!o.courier || !o.courier.trackingCode) continue;
    if (String(o.deliveryStatus || "").toUpperCase() === "DELIVERED") continue;
    checked++;
    const live = await trackParcel(o, settings);
    if (live) {
      orders[i].courier.liveStatus = String(live);
      orders[i].courier.status = String(live);
      if (isOrderDelivered(orders[i])) {
        orders[i].deliveryStatus = "DELIVERED";
        newlyDelivered++;
      } else if (/cancel|return/i.test(String(live))) {
        orders[i].deliveryStatus = "CANCELLED";
      }
    }
  }
  if (checked > 0) writeJson(ORDERS_FILE, orders);
  res.json({ status: "success", checked, newlyDelivered });
});

// Daily/Monthly Sales, Profit & Loss & Low-Stock Reports (Successful Deliveries Only)
app.get("/api/reports/summary", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const orders = readJson(ORDERS_FILE, []);
  const products = getProducts();
  const costLookup = {};
  products.forEach(p => { costLookup[p.id] = Number(p.costPrice) || 0; });

  const toDhakaDate = (iso) => {
    const d = new Date(new Date(iso || Date.now()).getTime() + 6 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };
  const todayStr = toDhakaDate(new Date().toISOString());
  const monthStr = todayStr.slice(0, 7);

  let todaySales = 0, todayOrders = 0, todayProfit = 0;
  let monthSales = 0, monthOrders = 0, monthProfit = 0;
  let totalSales = 0, totalCost = 0, deliveredCount = 0;
  let pendingOrders = 0, pendingSales = 0;
  const dailyMap = {};
  const monthlyMap = {};
  const deliveredOrders = [];

  orders.forEach(o => {
    const rev = Number(o.total) || 0;
    if (!isOrderDelivered(o)) {
      if (String(o.deliveryStatus || "").toUpperCase() !== "CANCELLED") {
        pendingOrders++;
        pendingSales += rev;
      }
      return;
    }

    deliveredCount++;
    const ordCost = Array.isArray(o.items)
      ? o.items.reduce((s, it) => s + (Number(it.lineCost) || ((costLookup[it.id] || 0) * (Number(it.qty) || 1))), 0)
      : 0;
    const ordProfit = rev - ordCost;
    const dKey = toDhakaDate(o.createdAt);
    const mKey = dKey.slice(0, 7);

    totalSales += rev;
    totalCost += ordCost;
    if (dKey === todayStr) { todaySales += rev; todayOrders++; todayProfit += ordProfit; }
    if (mKey === monthStr) { monthSales += rev; monthOrders++; monthProfit += ordProfit; }

    dailyMap[dKey] = dailyMap[dKey] || { period: dKey, orders: 0, sales: 0, cost: 0, profit: 0 };
    dailyMap[dKey].orders++; dailyMap[dKey].sales += rev; dailyMap[dKey].cost += ordCost; dailyMap[dKey].profit += ordProfit;

    monthlyMap[mKey] = monthlyMap[mKey] || { period: mKey, orders: 0, sales: 0, cost: 0, profit: 0 };
    monthlyMap[mKey].orders++; monthlyMap[mKey].sales += rev; monthlyMap[mKey].cost += ordCost; monthlyMap[mKey].profit += ordProfit;

    deliveredOrders.push({
      orderRef: o.orderRef,
      date: dKey,
      name: o.name,
      phone: o.phone,
      courier: o.courier?.provider || o.paymentMethod,
      trackingCode: o.courier?.trackingCode || "-",
      sales: rev,
      cost: ordCost,
      profit: ordProfit
    });
  });

  const lowStock = products.filter(p => Number(p.stock) <= 2).sort((a, b) => Number(a.stock) - Number(b.stock));
  const daily = Object.values(dailyMap).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 30);
  const monthly = Object.values(monthlyMap).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 12);

  res.json({
    today: { orders: todayOrders, sales: todaySales, profit: todayProfit },
    month: { orders: monthOrders, sales: monthSales, profit: monthProfit },
    overall: { orders: deliveredCount, sales: totalSales, cost: totalCost, profit: totalSales - totalCost },
    pending: { orders: pendingOrders, sales: pendingSales },
    deliveredOrders,
    lowStock,
    daily,
    monthly
  });
});

// Cash on Delivery Order + Auto Courier Booking
app.post("/api/orders/cod", async (req, res) => {
  const { orderRef, name, phone, email, address, items, itemsSummary, subtotal, deliveryCharge, couponCode, discount, total } = req.body || {};
  if (!name || !phone || !address || !total) {
    return res.status(400).json({ status: "error", message: "Missing required order fields." });
  }

  const enrichedItems = enrichOrderItems(items);
  const orders = readJson(ORDERS_FILE, []);
  const record = {
    orderRef: orderRef || "ORD-" + Math.floor(1000 + Math.random() * 9000),
    paymentMethod: "COD",
    paymentStatus: "PENDING_COD",
    name,
    phone,
    email: email || "",
    address,
    items: enrichedItems,
    itemsSummary: itemsSummary || "",
    subtotal: Number(subtotal) || 0,
    deliveryCharge: Number(deliveryCharge) || 0,
    couponCode: couponCode || "",
    discount: Number(discount) || 0,
    total: Number(total) || 0,
    createdAt: new Date().toISOString()
  };
  orders.unshift(record);
  writeJson(ORDERS_FILE, orders);
  sendFbCapiEvent("Purchase", { orderRef: record.orderRef, total: record.total, phone, email, items: enrichedItems });

  const s = getSettings();
  let courierResult = null;
  if (String(s.COURIER_AUTO_BOOK).toLowerCase() === "true") {
    courierResult = await autoBookOrder(record.orderRef);
  }

  res.json({
    status: "success",
    orderRef: record.orderRef,
    courierProvider: courierResult?.courier?.provider || null,
    trackingCode: courierResult?.courier?.trackingCode || null,
    consignmentId: courierResult?.courier?.consignmentId || null
  });
});

// Initiate SSLCommerz Online Payment (Cards, bKash, Nagad, Rocket, Upay)
app.post("/api/pay/sslcommerz", async (req, res) => {
  try {
    const s = getSettings();
    const { initUrl } = getSslUrls(s);
    if (!s.SSLCOMMERZ_STORE_ID || !s.SSLCOMMERZ_STORE_PASSWD || s.SSLCOMMERZ_STORE_ID === "your_store_id") {
      return res.status(500).json({
        status: "error",
        message: "SSLCommerz Store ID and Password are not configured in Control Panel yet."
      });
    }

    const { orderRef, name, phone, email, address, items, itemsSummary, total } = req.body || {};
    const numericTotal = Number(total) || 0;
    if (!name || !phone || !address || numericTotal <= 0) {
      return res.status(400).json({ status: "error", message: "Invalid order details or total." });
    }

    const tranId = `AUR-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const safeOrderRef = orderRef || "ORD-" + Math.floor(1000 + Math.random() * 9000);

    const payload = new URLSearchParams({
      store_id: s.SSLCOMMERZ_STORE_ID,
      store_passwd: s.SSLCOMMERZ_STORE_PASSWD,
      total_amount: numericTotal.toFixed(2),
      currency: "BDT",
      tran_id: tranId,
      success_url: `${BASE_URL}/api/sslcommerz/success`,
      fail_url: `${BASE_URL}/api/sslcommerz/fail`,
      cancel_url: `${BASE_URL}/api/sslcommerz/cancel`,
      ipn_url: `${BASE_URL}/api/sslcommerz/ipn`,
      shipping_method: "Courier",
      product_name: (itemsSummary || "Aureva Skincare Order").slice(0, 250),
      product_category: "Skincare",
      product_profile: "physical-goods",
      cus_name: name,
      cus_email: email || "customer@aureva-skincare.com",
      cus_add1: address,
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      cus_phone: phone,
      ship_name: name,
      ship_add1: address,
      ship_city: "Dhaka",
      ship_country: "Bangladesh",
      value_a: safeOrderRef
    });

    const sslRes = await fetch(initUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: payload.toString()
    });
    const sslData = await sslRes.json();

    if (sslData.status !== "SUCCESS" || !sslData.GatewayPageURL) {
      return res.status(502).json({
        status: "error",
        message: sslData.failedreason || "Failed to initiate SSLCommerz payment session."
      });
    }

    const orders = readJson(ORDERS_FILE, []);
    orders.unshift({
      orderRef: safeOrderRef,
      tranId,
      paymentMethod: "SSLCOMMERZ",
      paymentStatus: "INITIATED",
      name,
      phone,
      email: email || "",
      address,
      items: Array.isArray(items) ? items : [],
      itemsSummary: itemsSummary || "",
      total: numericTotal,
      createdAt: new Date().toISOString()
    });
    writeJson(ORDERS_FILE, orders);

    res.json({
      status: "success",
      gatewayUrl: sslData.GatewayPageURL,
      tranId,
      orderRef: safeOrderRef
    });
  } catch (err) {
    console.error("SSLCommerz init error:", err);
    res.status(500).json({ status: "error", message: "Payment server error." });
  }
});

// Helper: Validate transaction with SSLCommerz Order Validation API & Auto Book Courier
async function validateAndCompleteOrder(valId, tranId) {
  if (!valId || !tranId) return { valid: false, reason: "Missing val_id or tran_id" };

  const orders = readJson(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.tranId === tranId);
  if (idx === -1) return { valid: false, reason: "Order not found" };

  if (orders[idx].paymentStatus === "PAID") {
    return {
      valid: true,
      orderRef: orders[idx].orderRef,
      trackingCode: orders[idx].courier?.trackingCode || ""
    };
  }

  const s = getSettings();
  const { validateUrl } = getSslUrls(s);
  const url = `${validateUrl}?val_id=${encodeURIComponent(valId)}&store_id=${encodeURIComponent(s.SSLCOMMERZ_STORE_ID)}&store_passwd=${encodeURIComponent(s.SSLCOMMERZ_STORE_PASSWD)}&format=json`;
  const valRes = await fetch(url);
  const valData = await valRes.json();

  const isStatusOk = valData.status === "VALID" || valData.status === "VALIDATED";
  const amountMatches = Math.abs(Number(valData.amount) - Number(orders[idx].total)) < 0.01;
  const currencyMatches = valData.currency === "BDT";

  if (isStatusOk && amountMatches && currencyMatches) {
    orders[idx].paymentStatus = "PAID";
    orders[idx].valId = valId;
    orders[idx].cardType = valData.card_type || "";
    orders[idx].storeAmount = Number(valData.store_amount) || 0;
    orders[idx].paidAt = new Date().toISOString();
    writeJson(ORDERS_FILE, orders);

    let trackingCode = "";
    if (String(s.COURIER_AUTO_BOOK).toLowerCase() === "true") {
      const courierRes = await autoBookOrder(orders[idx].orderRef);
      trackingCode = courierRes?.courier?.trackingCode || "";
    }

    return { valid: true, orderRef: orders[idx].orderRef, trackingCode };
  }

  orders[idx].paymentStatus = "VALIDATION_FAILED";
  writeJson(ORDERS_FILE, orders);
  return { valid: false, reason: "Validation mismatch" };
}

// SSLCommerz Callbacks
app.post("/api/sslcommerz/success", async (req, res) => {
  try {
    const { val_id, tran_id } = req.body || {};
    const result = await validateAndCompleteOrder(val_id, tran_id);
    if (result.valid) {
      const trackingParam = result.trackingCode ? `&tracking=${encodeURIComponent(result.trackingCode)}` : "";
      return res.redirect(`/?payment=success&tran_id=${encodeURIComponent(tran_id)}&orderRef=${encodeURIComponent(result.orderRef)}${trackingParam}`);
    }
    return res.redirect(`/?payment=failed&tran_id=${encodeURIComponent(tran_id || "")}`);
  } catch (err) {
    console.error("Success callback error:", err);
    return res.redirect("/?payment=failed");
  }
});

app.post("/api/sslcommerz/fail", (req, res) => {
  const { tran_id } = req.body || {};
  if (tran_id) {
    const orders = readJson(ORDERS_FILE, []);
    const idx = orders.findIndex(o => o.tranId === tran_id);
    if (idx !== -1 && orders[idx].paymentStatus !== "PAID") {
      orders[idx].paymentStatus = "FAILED";
      writeJson(ORDERS_FILE, orders);
    }
  }
  res.redirect(`/?payment=failed&tran_id=${encodeURIComponent(tran_id || "")}`);
});

app.post("/api/sslcommerz/cancel", (req, res) => {
  const { tran_id } = req.body || {};
  if (tran_id) {
    const orders = readJson(ORDERS_FILE, []);
    const idx = orders.findIndex(o => o.tranId === tran_id);
    if (idx !== -1 && orders[idx].paymentStatus !== "PAID") {
      orders[idx].paymentStatus = "CANCELLED";
      writeJson(ORDERS_FILE, orders);
    }
  }
  res.redirect(`/?payment=cancelled&tran_id=${encodeURIComponent(tran_id || "")}`);
});

app.post("/api/sslcommerz/ipn", async (req, res) => {
  try {
    const { val_id, tran_id, status } = req.body || {};
    if (status === "VALID" && val_id && tran_id) {
      await validateAndCompleteOrder(val_id, tran_id);
    }
    res.status(200).send("IPN Received");
  } catch (err) {
    console.error("IPN error:", err);
    res.status(500).send("IPN Error");
  }
});

// Track Courier Delivery Status by Order Ref
app.get("/api/courier/track/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  const orders = readJson(ORDERS_FILE, []);
  const order = orders.find(o => o.orderRef === orderRef);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const liveDeliveryStatus = await trackParcel(order, getSettings());
  res.json({
    orderRef: order.orderRef,
    paymentStatus: order.paymentStatus,
    courier: order.courier || null,
    liveDeliveryStatus
  });
});

// Manual Courier Booking / Provider Override (Admin Protected)
app.post("/api/courier/book/:orderRef", async (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });

  const preferredProvider = req.query.provider || req.body?.provider;
  const result = await autoBookOrder(req.params.orderRef, preferredProvider);
  res.json(result);
});

// Consultation Form
app.post("/api/consultations", (req, res) => {
  const { name, phone, notes } = req.body || {};
  if (!name || !phone || !notes) {
    return res.status(400).json({ status: "error", message: "Missing consultation fields." });
  }
  const list = readJson(CONSULTATIONS_FILE, []);
  list.unshift({
    name,
    phone,
    notes,
    createdAt: new Date().toISOString()
  });
  writeJson(CONSULTATIONS_FILE, list);
  res.json({ status: "success" });
});

// Protected Control Panel Endpoints
app.get("/api/orders", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(ORDERS_FILE, []));
});

app.get("/api/consultations", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(CONSULTATIONS_FILE, []));
});

app.get("/api/settings", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  res.json(getSettings());
});

app.post("/api/settings", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== (getSettings().ADMIN_KEY || ADMIN_KEY)) return res.status(401).json({ error: "Unauthorized" });
  const current = readJson(SETTINGS_FILE, {});
  const updated = { ...current, ...(req.body || {}) };
  writeJson(SETTINGS_FILE, updated);
  res.json({ status: "success", settings: getSettings() });
});

function startKeepAlive() {
  const target = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || (String(BASE_URL || "").startsWith("https://") ? BASE_URL : "")).replace(/\/+$/, "");
  if (!target) return;
  const healthUrl = `${target}/api/health`;
  const client = healthUrl.startsWith("https://") ? require("https") : require("http");
  const ping = () => {
    try {
      const req = client.get(healthUrl, (res) => { res.resume(); });
      req.on("error", () => {});
      req.setTimeout(10000, () => req.destroy());
    } catch {}
  };
  setInterval(ping, 10 * 60 * 1000);
  console.log(`Keep-alive active: pinging ${healthUrl} every 10 minutes`);
}

initUpstashSync().finally(() => {
  app.listen(PORT, () => {
    const s = getSettings();
    console.log(`Aureva Store running on ${BASE_URL} | Control Panel: ${BASE_URL}/admin | PermanentDB: ${hasUpstash() ? "ON" : "OFF"} | Couriers:`, getConfiguredCouriers(s));
    startKeepAlive();
  });
});
