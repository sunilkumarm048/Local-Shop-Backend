import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';

import {
  User,
  Shop,
  Category,
  Product,
  Order,
  Booking,
  Review,
  TransportOrder,
  FcmToken,
  PushSubscription,
} from '../models/index.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';

/**
 * Admin Data Manager — /api/admin/data/*  (mounted inside the admin router,
 * so every route here is already behind requireRole('admin')).
 *
 * Raw-but-safe access to the database:
 *  - Whitelisted collections only (below), each with a display config.
 *  - Sensitive fields (password hashes, tokens) are NEVER returned and can
 *    NEVER be written through here.
 *  - Two-step delete enforced SERVER-SIDE: the request must carry the
 *    record's own name/email typed by the admin; a wrong confirmation is
 *    rejected. UI confirmation alone is not trusted.
 *  - Deletes CASCADE so no orphans are left behind (deleting a shop removes
 *    its products/bookings/orders/reviews; deleting a user removes their
 *    shops — cascaded — plus their bookings, orders, reviews, devices).
 */

const router = Router();

const HIDDEN_FIELDS = ['passwordHash', 'password', '__v'];
const PROTECTED_WRITE = new Set([
  '_id',
  'passwordHash',
  'password',
  'createdAt',
  'updatedAt',
  '__v',
]);

/** What the admin can browse, how to label rows, and what "confirm text" is. */
const COLLECTIONS = {
  users: {
    model: User,
    label: 'Users',
    searchFields: ['name', 'email', 'phone'],
    titleOf: (d) => d.name || d.email,
    confirmOf: (d) => d.email || d.name,
  },
  shops: {
    model: Shop,
    label: 'Shops / Providers',
    searchFields: ['name', 'ownerEmail', 'phone'],
    titleOf: (d) => d.name,
    confirmOf: (d) => d.name,
  },
  products: {
    model: Product,
    label: 'Products',
    searchFields: ['name'],
    titleOf: (d) => d.name,
    confirmOf: (d) => d.name,
  },
  bookings: {
    model: Booking,
    label: 'Service bookings',
    searchFields: ['serviceName', 'contactPhone'],
    titleOf: (d) => d.serviceName,
    confirmOf: (d) => d.serviceName,
  },
  orders: {
    model: Order,
    label: 'Orders',
    searchFields: ['code'],
    titleOf: (d) => d.code || String(d._id),
    confirmOf: (d) => d.code || String(d._id),
  },
  categories: {
    model: Category,
    label: 'Categories',
    searchFields: ['name'],
    titleOf: (d) => d.name,
    confirmOf: (d) => d.name,
  },
  reviews: {
    model: Review,
    label: 'Reviews',
    searchFields: ['comment'],
    titleOf: (d) => (d.comment || '').slice(0, 40) || String(d._id),
    confirmOf: (d) => String(d._id),
  },
  transportorders: {
    model: TransportOrder,
    label: 'Transport orders',
    searchFields: ['pickupAddress', 'dropAddress'],
    titleOf: (d) => `${(d.pickupAddress || '').slice(0, 24)} → ${(d.dropAddress || '').slice(0, 24)}`,
    confirmOf: (d) => String(d._id),
  },
};

function cfgOf(collection) {
  const cfg = COLLECTIONS[collection];
  if (!cfg) throw new HttpError(404, 'Unknown collection.');
  return cfg;
}

function redact(doc) {
  const out = { ...doc };
  for (const f of HIDDEN_FIELDS) delete out[f];
  return out;
}

/* ------------------------- browse ------------------------- */

router.get('/collections', async (_req, res, next) => {
  try {
    const out = [];
    for (const [id, cfg] of Object.entries(COLLECTIONS)) {
      out.push({ id, label: cfg.label, count: await cfg.model.estimatedDocumentCount() });
    }
    res.json({ collections: out });
  } catch (err) {
    next(err);
  }
});

router.get('/:collection', async (req, res, next) => {
  try {
    const cfg = cfgOf(req.params.collection);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 20;
    const search = String(req.query.search || '').trim();

    let filter = {};
    if (search) {
      if (mongoose.isValidObjectId(search)) {
        filter = { _id: search };
      } else {
        filter = {
          $or: cfg.searchFields.map((f) => ({ [f]: { $regex: search, $options: 'i' } })),
        };
      }
    }

    const [docs, total] = await Promise.all([
      cfg.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      cfg.model.countDocuments(filter),
    ]);

    res.json({
      total,
      page,
      pages: Math.ceil(total / limit),
      rows: docs.map((d) => ({
        _id: d._id,
        title: cfg.titleOf(d) || String(d._id),
        createdAt: d.createdAt,
        doc: redact(d),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- edit ------------------------- */

const editSchema = z.object({
  // Arbitrary field → value map. Values go through mongoose casting; invalid
  // values are rejected by schema validation on save.
  set: z.record(z.string(), z.any()),
});

router.patch('/:collection/:id', async (req, res, next) => {
  try {
    const cfg = cfgOf(req.params.collection);
    const { set } = validateBody(req, editSchema);

    const doc = await cfg.model.findById(req.params.id);
    if (!doc) throw new HttpError(404, 'Record not found.');

    const applied = [];
    for (const [key, value] of Object.entries(set)) {
      const root = key.split('.')[0];
      if (PROTECTED_WRITE.has(root)) continue; // silently skip protected
      doc.set(key, value);
      applied.push(key);
    }
    if (applied.length === 0) throw new HttpError(400, 'No editable fields in request.');

    await doc.save(); // runs schema validation & casting
    res.json({ ok: true, applied, doc: redact(doc.toObject()) });
  } catch (err) {
    if (err?.name === 'ValidationError' || err?.name === 'CastError') {
      return next(new HttpError(400, `Invalid value: ${err.message}`));
    }
    next(err);
  }
});

/* ------------------------- delete (two-step + cascade) ------------------------- */

const deleteSchema = z.object({
  // The admin must TYPE the record's name/email exactly — verified here on
  // the server, not just in the UI.
  confirmText: z.string().min(1),
});

async function cascadeDeleteShop(shopId) {
  await Promise.all([
    Product.deleteMany({ shop: shopId }),
    Booking.deleteMany({ provider: shopId }),
    Order.deleteMany({ shop: shopId }),
    Review.deleteMany({ shop: shopId }),
  ]);
  await Shop.deleteOne({ _id: shopId });
}

async function cascadeDeleteUser(userId) {
  const shops = await Shop.find({ owner: userId }).select('_id').lean();
  for (const s of shops) await cascadeDeleteShop(s._id);
  await Promise.all([
    Booking.deleteMany({ customer: userId }),
    Order.deleteMany({ customer: userId }),
    Review.deleteMany({ user: userId }),
    FcmToken.deleteMany({ user: userId }),
    PushSubscription.deleteMany({ user: userId }),
  ]);
  await User.deleteOne({ _id: userId });
}

router.delete('/:collection/:id', async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const cfg = cfgOf(collection);
    const { confirmText } = validateBody(req, deleteSchema);

    const doc = await cfg.model.findById(id).lean();
    if (!doc) throw new HttpError(404, 'Record not found.');

    const expected = String(cfg.confirmOf(doc) || '').trim();
    if (confirmText.trim().toLowerCase() !== expected.toLowerCase()) {
      throw new HttpError(400, `Confirmation text does not match. Type exactly: ${expected}`);
    }

    // Safety rails
    if (collection === 'users') {
      if (doc.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be deleted here.');
      if (String(doc._id) === String(req.user._id)) {
        throw new HttpError(403, 'You cannot delete your own account.');
      }
      await cascadeDeleteUser(doc._id);
    } else if (collection === 'shops') {
      await cascadeDeleteShop(doc._id);
    } else if (collection === 'categories') {
      const inUse = await Shop.countDocuments({ category: doc._id });
      if (inUse > 0) {
        throw new HttpError(409, `${inUse} shop(s) use this category. Move them first.`);
      }
      await Category.deleteOne({ _id: doc._id });
    } else {
      await cfg.model.deleteOne({ _id: doc._id });
    }

    res.json({ ok: true, deleted: id });
  } catch (err) {
    next(err);
  }
});

export default router;
