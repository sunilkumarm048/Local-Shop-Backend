import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';

/**
 * POST /api/voice — the AI voice assistant pipeline, moved from the old
 * Cloudflare Worker into our own backend so all keys live in Render env vars.
 *
 *   1. STT   — Groq Whisper (whisper-large-v3): audio → transcript.
 *              Handles Hinglish/Hindi/English naturally.
 *   2. Brain — Google Gemini: transcript + catalog + cart + pending action →
 *              short spoken-style reply + shopping action (JSON).
 *   3. TTS   — Sarvam AI (bulbul:v2, hi-IN): reply text → WAV audio (base64).
 *
 * Request (multipart/form-data — matches the frontend VoiceAssistant):
 *   audio         webm/mp4 blob of the user's speech
 *   products      JSON array [{name, price, mrp, weight, shopName, category, inStock}]
 *   shops         JSON array [{shopName, category, isOpen}]
 *   cart          JSON array [{name, qty, price}]
 *   history       JSON array [{role: 'user'|'assistant', content}]
 *   pendingAction JSON object or null — action awaiting user confirmation
 *
 * Response JSON (same protocol the old worker used):
 *   { transcript, replyText, replyAudio?, pendingAction?, executeAction?, cancelAction? }
 *
 * Actions use confirm-before-execute: we propose `pendingAction`, the client
 * echoes it back next turn, and we return `executeAction` only once the user
 * says yes (or `cancelAction: true` if they decline).
 *
 * Env (all optional — route returns 503 if the required ones are missing):
 *   GROQ_API_KEY, GEMINI_API_KEY, SARVAM_API_KEY, GEMINI_MODEL (default gemini-2.5-flash)
 */

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 25s of webm opus is well under this
});

const ACTION_TYPES = [
  'addToCart',
  'removeFromCart',
  'changeQty',
  'showCart',
  'clearCart',
  'selectCategory',
  'selectShop',
  'searchProduct',
  'goToCheckout',
  'trackOrder',
  'showOrderHistory',
];

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/* ---------------- 1. STT — Groq Whisper ---------------- */

async function transcribe(file) {
  const fd = new FormData();
  fd.append(
    'file',
    new Blob([file.buffer], { type: file.mimetype || 'audio/webm' }),
    'audio.webm'
  );
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'json');

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
  return (data.text || '').trim();
}

/* ---------------- 2. Brain — Gemini ---------------- */

function buildSystemPrompt({ products, shops, cart, pendingAction }) {
  return `You are the Sarvopakar voice assistant — a friendly shopping helper for Sarvopakar (सर्वोपकार), a hyperlocal delivery app in Odisha, India.

STYLE: Reply in short, natural Hinglish (Hindi written in Latin script, mixed with English). Maximum 2 short sentences — your reply is spoken aloud. Be warm and quick, like a helpful shopkeeper.

You can propose these actions (exact JSON shapes):
- {"type":"addToCart","productName":string,"qty":number}
- {"type":"removeFromCart","productName":string}
- {"type":"changeQty","productName":string,"qty":number}
- {"type":"showCart"}
- {"type":"clearCart"}
- {"type":"selectCategory","category":string}
- {"type":"selectShop","shopName":string}
- {"type":"searchProduct","query":string}
- {"type":"goToCheckout"}
- {"type":"trackOrder"}
- {"type":"showOrderHistory"}

RULES:
1. Never execute immediately. When the user asks for something actionable, set "pendingAction" to the proposed action and ask a short confirmation question in "reply" (e.g. "Sunil Tea Stall se 1 kg chini, ₹36 — add kar du?").
2. PENDING ACTION AWAITING CONFIRMATION: ${pendingAction ? JSON.stringify(pendingAction) : 'none'}.
   - If one exists and the user confirms (haan, ha, yes, ok, theek hai, kar do, add karo), return "executeAction" set to EXACTLY that pending action, confirm briefly in "reply", and set "pendingAction" to null.
   - If they decline (nahi, no, cancel, rehne do, mat karo), set "cancelAction" true and acknowledge briefly.
   - If they say something unrelated, drop the pending action and handle the new request.
3. For "productName"/"shopName", copy the EXACT name from the catalog below. If nothing matches, say it's not available and suggest the closest alternatives from the catalog — no action.
4. Price/availability questions: answer directly from the catalog, no action needed.
5. If the transcript is empty or gibberish, ask them to repeat.

CATALOG (products): ${JSON.stringify(products.slice(0, 200))}
SHOPS: ${JSON.stringify(shops.slice(0, 60))}
USER'S CART: ${JSON.stringify(cart)}

Respond ONLY with a single JSON object, no markdown:
{"reply": string, "pendingAction": object|null, "executeAction": object|null, "cancelAction": boolean}`;
}

async function think({ transcript, history, products, shops, cart, pendingAction }) {
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
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: buildSystemPrompt({ products, shops, cart, pendingAction }) }],
        },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error('AI reply failed'), { detail, step: 'llm' });
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = safeParse(text.replace(/```json|```/g, '').trim(), null);
  if (!parsed || typeof parsed.reply !== 'string') {
    return { reply: 'Sorry, samajh nahi aaya. Phir se boliye?', pendingAction: null, executeAction: null, cancelAction: false };
  }
  // Only pass through action types the frontend knows how to run.
  const clean = (a) => (a && typeof a === 'object' && ACTION_TYPES.includes(a.type) ? a : null);
  return {
    reply: parsed.reply,
    pendingAction: clean(parsed.pendingAction),
    executeAction: clean(parsed.executeAction),
    cancelAction: parsed.cancelAction === true,
  };
}

/* ---------------- 3. TTS — Sarvam ---------------- */

async function speak(text) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': env.SARVAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: [text.slice(0, 450)],
      target_language_code: 'hi-IN',
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
  return data?.audios?.[0] || null; // base64 WAV
}

/* ---------------- Route ---------------- */

router.post('/', upload.single('audio'), async (req, res) => {
  if (!env.GROQ_API_KEY || !env.GEMINI_API_KEY) {
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
    const transcript = await transcribe(req.file);
    if (!transcript) {
      return res.json({
        transcript: '',
        replyText: 'Kuch sunai nahi diya — phir se boliye?',
        pendingAction,
      });
    }

    const brain = await think({ transcript, history, products, shops, cart, pendingAction });

    // TTS is best-effort: if Sarvam is down or the key is missing, the text
    // reply still goes out and the client just skips audio playback.
    let replyAudio = null;
    if (env.SARVAM_API_KEY && brain.reply) {
      try {
        replyAudio = await speak(brain.reply);
      } catch (e) {
        console.error('[voice] TTS failed:', e.detail || e.message);
      }
    }

    return res.json({
      transcript,
      replyText: brain.reply,
      replyAudio,
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
