/**
 * Effective service mode — who travels for a service booking.
 *
 * Providers CAN set shop.serviceMode explicitly (Bookings tab → My time
 * slots → "Service type"). When they haven't, we infer a sensible default
 * from the category name:
 *
 *   HOME-VISIT trades  → 'visit_customer' : electrician, plumber, AC &
 *   refrigerator, carpenter, painter, mason, pest control, appliance/geyser/
 *   purifier repair, general workers/labour…
 *
 *   EVERYTHING ELSE    → 'customer_visits' : salon/barber, beauty parlour,
 *   garage, laundry, cyber cafe, photocopy, travel agency, courier, vet…
 *   (services with premises — the customer goes to them).
 *
 * The default direction ("rest = shop-based") is deliberate: new shop-type
 * categories added later behave correctly without touching this list; only
 * genuinely new home-visit trades ever need a keyword added.
 */

const HOME_VISIT_PATTERNS = [
  /electric/i,
  /plumb/i,
  /carpent/i,
  /refrigerator|fridge/i,
  /\ba\.?c\b/i, // "AC", "A.C", "AC & Refrigerator"
  /\bworker/i,
  /labou?r/i,
  /mason|mistri/i,
  /painter|painting/i,
  /pest/i,
  /appliance/i,
  /geyser/i,
  /purifier|\bro\b/i,
  /handyman/i,
  /welder|welding/i,
  /home (service|repair|clean)/i,
];

/** Does this category name describe a trade that visits the customer? */
export function isHomeVisitCategoryName(name) {
  const n = String(name || '');
  return HOME_VISIT_PATTERNS.some((re) => re.test(n));
}

/**
 * Resolve the mode for a shop (lean doc or mongoose doc).
 * Explicit setting always wins; otherwise infer from the populated category
 * name; if the category isn't populated/available, fall back to shop-based
 * (the safer default for the majority of listed services).
 */
export function effectiveServiceMode(shop) {
  if (shop?.serviceMode) return shop.serviceMode;
  const cat = shop?.category;
  const name = typeof cat === 'object' && cat ? cat.name : null;
  if (name == null) return 'customer_visits';
  return isHomeVisitCategoryName(name) ? 'visit_customer' : 'customer_visits';
}
