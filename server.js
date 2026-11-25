require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { getConfiguredCouriers, bookParcel, trackParcel } = require("./services/couriers");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const STORE_ID = process.env.SSLCOMMERZ_STORE_ID || "";
const STORE_PASSWD = process.env.SSLCOMMERZ_STORE_PASSWD || "";
const IS_LIVE = String(process.env.SSLCOMMERZ_IS_LIVE).toLowerCase() === "true";
const ADMIN_KEY = process.env.ADMIN_KEY || "aureva-admin-2026";
const COURIER_AUTO_BOOK = String(process.env.COURIER_AUTO_BOOK || "true").toLowerCase() === "true";

const SSLCOMMERZ_INIT_URL = IS_LIVE
  ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
  : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";

const SSLCOMMERZ_VALIDATE_URL = IS_LIVE
  ? "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php"
  : "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const CONSULTATIONS_FILE = path.join(DATA_DIR, "consultations.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function autoBookOrder(orderRef, preferredProvider) {
  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex(o => o.orderRef === orderRef);
  if (idx === -1) return { booked: false, reason: "Order not found" };

  const result = await bookParcel(orders[idx], preferredProvider);
  if (result.booked && result.courier) {
    orders[idx].courier = result.courier;
    writeJson(ORDERS_FILE, orders);
  }
  return result;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    gatewayConfigured: Boolean(STORE_ID && STORE_PASSWD && STORE_ID !== "your_store_id"),
    couriersConfigured: getConfiguredCouriers(),
    mode: IS_LIVE ? "LIVE" : "SANDBOX"
  });
});

// Cash on Delivery Order + Auto Courier Booking
app.post("/api/orders/cod", async (req, res) => {
  const { orderRef, name, phone, address, items, itemsSummary, total } = req.body || {};
  if (!name || !phone || !address || !total) {
    return res.status(400).json({ status: "error", message: "Missing required order fields." });
  }

  const orders = readJson(ORDERS_FILE);
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

  let courierResult = null;
  if (COURIER_AUTO_BOOK) {
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
    if (!STORE_ID || !STORE_PASSWD || STORE_ID === "your_store_id") {
      return res.status(500).json({
        status: "error",
        message: "SSLCommerz Store ID and Password are not configured in .env yet."
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
      store_id: STORE_ID,
      store_passwd: STORE_PASSWD,
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

    const sslRes = await fetch(SSLCOMMERZ_INIT_URL, {
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

    const orders = readJson(ORDERS_FILE);
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

  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex(o => o.tranId === tranId);
  if (idx === -1) return { valid: false, reason: "Order not found" };

  if (orders[idx].paymentStatus === "PAID") {
    return {
      valid: true,
      orderRef: orders[idx].orderRef,
      trackingCode: orders[idx].courier?.trackingCode || ""
    };
  }

  const url = `${SSLCOMMERZ_VALIDATE_URL}?val_id=${encodeURIComponent(valId)}&store_id=${encodeURIComponent(STORE_ID)}&store_passwd=${encodeURIComponent(STORE_PASSWD)}&format=json`;
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
    if (COURIER_AUTO_BOOK) {
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
    const orders = readJson(ORDERS_FILE);
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
    const orders = readJson(ORDERS_FILE);
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

// Track Courier Delivery Status by Order Ref (works across Steadfast, Pathao, RedX, eCourier)
app.get("/api/courier/track/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(o => o.orderRef === orderRef);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const liveDeliveryStatus = await trackParcel(order);
  res.json({
    orderRef: order.orderRef,
    paymentStatus: order.paymentStatus,
    courier: order.courier || null,
    liveDeliveryStatus
  });
});

// Manual Courier Booking / Provider Override (Admin Protected)
// Example: POST /api/courier/book/ORD-1234?provider=pathao&key=aureva-admin-2026
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
  const list = readJson(CONSULTATIONS_FILE);
  list.unshift({
    name,
    phone,
    notes,
    createdAt: new Date().toISOString()
  });
  writeJson(CONSULTATIONS_FILE, list);
  res.json({ status: "success" });
});

// Protected Admin Endpoints to view orders & consultations
app.get("/api/orders", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(ORDERS_FILE));
});

app.get("/api/consultations", (req, res) => {
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  res.json(readJson(CONSULTATIONS_FILE));
});

app.listen(PORT, () => {
  console.log(`Aureva Store running on ${BASE_URL} (SSLCommerz ${IS_LIVE ? "LIVE" : "SANDBOX"} | Couriers:`, getConfiguredCouriers(), ")");
});
