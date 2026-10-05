import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
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

app.disable('x-powered-by');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGIN.includes('*') || ALLOWED_ORIGIN.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '2mb' }));

const indexFile = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (_req, res) => res.sendFile(indexFile));

const rooms = new Map();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MOBI-SERVER', version: 2, mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN), rooms: rooms.size, uptime: Math.round(process.uptime()) });
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

app.listen(PORT, () => console.log(`MOBI-SERVER v2 escuchando en el puerto ${PORT}`));
