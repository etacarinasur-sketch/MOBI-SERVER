import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* =====================================================================
   MOBI-SERVER v2 · multidispositivo
   - Sirve la app (index.html) y la API desde el mismo servicio (Render).
   - /api/bus*      : puente en tiempo real entre dispositivos (chat, GPS, viajes, registro…)
   - /api/trip/*    : adjudicación atómica de viajes (el primer conductor que lo toma se lo queda)
   - /api/mercadopago/* : cobro con tarjeta (reserva → captura/cancelación) con Checkout API Orders
   - /api/gps/*     : compatibilidad con la versión anterior
   Estado en MEMORIA (prototipo): se pierde si Render reinicia o duerme el servicio.
   ===================================================================== */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || 'APP_USR-0f4197ef-84a2-4347-bd3a-967479635d78';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const MP_MIN = Number(process.env.MP_MIN_AMOUNT || 100);
const MP_MAX = Number(process.env.MP_MAX_AMOUNT || 300000);
/* Administración (clave en variable de entorno, nunca dentro de la página) */
const ADMIN_KEY = process.env.ADMIN_KEY || '';
/* WhatsApp Business Platform (Cloud API) · verificación de teléfono */
const WA_NUMBER = String(process.env.WA_NUMBER || '').replace(/\D/g, '');       // número de MOBI, solo dígitos con país (ej. 5491155551234)
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';                        // el que cargás en Meta al configurar el webhook
const WA_APP_SECRET = process.env.WA_APP_SECRET || '';                            // (opcional) valida que el mensaje venga de Meta
const WA_TOKEN = process.env.WA_TOKEN || '';                                      // (opcional) para responder "verificado"
const WA_PHONE_ID = process.env.WA_PHONE_ID || '';

app.disable('x-powered-by');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGIN.includes('*') || ALLOWED_ORIGIN.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  }
}));
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { if (req.url && req.url.startsWith('/api/wa/webhook')) req.rawBody = buf; } }));

const indexFile = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (_req, res) => {
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.type('text/plain').send('MOBI-SERVER OK · la app (index.html) está en otro repositorio. Probá /health');
});

const rooms = new Map();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MOBI-SERVER', version: 3, mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN), adminConfigured: Boolean(ADMIN_KEY), whatsappConfigured: Boolean(WA_NUMBER), rooms: rooms.size, uptime: Math.round(process.uptime()) });
});
app.get('/api/config', (_req, res) => {
  res.json({ ok: true, mpPublicKey: MP_PUBLIC_KEY, mpEnabled: Boolean(MP_ACCESS_TOKEN), serverTime: Date.now() });
});

/* ---------------- BUS multidispositivo ---------------- */
const RING_MAX = 3000;
const FRESH_MS = 120_000;
const ROOM_TTL = 24 * 3600_000;

function getRoom(name) {
  const key = String(name || 'pilot').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'pilot';
  let r = rooms.get(key);
  if (!r) { r = { name: key, seq: 0, ring: [], sticky: new Map(), claims: new Map(), touched: Date.now() }; rooms.set(key, r); }
  r.touched = Date.now();
  return r;
}

function pushMessage(room, m) {
  if (!m || typeof m.type !== 'string' || !m.type || m.type.length > 40) return null;
  const msg = {
    id: ++room.seq,
    type: m.type,
    src: String(m.src || '').slice(0, 40),
    key: m.key ? String(m.key).slice(0, 120) : null,
    ts: Number.isFinite(Number(m.ts)) ? Number(m.ts) : Date.now(),
    at: Date.now(),
    data: m.data === undefined ? null : m.data
  };
  room.ring.push(msg);
  if (room.ring.length > RING_MAX) room.ring.splice(0, room.ring.length - RING_MAX);
  if (msg.key) room.sticky.set(msg.type + '|' + msg.key, msg);
  return msg;
}

app.post('/api/bus/batch', (req, res) => {
  const { room, messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages must be an array' });
  const r = getRoom(room);
  let last = r.seq;
  for (const m of messages.slice(0, 100)) {
    if (m && m.type === 'trip' && m.data && m.data.active) {
      const a = m.data.active, k = a.tripKey, claim = k ? r.claims.get(k) : null;
      const drvId = a.driver && a.driver.id;
      if (claim && drvId && drvId !== claim.driverId && !/Esperando|Buscando/i.test(String(a.status || ''))) continue;
    }
    const saved = pushMessage(r, m);
    if (saved) last = saved.id;
  }
  res.json({ ok: true, last });
});

app.post('/api/bus', (req, res) => {
  const { room, ...m } = req.body || {};
  const saved = pushMessage(getRoom(room), m);
  if (!saved) return res.status(400).json({ ok: false, error: 'invalid message' });
  res.json({ ok: true, id: saved.id });
});

app.get('/api/bus', (req, res) => {
  const r = getRoom(req.query.room);
  const after = Number(req.query.after) || 0;
  const me = String(req.query.src || '');
  let messages;
  if (after <= 0) {
    const stickyList = [...r.sticky.values()];
    const stickyIds = new Set(stickyList.map(x => x.id));
    const recent = r.ring.filter(x => !stickyIds.has(x.id) && Date.now() - x.at < FRESH_MS);
    messages = [...stickyList, ...recent].sort((a, b) => a.id - b.id);
  } else {
    messages = r.ring.filter(x => x.id > after);
  }
  messages = messages.filter(x => !me || x.src !== me).slice(-400);
  res.json({ ok: true, messages, last: r.seq });
});

/* ------------- adjudicación atómica de viajes ------------- */
app.post('/api/trip/claim', (req, res) => {
  const { room, tripKey, driverId } = req.body || {};
  if (!tripKey || !driverId) return res.status(400).json({ ok: false, error: 'tripKey and driverId are required' });
  const r = getRoom(room);
  const cur = r.claims.get(String(tripKey));
  if (cur && cur.driverId !== String(driverId)) return res.json({ ok: false, winner: cur.driverId });
  r.claims.set(String(tripKey), { driverId: String(driverId), at: Date.now() });
  res.json({ ok: true, winner: String(driverId) });
});
app.post('/api/trip/release', (req, res) => {
  const { room, tripKey, driverId } = req.body || {};
  const r = getRoom(room);
  const cur = r.claims.get(String(tripKey));
  if (cur && (!driverId || cur.driverId === String(driverId))) r.claims.delete(String(tripKey));
  res.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) {
    if (now - r.touched > ROOM_TTL) { rooms.delete(k); continue; }
    for (const [ck, c] of r.claims) if (now - c.at > 6 * 3600_000) r.claims.delete(ck);
  }
}, 10 * 60_000).unref();

/* ------------- GPS (compatibilidad) ------------- */
const gps = new Map();
const GPS_TTL = 10 * 60_000;
app.post('/api/gps/update', (req, res) => {
  const { driverId, passengerId, lat, lng, accuracy, heading, speed, timestamp } = req.body || {};
  const ownerId = driverId || passengerId;
  if (!ownerId || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return res.status(400).json({ ok: false, error: 'driverId/passengerId, lat and lng are required' });
  }
  if (gps.size > 5000) gps.clear();
  const position = {
    lat: Number(lat), lng: Number(lng),
    accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
    heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
    speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
    timestamp: timestamp || new Date().toISOString(), at: Date.now()
  };
  gps.set(String(ownerId), position);
  res.json({ ok: true, id: String(ownerId), position });
});
app.get('/api/gps/:id', (req, res) => {
  const position = gps.get(String(req.params.id));
  if (!position || Date.now() - position.at > GPS_TTL) return res.status(404).json({ ok: false, error: 'Position not found' });
  res.json({ ok: true, id: String(req.params.id), position });
});

/* ------------- Mercado Pago · Checkout API Orders (tarjeta) -------------
   Pago al pedir el viaje: crédito = reserva (capture_mode manual) → /capture al finalizar,
   /cancel si se cancela. Débito se cobra en el momento. Access Token solo en el servidor. */
const MP_API = 'https://api.mercadopago.com';
const mpHeaders = (idem) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
  'X-Idempotency-Key': idem || crypto.randomUUID()
});
const needMp = (res) => {
  if (MP_ACCESS_TOKEN) return false;
  res.status(503).json({ ok: false, error: 'MP_ACCESS_TOKEN no está configurado en el servidor' });
  return true;
};
const cleanRef = (v) => String(v || `mobi_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
async function mpCall(method, url, body, idem) {
  const r = await fetch(MP_API + url, { method, headers: mpHeaders(idem), body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

app.post('/api/mercadopago/pay', async (req, res) => {
  if (needMp(res)) return;
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < MP_MIN || amount > MP_MAX) {
    return res.status(400).json({ ok: false, error: `amount debe estar entre ${MP_MIN} y ${MP_MAX}` });
  }
  const token = b.token, methodId = b.paymentMethodId;
  if (!token || !methodId) return res.status(400).json({ ok: false, error: 'token y paymentMethodId son obligatorios' });
  const isDebit = /^deb|maestro|debit/i.test(String(b.paymentTypeId || methodId));
  const type = b.paymentTypeId || (isDebit ? 'debit_card' : 'credit_card');
  const captureMode = type === 'credit_card' ? 'manual' : 'automatic';
  const reference = cleanRef(b.externalReference);
  const amountStr = amount.toFixed(2);
  const payer = { email: String((b.payer && b.payer.email) || b.payerEmail || 'test@testuser.com') };
  if (b.payer && b.payer.identification && b.payer.identification.number) {
    payer.identification = { type: String(b.payer.identification.type || 'DNI'), number: String(b.payer.identification.number) };
  }
  const payload = {
    type: 'online', processing_mode: 'automatic', capture_mode: captureMode,
    total_amount: amountStr, external_reference: reference, description: 'Viaje MOBI', payer,
    transactions: { payments: [{ amount: amountStr, payment_method: { id: String(methodId), type, token: String(token), installments: Number(b.installments) || 1 } }] }
  };
  try {
    const r = await mpCall('POST', '/v1/orders', payload, `pay_${reference}`);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Mercado Pago rechazó el cobro', details: r.data });
    const pay = (r.data.transactions && r.data.transactions.payments && r.data.transactions.payments[0]) || {};
    const bad = ['failed', 'rejected', 'canceled', 'cancelled', 'expired'];
    const authorized = !bad.includes(String(r.data.status)) && !bad.includes(String(pay.status));
    res.status(201).json({
      ok: true, authorized, captureMode, orderId: r.data.id, paymentId: pay.id || null,
      status: r.data.status, statusDetail: r.data.status_detail || pay.status_detail || null,
      paymentStatus: pay.status || null, totalAmount: r.data.total_amount
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: 'No se pudo contactar a Mercado Pago', details: error.message });
  }
});

app.post('/api/mercadopago/capture/:orderId', async (req, res) => {
  if (needMp(res)) return;
  try {
    const id = encodeURIComponent(req.params.orderId);
    const r = await mpCall('POST', `/v1/orders/${id}/capture`, null, `cap_${id}`);
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.data.status, statusDetail: r.data.status_detail, details: r.ok ? undefined : r.data });
  } catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

app.post('/api/mercadopago/cancel/:orderId', async (req, res) => {
  if (needMp(res)) return;
  const id = encodeURIComponent(req.params.orderId);
  try {
    let r = await mpCall('POST', `/v1/orders/${id}/cancel`, null, `can_${id}`);
    let how = 'cancel';
    if (!r.ok) { r = await mpCall('POST', `/v1/orders/${id}/refund`, null, `ref_${id}`); how = 'refund'; }
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, how, status: r.data.status, details: r.ok ? undefined : r.data });
  } catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

app.get('/api/mercadopago/order/:id', async (req, res) => {
  if (needMp(res)) return;
  try {
    const r = await mpCall('GET', `/v1/orders/${encodeURIComponent(req.params.id)}`);
    const d = r.data || {};
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, id: d.id, status: d.status, statusDetail: d.status_detail, totalAmount: d.total_amount, externalReference: d.external_reference });
  } catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

app.post('/api/mercadopago/webhook', (req, res) => {
  console.log('MP webhook', JSON.stringify({ q: req.query, type: req.body && req.body.type, action: req.body && req.body.action, id: req.body && req.body.data && req.body.data.id }));
  res.sendStatus(200);
});

app.post('/api/mercadopago/order', async (req, res) => {
  if (needMp(res)) return;
  const { amount, externalReference, payerEmail } = req.body || {};
  const n = Number(amount);
  if (!Number.isFinite(n) || n < MP_MIN || n > MP_MAX) return res.status(400).json({ ok: false, error: 'amount inválido' });
  const s = n.toFixed(2);
  try {
    const r = await mpCall('POST', '/v1/orders', {
      type: 'online', processing_mode: 'manual', total_amount: s, external_reference: cleanRef(externalReference),
      payer: { email: String(payerEmail || 'test@testuser.com') }, items: [{ title: 'Viaje MOBI', quantity: 1, unit_price: s }]
    });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Mercado Pago rechazó la orden', details: r.data });
    res.status(201).json({ ok: true, orderId: r.data.id, clientToken: r.data.client_token, status: r.data.status, totalAmount: r.data.total_amount });
  } catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

/* ---------------- administración: login con clave (en el servidor) ---------------- */
const adminTokens = new Map();   // token -> vencimiento
const adminFails = new Map();    // ip -> { n, until }
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'x', now = Date.now();
  const f = adminFails.get(ip) || { n: 0, until: 0 };
  if (f.until > now) return res.status(429).json({ ok: false, error: 'locked', retryInSec: Math.ceil((f.until - now) / 1000) });
  if (!ADMIN_KEY) return res.status(503).json({ ok: false, error: 'not_configured' });
  const key = String((req.body && req.body.key) || '');
  if (!key || !safeEq(key, ADMIN_KEY)) {
    f.n += 1; if (f.n >= 5) { f.until = now + 15 * 60_000; f.n = 0; }
    adminFails.set(ip, f);
    return res.status(401).json({ ok: false, error: 'bad_key' });
  }
  adminFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, now + 12 * 3600_000);
  res.json({ ok: true, token, expiresInSec: 12 * 3600 });
});
app.post('/api/admin/check', (req, res) => {
  const t = String((req.body && req.body.token) || ''), exp = adminTokens.get(t);
  if (exp && exp > Date.now()) return res.json({ ok: true });
  adminTokens.delete(t); res.status(401).json({ ok: false });
});

/* ---------------- verificación de teléfono por WhatsApp ----------------
   1) La app pide un código (POST /api/wa/start) y abre un chat de WhatsApp con el número de MOBI y el código escrito.
   2) El usuario lo envía; Meta avisa a este servidor (POST /api/wa/webhook).
   3) Si el código y el teléfono coinciden, queda verificado (GET /api/wa/status). */
const waPending = new Map();    // code -> { userId, tail, at }
const waVerified = new Map();   // userId -> { tail, at }
const tail8 = (v) => String(v || '').replace(/\D/g, '').slice(-8);
setInterval(() => { const now = Date.now(); for (const [c, v] of waPending) if (now - v.at > 30 * 60_000) waPending.delete(c); }, 5 * 60_000).unref();

app.post('/api/wa/start', (req, res) => {
  const b = req.body || {};
  const userId = String(b.userId || '').slice(0, 60), tail = tail8(b.phone);
  if (!userId || tail.length < 8) return res.status(400).json({ ok: false, error: 'userId y teléfono válidos son obligatorios' });
  for (const [c, v] of waPending) if (v.userId === userId) waPending.delete(c);
  let code; do { code = 'MOBI-' + String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); } while (waPending.has(code));
  waPending.set(code, { userId, tail, at: Date.now() });
  const text = `Hola MOBI, mi código de verificación es ${code}`;
  res.json({ ok: true, code, configured: Boolean(WA_NUMBER), waNumber: WA_NUMBER || null,
    link: WA_NUMBER ? `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}` : null });
});
app.get('/api/wa/status', (req, res) => {
  const v = waVerified.get(String(req.query.userId || ''));
  res.json({ ok: true, verified: Boolean(v), at: v ? v.at : null });
});
app.get('/api/wa/webhook', (req, res) => {
  if (WA_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
async function waReply(to, body) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
    });
  } catch (e) { console.warn('WA reply', e.message); }
}
app.post('/api/wa/webhook', (req, res) => {
  if (WA_APP_SECRET) {
    const sig = String(req.get('x-hub-signature-256') || '').replace('sha256=', '');
    const mac = crypto.createHmac('sha256', WA_APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
    let ok = false; try { ok = sig.length === mac.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); } catch (e) {}
    if (!ok) return res.sendStatus(403);
  }
  res.sendStatus(200);                                                    // Meta exige responder rápido
  try {
    for (const en of (req.body && req.body.entry) || []) for (const ch of en.changes || []) {
      for (const m of (ch.value && ch.value.messages) || []) {
        const text = String((m.text && m.text.body) || '');
        const mm = text.match(/MOBI[-\s]?(\d{6})/i); if (!mm) continue;
        const code = 'MOBI-' + mm[1], p = waPending.get(code);
        if (!p) { waReply(m.from, 'Ese código venció o no existe. Pedí uno nuevo desde la app de MOBI.'); continue; }
        if (tail8(m.from) !== p.tail) { waReply(m.from, 'Este número no coincide con el que cargaste en MOBI.'); continue; }
        waPending.delete(code); waVerified.set(p.userId, { tail: p.tail, at: Date.now() });
        waReply(m.from, '✅ Número verificado. Ya podés volver a MOBI.');
      }
    }
  } catch (e) { console.warn('WA webhook', e.message); }
});

app.listen(PORT, () => console.log(`MOBI-SERVER v3 escuchando en el puerto ${PORT}`));
