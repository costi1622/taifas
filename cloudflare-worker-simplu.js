// Taifas - Worker v9 (seif de chei + Runware + merge si pe planul gratuit Workers Free)
//
// Ce face:
//   1. Poze prin Workers AI          POST /v1/images/generations
//   2. Consum de neuroni              GET  /v1/usage
//   3. Notificari (Web Push)          /v1/push/*   (KV legat ca KV + Cron Trigger "* * * * *")
//   4. SEIF DE CHEI                   /v1/proxy/{anthropic|runware}/...
//      Cheile stau ca secrete in Cloudflare, nu in telefon. Aplicatia trimite doar parola (TOKEN).
//   5. Verificare                     GET  /v1/health  (ce secrete sunt puse, fara sa le arate)
//
// Nou in v9:
//   - Runware (pozele „Fidel · 9B”, acelasi model FLUX.2 klein 9B): POST /v1/proxy/runware/v1, cheia in secretul RUNWARE_KEY.
//     Doar sarcini imageInference (max 4 pe cerere), ca un TOKEN furat sa nu poata folosi contul la altceva.
//   - Planul gratuit (Workers Free): cron-ul nu mai listeaza KV in fiecare minut (limita gratuita e 1.000 de listari/zi);
//     citeste o singura cheie („next”) si listeaza doar cand e ceva de trimis + o data la 10 minute, ca plasa de siguranta.
//   - Pozele Workers AI pot pleca direct ca imagine (?bin=1), fara conversie base64 (mai putin CPU, ~25% mai putini octeti).
//
// Bindings:  AI (Workers AI) · KV (pentru notificari)
// Secret OBLIGATORIU:
//   TOKEN            parola aplicatiei, minimum 24 de caractere (aplicatia o genereaza: Setari -> Inteligenta -> Seif)
// Variabila recomandata:
//   ORIGIN           adresa aplicatiei, ex. https://numele-tau.github.io (mai multe: separate prin virgula)
// Secrete optionale pentru seif (pui doar ce folosesti):
//   ANTHROPIC_KEY    sk-ant-...
//   RUNWARE_KEY      cheia Runware (runware.ai → API Keys)
// Secrete optionale pentru consumul de neuroni:
//   CF_API_TOKEN (Account Analytics: Read) · CF_ACCOUNT_ID

const VER = 9;

const MODELE = {
  eco: '@cf/black-forest-labs/flux-2-klein-4b',
  calitate: '@cf/leonardo/phoenix-1.0',
  realism: '@cf/leonardo/lucid-origin',
  ancorat: '@cf/black-forest-labs/flux-2-klein-9b',
  'ancorat+': '@cf/black-forest-labs/flux-2-dev',
  rapid: '@cf/black-forest-labs/flux-1-schnell',
  flux: '@cf/black-forest-labs/flux-1-schnell',
  sdxl: '@cf/stabilityai/stable-diffusion-xl-base-1.0'
};

// limite
const MAX_BODY = 15 * 1024 * 1024;     // orice cerere
const MAX_REF = 6 * 1024 * 1024;       // o poza de referinta
const MAX_PROMPT = 6000;               // caractere in promptul pentru poze
const MAX_TOKENS = 8192;               // plafon max_tokens pentru Anthropic
const RATE_MIN = 90;                   // cereri pe minut, per IP (pe instanta)
const FAIL_MAX = 8;                    // parole gresite inainte de blocare
const FAIL_WIN = 15 * 60e3;            // fereastra de blocare

/* ───────── raspunsuri, CORS ───────── */
function origini(env) { return String(env.ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean) }
function corsPentru(request, env) {
  const o = request.headers.get('Origin') || '', lista = origini(env);
  return {
    'Access-Control-Allow-Origin': !lista.length ? '*' : (lista.includes(o) ? o : lista[0]),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version, anthropic-beta, accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };
}
// fiecare cerere isi poarta antetele CORS (fara variabile globale intre cereri)
function json(cx, obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cx.cors) });
}
function eroare(cx, mesaj, status) { return json(cx, { error: { message: mesaj } }, status || 400) }

/* ───────── paza: parola, origine, ritm ───────── */
const ritm = new Map(), esecuri = new Map();
function ipDin(request) { return request.headers.get('CF-Connecting-IP') || 'necunoscut' }
function preaDes(ip) {
  const acum = Date.now(), r = ritm.get(ip) || { t: acum, n: 0 };
  if (acum - r.t > 60e3) { r.t = acum; r.n = 0 }
  r.n++; ritm.set(ip, r);
  if (ritm.size > 5000) ritm.clear();
  return r.n > RATE_MIN;
}
function blocat(ip) { const f = esecuri.get(ip); return f && f.n >= FAIL_MAX && Date.now() - f.t < FAIL_WIN }
function esec(ip) {
  const acum = Date.now(), f = esecuri.get(ip) || { t: acum, n: 0 };
  if (acum - f.t > FAIL_WIN) { f.t = acum; f.n = 0 }
  f.n++; esecuri.set(ip, f);
  if (esecuri.size > 5000) esecuri.clear();
}
async function egal(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  const p = new Uint8Array(x), q = new Uint8Array(y); let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}
async function corpLimitat(request) {
  const n = +(request.headers.get('content-length') || 0);
  if (n > MAX_BODY) throw new Error('Cererea e prea mare.');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new Error('Cererea e prea mare.');
  return buf;
}

/* ───────── poze ───────── */
function alegeModel(nume) { return MODELE[nume] || MODELE.eco }
function esteFlux2(m) { return m.indexOf('flux-2') !== -1 }
function esteSchnell(m) { return m.indexOf('flux-1-schnell') !== -1 }
function laturi(size, maxim) {
  const p = String(size || '1024x1024').split('x').map(function (n) {
    const v = parseInt(n, 10) || 1024;
    return Math.min(maxim, Math.max(256, Math.round(v / 8) * 8));
  });
  return [p[0], p[1] || p[0]];
}
function b64din(buf) {
  const o = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
  return btoa(s);
}
async function laBase64(raspuns) {
  if (!raspuns) return '';
  if (typeof raspuns === 'string') return raspuns;
  if (typeof raspuns.image === 'string') return raspuns.image;
  if (typeof ReadableStream !== 'undefined' && raspuns instanceof ReadableStream) return b64din(await new Response(raspuns).arrayBuffer());
  if (raspuns instanceof Uint8Array) return b64din(raspuns);
  if (raspuns instanceof ArrayBuffer) return b64din(raspuns);
  return '';
}
function esteImagine(f) { return f && typeof f !== 'string' && f.size > 0 && f.size <= MAX_REF && /^image\//.test(f.type || 'image/jpeg') }

async function poze(cx, request, env) {
  if (request.method !== 'POST') return eroare(cx, 'Doar POST', 405);
  let corp = {}, refBlob = null, refBlob2 = null, refMore = [];
  const tip = request.headers.get('content-type') || '';
  if (tip.indexOf('multipart/form-data') !== -1) {
    if (+(request.headers.get('content-length') || 0) > MAX_BODY) return eroare(cx, 'Cererea e prea mare.', 413);
    const fd = await request.formData();
    fd.forEach(function (v, k) { if (typeof v === 'string') corp[k] = v.slice(0, MAX_PROMPT + 100) });
    const r = fd.get('image') || fd.get('input_image_0');
    if (r && typeof r !== 'string') { if (!esteImagine(r)) return eroare(cx, 'Poza de referinta e prea mare sau nu e imagine.', 413); refBlob = r }
    const r2 = fd.get('image_1') || fd.get('input_image_1');
    if (r2 && typeof r2 !== 'string') { if (!esteImagine(r2)) return eroare(cx, 'Poza de referinta 2 e prea mare sau nu e imagine.', 413); refBlob2 = r2 }
    for (const n of [2, 3]) { const x = fd.get('image_' + n) || fd.get('input_image_' + n); if (x && typeof x !== 'string' && esteImagine(x)) refMore.push(x) }
  } else {
    try { corp = JSON.parse(new TextDecoder().decode(await corpLimitat(request))) } catch (e) { return eroare(cx, 'Corp JSON invalid') }
  }

  const prompt = String(corp.prompt || '').trim();
  if (!prompt) return eroare(cx, 'Lipseste prompt');
  if (prompt.length > MAX_PROMPT) return eroare(cx, 'Promptul e prea lung (max ' + MAX_PROMPT + ' caractere).', 413);

  let model = alegeModel(corp.model);
  if (refBlob && !esteFlux2(model)) model = MODELE.eco;

  let raspuns;
  try {
    if (esteFlux2(model)) {
      const l = laturi(corp.size, 1920);
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('width', String(l[0]));
      form.append('height', String(l[1]));
      if (corp.seed) form.append('seed', String(parseInt(corp.seed, 10) || 0));
      if (corp.guidance) form.append('guidance', String(Math.min(10, Math.max(1, parseFloat(corp.guidance) || 4))));
      if (refBlob) form.append('input_image_0', refBlob, 'ref.png');
      if (refBlob && refBlob2) form.append('input_image_1', refBlob2, 'ref2.png');
      if (refBlob && refBlob2) refMore.forEach(function (x, i) { form.append('input_image_' + (i + 2), x, 'ref' + (i + 3) + '.png') });
      const fr = new Response(form);
      raspuns = await env.AI.run(model, { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } });
    } else if (esteSchnell(model)) {
      raspuns = await env.AI.run(model, { prompt: prompt, steps: Math.min(8, parseInt(corp.steps, 10) || 4) });
    } else {
      const l = laturi(corp.size, 2048);
      const cerere = { prompt: prompt, width: l[0], height: l[1] };
      if (corp.negative_prompt) cerere.negative_prompt = String(corp.negative_prompt).slice(0, 2000);
      if (corp.seed) cerere.seed = parseInt(corp.seed, 10) || 0;
      if (model.indexOf('leonardo') !== -1) {
        cerere.num_steps = Math.min(50, Math.max(1, parseInt(corp.steps, 10) || 25));
        cerere.guidance = Math.min(10, Math.max(2, parseFloat(corp.guidance) || 4));
      }
      raspuns = await env.AI.run(model, cerere);
    }
  } catch (e) {
    return eroare(cx, 'Workers AI: ' + (e && e.message ? String(e.message).slice(0, 300) : 'eroare'), 502);
  }
  // v9: daca modelul da octeti (nu text base64) si aplicatia accepta, ii trimitem direct, fara conversie
  const bin = new URL(request.url).searchParams.get('bin') === '1';
  if (bin && raspuns && typeof raspuns !== 'string' && typeof raspuns.image !== 'string') {
    const corpImg = (typeof ReadableStream !== 'undefined' && raspuns instanceof ReadableStream) || raspuns instanceof Uint8Array || raspuns instanceof ArrayBuffer ? raspuns : null;
    if (corpImg) return new Response(corpImg, { headers: Object.assign({ 'Content-Type': 'image/png', 'X-Model': model }, cx.cors) });
  }
  const b64 = await laBase64(raspuns);
  if (!b64) return eroare(cx, 'Modelul nu a intors nicio imagine', 502);
  return json(cx, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }], model: model });
}

/* ───────── consum de neuroni (GraphQL Analytics) ───────── */
const GQL = 'https://api.cloudflare.com/client/v4/graphql';
let campNeuroni = null;
async function gql(env, query, variables) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.CF_API_TOKEN },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok || (d.errors && d.errors.length)) {
    const m = (d.errors && d.errors[0] && d.errors[0].message) || ('HTTP ' + r.status);
    throw new Error(m);
  }
  return d.data;
}
function numeTip(t) { while (t && !t.name && t.ofType) t = t.ofType; return t && t.name; }
async function campuri(env, tip) {
  const d = await gql(env, 'query($n:String!){__type(name:$n){fields{name type{name ofType{name ofType{name ofType{name}}}}}}}', { n: tip });
  return (d.__type && d.__type.fields) || [];
}
async function aflaCampul(env) {
  if (campNeuroni) return campNeuroni;
  const acc = await campuri(env, 'account');
  const g = acc.find(function (f) { return f.name === 'aiInferenceAdaptiveGroups'; });
  if (!g) throw new Error('Setul aiInferenceAdaptiveGroups nu e disponibil pentru token');
  const gr = await campuri(env, numeTip(g.type));
  const sum = gr.find(function (f) { return f.name === 'sum'; });
  if (!sum) throw new Error('Nu exista sum.');
  const sf = await campuri(env, numeTip(sum.type));
  const n = sf.find(function (f) { return /neuron/i.test(f.name); });
  if (!n) throw new Error('Niciun camp cu neuroni in sum.');
  campNeuroni = n.name;
  return campNeuroni;
}
async function consum(cx, env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return eroare(cx, 'Lipsesc secretele CF_API_TOKEN si CF_ACCOUNT_ID din Worker', 400);
  try {
    const camp = await aflaCampul(env);
    const azi = new Date().toISOString().slice(0, 10);
    const d = await gql(env,
      'query($a:String!,$z:Date!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:1000,filter:{date_geq:$z,date_leq:$z}){sum{' + camp + '}}}}}',
      { a: env.CF_ACCOUNT_ID, z: azi });
    const conturi = (d.viewer && d.viewer.accounts) || [];
    if (!conturi.length) throw new Error('Contul nu a fost gasit.');
    let total = 0;
    (conturi[0].aiInferenceAdaptiveGroups || []).forEach(function (g) { total += Number((g.sum || {})[camp]) || 0; });
    return json(cx, { date: azi, neurons: Math.round(total * 100) / 100, limit: 10000, field: camp });
  } catch (e) {
    return eroare(cx, 'Analytics: ' + (e && e.message ? String(e.message).slice(0, 200) : 'eroare'), 502);
  }
}

/* ───────── notificari (Web Push) ───────── */
// abonamentul poate trimite doar spre serviciile de push reale (altfel Worker-ul ar putea fi pus sa loveasca orice adresa)
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
function b64u(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function cheiVapid(env) {
  let v = await env.KV.get('vapid', 'json');
  if (v) return v;
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = { priv: await crypto.subtle.exportKey('jwk', k.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) };
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}
async function jwtVapid(env, aud) {
  const v = await cheiVapid(env);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:taifas@example.com' });
  const key = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(data));
  return { jwt: data + '.' + b64u(sig), pub: v.pub };
}
function abonamentBun(sub) {
  try { const u = new URL(sub.endpoint); return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) } catch (e) { return false }
}
async function trimitePush(env) {
  const sub = await env.KV.get('sub', 'json');
  if (!sub || !sub.endpoint || !abonamentBun(sub)) return 'fara abonament';
  const j = await jwtVapid(env, new URL(sub.endpoint).origin);
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: 'vapid t=' + j.jwt + ', k=' + j.pub, 'Content-Length': '0' } });
  if (r.status === 404 || r.status === 410) { await env.KV.delete('sub'); return 'abonament expirat' }
  return r.status;
}
async function pushRuta(cx, request, env, url) {
  if (!env.KV) return eroare(cx, 'Lipseste KV.', 500);
  const p = url.pathname.replace(/^.*\/push\//, '');
  const citesteJson = async () => JSON.parse(new TextDecoder().decode(await corpLimitat(request)) || '{}');
  if (p === 'key' && request.method === 'GET') return json(cx, { key: (await cheiVapid(env)).pub });
  if (p === 'sub' && request.method === 'POST') {
    const b = await citesteJson(), sub = b.sub || b;
    if (!sub || typeof sub.endpoint !== 'string' || !abonamentBun(sub)) return eroare(cx, 'Abonament invalid.');
    const curat = { endpoint: sub.endpoint.slice(0, 1000) };
    if (sub.keys && typeof sub.keys === 'object') curat.keys = { p256dh: String(sub.keys.p256dh || '').slice(0, 200), auth: String(sub.keys.auth || '').slice(0, 100) };
    await env.KV.put('sub', JSON.stringify(curat)); return json(cx, { ok: true });
  }
  if (p === 'at' && request.method === 'POST') {
    const b = await citesteJson(); if (!b.id || !b.at) return eroare(cx, 'id si at sunt obligatorii');
    const id = String(b.id).replace(/[^\w:.-]/g, '').slice(0, 80), at = +b.at;
    if (!id || !isFinite(at) || at > Date.now() + 15 * 86400e3) return eroare(cx, 'Data invalida.');
    const url2 = String(b.url || './'); if (!/^\.\/(\?go=[\w%:.-]*)?$/.test(url2)) return eroare(cx, 'Adresa invalida.');
    await env.KV.put('q:' + id, JSON.stringify({ id: id, at: at, title: String(b.title || 'Taifas').slice(0, 80), body: String(b.body || '').slice(0, 160), url: url2 }), { metadata: { at: at }, expiration: Math.floor(Math.max(at, Date.now()) / 1000) + 7 * 86400 });
    const nx = +(await env.KV.get('next')) || Infinity;
    if (at < nx) await env.KV.put('next', String(at));   // v9: cron-ul citeste doar cheia asta
    return json(cx, { ok: true });
  }
  if (p === 'at' && request.method === 'DELETE') { const id = String(url.searchParams.get('id') || '').replace(/[^\w:.-]/g, '').slice(0, 80); if (id) await env.KV.delete('q:' + id); return json(cx, { ok: true }) }
  if (p === 'pending' && request.method === 'GET') {
    const l = await env.KV.list({ prefix: 'sent:' }), items = [];
    for (const k of l.keys) { const v = await env.KV.get(k.name, 'json'); if (v) items.push(v); await env.KV.delete(k.name) }
    return json(cx, { items: items });
  }
  if (p === 'test' && request.method === 'POST') {
    await env.KV.put('sent:test', JSON.stringify({ id: 'test', title: 'Taifas', body: '🔔 Notificările merg!', url: './' }), { expirationTtl: 3600 });
    return json(cx, { ok: true, push: await trimitePush(env) });
  }
  return eroare(cx, 'Ruta necunoscuta', 404);
}
async function cronPush(env, cand) {
  if (!env.KV) return;
  const acum = cand || Date.now();
  // v9: o citire pe minut in loc de o listare (planul gratuit: 100.000 citiri/zi, dar doar 1.000 listari/zi)
  const nx = await env.KV.get('next');
  const plasa = Math.floor(acum / 60e3) % 10 === 0;          // o data la 10 minute listam oricum (KV se propaga in pana la ~60 s)
  if (!plasa && nx !== null && +nx > acum) return;
  const l = await env.KV.list({ prefix: 'q:' });
  let n = 0, urm = Infinity;
  for (const k of l.keys) {
    const at = k.metadata && k.metadata.at;
    if (!at) continue;
    if (at > acum) { urm = Math.min(urm, at); continue; }
    const v = await env.KV.get(k.name);
    if (v) { await env.KV.put('sent:' + k.name.slice(2), v, { expirationTtl: 86400 }); n++ }
    await env.KV.delete(k.name);
  }
  const vrea = Number.isFinite(urm) ? String(urm) : String(acum + 7 * 86400e3);
  if (nx !== vrea) await env.KV.put('next', vrea);
  if (n) await trimitePush(env);
}

/* ───────── 🔐 seiful de chei (v8) ─────────
   Aplicatia nu mai tine cheile: Worker-ul le adauga aici, din secrete. Doar rutele de mai jos sunt permise. */
const SEIF = {
  anthropic: {
    sus: 'https://api.anthropic.com', secret: 'ANTHROPIC_KEY',
    rute: [['POST', /^\/v1\/messages$/], ['POST', /^\/v1\/messages\/batches$/], ['GET', /^\/v1\/messages\/batches\/[\w-]{1,80}$/],
      ['GET', /^\/v1\/messages\/batches\/[\w-]{1,80}\/results$/], ['POST', /^\/v1\/messages\/batches\/[\w-]{1,80}\/cancel$/]],
    antet: (env, req) => {
      const h = { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': (req.headers.get('anthropic-version') || '2023-06-01').slice(0, 20) };
      const b = req.headers.get('anthropic-beta'); if (b) h['anthropic-beta'] = b.slice(0, 200);
      return h;
    }
  },
  runware: {
    sus: 'https://api.runware.ai', secret: 'RUNWARE_KEY',
    rute: [['POST', /^\/v1$/]],
    antet: env => ({ authorization: 'Bearer ' + env.RUNWARE_KEY })
  }
};
// v9: Runware primeste doar generari de imagini, cel mult 4 pe cerere, cel mult 4 rezultate fiecare
function verificaRunware(o) {
  if (!Array.isArray(o) || !o.length || o.length > 4) throw new Error('Cerere Runware invalida.');
  for (const t of o) {
    if (!t || typeof t !== 'object' || t.taskType !== 'imageInference') throw new Error('Doar imageInference e permis prin seif.');
    if (t.numberResults !== undefined && !(+t.numberResults >= 1 && +t.numberResults <= 4)) throw new Error('numberResults prea mare.');
  }
}
function verificaAnthropic(o) {
  if (!o || typeof o !== 'object') throw new Error('Cerere invalida.');
  if (typeof o.model !== 'string' || !/^claude-[a-z0-9.\-]{1,60}$/.test(o.model)) throw new Error('Model nepermis.');
  if (o.max_tokens !== undefined) o.max_tokens = Math.min(MAX_TOKENS, Math.max(1, Math.floor(+o.max_tokens) || 1));
  delete o.tools; delete o.mcp_servers;       // aplicatia nu le foloseste; un token furat nu le poate folosi nici el
  return o;
}
async function seif(cx, request, env, url) {
  const m = url.pathname.match(/\/proxy\/(anthropic|runware)(\/.*)$/);
  if (!m) return eroare(cx, 'Ruta necunoscuta', 404);
  const s = SEIF[m[1]], cale = m[2];
  if (!env[s.secret]) return eroare(cx, 'Seiful nu are cheia pentru ' + m[1] + ' (secretul ' + s.secret + ' lipseste din Worker).', 501);
  if (!s.rute.some(r => r[0] === request.method && r[1].test(cale))) return eroare(cx, 'Ruta nepermisa in seif.', 403);

  let corp = null;
  if (request.method === 'POST') {
    let buf;
    try { buf = await corpLimitat(request) } catch (e) { return eroare(cx, e.message, 413) }
    if (m[1] === 'anthropic') {
      try {
        const o = JSON.parse(new TextDecoder().decode(buf) || '{}');
        if (/\/batches$/.test(cale)) { if (!Array.isArray(o.requests) || !o.requests.length || o.requests.length > 100) throw new Error('Lot invalid.'); o.requests.forEach(r => verificaAnthropic(r && r.params)) }
        else if (/\/messages$/.test(cale)) verificaAnthropic(o);
        corp = JSON.stringify(o);
      } catch (e) { return eroare(cx, e.message || 'JSON invalid.') }
    } else if (m[1] === 'runware') {
      // se verifica, dar pleaca exact octetii primiti (fara JSON.stringify: mai putin CPU pe planul gratuit)
      try { verificaRunware(JSON.parse(new TextDecoder().decode(buf) || '[]')) } catch (e) { return eroare(cx, e.message || 'JSON invalid.') }
      corp = buf;
    } else corp = buf;
  }
  const antet = Object.assign({}, s.antet(env, request));
  const ct = request.headers.get('content-type'); if (corp !== null) antet['content-type'] = ct && ct.length < 100 ? ct : 'application/json';
  const acc = request.headers.get('accept'); if (acc && acc.length < 100) antet.accept = acc;

  let r;
  try { r = await fetch(s.sus + cale, { method: request.method, headers: antet, body: corp }) }
  catch (e) { return eroare(cx, 'Nu pot ajunge la ' + m[1] + '.', 502) }
  const h = Object.assign({}, cx.cors);
  const rct = r.headers.get('content-type'); if (rct) h['Content-Type'] = rct;
  return new Response(r.body, { status: r.status, headers: h });
}

/* ───────── intrarea ───────── */
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(cronPush(env, event && event.scheduledTime)) },
  async fetch(request, env) {
    const cx = { cors: corsPentru(request, env) };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cx.cors });

    const url = new URL(request.url), ip = ipDin(request);
    const o = request.headers.get('Origin'), lista = origini(env);
    if (o && lista.length && !lista.includes(o)) return eroare(cx, 'Origine nepermisa.', 403);

    if (!env.TOKEN || String(env.TOKEN).length < 24) return eroare(cx, 'Worker-ul v8 cere secretul TOKEN, de minimum 24 de caractere (Cloudflare → Worker → Settings → Variables and Secrets).', 503);
    if (blocat(ip)) return eroare(cx, 'Prea multe parole greșite. Încearcă peste 15 minute.', 429);
    const dat = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!dat || !(await egal(dat, String(env.TOKEN)))) { esec(ip); return eroare(cx, 'Cheie gresita', 401) }
    if (preaDes(ip)) return eroare(cx, 'Prea multe cereri. Mai încearcă peste un minut.', 429);

    const p = url.pathname;
    try {
      if (/\/proxy\//.test(p)) return await seif(cx, request, env, url);
      if (/\/push\//.test(p)) return await pushRuta(cx, request, env, url);
      if (/\/usage$/.test(p)) return await consum(cx, env);
      if (/\/health$/.test(p)) return json(cx, { v: VER, seif: { anthropic: !!env.ANTHROPIC_KEY, runware: !!env.RUNWARE_KEY }, origine: lista.length > 0, kv: !!env.KV, ai: !!env.AI });
      if (/\/images\/(generations|edits)$/.test(p)) return await poze(cx, request, env);
    } catch (e) {
      return eroare(cx, 'Eroare internă: ' + (e && e.message ? String(e.message).slice(0, 200) : 'necunoscută'), 500);
    }
    return eroare(cx, 'Ruta necunoscuta', 404);
  }
};
