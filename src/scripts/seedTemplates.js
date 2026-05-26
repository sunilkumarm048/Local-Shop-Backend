#!/usr/bin/env node
/**
 * Seed product templates from the Indian Monthly Grocery List.
 *
 * Curated from SimpleIndianRecipes.com — irrelevant items (e.g. "Other nuts
 * as needed") removed, vague entries split or skipped. Suggested prices are
 * representative for an Indian small-town grocery store in 2025-2026 — owners
 * override per their actual cost.
 *
 * Idempotent: re-running upserts by (name + group) — won't duplicate.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node src/scripts/seedTemplates.js
 *
 * Or in Render shell:
 *   cd /opt/render/project/src && node src/scripts/seedTemplates.js
 */

import mongoose from 'mongoose';
import ProductTemplate from '../models/ProductTemplate.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI env var is required.');
  process.exit(1);
}

// Each template: { name, weight, suggestedPrice }
// `weight` is display-only free text; suggestedPrice in ₹.
const TEMPLATES = [
  // ===== GRAINS =====
  ['Grains', 'Boiled Rice', '5 kg', 450],
  ['Grains', 'Idli Rice', '5 kg', 460],
  ['Grains', 'Raw Rice', '2 kg', 200],
  ['Grains', 'Basmati Rice', '2 kg', 280],
  ['Grains', 'Brown Rice', '1 kg', 130],
  ['Grains', 'Wheat Flour (Atta)', '2 kg', 110],
  ['Grains', 'Maida', '500 g', 35],
  ['Grains', 'Rava (Sooji)', '500 g', 35],
  ['Grains', 'Ragi Flour', '500 g', 55],
  ['Grains', 'Rice Flour', '1 kg', 70],
  ['Grains', 'Foxtail Millet', '500 g', 80],
  ['Grains', 'Pearl Millet (Bajra)', '500 g', 60],
  ['Grains', 'Pasta', '500 g', 75],
  ['Grains', 'Noodles (Family Pack)', '1 pack', 60],
  ['Grains', 'Pressed Rice (Poha)', '500 g', 45],
  ['Grains', 'Sago (Sabudana)', '500 g', 70],
  ['Grains', 'Gram Flour (Besan)', '250 g', 30],
  ['Grains', 'Vermicelli', '500 g', 50],
  ['Grains', 'Instant Rice Sevai', '500 g', 65],
  ['Grains', 'Broken Wheat (Dalia)', '500 g', 45],

  // ===== PULSES =====
  ['Pulses', 'Urad Dal', '1 kg', 160],
  ['Pulses', 'Toor Dal', '1 kg', 170],
  ['Pulses', 'Moong Dal', '500 g', 80],
  ['Pulses', 'Channa Dal', '500 g', 75],
  ['Pulses', 'Chickpeas', '500 g', 70],
  ['Pulses', 'Dried Green Peas', '500 g', 70],
  ['Pulses', 'Whole Green Gram (Moong)', '500 g', 75],
  ['Pulses', 'Black Chickpeas (Kala Chana)', '500 g', 65],
  ['Pulses', 'Red Kidney Beans (Rajma)', '500 g', 95],
  ['Pulses', 'Whole Masoor', '500 g', 70],
  ['Pulses', 'Masoor Dal', '500 g', 75],
  ['Pulses', 'Black Eye Beans (Lobia)', '500 g', 80],
  ['Pulses', 'Frozen Green Peas', '1 pack', 75],
  ['Pulses', 'Frozen Sweet Corn', '1 pack', 90],

  // ===== OILS =====
  ['Oils', 'Sunflower Oil', '1 L', 160],
  ['Oils', 'Groundnut Oil', '1 L', 230],
  ['Oils', 'Sesame Oil', '500 ml', 240],
  ['Oils', 'Coconut Oil', '250 ml', 130],
  ['Oils', 'Olive Oil', '250 ml', 320],
  ['Oils', 'Ghee', '200 g', 220],
  ['Oils', 'Butter', '200 g', 110],
  ['Oils', 'Mustard Oil', '1 L', 200],

  // ===== SPICES & CONDIMENTS =====
  ['Spices & Condiments', 'Salt', '1 kg', 25],
  ['Spices & Condiments', 'Crystal Salt', '1 kg', 30],
  ['Spices & Condiments', 'Sugar', '1 kg', 50],
  ['Spices & Condiments', 'Jaggery', '500 g', 60],
  ['Spices & Condiments', 'Palm Jaggery', '250 g', 90],
  ['Spices & Condiments', 'Tea Powder', '250 g', 140],
  ['Spices & Condiments', 'Coffee Powder', '100 g', 130],
  ['Spices & Condiments', 'Tamarind', '250 g', 55],
  ['Spices & Condiments', 'Asafoetida (Hing)', '50 g', 60],
  ['Spices & Condiments', 'Dry Red Chilies', '250 g', 80],
  ['Spices & Condiments', 'Mustard Seeds', '100 g', 30],
  ['Spices & Condiments', 'Cumin Seeds', '100 g', 60],
  ['Spices & Condiments', 'Fennel Seeds (Saunf)', '100 g', 40],
  ['Spices & Condiments', 'Fenugreek Seeds (Methi)', '100 g', 25],
  ['Spices & Condiments', 'Peppercorns', '100 g', 110],
  ['Spices & Condiments', 'Sesame Seeds', '100 g', 35],
  ['Spices & Condiments', 'Carom Seeds (Ajwain)', '50 g', 25],
  ['Spices & Condiments', 'Dry Ginger', '50 g', 30],
  ['Spices & Condiments', 'Cardamom (Elaichi)', '25 g', 90],
  ['Spices & Condiments', 'Cinnamon', '25 g', 40],
  ['Spices & Condiments', 'Star Anise', '1 pack', 40],
  ['Spices & Condiments', 'Cloves', '25 g', 70],
  ['Spices & Condiments', 'Bay Leaf', '1 pack', 30],
  ['Spices & Condiments', 'Turmeric Powder', '100 g', 30],
  ['Spices & Condiments', 'Sambar Powder', '100 g', 50],
  ['Spices & Condiments', 'Chicken Masala', '100 g', 60],
  ['Spices & Condiments', 'Red Chilli Powder', '200 g', 60],
  ['Spices & Condiments', 'Coriander Powder', '200 g', 50],
  ['Spices & Condiments', 'Garam Masala', '100 g', 55],
  ['Spices & Condiments', 'Black Pepper Powder', '50 g', 60],
  ['Spices & Condiments', 'Cumin Powder', '50 g', 35],
  ['Spices & Condiments', 'Idli Podi', '100 g', 55],
  ['Spices & Condiments', 'Channa Masala', '100 g', 55],
  ['Spices & Condiments', 'Pav Bhaji Masala', '100 g', 55],
  ['Spices & Condiments', 'Ginger Garlic Paste', '200 g', 50],
  ['Spices & Condiments', 'Pickle (Mixed)', '500 g', 130],
  ['Spices & Condiments', 'Pickle (Mango)', '500 g', 130],
  ['Spices & Condiments', 'Pickle (Lemon)', '500 g', 130],
  ['Spices & Condiments', 'Soy Sauce', '200 ml', 90],
  ['Spices & Condiments', 'Tomato Ketchup', '500 g', 95],
  ['Spices & Condiments', 'Chilli Sauce', '200 ml', 65],
  ['Spices & Condiments', 'Vinegar', '500 ml', 50],
  ['Spices & Condiments', 'Mayonnaise', '250 g', 110],
  ['Spices & Condiments', 'Mixed Fruit Jam', '500 g', 150],
  ['Spices & Condiments', 'Honey', '500 g', 250],
  ['Spices & Condiments', 'Papad', '200 g', 60],
  ['Spices & Condiments', 'Cheese Spread', '200 g', 150],
  ['Spices & Condiments', 'Cheese Slices', '200 g', 130],
  ['Spices & Condiments', 'Cheese Block', '200 g', 220],
  ['Spices & Condiments', 'Paneer', '200 g', 90],
  ['Spices & Condiments', 'Plain Curd', '500 g', 35],
  ['Spices & Condiments', 'Fresh Cream', '200 g', 60],

  // ===== NUTS, DRY FRUITS & BAKING =====
  ['Nuts, Dry Fruits & Baking', 'Cashews', '100 g', 110],
  ['Nuts, Dry Fruits & Baking', 'Raisins', '100 g', 60],
  ['Nuts, Dry Fruits & Baking', 'Almonds', '100 g', 100],
  ['Nuts, Dry Fruits & Baking', 'Dates', '250 g', 130],
  ['Nuts, Dry Fruits & Baking', 'Peanuts', '500 g', 110],
  ['Nuts, Dry Fruits & Baking', 'Walnuts', '100 g', 130],
  ['Nuts, Dry Fruits & Baking', 'Pistachios', '100 g', 200],
  ['Nuts, Dry Fruits & Baking', 'Dried Figs (Anjeer)', '100 g', 130],
  ['Nuts, Dry Fruits & Baking', 'Yeast', '1 box', 35],
  ['Nuts, Dry Fruits & Baking', 'Baking Soda', '100 g', 25],
  ['Nuts, Dry Fruits & Baking', 'Baking Powder', '100 g', 30],
  ['Nuts, Dry Fruits & Baking', 'Cocoa Powder', '100 g', 90],
  ['Nuts, Dry Fruits & Baking', 'Vanilla Extract', '20 ml', 80],
  ['Nuts, Dry Fruits & Baking', 'Condensed Milk', '400 g', 130],

  // ===== SNACKS =====
  ['Snacks', 'Cornflakes', '500 g', 220],
  ['Snacks', 'Choco Cereal', '375 g', 250],
  ['Snacks', 'Sandwich Bread', '1 loaf', 50],
  ['Snacks', 'Pav Buns (6)', '1 pack', 35],
  ['Snacks', 'Burger Buns (4)', '1 pack', 45],
  ['Snacks', 'Pizza Base', '1 pack', 60],
  ['Snacks', 'Marie Biscuits', '250 g', 35],
  ['Snacks', 'Cream Biscuits', '100 g', 25],
  ['Snacks', 'Salt Crackers', '200 g', 40],
  ['Snacks', 'Chocolate Cake', '1 pack', 75],
  ['Snacks', 'Mixture (Namkeen)', '200 g', 50],
  ['Snacks', 'Potato Chips', '1 pack', 30],
  ['Snacks', 'Popcorn Pack', '1 pack', 50],
  ['Snacks', 'Flavoured Yogurt', '200 g', 30],

  // ===== VEGETABLES =====
  ['Vegetables', 'Onion', '1 kg', 35],
  ['Vegetables', 'Tomato', '1 kg', 30],
  ['Vegetables', 'Small Onions (Sambar)', '500 g', 45],
  ['Vegetables', 'Garlic', '250 g', 50],
  ['Vegetables', 'Ginger', '250 g', 40],
  ['Vegetables', 'Green Chilies', '100 g', 15],
  ['Vegetables', 'Potatoes', '1 kg', 30],
  ['Vegetables', 'Lemon (5 pieces)', '5 pcs', 25],
  ['Vegetables', 'Coriander Leaves', '1 bunch', 10],
  ['Vegetables', 'Mint Leaves', '1 bunch', 15],
  ['Vegetables', 'Curry Leaves', '1 bunch', 10],
  ['Vegetables', 'Coconut', '1 piece', 35],
  ['Vegetables', 'Carrot', '500 g', 30],
  ['Vegetables', 'Cabbage', '1 piece', 30],
  ['Vegetables', 'Cauliflower', '1 piece', 40],
  ['Vegetables', 'Beans', '500 g', 40],
  ['Vegetables', 'Brinjal (Eggplant)', '500 g', 35],
  ['Vegetables', 'Bottle Gourd (Lauki)', '1 piece', 30],
  ['Vegetables', 'Capsicum', '500 g', 50],
  ['Vegetables', 'Cucumber', '500 g', 25],
  ['Vegetables', 'Ladies Finger (Okra)', '500 g', 40],
  ['Vegetables', 'Spinach', '1 bunch', 20],
  ['Vegetables', 'Banana (Dozen)', '12 pcs', 60],
  ['Vegetables', 'Apple', '1 kg', 180],
  ['Vegetables', 'Mango', '1 kg', 90],
  ['Vegetables', 'Orange', '1 kg', 100],
  ['Vegetables', 'Grapes', '500 g', 75],

  // ===== CLEANING =====
  ['Cleaning', 'Dish Wash Bar', '500 g', 60],
  ['Cleaning', 'Dish Wash Liquid', '500 ml', 130],
  ['Cleaning', 'Washing Detergent Powder', '1 kg', 130],
  ['Cleaning', 'Liquid Detergent', '1 L', 220],
  ['Cleaning', 'Bleach', '1 L', 40],
  ['Cleaning', 'Laundry Soap', '2 bars', 50],
  ['Cleaning', 'Hand Wash Liquid', '500 ml', 90],
  ['Cleaning', 'Toilet Cleaner', '1 L', 100],
  ['Cleaning', 'Floor Cleaner', '1 L', 110],
  ['Cleaning', 'Glass Cleaner', '500 ml', 110],
  ['Cleaning', 'All-Purpose Cleaner', '500 ml', 120],
  ['Cleaning', 'Room Spray', '250 ml', 180],
  ['Cleaning', 'Air Freshener', '300 ml', 200],
  ['Cleaning', 'Harpic Tablets', '1 pack', 95],
  ['Cleaning', 'Garbage Bags (Pack)', '1 pack', 90],

  // ===== TOILETRIES =====
  ['Toiletries', 'Body Soap', '1 bar', 35],
  ['Toiletries', 'Face Wash', '100 ml', 130],
  ['Toiletries', 'Deodorant', '150 ml', 220],
  ['Toiletries', 'Shampoo', '180 ml', 130],
  ['Toiletries', 'Conditioner', '180 ml', 180],
  ['Toiletries', 'Body Lotion', '200 ml', 200],
  ['Toiletries', 'Sunscreen', '50 ml', 220],
  ['Toiletries', 'Hair Oil', '200 ml', 90],
  ['Toiletries', 'Toothpaste', '150 g', 110],
  ['Toiletries', 'Toothbrush', '1 piece', 35],
  ['Toiletries', 'Shaving Cream', '70 g', 95],
  ['Toiletries', 'Shaving Razor (Pack)', '1 pack', 90],
  ['Toiletries', 'Hand Sanitizer', '200 ml', 95],
  ['Toiletries', 'Dettol Antiseptic', '250 ml', 130],
  ['Toiletries', 'Sanitary Napkins', '1 pack', 110],
  ['Toiletries', 'Toilet Paper (4 Rolls)', '1 pack', 130],
  ['Toiletries', 'Kitchen Roll', '1 roll', 80],
  ['Toiletries', 'Cotton Balls', '1 pack', 35],

  // ===== DISPOSABLES =====
  ['Disposables', 'Tissue Paper Box', '1 box', 60],
  ['Disposables', 'Paper Plates (50)', '1 pack', 110],
  ['Disposables', 'Paper Cups (50)', '1 pack', 90],
  ['Disposables', 'Disposable Spoons', '1 pack', 50],
  ['Disposables', 'Aluminium Foil', '1 roll', 95],
  ['Disposables', 'Ziploc Bags', '1 pack', 75],
  ['Disposables', 'Toothpicks', '1 pack', 25],
];

async function seed() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.\n');

  let created = 0;
  let updated = 0;
  let sortCounter = 0;

  for (const [group, name, weight, suggestedPrice] of TEMPLATES) {
    sortCounter += 10;
    const existing = await ProductTemplate.findOne({ name, group });
    if (existing) {
      // Update price/weight in case admin tweaked the seed
      existing.weight = weight;
      existing.suggestedPrice = suggestedPrice;
      existing.sortOrder = sortCounter;
      existing.isActive = true;
      await existing.save();
      updated += 1;
    } else {
      await ProductTemplate.create({
        name,
        weight,
        suggestedPrice,
        group,
        sortOrder: sortCounter,
        isActive: true,
      });
      created += 1;
      console.log(`  + ${group} / ${name} (${weight}) — ₹${suggestedPrice}`);
    }
  }

  console.log('');
  console.log(`Done. Created ${created} new, updated ${updated} existing. Total in seed: ${TEMPLATES.length}`);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
  
