#!/usr/bin/env node
/**
 * Seed 7 parent groups + 50 child categories.
 *
 * Idempotent — re-running won't duplicate. Uses upsert by name.
 *
 * Usage (locally with MONGODB_URI in env):
 *   node src/scripts/seedCategories.js
 *
 * Or once-off on Render:
 *   Render shell → cd /opt/render/project/src && node src/scripts/seedCategories.js
 *
 * Or via MongoDB Atlas Data Explorer: open `local_shop.categories` collection,
 * use the Aggregation tab to manually paste these documents — but the script
 * is much safer because parent ObjectIds are resolved server-side.
 */

import mongoose from 'mongoose';
import Category from '../models/Category.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI env var is required.');
  process.exit(1);
}

// ============================================================
// The category tree
// ============================================================

const TREE = [
  {
    name: 'Food & Daily Need',
    icon: '🍎',
    sortOrder: 10,
    children: [
      { name: 'Grocery / Kirana', icon: '🛒' },
      { name: 'Bakery', icon: '🥐' },
      { name: 'Vegetable', icon: '🥬' },
      { name: 'Fruit', icon: '🍌' },
      { name: 'Meat', icon: '🥩' },
      { name: 'Fish', icon: '🐟' },
      { name: 'Dairy / Milk', icon: '🥛' },
      { name: 'Sweet Shop (Mithai)', icon: '🍬' },
      { name: 'Fast Food', icon: '🍔' },
      { name: 'Tea / Coffee Stall', icon: '☕' },
      { name: 'Restaurant / Dhaba', icon: '🍛' },
    ],
  },
  {
    name: 'Household & Utility',
    icon: '🏠',
    sortOrder: 20,
    children: [
      { name: 'Hardware', icon: '🔨' },
      { name: 'Electrical', icon: '💡' },
      { name: 'Plumbing', icon: '🚰' },
      { name: 'Paint', icon: '🎨' },
      { name: 'Furniture', icon: '🪑' },
      { name: 'Kitchenware', icon: '🍳' },
      { name: 'Plastic Items', icon: '🧺' },
      { name: 'Gas Stove / Kitchen Appliance', icon: '🔥' },
    ],
  },
  {
    name: 'Electronics & Technology',
    icon: '📱',
    sortOrder: 30,
    children: [
      { name: 'Mobile', icon: '📱' },
      { name: 'Mobile Repair', icon: '🔧' },
      { name: 'Laptop / Computer', icon: '💻' },
      { name: 'Electronics (TV, Fridge, Fan)', icon: '📺' },
      { name: 'CCTV', icon: '📹' },
      { name: 'Solar Equipment', icon: '🔆' },
    ],
  },
  {
    name: 'Automobile',
    icon: '🚗',
    sortOrder: 40,
    children: [
      { name: 'Bike Parts', icon: '🏍️' },
      { name: 'Car Parts', icon: '🚙' },
      { name: 'Tyre', icon: '🛞' },
      { name: 'Bike Repair Garage', icon: '🔧' },
      { name: 'Car Repair Garage', icon: '🛠️' },
      { name: 'Battery', icon: '🔋' },
      { name: 'Oil & Lubricant', icon: '🛢️' },
    ],
  },
  {
    name: 'Clothing & Fashion',
    icon: '👕',
    sortOrder: 50,
    children: [
      { name: 'Garments', icon: '👔' },
      { name: 'Saree', icon: '🥻' },
      { name: 'Shoe', icon: '👟' },
      { name: 'Tailor', icon: '🧵' },
      { name: 'Cosmetic', icon: '💄' },
      { name: 'Jewellery', icon: '💍' },
    ],
  },
  {
    name: 'Services',
    icon: '🛎️',
    sortOrder: 60,
    children: [
      { name: 'Barber / Salon', icon: '💇' },
      { name: 'Laundry / Dry Cleaning', icon: '🧺' },
      { name: 'Photocopy / Print', icon: '🖨️' },
      { name: 'Cyber Cafe', icon: '🌐' },
      { name: 'Travel Agency', icon: '✈️' },
      { name: 'Courier Service', icon: '📦' },
    ],
  },
  {
    name: 'Construction',
    icon: '🏗️',
    sortOrder: 70,
    children: [
      { name: 'Cement', icon: '🧱' },
      { name: 'Steel', icon: '🔩' },
      { name: 'Tile / Marble', icon: '⬜' },
      { name: 'Building Material', icon: '🏠' },
    ],
  },
];

// ============================================================
// Seed runner
// ============================================================

async function seed() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  let parentsCreated = 0;
  let parentsExisted = 0;
  let childrenCreated = 0;
  let childrenExisted = 0;

  let childSort = 0;

  for (const group of TREE) {
    // Upsert the parent
    const parent = await Category.findOneAndUpdate(
      { name: group.name },
      {
        $setOnInsert: {
          name: group.name,
          icon: group.icon,
          sortOrder: group.sortOrder,
          isActive: true,
          parent: null,
        },
      },
      { new: true, upsert: true }
    );
    const wasNew = parent.createdAt && (Date.now() - parent.createdAt.getTime()) < 5000;
    if (wasNew) {
      parentsCreated += 1;
      console.log(`  + parent: ${group.icon} ${group.name}`);
    } else {
      parentsExisted += 1;
      console.log(`  · parent (exists): ${group.icon} ${group.name}`);
    }

    // Upsert each child with parent reference
    for (const child of group.children) {
      childSort += 10;
      const c = await Category.findOneAndUpdate(
        { name: child.name },
        {
          $setOnInsert: {
            name: child.name,
            icon: child.icon,
            sortOrder: childSort,
            isActive: true,
            parent: parent._id,
          },
        },
        { new: true, upsert: true }
      );
      const childWasNew = c.createdAt && (Date.now() - c.createdAt.getTime()) < 5000;
      if (childWasNew) {
        childrenCreated += 1;
        console.log(`      + ${child.icon} ${child.name}`);
      } else {
        childrenExisted += 1;
        console.log(`      · ${child.icon} ${child.name} (exists, skipped)`);
      }
    }
  }

  console.log('');
  console.log(`Done. Created ${parentsCreated} parents (${parentsExisted} already existed).`);
  console.log(`Created ${childrenCreated} children (${childrenExisted} already existed).`);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
