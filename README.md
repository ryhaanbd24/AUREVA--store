# Aureva Skincare Store — SSLCommerz Payment & All Top BD Couriers

এই প্রজেক্টে **Aureva** ওয়েবসাইটের (`public/index.html`) সাথে **SSLCommerz** (কার্ড, bKash, Nagad, Rocket, Upay), **Cash on Delivery (COD)** এবং বাংলাদেশের প্রথম সারির ৪টি কুরিয়ার সার্ভিস যুক্ত করা আছে:

1. **Steadfast Courier** (`portal.packzy.com`)
2. **Pathao Courier** (`api-hermes.pathao.com`)
3. **RedX** (`openapi.redx.com.bd`)
4. **eCourier** (`backoffice.ecourier.com.bd`)

## ফাইল পরিচিতি
- `public/index.html` — Aureva ওয়েবসাইট (অনলাইন পেমেন্ট + COD চেকআউট)
- `server.js` — Node.js / Express সার্ভার
- `services/couriers.js` — ৪টি কুরিয়ারের অটো-বুকিং ও লাইভ ট্র্যাকিং ইন্টিগ্রেশন
- `.env.example` — SSLCommerz ও ৪টি কুরিয়ারের API কী কনফিগারেশন

## সেটআপ ও চালানোর নিয়ম
1. **`.env` ফাইল তৈরি**:
   - `.env.example` কপি করে `.env` নামে সেভ করুন।
   - `SSLCOMMERZ_STORE_ID` ও `SSLCOMMERZ_STORE_PASSWD` বসান।
   - যে কুরিয়ারগুলো ব্যবহার করতে চান (Steadfast, Pathao, RedX, বা eCourier) তাদের API কী বসান এবং `COURIER_PROVIDER=auto` (অথবা নির্দিষ্ট নাম যেমন `pathao`) দিন।
2. **সার্ভার চালু করা** (Node.js 18+):
   ```bash
   npm install
   npm start
   ```
3. **অর্ডার ও কুরিয়ার ট্র্যাকিং**:
   - সব অর্ডার দেখতে: `http://localhost:3000/api/orders?key=aureva-admin-2026`
   - লাইভ ট্র্যাকিং দেখতে: `http://localhost:3000/api/courier/track/ORD-1234`
   - নির্দিষ্ট কোনো অর্ডার অন্য কুরিয়ারে পাঠাতে: `POST /api/courier/book/ORD-1234?provider=redx&key=aureva-admin-2026`
