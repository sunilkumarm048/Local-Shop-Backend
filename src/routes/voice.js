import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';

/**
 * POST /api/voice — Sarvopakar's multilingual AI voice assistant.
 * GET  /api/voice/health — checks each AI provider and reports status.
 *
 * Pipeline (all keys are server-side Render env vars):
 *   1. STT   — Sarvam Saarika (saarika:v2.5, auto language detect: Odia /
 *              Hindi / English / other Indian languages). Falls back to
 *              Groq Whisper if Sarvam STT fails or isn't configured.
 *   2. Brain — Google Gemini: replies in the USER'S OWN LANGUAGE (Odia in
 *              Odia script, Hindi, English…), knows Sarvopakar's shops,
 *              service providers (electrician/plumber/…), cart, distances,
 *              and open/available status. Proposes app actions.
 *   3. TTS   — Sarvam bulbul:v2, spoken in the same language as the reply
 *              (od-IN / hi-IN / en-IN / …). Best-effort: text still returned
 *              if TTS fails.
 *
 * Response protocol (unchanged, matches the frontend VoiceAssistant):
 *   { transcript, replyText, replyAudio?, pendingAction?, executeAction?, cancelAction? }
 *
 * Confirmation policy: cart-changing actions + checkout + booking need a
 * spoken yes; navigation/search/filter actions execute immediately.
 */

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Must stay in sync with the frontend VoiceAssistant executor.
const CONFIRM_ACTIONS = ['addToCart', 'removeFromCart', 'changeQty', 'clearCart', 'goToCheckout', 'bookProvider', 'createBooking'];
const INSTANT_ACTIONS = ['showCart', 'selectCategory', 'selectShop', 'searchProduct', 'trackOrder', 'showOrderHistory', 'showServices', 'showShops', 'openBookings'];
const ACTION_TYPES = [...CONFIRM_ACTIONS, ...INSTANT_ACTIONS];

// Languages Sarvam bulbul:v2 can speak.
const TTS_LANGS = new Set(['od-IN', 'hi-IN', 'en-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN']);

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/* ---------------- 1. STT ---------------- */

async function sttSarvam(file) {
  const fd = new FormData();
  fd.append('file', new Blob([file.buffer], { type: file.mimetype || 'audio/webm' }), 'audio.webm');
  fd.append('model', 'saarika:v2.5');
  fd.append('language_code', 'unknown'); // auto-detect (Odia, Hindi, English, …)
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY },
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('Sarvam STT failed'), { detail, step: 'stt' });
  }
  const data = await res.json();
  return {
    transcript: (data.transcript || '').trim(),
    language: data.language_code || null, // e.g. 'od-IN'
  };
}

async function sttGroq(file) {
  const fd = new FormData();
  fd.append('file', new Blob([file.buffer], { type: file.mimetype || 'audio/webm' }), 'audio.webm');
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'verbose_json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('Speech-to-text failed'), { detail, step: 'stt' });
  }
  const data = await res.json();
  const langMap = { or: 'od-IN', hi: 'hi-IN', en: 'en-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN' };
  return {
    transcript: (data.text || '').trim(),
    language: langMap[data.language] || null,
  };
}

async function transcribe(file) {
  if (env.SARVAM_API_KEY) {
    try {
      return await sttSarvam(file);
    } catch (e) {
      console.error('[voice] Sarvam STT failed, falling back to Groq:', e.detail || e.message);
    }
  }
  if (env.GROQ_API_KEY) return sttGroq(file);
  throw Object.assign(new Error('No speech-to-text provider configured'), { step: 'stt' });
}

/* ---------------- 2. Brain — Gemini ---------------- */

function buildSystemPrompt({ products, shops, cart, pendingAction, language }) {
  return `You are the Sarvopakar (ସର୍ବୋପକାର / सर्वोपकार) voice assistant — for a hyperlocal app in Odisha, India where customers (1) order products from nearby local shops for delivery, and (2) book home-service providers (electrician, plumber, beautician, mechanic, etc.) who visit their home.

LANGUAGE — MOST IMPORTANT RULE:
Reply in the SAME language the user spoke. Detected language of this message: ${language || 'unknown'}.
- Odia (od-IN) → reply in Odia, in Odia script (ଓଡ଼ିଆ). Example: "ଏକ କିଲୋ ଚିନି ₹36 ର, Sunil Tea Stall ରୁ — add କରିଦେବି?"
- Hindi (hi-IN) → natural Hindi/Hinglish in Devanagari or Latin script.
- English (en-IN) → simple English.
Keep replies SHORT (max 2 sentences) — they are spoken aloud. Warm, like a helpful local shopkeeper.

SARVOPAKAR CONTEXT:
- SHOPS list below: entries with isService=true are HOME-SERVICE PROVIDERS (availableNow=true means they can come now); others are product shops (isOpen=true means open). distanceKm = distance from the customer.
- Products can only be ordered from OPEN shops. Services only from AVAILABLE providers.
- When recommending, prefer nearby (small distanceKm) and open/available.

ACTIONS (exact JSON shapes):
Needs confirmation first: {"type":"addToCart","productName":s,"qty":n} {"type":"removeFromCart","productName":s} {"type":"changeQty","productName":s,"qty":n} {"type":"clearCart"} {"type":"goToCheckout"} {"type":"createBooking","shopName":s,"serviceName":s,"notes":s,"requestNow":bool,"scheduledDate":"YYYY-MM-DD" or null,"scheduledSlot":s or null} {"type":"bookProvider","shopName":s}
Instant (no confirmation): {"type":"showCart"} {"type":"searchProduct","query":s} {"type":"selectCategory","category":s} {"type":"selectShop","shopName":s} {"type":"showServices"} {"type":"showShops"} {"type":"openBookings"} {"type":"trackOrder"} {"type":"showOrderHistory"}

RULES:
1. Cart/checkout/booking requests → set "pendingAction" and ask a short confirmation question. Include price and shop name when proposing addToCart.
2. PENDING ACTION AWAITING CONFIRMATION: ${pendingAction ? JSON.stringify(pendingAction) : 'none'}.
   User confirms (haan/ହଁ/yes/ok/theek hai/କର) → return "executeAction" = EXACTLY that pending action, confirm briefly.
   User declines (nahi/ନାହିଁ/no/cancel) → "cancelAction": true, acknowledge briefly.
   Unrelated speech → drop it, handle the new request.
3. Navigation/search requests → return the action directly in "executeAction" (no confirmation), with a short reply like "ଦେଖାଉଛି…".
4. BOOKING A SERVICE BY VOICE — the most important skill. NEVER propose a booking until you know THREE things: (1) WHO (provider), (2) WHAT (the job), (3) WHEN (now or scheduled). Gather what's missing conversationally, ONE short question at a time:
   STEP 1 — WHAT: If the user hasn't said what needs doing ("electrician bulao"), ask what the problem is ("Kya kaam hai? / କଣ କାମ ଅଛି?"). serviceName = short job summary in the user's language (e.g. "AC repair", "ପାଇପ୍ ଲିକ୍ ମରାମତି"); extra details (floor, urgency, brand) go in notes.
   STEP 2 — WHO: Pick the best provider: matching type, availableNow=true, smallest distanceKm. If the user named one, use that exact shopName. If NO matching provider is availableNow: say so HONESTLY (never invent providers), offer alternatives or executeAction showServices.
   STEP 3 — WHEN: If the user hasn't said when, ASK: "Abhi bhejun, ya time fix karein? / ଏବେ ପଠାଇବି ନା time ଠିକ୍ କରିବେ?"
     - "now/abhi/turant/ଏବେ" → requestNow=true, scheduledDate=null, scheduledSlot=null.
     - A day/time → requestNow=false, scheduledDate="YYYY-MM-DD" (TODAY in India is ${new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)} — compute kal/tomorrow/parson/day names from this), and scheduledSlot = EXACTLY one of: "8–10 AM", "10–12 PM", "12–2 PM", "2–4 PM", "4–6 PM", "6–8 PM". Map spoken times to the nearest slot (e.g. "subah 9 baje"→"8–10 AM", "shaam ko"→ask 4–6 or 6–8). If the day is known but not the time, ask which slot, offering 2–3 options naturally.
   STEP 4 — CONFIRM: Only when all three are known, propose {"type":"createBooking",…} as pendingAction with a full summary in reply: provider + job + time. e.g. "Likan AC repair (2.1 km), kal 10–12 PM, AC servicing — booking କରିଦେବି?"
   AFTER: the app creates the booking and reports the result here (messages starting with [APP]) — trust those; if it failed, help the user with the reason.
   Use {"type":"bookProvider","shopName":…} only if the user explicitly wants to open the booking form and fill it themselves.
5. Copy productName/shopName EXACTLY from the lists below. Nothing matches → say it's not available, suggest the closest alternatives, no action.
6. Price/availability questions → answer directly from data, no action.
7. "lang" field: the BCP-47 code of YOUR reply — one of od-IN, hi-IN, en-IN, bn-IN, ta-IN, te-IN, kn-IN, ml-IN, mr-IN, gu-IN, pa-IN.

PRODUCTS: ${JSON.stringify(products.slice(0, 200))}
SHOPS & SERVICE PROVIDERS: ${JSON.stringify(shops.slice(0, 80))}
USER'S CART: ${JSON.stringify(cart)}

Respond ONLY with one JSON object, no markdown:
{"reply": string, "lang": string, "pendingAction": object|null, "executeAction": object|null, "cancelAction": boolean}`;
}

function parseBrainJson(text, language) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, '') // Sarvam-M thinking traces
    .replace(/```json|```/g, '')
    .trim();
  const parsed = safeParse(cleaned, null);
  if (!parsed || typeof parsed.reply !== 'string') {
    const fallback = language === 'od-IN' ? 'ଦୁଃଖିତ, ବୁଝିପାରିଲି ନାହିଁ। ପୁଣି କୁହନ୍ତୁ?' : 'Sorry, samajh nahi aaya. Phir se boliye?';
    return { reply: fallback, lang: language || 'hi-IN', pendingAction: null, executeAction: null, cancelAction: false };
  }
  const clean = (a) => (a && typeof a === 'object' && ACTION_TYPES.includes(a.type) ? a : null);
  return {
    reply: parsed.reply,
    lang: TTS_LANGS.has(parsed.lang) ? parsed.lang : language || 'hi-IN',
    pendingAction: clean(parsed.pendingAction),
    executeAction: clean(parsed.executeAction),
    cancelAction: parsed.cancelAction === true,
  };
}

async function thinkGemini({ systemPrompt, history, transcript }) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const contents = [
    ...history.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    })),
    { role: 'user', parts: [{ text: transcript }] },
  ];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 512, responseMimeType: 'application/json' },
      }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('AI reply failed'), { detail, step: 'llm' });
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function thinkSarvam({ systemPrompt, history, transcript }) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SARVAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // sarvam-m was deprecated; sarvam-30b is Sarvam's recommended model
      // for real-time voice pipelines. reasoning_effort null disables the
      // default thinking mode — faster + cheaper for short shopping turns.
      model: env.SARVAM_MODEL || 'sarvam-30b',
      reasoning_effort: null,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-8).map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || ''),
        })),
        { role: 'user', content: transcript },
      ],
      temperature: 0.4,
      max_tokens: 512,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('AI reply failed'), { detail, step: 'llm' });
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Brain chooser — VOICE_BRAIN env var picks 'gemini' (default) or 'sarvam'
 * (Sarvam-M, tuned for Indian languages). If the chosen brain fails, the
 * other one is tried automatically before giving up.
 */
async function think({ transcript, history, products, shops, cart, pendingAction, language }) {
  const systemPrompt = buildSystemPrompt({ products, shops, cart, pendingAction, language });
  const args = { systemPrompt, history, transcript };

  const preferSarvam = (env.VOICE_BRAIN || '').toLowerCase() === 'sarvam';
  const primary = preferSarvam && env.SARVAM_API_KEY ? thinkSarvam : thinkGemini;
  const backup = primary === thinkSarvam ? (env.GEMINI_API_KEY ? thinkGemini : null) : env.SARVAM_API_KEY ? thinkSarvam : null;

  try {
    return parseBrainJson(await primary(args), language);
  } catch (e) {
    console.error(`[voice] ${primary === thinkSarvam ? 'sarvam-m' : 'gemini'} brain failed:`, (e.detail || e.message || '').slice(0, 200));
    if (!backup) throw e;
    console.error(`[voice] falling back to ${backup === thinkSarvam ? 'sarvam-m' : 'gemini'}`);
    return parseBrainJson(await backup(args), language);
  }
}

/* ---------------- 3. TTS — Sarvam ---------------- */

async function speak(text, lang) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [text.slice(0, 450)],
      target_language_code: TTS_LANGS.has(lang) ? lang : 'hi-IN',
      speaker: 'anushka',
      model: 'bulbul:v2',
      speech_sample_rate: 22050,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('Text-to-speech failed'), { detail, step: 'tts' });
  }
  const data = await res.json();
  return data?.audios?.[0] || null;
}

/* ---------------- Health check ---------------- */

router.get('/health', async (_req, res) => {
  async function check(name, fn) {
    if (!fn) return { configured: false, ok: false, note: 'API key not set in Render env' };
    try {
      const r = await fn();
      return { configured: true, ok: r.ok, status: r.status, note: r.ok ? 'working' : (await r.text().catch(() => '')).slice(0, 140) };
    } catch (e) {
      return { configured: true, ok: false, note: String(e.message).slice(0, 140) };
    }
  }

  const [groq, gemini, sarvam] = await Promise.all([
    check('groq', env.GROQ_API_KEY && (() => fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` } }))),
    check('gemini', env.GEMINI_API_KEY && (() => fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } }))),
    check('sarvam', env.SARVAM_API_KEY && (() =>
      fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: ['ok'], target_language_code: 'od-IN', speaker: 'anushka', model: 'bulbul:v2' }),
      }))),
  ]);

  const allOk = groq.ok && gemini.ok && sarvam.ok;
  const brain = (env.VOICE_BRAIN || '').toLowerCase() === 'sarvam' ? env.SARVAM_MODEL || 'sarvam-30b' : env.GEMINI_MODEL || 'gemini-2.5-flash';
  res.status(allOk ? 200 : 207).json({ allOk, brain, groq, gemini, sarvam });
});

/* ---------------- Speak app messages ---------------- */

/**
 * POST /api/voice/say — { text, lang } → { audio } (base64 WAV).
 * Lets the app announce results it produced client-side (booking created,
 * login needed, booking failed…) in the same voice and language as the
 * conversation. Text is capped short; returns { audio: null } when TTS is
 * unavailable so the client falls back to on-screen text.
 */
router.post('/say', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 300).trim();
  const lang = String(req.body?.lang || 'hi-IN');
  if (!text) return res.status(400).json({ error: 'No text' });
  if (!env.SARVAM_API_KEY) return res.json({ audio: null });
  try {
    const audio = await speak(text, lang);
    return res.json({ audio });
  } catch (e) {
    console.error('[voice] say failed:', e.detail || e.message);
    return res.json({ audio: null });
  }
});

/* ---------------- Main route ---------------- */

router.post('/', upload.single('audio'), async (req, res) => {
  if ((!env.GEMINI_API_KEY && !env.SARVAM_API_KEY) || (!env.SARVAM_API_KEY && !env.GROQ_API_KEY)) {
    return res.status(503).json({ error: 'Voice assistant is not configured on the server.' });
  }
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: 'No audio received.' });
  }

  const products = safeParse(req.body.products, []);
  const shops = safeParse(req.body.shops, []);
  const cart = safeParse(req.body.cart, []);
  const history = safeParse(req.body.history, []);
  const pendingAction = safeParse(req.body.pendingAction, null);

  try {
    const { transcript, language } = await transcribe(req.file);
    if (!transcript) {
      return res.json({
        transcript: '',
        replyText: language === 'od-IN' ? 'କିଛି ଶୁଣାଗଲା ନାହିଁ — ପୁଣି କୁହନ୍ତୁ?' : 'Kuch sunai nahi diya — phir se boliye?',
        pendingAction,
      });
    }

    const brain = await think({ transcript, history, products, shops, cart, pendingAction, language });

    let replyAudio = null;
    if (env.SARVAM_API_KEY && brain.reply) {
      try {
        replyAudio = await speak(brain.reply, brain.lang);
      } catch (e) {
        console.error('[voice] TTS failed:', e.detail || e.message);
      }
    }

    return res.json({
      transcript,
      replyText: brain.reply,
      replyAudio,
      lang: brain.lang,
      pendingAction: brain.pendingAction,
      executeAction: brain.executeAction,
      cancelAction: brain.cancelAction,
    });
  } catch (err) {
    console.error(`[voice] ${err.step || 'pipeline'} error:`, err.detail || err.message);
    return res.status(502).json({
      error: err.message || 'Voice pipeline failed',
      detail: (err.detail || '').slice(0, 200),
    });
  }
});

export default router;
