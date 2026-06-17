import { env } from '../config/env.js';
import { redis } from '../config/redis.js';

/**
 * Search query normalizer.
 *
 * Customers type messy queries: typos ("kiranna"), half-words ("sunl kir"),
 * mixed Hindi/English ("doodh milk"). This uses Google Gemini (free tier) to
 * correct the query into clean search terms BEFORE it hits the MongoDB $text
 * search and product filter.
 *
 * Design choices:
 *   - One small model call per *committed* search (on Enter), never per keystroke.
 *   - Cached in Redis for 30 days — repeat searches cost nothing.
 *   - Fails safe: if the key is missing or the call errors, we return the raw
 *     query unchanged, so search always works.
 *
 * Gemini free tier: ~1,500 requests/day, no credit card. Use a Google Cloud
 * project WITHOUT billing enabled, or the free tier is disabled on it.
 */

// Flash-Lite is the cheapest/fastest free-tier model — ideal for short rewrites.
const MODEL = 'gemini-2.5-flash-lite';
const CACHE_PREFIX = 'searchnorm:';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const INSTRUCTION =
  'You correct short shopping search queries for a local Indian marketplace ' +
  '(shops and products in Odisha, India). Fix spelling, complete half-words, ' +
  'and normalize to the most likely intended shop or product name in English. ' +
  'Keep it short. Do not add words that were not implied. ' +
  'Reply with ONLY the corrected query text — no quotes, no explanation.';

/**
 * @param {string} raw  the user's typed query
 * @returns {Promise<string>} corrected query (or the raw query on any failure)
 */
export async function normalizeSearchQuery(raw) {
  const query = String(raw || '').trim();
  if (!query) return '';
  // Very short queries (1–2 chars) aren't worth a model call.
  if (query.length < 3) return query;
  if (!env.GEMINI_API_KEY) return query;

  const cacheKey = CACHE_PREFIX + query.toLowerCase();

  // 1) Cache hit?
  try {
    const cached = await redis.get(cacheKey);
    if (cached != null) return cached;
  } catch {
    // Redis down — ignore and continue to the model.
  }

  // 2) Ask Gemini.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
      `?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        generationConfig: { maxOutputTokens: 32, temperature: 0 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return query;

    const data = await resp.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join(' ')
      .trim();

    const corrected = text && text.length <= 80 ? text : query;

    // 3) Cache the result (best-effort).
    try {
      await redis.set(cacheKey, corrected, 'EX', CACHE_TTL_SECONDS);
    } catch {
      /* ignore cache write failures */
    }

    return corrected;
  } catch {
    // Timeout, network error, bad JSON — fall back to the raw query.
    return query;
  }
}
