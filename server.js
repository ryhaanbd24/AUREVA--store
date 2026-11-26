require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
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
  [SITE_CONFIG_FILE]: "aureva:site_config"
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
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const current = readJson(SITE_CONFIG_FILE, {});
  const updated = { ...current, ...(req.body || {}) };
  writeJson(SITE_CONFIG_FILE, updated);
  res.json({ status: "success", config: updated });
});

app.delete("/api/site-config", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  writeJson(SITE_CONFIG_FILE, {});
  res.json({ status: "success" });
});

// Public Products API
app.get("/api/products", (req, res) => {
  res.json(getProducts());
});

// Admin Product Management (Add & Delete)
app.post("/api/products", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { name, brand, category, size, price, offerPrice, isCombo, comboTag, stock, desc, imageUrl, ingredients, howToUse, skinType } = req.body || {};
  if (!name || !brand || !category || !price) {
    return res.status(400).json({ error: "Name, brand, category, and price are required." });
  }

  const products = getProducts();
  const parsedOffer = Number(offerPrice);
  const newProduct = {
    id: "AUR-SK-" + Date.now().toString().slice(-5),
    name: String(name).trim(),
    brand: String(brand).trim(),
    category: String(category).trim(),
    size: String(size || "").trim(),
    price: Number(price) || 0,
    offerPrice: parsedOffer > 0 ? parsedOffer : null,
    isCombo: Boolean(isCombo === true || isCombo === "true" || isCombo === "on"),
    comboTag: String(comboTag || "").trim(),
    stock: Number(stock ?? 5),
    desc: String(desc || "").trim(),
    imageUrl: String(imageUrl || "").trim()
  };
  products.unshift(newProduct);
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success", product: newProduct });
});

app.delete("/api/products/:id", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

  const products = getProducts().filter(p => p.id !== req.params.id);
  writeJson(PRODUCTS_FILE, products);
  res.json({ status: "success" });
});

// Cash on Delivery Order + Auto Courier Booking
app.post("/api/orders/cod", async (req, res) => {
  const { orderRef, name, phone, address, items, itemsSummary, total } = req.body || {};
  if (!name || !phone || !address || !total) {
    return res.status(400).json({ status: "error", message: "Missing required order fields." });
  }

  const orders = readJson(ORDERS_FILE, []);
  const record = {
    orderRef: orderRef || "ORD-" + Math.floor(1000 + Math.random() * 9000),
    paymentMethod: "COD",
    paymentStatus: "PENDING_COD",
    name,
    phone,
    address,
    items: Array.isArray(items) ? items : [],
    itemsSummary: itemsSummary || "",
    total: Number(total) || 0,
    createdAt: new Date().toISOString()
  };
  orders.unshift(record);
  writeJson(ORDERS_FILE, orders);

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
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

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
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(ORDERS_FILE, []));
});

app.get("/api/consultations", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(CONSULTATIONS_FILE, []));
});

app.get("/api/settings", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(getSettings());
});

app.post("/api/settings", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const current = readJson(SETTINGS_FILE, {});
  const updated = { ...current, ...(req.body || {}) };
  writeJson(SETTINGS_FILE, updated);
  res.json({ status: "success", settings: getSettings() });
});

initUpstashSync().finally(() => {
  app.listen(PORT, () => {
    const s = getSettings();
    console.log(`Aureva Store running on ${BASE_URL} | Control Panel: ${BASE_URL}/admin | PermanentDB: ${hasUpstash() ? "ON" : "OFF"} | Couriers:`, getConfiguredCouriers(s));
  });
});
