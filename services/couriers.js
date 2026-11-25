// Unified Courier Service for Bangladesh's Top Couriers:
// 1. Steadfast Courier (https://portal.packzy.com)
// 2. Pathao Courier (https://pathao.com/courier/)
// 3. RedX (https://redx.com.bd/developer-api/)
// 4. eCourier (https://ecourier.com.bd/)

const STEADFAST_BASE = "https://portal.packzy.com/api/v1";
const PATHAO_BASE =
  String(process.env.PATHAO_IS_LIVE || "true").toLowerCase() === "true"
    ? "https://api-hermes.pathao.com"
    : "https://courier-api-sandbox.pathao.com";
const REDX_BASE =
  String(process.env.REDX_IS_LIVE || "true").toLowerCase() === "true"
    ? "https://openapi.redx.com.bd/v1.0.0-beta"
    : "https://sandbox.redx.com.bd/v1.0.0-beta";
const ECOURIER_BASE =
  String(process.env.ECOURIER_IS_LIVE || "true").toLowerCase() === "true"
    ? "https://backoffice.ecourier.com.bd/api"
    : "https://staging.ecourier.com.bd/api";

function isSet(val, placeholderPrefix = "your_") {
  return Boolean(val && !String(val).startsWith(placeholderPrefix));
}

function getConfiguredCouriers() {
  return {
    steadfast:
      isSet(process.env.STEADFAST_API_KEY) &&
      isSet(process.env.STEADFAST_SECRET_KEY),
    pathao:
      isSet(process.env.PATHAO_CLIENT_ID) &&
      isSet(process.env.PATHAO_CLIENT_SECRET) &&
      isSet(process.env.PATHAO_USERNAME) &&
      isSet(process.env.PATHAO_PASSWORD) &&
      isSet(process.env.PATHAO_STORE_ID),
    redx: isSet(process.env.REDX_API_TOKEN),
    ecourier:
      isSet(process.env.ECOURIER_API_KEY) &&
      isSet(process.env.ECOURIER_API_SECRET) &&
      isSet(process.env.ECOURIER_USER_ID) &&
      isSet(process.env.ECOURIER_PACKAGE_CODE)
  };
}

function resolveProvider(preferred) {
  const configured = getConfiguredCouriers();
  const choice = (preferred || process.env.COURIER_PROVIDER || "auto").toLowerCase();
  if (choice !== "auto") {
    return configured[choice] ? choice : null;
  }
  for (const name of ["steadfast", "pathao", "redx", "ecourier"]) {
    if (configured[name]) return name;
  }
  return null;
}

// 1. Steadfast Courier
async function bookSteadfast(order, codAmount) {
  const res = await fetch(`${STEADFAST_BASE}/create_order`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.STEADFAST_API_KEY,
      "Secret-Key": process.env.STEADFAST_SECRET_KEY,
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
        status: data.consignment.status || "in_review",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "Steadfast booking failed" };
}

async function trackSteadfast(order) {
  const res = await fetch(`${STEADFAST_BASE}/status_by_invoice/${encodeURIComponent(order.orderRef)}`, {
    headers: {
      "Api-Key": process.env.STEADFAST_API_KEY,
      "Secret-Key": process.env.STEADFAST_SECRET_KEY,
      "Content-Type": "application/json"
    }
  });
  const data = await res.json();
  return data.delivery_status || null;
}

// 2. Pathao Courier
async function getPathaoToken() {
  const res = await fetch(`${PATHAO_BASE}/aladdin/api/v1/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.PATHAO_CLIENT_ID,
      client_secret: process.env.PATHAO_CLIENT_SECRET,
      username: process.env.PATHAO_USERNAME,
      password: process.env.PATHAO_PASSWORD,
      grant_type: "password"
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.message || "Pathao auth failed");
  return data.access_token;
}

async function bookPathao(order, codAmount) {
  const token = await getPathaoToken();
  const res = await fetch(`${PATHAO_BASE}/aladdin/api/v1/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      store_id: Number(process.env.PATHAO_STORE_ID),
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
        status: data.data.order_status || "Pending",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "Pathao booking failed" };
}

async function trackPathao(order) {
  const token = await getPathaoToken();
  const cid = order.courier?.consignmentId;
  if (!cid) return null;
  const res = await fetch(`${PATHAO_BASE}/aladdin/api/v1/orders/${encodeURIComponent(cid)}/info`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const data = await res.json();
  return data.data?.order_status || null;
}

// 3. RedX Courier
async function bookRedx(order, codAmount) {
  const res = await fetch(`${REDX_BASE}/parcel`, {
    method: "POST",
    headers: {
      "API-ACCESS-TOKEN": `Bearer ${process.env.REDX_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      customer_name: order.name,
      customer_phone: order.phone,
      delivery_area: process.env.REDX_DEFAULT_AREA || "Dhaka",
      delivery_area_id: Number(process.env.REDX_DEFAULT_AREA_ID || 1),
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
        status: "pickup-pending",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "RedX booking failed" };
}

async function trackRedx(order) {
  const tid = order.courier?.trackingCode;
  if (!tid) return null;
  const res = await fetch(`${REDX_BASE}/parcel/info/${encodeURIComponent(tid)}`, {
    headers: { "API-ACCESS-TOKEN": `Bearer ${process.env.REDX_API_TOKEN}` }
  });
  const data = await res.json();
  return data.parcel?.status || null;
}

// 4. eCourier
async function bookEcourier(order, codAmount) {
  const paymentMethod = codAmount > 0 ? "COD" : "MPAY";
  const res = await fetch(`${ECOURIER_BASE}/order-place`, {
    method: "POST",
    headers: {
      "API-KEY": process.env.ECOURIER_API_KEY,
      "API-SECRET": process.env.ECOURIER_API_SECRET,
      "USER-ID": process.env.ECOURIER_USER_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient_name: order.name,
      recipient_mobile: order.phone,
      recipient_city: process.env.ECOURIER_DEFAULT_CITY || "Dhaka",
      recipient_thana: process.env.ECOURIER_DEFAULT_THANA || "Dhaka",
      recipient_area: process.env.ECOURIER_DEFAULT_AREA || "Dhaka",
      recipient_address: order.address,
      package_code: process.env.ECOURIER_PACKAGE_CODE,
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
        status: "placed",
        codAmount,
        bookedAt: new Date().toISOString()
      }
    };
  }
  return { booked: false, reason: data.message || "eCourier booking failed" };
}

async function trackEcourier(order) {
  const ecr = order.courier?.trackingCode;
  if (!ecr) return null;
  const res = await fetch(`${ECOURIER_BASE}/track`, {
    method: "POST",
    headers: {
      "API-KEY": process.env.ECOURIER_API_KEY,
      "API-SECRET": process.env.ECOURIER_API_SECRET,
      "USER-ID": process.env.ECOURIER_USER_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ecr })
  });
  const data = await res.json();
  return data.query_data?.status?.[0]?.status || null;
}

async function bookParcel(order, preferredProvider) {
  if (order.courier && order.courier.consignmentId) {
    return { booked: true, alreadyBooked: true, courier: order.courier };
  }

  const provider = resolveProvider(preferredProvider);
  if (!provider) {
    return { booked: false, reason: "No courier API credentials configured in .env" };
  }

  const codAmount = order.paymentStatus === "PAID" ? 0 : Math.round(Number(order.total) || 0);
  try {
    if (provider === "steadfast") return await bookSteadfast(order, codAmount);
    if (provider === "pathao") return await bookPathao(order, codAmount);
    if (provider === "redx") return await bookRedx(order, codAmount);
    if (provider === "ecourier") return await bookEcourier(order, codAmount);
    return { booked: false, reason: `Unsupported provider: ${provider}` };
  } catch (err) {
    console.error(`Courier (${provider}) booking error:`, err);
    return { booked: false, reason: err.message };
  }
}

async function trackParcel(order) {
  const provider = (order.courier?.provider || "").toLowerCase();
  if (!provider) return null;
  try {
    if (provider === "steadfast") return await trackSteadfast(order);
    if (provider === "pathao") return await trackPathao(order);
    if (provider === "redx") return await trackRedx(order);
    if (provider === "ecourier") return await trackEcourier(order);
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
