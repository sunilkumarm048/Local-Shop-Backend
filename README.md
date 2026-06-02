# Local Shop — Backend API

REST + real-time API powering **Local Shop**, a hyperlocal commerce platform for
India: customers order from nearby shops with fast delivery, local **service**
providers are discoverable "near me," and shop owners, delivery partners, and
admins each get their own tooling. This repo is the **Node/Express API**. The
web client lives in a separate frontend repo.

> Companion repo: [local-shop-frontend](https://github.com/sunilkumarm048/local-shop-frontend)

---

## ✨ What it does

- **Auth & roles** — JWT auth with customer / shop / delivery / admin roles,
  email+password and Google sign-in, phone OTP via MSG91
- **Shops & products** — shop onboarding, admin approval, geo ("near me")
  queries, product catalog, categories & templates
- **Orders** — cart checkout, multi-shop split orders, COD + Razorpay online
  payment with server-side signature verification and webhooks
- **Inventory** — atomic, race-safe stock decrement on order confirmation
- **Delivery** — delivery-partner profiles, auto-assignment of pickup jobs,
  wallet, earnings, and withdrawal requests
- **Transport** — separate vehicle/transport booking flow with quotes
- **Reviews** — ratings, reviews, and review photos; recomputed shop ratings
- **Realtime** — Socket.IO (Redis-backed) for live order tracking & events
- **Notifications** — Web Push (VAPID) with graceful in-app socket fallback
- **Housekeeping** — background job that cancels abandoned (unpaid) orders

---

## 🛠 Tech Stack

| Area        | Tech                                          |
|-------------|-----------------------------------------------|
| Runtime     | Node.js 20+ (ES Modules)                       |
| Framework   | Express 4                                      |
| Database    | MongoDB + Mongoose 8                            |
| Realtime    | Socket.IO 4 + Redis adapter (ioredis)          |
| Auth        | JWT (jsonwebtoken) + bcryptjs                   |
| Validation  | Zod                                            |
| Payments    | Razorpay (orders, verification, webhooks)      |
| SMS / OTP   | MSG91                                          |
| Push        | web-push (VAPID)                               |
| Security    | helmet, CORS, express-rate-limit               |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- MongoDB (local or MongoDB Atlas)
- Redis (local or a managed Redis)

### Install & run
```bash
git clone https://github.com/sunilkumarm048/Local-Shop-Backend.git
cd Local-Shop-Backend
npm install
cp .env.example .env     # then fill in the values (see below)
npm run dev              # starts on http://localhost:4000 (with --watch)
```

### Scripts
| Command         | Does                                  |
|-----------------|---------------------------------------|
| `npm run dev`   | Start with auto-reload (`node --watch`)|
| `npm start`     | Start (production)                    |
| `npm run lint`  | ESLint                                |

---

## 🔑 Environment Variables

Create `.env`:

```bash
# Core
NODE_ENV=development
PORT=4000
MONGODB_URI=mongodb+srv://...            # MongoDB connection string
REDIS_URL=redis://...                    # Redis for Socket.IO adapter
CLIENT_ORIGIN=http://localhost:3000      # frontend URL (CORS) — MUST match

# Auth
JWT_SECRET=your_long_random_secret
JWT_EXPIRES_IN=7d
ADMIN_EMAILS=you@example.com             # comma-separated admin emails
GOOGLE_CLIENT_ID=...                     # optional, for Google sign-in
GOOGLE_CLIENT_SECRET=...

# Payments (Razorpay)
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# SMS / OTP (MSG91) — optional
MSG91_AUTH_KEY=...
MSG91_TEMPLATE_ID=...
MSG91_SENDER_ID=...

# Web Push (VAPID) — optional; generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com

# Maps — optional
GOOGLE_MAPS_API_KEY=...
```

Anything marked optional can be left unset — those features disable cleanly
(e.g. no VAPID keys → push falls back to in-app socket notifications).

> ⚠️ Never commit `.env`. Keep all secrets in your host's environment settings.

---

## 🧭 API Overview

Base path: `/api`

| Prefix            | Purpose                                  |
|-------------------|------------------------------------------|
| `/auth`           | Register, login, Google, OTP             |
| `/shops`          | Shops, products, "near me", reviews      |
| `/orders`         | Cart checkout, order status              |
| `/payments`       | Razorpay create / verify / webhook       |
| `/delivery`       | Partner jobs, wallet, withdrawals        |
| `/transport`      | Vehicle booking                          |
| `/quotes`         | Delivery/transport quotes                |
| `/templates`      | Product templates                        |
| `/notifications`  | Push subscribe / unsubscribe / test      |
| `/admin`          | Admin management (role-guarded)          |
| `/health`         | Health check                             |

---

## 📂 Project Structure

```
src/
├── config/       # env validation, db, redis
├── middleware/   # auth, role guards, error handler
├── models/       # Mongoose schemas (User, Shop, Order, Review, …)
├── routes/       # Express routers (one per feature area)
├── services/     # business logic (auth, razorpay, push, inventory,
│                 #   autoAssign, pendingCleanup, otp, pricing)
├── sockets/      # Socket.IO setup
├── utils/        # helpers (validation, etc.)
├── app.js        # Express app (middleware + routes)
└── server.js     # boot: db, redis, sockets, background jobs
```

---

## ☁️ Deployment (Render)

1. Create a Web Service from this repo.
2. Build: `npm install` · Start: `npm start`.
3. Add all environment variables above in the Render dashboard.
4. Set `CLIENT_ORIGIN` to your deployed frontend URL (or CORS will block it).
5. Provide managed MongoDB (Atlas) and Redis URLs.

On boot you should see the server listening plus the background jobs starting
(auto-assign and pending-order cleanup).

---

## 🔒 Security Notes

- Payment signatures verified server-side; Razorpay webhook signature checked.
- Admin routes guarded by role middleware.
- helmet, locked-down CORS, and rate limiting (tighter on auth) enabled.
- Passwords hashed with bcrypt; secrets read only from environment.

---

## 📄 License

Add a license of your choice (e.g. MIT) or leave unlicensed if private.
