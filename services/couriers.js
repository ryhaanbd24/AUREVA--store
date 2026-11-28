// Unified Courier Service for Bangladesh's Top Couriers:
// 1. Steadfast Courier (https://portal.packzy.com)
// 2. Pathao Courier (https://pathao.com/courier/)
// 3. RedX (https://redx.com.bd/developer-api/)
// 4. eCourier (https://ecourier.com.bd/)

const STEADFAST_BASE = "https://portal.packzy.com/api/v1";

function isSet(val, placeholderPrefix = "your_") {
  return Boolean(val && !String(val).startsWith(placeholderPrefix));
}

function getCfg(settings = {}) {
  return {
    COURIER_PROVIDER: settings.COURIER_PROVIDER || process.env.COURIER_PROVIDER || "auto",
    STEADFAST_API_KEY: settings.STEADFAST_API_KEY || process.env.STEADFAST_API_KEY || "",
    STEADFAST_SECRET_KEY: settings.STEADFAST_SECRET_KEY || process.env.STEADFAST_SECRET_KEY || "",
    PATHAO_IS_LIVE: settings.PATHAO_IS_LIVE ?? process.env.PATHAO_IS_LIVE ?? "true",
    PATHAO_CLIENT_ID: settings.PATHAO_CLIENT_ID || process.env.PATHAO_CLIENT_ID || "",
    PATHAO_CLIENT_SECRET: settings.PATHAO_CLIENT_SECRET || process.env.PATHAO_CLIENT_SECRET || "",
    PATHAO_USERNAME: settings.PATHAO_USERNAME || process.env.PATHAO_USERNAME || "",
    PATHAO_PASSWORD: settings.PATHAO_PASSWORD || process.env.PATHAO_PASSWORD || "",
    PATHAO_STORE_ID: settings.PATHAO_STORE_ID || process.env.PATHAO_STORE_ID || "",
    REDX_IS_LIVE: settings.REDX_IS_LIVE ?? process.env.REDX_IS_LIVE ?? "true",
    REDX_API_TOKEN: settings.REDX_API_TOKEN || process.env.REDX_API_TOKEN || "",
    REDX_DEFAULT_AREA: settings.REDX_DEFAULT_AREA || process.env.REDX_DEFAULT_AREA || "Dhaka",
    REDX_DEFAULT_AREA_ID: settings.REDX_DEFAULT_AREA_ID || process.env.REDX_DEFAULT_AREA_ID || "1",
    ECOURIER_IS_LIVE: settings.ECOURIER_IS_LIVE ?? process.env.ECOURIER_IS_LIVE ?? "true",
    ECOURIER_API_KEY: settings.ECOURIER_API_KEY || process.env.ECOURIER_API_KEY || "",
    ECOURIER_API_SECRET: settings.ECOURIER_API_SECRET || process.env.ECOURIER_API_SECRET || "",
    ECOURIER_USER_ID: settings.ECOURIER_USER_ID || process.env.ECOURIER_USER_ID || "",
    ECOURIER_PACKAGE_CODE: settings.ECOURIER_PACKAGE_CODE || process.env.ECOURIER_PACKAGE_CODE || "",
    ECOURIER_DEFAULT_CITY: settings.ECOURIER_DEFAULT_CITY || process.env.ECOURIER_DEFAULT_CITY || "Dhaka",
    ECOURIER_DEFAULT_THANA: settings.ECOURIER_DEFAULT_THANA || process.env.ECOURIER_DEFAULT_THANA || "Dhaka",
    ECOURIER_DEFAULT_AREA: settings.ECOURIER_DEFAULT_AREA || process.env.ECOURIER_DEFAULT_AREA || "Dhaka"
  };
}

function getConfiguredCouriers(settings = {}) {
  const cfg = getCfg(settings);
  return {
    steadfast: isSet(cfg.STEADFAST_API_KEY) && isSet(cfg.STEADFAST_SECRET_KEY),
    pathao:
      isSet(cfg.PATHAO_CLIENT_ID) &&
      isSet(cfg.PATHAO_CLIENT_SECRET) &&
      isSet(cfg.PATHAO_USERNAME) &&
      isSet(cfg.PATHAO_PASSWORD) &&
      isSet(cfg.PATHAO_STORE_ID),
    redx: isSet(cfg.REDX_API_TOKEN),
    ecourier:
      isSet(cfg.ECOURIER_API_KEY) &&
      isSet(cfg.ECOURIER_API_SECRET) &&
      isSet(cfg.ECOURIER_USER_ID) &&
      isSet(cfg.ECOURIER_PACKAGE_CODE)
  };
}

function resolveProvider(preferred, settings = {}) {
  const cfg = getCfg(settings);
  const configured = getConfiguredCouriers(settings);
  const choice = (preferred || cfg.COURIER_PROVIDER || "auto").toLowerCase();
  if (choice !== "auto") {
    return configured[choice] ? choice : null;
  }
  for (const name of ["steadfast", "pathao", "redx", "ecourier"]) {
    if (configured[name]) return name;
  }
  return null;
}

// 1. Steadfast Courier
async function bookSteadfast(order, codAmount, cfg) {
  const res = await fetch(`${STEADFAST_BASE}/create_order`, {
    method: "POST",
    headers: {
      "Api-Key": cfg.STEADFAST_API_KEY,
      "Secret-Key": cfg.STEADFAST_SECRET_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      invoice: order.orderRef,
      recipient_name: order.name,
      recipient_phone: order.phone,
      recipient_address: order.address,
      cod_amount: codAmount,
      note: (order.itemsSummary || "Aureva Skincare Parcel").slice(0, 250)
    })
  });
  const data = await res.json();
  if (data.status === 200 && data.consignment) {
    return {
      booked: true,
      courier: {
        provider: "Steadfast",
        consignmentId: String(data.consignment.consignment_id),
        trackingCode: data.consignment.tracking_code,
        trackingUrl: `https://steadfast.com.bd/t/${encodeURIComponent(data.consignment.tracking_code)}`,
        status: data.consignment.status || "in_review",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "Steadfast booking failed" };
}

async function trackSteadfast(order, cfg) {
  const res = await fetch(`${STEADFAST_BASE}/status_by_invoice/${encodeURIComponent(order.orderRef)}`, {
    headers: {
      "Api-Key": cfg.STEADFAST_API_KEY,
      "Secret-Key": cfg.STEADFAST_SECRET_KEY,
      "Content-Type": "application/json"
    }
  });
  const data = await res.json();
  return data.delivery_status || null;
}

// 2. Pathao Courier
function pathaoBase(cfg) {
  return String(cfg.PATHAO_IS_LIVE).toLowerCase() === "true"
    ? "https://api-hermes.pathao.com"
    : "https://courier-api-sandbox.pathao.com";
}

async function getPathaoToken(cfg) {
  const res = await fetch(`${pathaoBase(cfg)}/aladdin/api/v1/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.PATHAO_CLIENT_ID,
      client_secret: cfg.PATHAO_CLIENT_SECRET,
      username: cfg.PATHAO_USERNAME,
      password: cfg.PATHAO_PASSWORD,
      grant_type: "password"
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.message || "Pathao auth failed");
  return data.access_token;
}

async function bookPathao(order, codAmount, cfg) {
  const token = await getPathaoToken(cfg);
  const res = await fetch(`${pathaoBase(cfg)}/aladdin/api/v1/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      store_id: Number(cfg.PATHAO_STORE_ID),
      merchant_order_id: order.orderRef,
      recipient_name: order.name,
      recipient_phone: order.phone,
      recipient_address: order.address,
      delivery_type: 48,
      item_type: 2,
      special_instruction: (order.itemsSummary || "Aureva Skincare").slice(0, 200),
      item_quantity: 1,
      item_weight: 0.5,
      amount_to_collect: codAmount,
      item_description: (order.itemsSummary || "Skincare products").slice(0, 200)
    })
  });
  const data = await res.json();
  if (data.code === 200 && data.data && data.data.consignment_id) {
    return {
      booked: true,
      courier: {
        provider: "Pathao",
        consignmentId: String(data.data.consignment_id),
        trackingCode: String(data.data.consignment_id),
        trackingUrl: "https://merchant.pathao.com/",
        status: data.data.order_status || "Pending",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "Pathao booking failed" };
}

async function trackPathao(order, cfg) {
  const token = await getPathaoToken(cfg);
  const cid = order.courier?.consignmentId;
  if (!cid) return null;
  const res = await fetch(`${pathaoBase(cfg)}/aladdin/api/v1/orders/${encodeURIComponent(cid)}/info`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const data = await res.json();
  return data.data?.order_status || null;
}

// 3. RedX Courier
function redxBase(cfg) {
  return String(cfg.REDX_IS_LIVE).toLowerCase() === "true"
    ? "https://openapi.redx.com.bd/v1.0.0-beta"
    : "https://sandbox.redx.com.bd/v1.0.0-beta";
}

async function bookRedx(order, codAmount, cfg) {
  const res = await fetch(`${redxBase(cfg)}/parcel`, {
    method: "POST",
    headers: {
      "API-ACCESS-TOKEN": `Bearer ${cfg.REDX_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      customer_name: order.name,
      customer_phone: order.phone,
      delivery_area: cfg.REDX_DEFAULT_AREA,
      delivery_area_id: Number(cfg.REDX_DEFAULT_AREA_ID || 1),
      customer_address: order.address,
      merchant_invoice_id: order.orderRef,
      cash_collection_amount: codAmount,
      parcel_weight: 500,
      instruction: (order.itemsSummary || "Aureva Skincare").slice(0, 200),
      value: Math.round(Number(order.total) || codAmount)
    })
  });
  const data = await res.json();
  if (data.tracking_id) {
    return {
      booked: true,
      courier: {
        provider: "RedX",
        consignmentId: String(data.tracking_id),
        trackingCode: String(data.tracking_id),
        trackingUrl: "https://redx.com.bd/track-global-parcel/",
        status: "pickup-pending",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "RedX booking failed" };
}

async function trackRedx(order, cfg) {
  const tid = order.courier?.trackingCode;
  if (!tid) return null;
  const res = await fetch(`${redxBase(cfg)}/parcel/info/${encodeURIComponent(tid)}`, {
    headers: { "API-ACCESS-TOKEN": `Bearer ${cfg.REDX_API_TOKEN}` }
  });
  const data = await res.json();
  return data.parcel?.status || null;
}

// 4. eCourier
function ecourierBase(cfg) {
  return String(cfg.ECOURIER_IS_LIVE).toLowerCase() === "true"
    ? "https://backoffice.ecourier.com.bd/api"
    : "https://staging.ecourier.com.bd/api";
}

async function bookEcourier(order, codAmount, cfg) {
  const paymentMethod = codAmount > 0 ? "COD" : "MPAY";
  const res = await fetch(`${ecourierBase(cfg)}/order-place`, {
    method: "POST",
    headers: {
      "API-KEY": cfg.ECOURIER_API_KEY,
      "API-SECRET": cfg.ECOURIER_API_SECRET,
      "USER-ID": cfg.ECOURIER_USER_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient_name: order.name,
      recipient_mobile: order.phone,
      recipient_city: cfg.ECOURIER_DEFAULT_CITY,
      recipient_thana: cfg.ECOURIER_DEFAULT_THANA,
      recipient_area: cfg.ECOURIER_DEFAULT_AREA,
      recipient_address: order.address,
      package_code: cfg.ECOURIER_PACKAGE_CODE,
      product_price: Math.round(Number(order.total) || 0),
      payment_method: paymentMethod,
      parcel_type: "BOX",
      product_id: order.orderRef,
      comments: (order.itemsSummary || "Aureva Skincare").slice(0, 200)
    })
  });
  const data = await res.json();
  if (data.success && data.ID) {
    return {
      booked: true,
      courier: {
        provider: "eCourier",
        consignmentId: String(data.ID),
        trackingCode: String(data.ID),
        trackingUrl: "https://ecourier.com.bd/tracking/",
        status: "placed",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "eCourier booking failed" };
}

async function trackEcourier(order, cfg) {
  const ecr = order.courier?.trackingCode;
  if (!ecr) return null;
  const res = await fetch(`${ecourierBase(cfg)}/track`, {
    method: "POST",
    headers: {
      "API-KEY": cfg.ECOURIER_API_KEY,
      "API-SECRET": cfg.ECOURIER_API_SECRET,
      "USER-ID": cfg.ECOURIER_USER_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ecr })
  });
  const data = await res.json();
  return data.query_data?.status?.[0]?.status || null;
}

async function bookParcel(order, preferredProvider, settings = {}) {
  if (order.courier && order.courier.consignmentId && !preferredProvider) {
    return { booked: true, alreadyBooked: true, courier: order.courier };
  }

  const provider = resolveProvider(preferredProvider, settings);
  if (!provider) {
    return { booked: false, reason: "No courier API credentials configured in Control Panel or .env" };
  }

  const cfg = getCfg(settings);
  const codAmount = order.paymentStatus === "PAID" ? 0 : Math.round(Number(order.total) || 0);
  try {
    if (provider === "steadfast") return await bookSteadfast(order, codAmount, cfg);
    if (provider === "pathao") return await bookPathao(order, codAmount, cfg);
    if (provider === "redx") return await bookRedx(order, codAmount, cfg);
    if (provider === "ecourier") return await bookEcourier(order, codAmount, cfg);
    return { booked: false, reason: `Unsupported provider: ${provider}` };
  } catch (err) {
    console.error(`Courier (${provider}) booking error:`, err);
    return { booked: false, reason: err.message };
  }
}

async function trackParcel(order, settings = {}) {
  const provider = (order.courier?.provider || "").toLowerCase();
  if (!provider) return null;
  const cfg = getCfg(settings);
  try {
    if (provider === "steadfast") return await trackSteadfast(order, cfg);
    if (provider === "pathao") return await trackPathao(order, cfg);
    if (provider === "redx") return await trackRedx(order, cfg);
    if (provider === "ecourier") return await trackEcourier(order, cfg);
    return null;
  } catch (err) {
    console.error(`Courier (${provider}) tracking error:`, err);
    return null;
  }
}

module.exports = {
  getConfiguredCouriers,
  bookParcel,
  trackParcel
};
