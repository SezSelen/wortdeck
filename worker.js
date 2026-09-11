/**
 * Wortdeck Worker
 * - /api/lookup : Anthropic'e vekillik eder, anahtar burada durur
 * - /api/deck   : desteyi KV'de tutar, GET ile okur PUT ile birleştirir
 * Statik dosyalar (public/) bu koda hiç uğramaz, Cloudflare doğrudan servis eder.
 */

const MODELS = new Set(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
const DECK_KEY = 'deck';

const WORTARTEN = ['Nomen','Verb','Adjektiv','Adverb','Präposition','Konjunktion','Redewendung','Sonstige'];

const LOOKUP_SYSTEM = `Du bist ein deutsch-türkisches Lernwörterbuch für eine Studentin auf Niveau B1.
Gib AUSSCHLIESSLICH gültiges JSON zurück. Keine Erklärung, kein Markdown, keine Backticks.

Schema:
{
 "lemma": "Grundform, bei Nomen groß geschrieben",
 "wortart": eines von ${JSON.stringify(WORTARTEN)},
 "artikel": "der" | "die" | "das" | null,
 "plural": "Pluralform oder null",
 "verbInfo": {"praeteritum":"","perfekt":"","trennbar":true|false,"kasus":"z.B. Akkusativ"} oder null,
 "de_definition": "Erklärung auf Deutsch, einfach, A2-B1 Wortschatz, max 25 Wörter",
 "tr": "türkische Entsprechung, bei Mehrdeutigkeit 2-3 durch Komma getrennt",
 "beispiel": "ein natürlicher Beispielsatz auf B1-Niveau",
 "beispiel_tr": "türkische Übersetzung des Beispielsatzes",
 "niveau": "A1"|"A2"|"B1"|"B2"|"C1"
}
Bei Verben immer verbInfo füllen. Bei Nomen immer artikel und plural füllen.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

/** Sabit süreli karşılaştırma — parolayı karakter karakter sızdırmamak için */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Lemma'ya göre birleştir, çakışmada updatedAt'i yeni olan kazanır */
function mergeDecks(a = [], b = []) {
  const map = new Map();
  for (const w of [...a, ...b]) {
    if (!w || !w.lemma) continue;
    const k = String(w.lemma).trim().toLowerCase();
    const cur = map.get(k);
    if (!cur || (w.updatedAt || 0) > (cur.updatedAt || 0)) map.set(k, w);
  }
  return [...map.values()];
}

async function readDeck(env) {
  const raw = await env.DECK.get(DECK_KEY);
  if (!raw) return [];
  try { const d = JSON.parse(raw); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

async function handleLookup(request, env) {
  const { word, model } = await request.json();
  if (!word || typeof word !== 'string' || word.length > 80) {
    return json({ error: 'Geçersiz kelime.' }, 400);
  }
  const chosen = MODELS.has(model) ? model : 'claude-haiku-4-5-20251001';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: chosen,
      max_tokens: 1000,
      system: LOOKUP_SYSTEM,
      messages: [{ role: 'user', content: word.trim() }]
    })
  });

  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return json({ error: d.error?.message || `Anthropic hatası: HTTP ${res.status}` }, 502);
  }

  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch {
    return json({ error: 'Sözlük maddesi okunamadı, tekrar dene.' }, 502);
  }
}

async function handlePutDeck(request, env) {
  const incoming = await request.json();
  if (!Array.isArray(incoming)) return json({ error: 'Deste bir dizi olmalı.' }, 400);

  const merged = mergeDecks(await readDeck(env), incoming);
  await env.DECK.put(DECK_KEY, JSON.stringify(merged));
  return json(merged);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Bulunamadı.' }, 404);
    }
    if (!env.ANTHROPIC_API_KEY || !env.APP_PASSWORD) {
      return json({ error: 'Sunucu yapılandırılmamış: secret tanımlı değil.' }, 500);
    }
    if (!sameSecret(request.headers.get('x-wortdeck-pass') || '', env.APP_PASSWORD)) {
      return json({ error: 'Parola hatalı.' }, 401);
    }

    try {
      if (url.pathname === '/api/lookup' && request.method === 'POST') {
        return await handleLookup(request, env);
      }
      if (url.pathname === '/api/deck' && request.method === 'GET') {
        return json(await readDeck(env));
      }
      if (url.pathname === '/api/deck' && request.method === 'PUT') {
        return await handlePutDeck(request, env);
      }
      return json({ error: 'Bilinmeyen uç nokta.' }, 404);
    } catch (e) {
      return json({ error: e.message || 'Beklenmeyen hata.' }, 500);
    }
  }
};
