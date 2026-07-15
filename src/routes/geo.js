import { Router } from 'express';

import { env } from '../config/env.js';

/**
 * Geocoding proxy. Keeps the Ola Maps API key server-side (never shipped to the
 * browser) and gives the frontend two simple, provider-agnostic endpoints:
 *
 *   GET /api/geo/search?q=...           → [{ name, address, lat, lng }]
 *   GET /api/geo/reverse?lat=..&lng=..  → { address, areaName }
 *
 * Uses Ola Maps when OLA_MAPS_API_KEY is set (good India/village data), and
 * transparently falls back to OpenStreetMap/Nominatim otherwise — so the app
 * keeps working even if the key is missing or Ola is down.
 */

const router = Router();
const OLA = 'https://api.olamaps.io/places/v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const hasOla = () => Boolean(env.OLA_MAPS_API_KEY);

/* ----------------------------- search (forward) ---------------------------- */
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ results: [] });

    if (hasOla()) {
      try {
        const url = `${OLA}/autocomplete?input=${encodeURIComponent(q)}&api_key=${env.OLA_MAPS_API_KEY}`;
        const r = await fetch(url, { headers: { 'X-Request-Id': `ls-${Date.now()}` } });
        console.log('[geo] ola autocomplete status:', r.status);
        if (r.ok) {
          const data = await r.json();
          const results = normalizeOlaAutocomplete(data);
          console.log('[geo] ola parsed results:', results.length, '| raw keys:', Object.keys(data || {}).join(','));
          // If Ola returned nothing useful, fall through to Nominatim.
          if (results.length > 0) return res.json({ results, source: 'ola' });
        } else {
          const body = await r.text();
          console.log('[geo] ola error body:', body.slice(0, 300));
        }
      } catch (e) {
        console.log('[geo] ola threw:', e.message);
      }
    } else {
      console.log('[geo] OLA_MAPS_API_KEY not set — using OSM');
    }

    // Fallback: Nominatim (India-only)
    const nurl = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=6&countrycodes=in&addressdetails=1`;
    const nr = await fetch(nurl, { headers: { 'Accept-Language': 'en' } });
    const ndata = nr.ok ? await nr.json() : [];
    return res.json({ results: normalizeNominatimSearch(ndata), source: 'osm' });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- reverse geocode ----------------------------- */
router.get('/reverse', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    if (hasOla()) {
      try {
        const url = `${OLA}/reverse-geocode?latlng=${lat},${lng}&api_key=${env.OLA_MAPS_API_KEY}`;
        const r = await fetch(url, { headers: { 'X-Request-Id': `ls-${Date.now()}` } });
        if (r.ok) {
          const data = await r.json();
          const out = normalizeOlaReverse(data);
          if (out.address) return res.json({ ...out, source: 'ola' });
        }
      } catch {
        // fall back
      }
    }

    const nurl = `${NOMINATIM}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`;
    const nr = await fetch(nurl, { headers: { 'Accept-Language': 'en' } });
    const ndata = nr.ok ? await nr.json() : {};
    return res.json({
      address: ndata.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      areaName: shortFromNominatim(ndata),
      source: 'osm',
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ normalizers -------------------------------- */
// Ola autocomplete → our shape. Defensive: Ola's payload nests differ across
// versions, so we read the common fields and skip anything missing coords.
function normalizeOlaAutocomplete(data) {
  const preds = data?.predictions || data?.results || [];
  return preds
    .map((p) => {
      const loc = p?.geometry?.location || p?.location || {};
      const lat = loc.lat ?? loc.latitude;
      const lng = loc.lng ?? loc.longitude;
      if (lat == null || lng == null) return null;
      return {
        name: p?.structured_formatting?.main_text || p?.name || p?.description || 'Location',
        address: p?.description || p?.formatted_address || '',
        lat: Number(lat),
        lng: Number(lng),
      };
    })
    .filter(Boolean);
}

function normalizeOlaReverse(data) {
  const first = (data?.results || [])[0] || {};
  return {
    address: first.formatted_address || '',
    areaName:
      first?.address_components?.find?.((c) => c.types?.includes('sublocality'))?.name ||
      first?.name ||
      '',
  };
}

function normalizeNominatimSearch(arr) {
  return (Array.isArray(arr) ? arr : []).map((r) => ({
    name: shortFromNominatim(r) || r.display_name,
    address: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
  }));
}

function shortFromNominatim(r) {
  const a = r?.address || {};
  return (
    a.suburb || a.village || a.town || a.city || a.county || a.state_district || r?.name || ''
  );
}

/**
 * GET /api/geo/route-distance?olat=..&olng=..&dests=lat,lng|lat,lng|...
 *
 * Road distance + travel time from one origin (the customer) to up to 20
 * destinations (service providers), via Ola Maps Distance Matrix. The API
 * key stays server-side. Returns { results: [{ km, mins } | null, ...] } in
 * destination order, or { results: null } when Ola is unavailable — the
 * frontend then keeps its straight-line estimate.
 */
router.get('/route-distance', async (req, res) => {
  try {
    const { olat, olng, dests } = req.query;
    const origin = `${Number(olat)},${Number(olng)}`;
    const list = String(dests || '')
      .split('|')
      .filter(Boolean)
      .slice(0, 20);
    if (!hasOla() || !Number(olat) || !Number(olng) || list.length === 0) {
      return res.json({ results: null });
    }
    const url =
      `https://api.olamaps.io/routing/v1/distanceMatrix/basic?origins=${encodeURIComponent(origin)}` +
      `&destinations=${encodeURIComponent(list.join('|'))}&api_key=${env.OLA_MAPS_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      console.error('[geo] distance matrix failed:', r.status);
      return res.json({ results: null });
    }
    const data = await r.json();
    const elements = data?.rows?.[0]?.elements || [];
    const results = list.map((_, i) => {
      const el = elements[i];
      const meters = Number(el?.distance);
      const seconds = Number(el?.duration);
      if (!el || (el.status && el.status !== 'OK') || !Number.isFinite(meters)) return null;
      return {
        km: Math.round((meters / 1000) * 10) / 10,
        mins: Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null,
      };
    });
    return res.json({ results });
  } catch (e) {
    console.error('[geo] distance matrix error:', e.message);
    return res.json({ results: null });
  }
});

export default router;
