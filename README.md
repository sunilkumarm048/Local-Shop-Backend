# local-shop-api

Backend for Local Shop — Express + Socket.IO + MongoDB + Redis.

## Stack
- **Express 4** — REST API
- **Socket.IO** with Redis adapter — real-time
- **MongoDB** (via Mongoose) — primary datastore
- **Redis** — Socket.IO pub/sub, OTP storage, caching, rate-limits
- **JWT** — stateless auth (issued here, consumed by both API and Socket.IO)
- **Razorpay** — payments (server-signed orders only)
- **bcryptjs** — password hashing
- **zod** — request validation

## Phase 1–3 status
- [x] Mongoose schemas for all 9 collections
- [x] Express app with helmet, CORS, rate-limit, error handler
- [x] Socket.IO with JWT handshake and Redis adapter
- [x] Health endpoint at `GET /api/health`
- [x] **Email + password** signup/login with bcrypt
- [x] **Phone OTP** (mock provider — easy swap to MSG91/Twilio)
- [x] JWT issuance + `/auth/me` + role-based middleware
- [x] **Shops + products** browse endpoints with geo-search
- [x] **Checkout** flow (single + split-shop carts) with server-side pricing
- [x] **Razorpay** order creation + signature verification + webhook handler
- [x] Quote endpoint for live cart totals
- [ ] Shop/delivery/admin dashboards (Phases 4–6)

## Endpoints

### Auth
| Method | Path                       | Auth | What                                          |
|--------|----------------------------|------|-----------------------------------------------|
| POST   | `/api/auth/register`       | —    | Email + password signup with role selection  |
| POST   | `/api/auth/login`          | —    | Email + password login                        |
| POST   | `/api/auth/otp/send`       | —    | Send OTP to phone (mock: logs to console)    |
| POST   | `/api/auth/otp/verify`     | —    | Verify OTP, log in or create user             |
| GET    | `/api/auth/me`             | ✓    | Current user                                  |
| POST   | `/api/auth/logout`         | ✓    | Logout (client clears token)                 |

### Shops & products
| Method | Path                          | Auth | What                                        |
|--------|-------------------------------|------|---------------------------------------------|
| GET    | `/api/shops`                  | —    | List shops (geo if `?lng=&lat=`)            |
| GET    | `/api/shops/categories`       | —    | All active categories                       |
| GET    | `/api/shops/:id`              | —    | One shop                                    |
| GET    | `/api/shops/:id/products`     | —    | Products of one shop                        |

### Orders & payments
| Method | Path                          | Auth | What                                        |
|--------|-------------------------------|------|---------------------------------------------|
| POST   | `/api/quotes/order`           | —    | Preview totals (no DB writes)               |
| GET    | `/api/quotes/pricing-config`  | —    | Current pricing config                      |
| POST   | `/api/orders/checkout`        | ✓    | Place orders, return Razorpay order id      |
| GET    | `/api/orders/mine`            | ✓    | My orders                                   |
| GET    | `/api/orders/:id`             | ✓    | One order (customer/shop/delivery/admin)   |
| POST   | `/api/payments/verify`        | ✓    | Verify Razorpay signature, mark paid        |
| POST   | `/api/payments/webhook`       | —    | Razorpay → us (signature-verified)          |

## Phone OTP — production swap
The mock provider is at `src/services/otp.js`. To switch to real SMS, replace
the `sendSms(phone, code)` function at the bottom of that file. Everything
else — code generation, Redis storage, rate-limiting, attempt counting —
stays as-is.

```js
// MSG91 example:
async function sendSms(phone, code) {
  await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { authkey: process.env.MSG91_AUTH_KEY },
    body: JSON.stringify({
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: phone.replace('+', ''),
      otp: code,
    }),
  });
}
```

## Razorpay setup
1. Sign up at razorpay.com (test mode is free)
2. Dashboard → Settings → API Keys → Generate test key
3. Put `Key Id` in `RAZORPAY_KEY_ID` and `Key Secret` in `RAZORPAY_KEY_SECRET`
4. For webhooks (refunds + late captures): Settings → Webhooks → Add endpoint
   pointing at `https://your-render-url/api/payments/webhook`. Generate a
   secret and put it in `RAZORPAY_WEBHOOK_SECRET`.

## Setup
```bash
npm install
cp .env.example .env       # then edit JWT_SECRET + Razorpay keys
npm run dev
curl http://localhost:4000/api/health
```

You'll need MongoDB and Redis running. The quickest way:
```bash
docker run -d -p 27017:27017 --name mongo mongo
docker run -d -p 6379:6379 --name redis redis
```

## Production (Render)
Web Service · Node · `npm install` · `npm start` · all env vars from `.env.example` (point Mongo at Atlas, Redis at Upstash/Redis Cloud).

## Socket.IO rooms
| Room                 | Members                              | Used for                          |
|----------------------|--------------------------------------|-----------------------------------|
| `user:<userId>`      | one user                             | personal notifications            |
| `shop:<shopId>`      | shop owner + their staff             | new orders, status changes        |
| `order:<orderId>`    | customer + shop + delivery partner   | live tracking, status updates     |
| `delivery:available` | all online delivery partners         | broadcasting new jobs             |
