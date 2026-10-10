import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* =====================================================================
   MOBI-SERVER v5 · multidispositivo
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
let WA_PHONE_ID = process.env.WA_PHONE_ID || '';                                  // si falta, se busca solo con WA_WABA_ID

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

/* ---------------- BASE DE DATOS (Neon / Postgres) ----------------
   Si existe la variable DATABASE_URL, todo lo importante se guarda en la base:
   mensajes "fijos" del bus (registros de pasajeros y conductores, pagos y retiros, estado de viajes)
   y las verificaciones de WhatsApp. Si no hay base, el servidor sigue funcionando en memoria. */
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()
  .replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');   // Neon agrega channel_binding: node-postgres no lo necesita
let db = null, dbState = DATABASE_URL ? 'starting' : 'off', dbError = '';
const dirty = new Map();
let flushing = false;
async function dbInit() {
  if (!DATABASE_URL) return;
  try {
    const mod = await import('pg');
    const pg = mod.default || mod;
    db = new pg.Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 20_000 });
    db.on('error', (e) => { dbError = e.message; });
    await db.query(`CREATE TABLE IF NOT EXISTS mobi_sticky (room text NOT NULL, k text NOT NULL, msg jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (room, k))`);
    await db.query(`CREATE TABLE IF NOT EXISTS mobi_kv (ns text NOT NULL, id text NOT NULL, data jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ns, id))`);
    await db.query(`DELETE FROM mobi_sticky WHERE (k LIKE 'trip%' AND at < now() - interval '3 days') OR k LIKE 'pax-pos%' OR k LIKE 'driver-pos%' OR k LIKE 'approach-route%'`);
    const r = await db.query('SELECT room, k, msg FROM mobi_sticky');
    for (const row of r.rows) {
      const room = getRoom(row.room), msg = row.msg;
      room.sticky.set(row.k, msg);
      if (Number(msg.id) > room.seq) room.seq = Number(msg.id);
    }
    const w = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'wa'`);
    for (const row of w.rows) waVerified.set(row.id, row.data);
    dbState = 'on';
    console.log(`Base de datos conectada: ${r.rows.length} registros, ${w.rows.length} verificaciones`);
  } catch (e) {
    dbState = 'error'; dbError = e.message; db = null;
    console.warn('No se pudo conectar la base de datos (sigo en memoria):', e.message);
  }
}
/* qué se guarda: solo lo que importa conservar. Las ubicaciones GPS cambian todo el tiempo y quedan en memoria
   (así la base "duerme" cuando no hay actividad y no se gastan las horas gratis). El viaje en curso se guarda cada 20 s. */
const DURABLE = new Set(['pax-reg', 'driver-reg', 'debt-charge', 'debt-pay', 'rating', 'report', 'trip-end', 'trip-done', 'acct-susp', 'pax-chg', 'cfg-price']);
const dirtySlow = new Map();
function persistSticky(roomName, k, msg) {
  if (!db) return;
  const item = { room: roomName, k, msg }, key = roomName + '\u0001' + k;
  if (DURABLE.has(msg.type)) dirty.set(key, item);
  else if (msg.type === 'trip') dirtySlow.set(key, item);
}
setInterval(() => { for (const [k, v] of dirtySlow) dirty.set(k, v); dirtySlow.clear(); }, 20_000).unref();
async function flushSticky() {
  if (!db || flushing || !dirty.size) return;
  flushing = true;
  const items = [...dirty.values()]; dirty.clear();
  try {
    for (let i = 0; i < items.length; i += 40) {
      const chunk = items.slice(i, i + 40), vals = [], args = [];
      chunk.forEach((it, j) => { vals.push(`($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::jsonb, now())`); args.push(it.room, it.k, JSON.stringify(it.msg)); });
      await db.query(`INSERT INTO mobi_sticky (room, k, msg, at) VALUES ${vals.join(',')} ON CONFLICT (room, k) DO UPDATE SET msg = EXCLUDED.msg, at = now()`, args);
    }
    dbError = '';
  } catch (e) {
    dbError = e.message;
    for (const it of items) { const key = it.room + '\u0001' + it.k; if (!dirty.has(key)) dirty.set(key, it); }
    console.warn('Error guardando en la base:', e.message);
  }
  flushing = false;
}
setInterval(flushSticky, 1000).unref();
async function kvSet(ns, id, data) {
  if (!db) return;
  try { await db.query(`INSERT INTO mobi_kv (ns, id, data, at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (ns, id) DO UPDATE SET data = EXCLUDED.data, at = now()`, [ns, String(id), JSON.stringify(data)]); }
  catch (e) { dbError = e.message; console.warn('kv', e.message); }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MOBI-SERVER', version: 5, database: dbState, databaseError: dbState === 'on' ? undefined : (dbError || undefined), mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN), adminConfigured: Boolean(ADMIN_KEY), whatsappConfigured: Boolean(WA_NUMBER), rooms: rooms.size, uptime: Math.round(process.uptime()) });
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
  if (msg.key) { room.sticky.set(msg.type + '|' + msg.key, msg); persistSticky(room.name, msg.type + '|' + msg.key, msg); }
  return msg;
}

/* V362 · una persona puede ser pasajero Y conductor, pero no registrarse dos veces en el mismo rol
   (mismo celular, o mismo DNI en pasajeros). Los registros rechazados no cuentan. */
function findDupReg(room, type, d) {
  if (!d || typeof d !== 'object') return null;
  const t = tail8(d.phone), dni = String(d.dni || '').replace(/\D/g, '');
  for (const m of room.sticky.values()) {
    if (!m || m.type !== type) continue;
    const o = m.data; if (!o || typeof o !== 'object' || o.id === d.id || o.hiddenAt || o.deletedAt) continue;
    if (type === 'driver-reg' && !(o.status === 'pendiente' || o.status === 'aprobado')) continue;
    const same = (t.length >= 8 && tail8(o.phone) === t) || (type === 'pax-reg' && dni.length >= 6 && String(o.dni || '').replace(/\D/g, '') === dni);
    if (same) return o;
  }
  return null;
}
function regBlocked(room, m) {
  if (!m || !m.data) return false;
  if (m.type === 'driver-reg' && m.data.status === 'pendiente') return !!findDupReg(room, 'driver-reg', m.data);
  if (m.type === 'pax-reg' && !room.sticky.has('pax-reg|' + (m.key || ''))) return !!findDupReg(room, 'pax-reg', m.data);
  return false;
}
app.post('/api/reg/check', (req, res) => {
  const b = req.body || {}, role = b.role === 'drv' ? 'driver-reg' : 'pax-reg';
  const o = findDupReg(getRoom(b.room), role, { id: String(b.id || ''), phone: b.phone, dni: b.dni });
  res.json({ ok: true, dup: !!o, status: o ? String(o.status || 'aprobado') : '' });
});

app.post('/api/bus/batch', (req, res) => {
  const { room, messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages must be an array' });
  const r = getRoom(room);
  let last = r.seq;
  for (const m of messages.slice(0, 100)) {
    if (m && (m.type === 'acct-susp' || m.type === 'cfg-price')) continue;   // solo el administrador (endpoint propio)
    if (regBlocked(r, m)) continue;               // registro doble en el mismo rol
    if (m && m.type === 'pax-chg' && !(m.data && (m.data.status === 'pendiente' || m.data.status === 'cancelado'))) continue;
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
  if (m && (m.type === 'acct-susp' || m.type === 'cfg-price' || (m.type === 'pax-chg' && !(m.data && (m.data.status === 'pendiente' || m.data.status === 'cancelado'))))) return res.status(403).json({ ok: false, error: 'admin' });
  if (regBlocked(getRoom(room), m)) return res.status(409).json({ ok: false, error: 'dup_reg' });
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
const MP_API = process.env.MP_API_BASE || 'https://api.mercadopago.com';
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

/* V358 · motivo del rechazo en palabras simples (y queda en el registro de Render) */
const MP_REASONS = {
  cc_rejected_high_risk: 'Mercado Pago lo frenó por seguridad (riesgo alto). Suele pasar con cuentas nuevas o si quien paga es la misma cuenta que cobra.',
  cc_rejected_other_reason: 'El banco rechazó la tarjeta sin dar el motivo.',
  cc_rejected_insufficient_amount: 'La tarjeta no tiene saldo o límite suficiente.',
  cc_rejected_bad_filled_security_code: 'El código de seguridad es incorrecto.',
  cc_rejected_bad_filled_date: 'La fecha de vencimiento es incorrecta.',
  cc_rejected_bad_filled_other: 'Algún dato de la tarjeta está mal cargado.',
  cc_rejected_bad_filled_card_number: 'El número de tarjeta es incorrecto.',
  cc_rejected_call_for_authorize: 'El banco pide autorizar el pago: llamá al banco o usá otra tarjeta.',
  cc_rejected_card_disabled: 'La tarjeta no está habilitada para compras online. Activala desde el banco.',
  cc_rejected_blacklist: 'La tarjeta no puede usarse en Mercado Pago.',
  cc_rejected_duplicated_payment: 'Ya hiciste un pago igual hace un momento.',
  cc_rejected_max_attempts: 'Llegaste al máximo de intentos. Probá más tarde u otra tarjeta.',
  cc_rejected_card_type_not_allowed: 'Este tipo de tarjeta no se acepta.',
  insufficient_amount: 'La tarjeta no tiene saldo o límite suficiente.',
  high_risk: 'Mercado Pago lo frenó por seguridad (riesgo alto).'
};
function mpReason(data) {
  const txt = JSON.stringify(data || {});
  const m = txt.match(/cc_rejected_[a-z_]+|insufficient_amount|high_risk/);
  let r = m ? (MP_REASONS[m[0]] || m[0]) : '';
  if (!r && /payer.*collector|collector.*payer|same user|mismo usuario/i.test(txt)) r = 'Quien paga no puede ser la misma cuenta de Mercado Pago que cobra.';
  if (!r && /invalid.*token|card_token/i.test(txt)) r = 'Los datos de la tarjeta vencieron: volvé a cargarla.';
  if (/^TEST-/.test(MP_ACCESS_TOKEN || '')) r = (r ? r + ' ' : '') + '(El servidor usa credenciales DE PRUEBA: solo funcionan las tarjetas de prueba de Mercado Pago.)';
  return r || 'Mercado Pago rechazó el cobro.';
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
  const payer = b.customerId ? { customer_id: String(b.customerId) } : { email: String((b.payer && b.payer.email) || b.payerEmail || 'test@testuser.com') };
  if (!b.customerId && b.payer && b.payer.identification && b.payer.identification.number) {
    payer.identification = { type: String(b.payer.identification.type || 'DNI'), number: String(b.payer.identification.number) };
  }
  const payload = {
    type: 'online', processing_mode: 'automatic', capture_mode: captureMode,
    total_amount: amountStr, external_reference: reference, description: 'Viaje MOBI', payer,
    transactions: { payments: [{ amount: amountStr, payment_method: { id: String(methodId), type, token: String(token), installments: Number(b.installments) || 1 } }] }
  };
  try {
    const r = await mpCall('POST', '/v1/orders', payload, `pay_${reference}`);
    if (!r.ok) { console.log('MP pago RECHAZADO', r.status, JSON.stringify(r.data).slice(0, 800)); return res.status(r.status).json({ ok: false, error: 'Mercado Pago rechazó el cobro', reason: mpReason(r.data), details: r.data }); }
    const pay = (r.data.transactions && r.data.transactions.payments && r.data.transactions.payments[0]) || {};
    const bad = ['failed', 'rejected', 'canceled', 'cancelled', 'expired'];
    const authorized = !bad.includes(String(r.data.status)) && !bad.includes(String(pay.status));
    if (!authorized) console.log('MP pago no autorizado', r.data.status, r.data.status_detail || pay.status_detail, JSON.stringify(pay).slice(0, 500));
    res.status(201).json({
      ok: true, authorized, captureMode, reason: authorized ? undefined : mpReason({ a: r.data.status_detail, b: pay.status_detail, c: pay }), orderId: r.data.id, paymentId: pay.id || null,
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

/* ---------------- tarjetas guardadas (Mercado Pago Customers) ----------------
   El número de tarjeta nunca pasa por MOBI: la app lo tokeniza con Mercado Pago y acá solo se guarda el token
   en el "customer" del pasajero. Cada customer queda atado al DNI del perfil (description = mobi:dni:<DNI>). */
const dniOf = (v) => String(v || '').replace(/\D/g, '').slice(0, 9);
const okEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
async function findCustomer(email) {
  const r = await mpCall('GET', `/v1/customers/search?email=${encodeURIComponent(email)}`);
  const c = r.ok && r.data && Array.isArray(r.data.results) ? r.data.results[0] : null;
  return c || null;
}
const cardView = (c) => ({
  id: c.id, last4: c.last_four_digits, firstSix: c.first_six_digits,
  brand: (c.payment_method && (c.payment_method.name || c.payment_method.id)) || 'Tarjeta',
  methodId: c.payment_method && c.payment_method.id, typeId: c.payment_method && c.payment_method.payment_type_id,
  thumb: c.payment_method && (c.payment_method.secure_thumbnail || c.payment_method.thumbnail),
  exp: c.expiration_month && c.expiration_year ? `${String(c.expiration_month).padStart(2, '0')}/${String(c.expiration_year).slice(-2)}` : '',
  holder: c.cardholder && c.cardholder.name
});
function cardsGuard(req, res) {
  if (needMp(res)) return null;
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), dni = dniOf(b.dni);
  if (!okEmail(email)) { res.status(400).json({ ok: false, error: 'email_required' }); return null; }
  if (dni.length < 6) { res.status(400).json({ ok: false, error: 'dni_required' }); return null; }
  return { b, email, dni };
}
const ownedBy = (c, dni) => !c.description || c.description === `mobi:dni:${dni}`;

app.post('/api/mp/cards', async (req, res) => {
  const g = cardsGuard(req, res); if (!g) return;
  try {
    const c = await findCustomer(g.email);
    if (!c) return res.json({ ok: true, customerId: null, cards: [] });
    if (!ownedBy(c, g.dni)) return res.status(403).json({ ok: false, error: 'not_owner' });
    const r = await mpCall('GET', `/v1/customers/${encodeURIComponent(c.id)}/cards`);
    res.json({ ok: true, customerId: c.id, cards: (r.ok && Array.isArray(r.data) ? r.data : []).map(cardView) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/mp/cards/add', async (req, res) => {
  const g = cardsGuard(req, res); if (!g) return;
  if (!g.b.token) return res.status(400).json({ ok: false, error: 'token_required' });
  try {
    let c = await findCustomer(g.email);
    if (c && !ownedBy(c, g.dni)) return res.status(403).json({ ok: false, error: 'not_owner' });
    if (!c) {
      const full = String(g.b.name || '').trim().split(/\s+/);
      const r = await mpCall('POST', '/v1/customers', { email: g.email, first_name: full[0] || undefined, last_name: full.slice(1).join(' ') || undefined,
        identification: { type: 'DNI', number: g.dni }, description: `mobi:dni:${g.dni}` });
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'customer_failed', details: r.data });
      c = r.data;
    }
    const r2 = await mpCall('POST', `/v1/customers/${encodeURIComponent(c.id)}/cards`, { token: String(g.b.token) });
    if (!r2.ok) return res.status(r2.status).json({ ok: false, error: 'card_failed', details: r2.data });
    res.status(201).json({ ok: true, customerId: c.id, card: cardView(r2.data) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/mp/cards/remove', async (req, res) => {
  const g = cardsGuard(req, res); if (!g) return;
  try {
    const c = await findCustomer(g.email);
    if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!ownedBy(c, g.dni)) return res.status(403).json({ ok: false, error: 'not_owner' });
    const r = await mpCall('DELETE', `/v1/customers/${encodeURIComponent(c.id)}/cards/${encodeURIComponent(String(g.b.cardId || ''))}`);
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

/* ---------------- verificación de teléfono por WhatsApp ----------------
   1) La app pide un código (POST /api/wa/start) y abre un chat de WhatsApp con el número de MOBI y el código escrito.
   2) El usuario lo envía; Meta avisa a este servidor (POST /api/wa/webhook).
   3) Si el código y el teléfono coinciden, queda verificado (GET /api/wa/status). */
const waPending = new Map();    // code -> { userId, tail, at }
const waVerified = new Map();   // userId -> { tail, at }
const tail8 = (v) => String(v || '').replace(/\D/g, '').slice(-8);
setInterval(() => { const now = Date.now(); for (const [c, v] of waPending) if (now - v.at > 30 * 60_000) waPending.delete(c); }, 5 * 60_000).unref();

/* Número de prueba de Meta (+1 555…): WhatsApp no deja que el usuario escriba primero.
   En ese caso MOBI le manda antes la plantilla de prueba "hello_world" para abrir el chat. */
const WA_IS_TEST = WA_NUMBER.startsWith('1555');
function waE164AR(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9')) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, (m, a, n) => (a + n).length === 10 ? a + n : m);   // 011 15 xxxx → sin el 15
  return d.length === 10 ? '549' + d : null;
}
const WA_PIN = String(process.env.WA_PIN || '246810').replace(/\D/g, '').slice(0, 6).padEnd(6, '0');
let waRegisterTried = 0;
async function waRegister() {                                   // error 133010: el número de MOBI no está registrado → registrarlo
  if (!WA_TOKEN || !WA_PHONE_ID || Date.now() - waRegisterTried < 60_000) return false;
  waRegisterTried = Date.now();
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/register`, {
      method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: WA_PIN })
    });
    const t = (await r.text()).slice(0, 300);
    console.log('WA register', r.status, t);
    if (r.ok) await waSubscribe();
    return r.ok;
  } catch (e) { console.warn('WA register', e.message); return false; }
}
const WA_WABA_ID = String(process.env.WA_WABA_ID || (WA_PHONE_ID === '1459329300586126' ? '2099638707344052' : '')).replace(/\D/g, '');
async function waSubscribe() {                                  // conecta la cuenta de WhatsApp de MOBI con la app (si no, Meta no avisa los mensajes)
  if (!WA_TOKEN || !WA_WABA_ID) return;
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_WABA_ID}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    console.log('WA subscribe', r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.warn('WA subscribe', e.message); }
}
/* V361 · número REAL de MOBI: al arrancar se busca su ID (si no está cargado), se registra en la nube (una sola vez) y se conecta a la app */
async function waGraph(path, opts) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${path}`, Object.assign({ headers: { Authorization: `Bearer ${WA_TOKEN}` } }, opts || {}));
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}
async function waAutoSetup() {
  if (!WA_TOKEN) return;
  try {
    if (!WA_PHONE_ID && WA_WABA_ID) {
      const r = await waGraph(`${WA_WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type`);
      const list = (r.j && r.j.data) || [];
      const mine = list.find(x => tail8(x.display_phone_number) === tail8(WA_NUMBER)) || list[0];
      if (mine) { WA_PHONE_ID = String(mine.id); console.log('WA número encontrado:', mine.display_phone_number, mine.verified_name, 'ID', WA_PHONE_ID); }
      else console.log('WA: no encontré números en la cuenta', WA_WABA_ID, r.status, JSON.stringify(r.j).slice(0, 200));
    }
    if (WA_PHONE_ID && !WA_IS_TEST) {
      const st = await waGraph(`${WA_PHONE_ID}?fields=display_phone_number,verified_name,name_status,status,platform_type`);
      console.log('WA estado del número', st.status, JSON.stringify(st.j).slice(0, 300));
      if (st.ok && String(st.j.platform_type || '').toUpperCase() !== 'CLOUD_API') await waRegister();
    }
  } catch (e) { console.warn('WA autosetup', e.message); }
  await waSubscribe();
}
setTimeout(waAutoSetup, 5000);
async function waOpenTestChat(phone, again) {
  const e = waE164AR(phone);
  if (!WA_IS_TEST || !WA_TOKEN || !WA_PHONE_ID || !e) return;
  const d = e.slice(3);                                   // 10 dígitos: característica + número
  /* Meta guarda los celulares argentinos de formas distintas (con 9, o con 15): se prueban todas */
  const cands = [e, '54' + d, '54' + d.slice(0, 2) + '15' + d.slice(2), '54' + d.slice(0, 3) + '15' + d.slice(3), '54' + d.slice(0, 4) + '15' + d.slice(4)];
  for (const to of [...new Set(cands)]) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } })
      });
      const t = (await r.text()).slice(0, 300);
      console.log('WA hello_world', to, r.status, t);
      if (r.ok) return;
      if (/133010/.test(t)) { if (!again && await waRegister()) return waOpenTestChat(phone, true); return; }
      if (r.status === 401 || /OAuth|access token/i.test(t)) return;   // token vencido o inválido: no tiene sentido seguir
    } catch (err) { console.warn('WA hello_world', to, err.message); return; }
  }
}
app.post('/api/wa/start', async (req, res) => {
  const b = req.body || {};
  const userId = String(b.userId || '').slice(0, 60), tail = tail8(b.phone);
  if (!userId || tail.length < 8) return res.status(400).json({ ok: false, error: 'userId y teléfono válidos son obligatorios' });
  for (const [c, v] of waPending) if (v.userId === userId) waPending.delete(c);
  let code; do { code = 'MOBI-' + String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); } while (waPending.has(code));
  waPending.set(code, { userId, tail, at: Date.now() });
  const text = `Hola MOBI, mi código de verificación es ${code}`;
  await Promise.race([waOpenTestChat(b.phone), new Promise((r) => setTimeout(r, 12000))]);
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
  const d = String(to || '').replace(/\D/g, '');
  const cands = [d];
  if (/^549\d{10}$/.test(d)) { const n = d.slice(3); cands.push('54' + n, '54' + n.slice(0, 2) + '15' + n.slice(2), '54' + n.slice(0, 3) + '15' + n.slice(3), '54' + n.slice(0, 4) + '15' + n.slice(4)); }
  for (const t of [...new Set(cands)]) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: t, type: 'text', text: { body } })
      });
      const x = (await r.text()).slice(0, 200);
      console.log('WA reply', t, r.status, r.ok ? '' : x);
      if (/133010/.test(x) && !waReply.__reg) { waReply.__reg = 1; if (await waRegister()) return waReply(to, body); }
      if (r.ok || !/131030|recipient/i.test(x)) return;      // solo se reintenta si el problema es el formato del número
    } catch (e) { console.warn('WA reply', e.message); return; }
  }
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
    const n = ((req.body && req.body.entry) || []).reduce((a, en) => a + (en.changes || []).reduce((b, ch) => b + ((ch.value && ch.value.messages) || []).length, 0), 0);
    console.log('WA webhook recibido · mensajes:', n);
    for (const en of (req.body && req.body.entry) || []) for (const ch of en.changes || []) {
      for (const m of (ch.value && ch.value.messages) || []) {
        const text = String((m.text && m.text.body) || '');
        const mm = text.match(/MOBI[-\s]?(\d{6})/i); if (!mm) continue;
        const code = 'MOBI-' + mm[1], p = waPending.get(code);
        console.log('WA código', code, p ? 'encontrado' : 'NO encontrado', '· desde …' + tail8(m.from).slice(-4));
        if (!p) { waReply(m.from, 'Ese código venció o no existe. Pedí uno nuevo desde la app de MOBI.'); continue; }
        if (tail8(m.from) !== p.tail) { waReply(m.from, 'Este número no coincide con el que cargaste en MOBI.'); continue; }
        waPending.delete(code); waVerified.set(p.userId, { tail: p.tail, at: Date.now() }); kvSet('wa', p.userId, { tail: p.tail, at: Date.now() });
        waReply(m.from, '✅ Número verificado. Ya podés volver a MOBI.');
      }
    }
  } catch (e) { console.warn('WA webhook', e.message); }
});


/* ---------------- fotos de documentos (conductores y vehículos) ----------------
   El conductor sube cada foto una vez al enviar a evaluación. Solo el administrador (con su token) puede verlas,
   y el propio dueño cuando recupera su cuenta con WhatsApp. */
const DOC_KINDS = new Set(['cedula', 'license', 'dniF', 'dniB', 'profile', 'proof']);
const docMem = new Map();                                        // owner|kind -> { img, at }  (respaldo si no hay base)
const okOwner = (o) => /^(drv_[a-z0-9]{3,20}|car:drv_[a-z0-9]{3,20}:[A-Z0-9]{5,8}|trip_[A-Za-z0-9]{6,30})$/.test(String(o || ''));
app.post('/api/docs/put', async (req, res) => {
  const b = req.body || {}, owner = String(b.owner || ''), kind = String(b.kind || ''), img = String(b.img || '');
  if (!okOwner(owner) || !DOC_KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'bad_owner_or_kind' });
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 1_600_000) return res.status(400).json({ ok: false, error: 'bad_image' });
  const id = owner + '|' + kind, item = { img, at: Date.now() };
  docMem.set(id, item); if (docMem.size > 400) docMem.delete(docMem.keys().next().value);
  await kvSet('doc', id, item);
  res.json({ ok: true });
});
async function docsOf(owner) {
  const out = {};
  if (db) {
    try { const r = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'doc' AND id LIKE $1`, [owner + '|%']); for (const row of r.rows) out[row.id.split('|')[1]] = row.data.img; }
    catch (e) { console.warn('docs', e.message); }
  }
  for (const [id, v] of docMem) if (id.startsWith(owner + '|') && !out[id.split('|')[1]]) out[id.split('|')[1]] = v.img;
  return out;
}
function adminOk(t) { const exp = adminTokens.get(String(t || '')); return !!(exp && exp > Date.now()); }

/* V352 · aprobar / rechazar cambios de datos de un pasajero · solo administrador */
app.post('/api/admin/paxchg', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const id = String(b.id || ''), status = b.status === 'aprobado' ? 'aprobado' : b.status === 'rechazado' ? 'rechazado' : '';
  if (!/^pax_[a-z0-9]{3,20}$/.test(id) || !status) return res.status(400).json({ ok: false, error: 'datos' });
  const data = { id, rid: String(b.rid || '').slice(0, 40), status, reason: String(b.reason || '').slice(0, 200), at: Date.now() };
  const saved = pushMessage(getRoom(b.room), { type: 'pax-chg', key: 'pc:' + id, src: 'admin', data });
  res.json({ ok: true, data, id: saved && saved.id });
});

/* V398 · tarifas, comisión y plus por retiro lejano · solo administrador (se reparte a todos por el bus) */
app.post('/api/admin/pricing', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const c = b.cfg || {};
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const data = {
    base: num(c.base, 0, 50000, 2000), kmRate: num(c.kmRate, 0, 5000, 480), minRate: num(c.minRate, 0, 500, 20),
    commissionPct: num(c.commissionPct, 0, 30, 3), promoPct: num(c.promoPct, 0, 30, 0), promoUntil: num(c.promoUntil, 0, 4102444800000, 0),
    farOn: c.farOn ? 1 : 0, farFrom: num(c.farFrom, 0, 20, 2), farRate: num(c.farRate, 0, 3000, 300), farCap: num(c.farCap, 0, 20000, 2000),
    demandOn: c.demandOn === 0 || c.demandOn === false ? 0 : 1,
    adjPct: num(c.adjPct, 0, 100, 0), adjUntil: num(c.adjUntil, 0, 4102444800000, 0),
    ruleOn: c.ruleOn ? 1 : 0, ruleDays: num(c.ruleDays, 0, 127, 96), ruleFrom: num(c.ruleFrom, 0, 23, 21), ruleTo: num(c.ruleTo, 0, 23, 3), rulePct: num(c.rulePct, 0, 100, 15),
    rainOn: c.rainOn ? 1 : 0, rainPct: num(c.rainPct, 0, 100, 10), capPct: num(c.capPct, 0, 100, 60),
    tgtOn: c.tgtOn === 0 || c.tgtOn === false ? 0 : 1, tgtDisc: num(c.tgtDisc, 0, 40, 15), didiBase: num(c.didiBase, 0, 50000, 3000), didiKm: num(c.didiKm, 0, 5000, 580), didiTierKm: num(c.didiTierKm, 0, 100, 6), didiKm2: num(c.didiKm2, 0, 5000, 170), didiTier2Km: num(c.didiTier2Km, 0, 200, 12), b1On: c.b1On ? 1 : 0, b1Days: num(c.b1Days, 0, 127, 62), b1From: num(c.b1From, 0, 23, 6), b1To: num(c.b1To, 0, 24, 8), b1Pct: num(c.b1Pct, 0, 150, 20), b2On: c.b2On ? 1 : 0, b2Days: num(c.b2Days, 0, 127, 62), b2From: num(c.b2From, 0, 23, 12), b2To: num(c.b2To, 0, 24, 13), b2Pct: num(c.b2Pct, 0, 150, 20), b3On: c.b3On ? 1 : 0, b3Days: num(c.b3Days, 0, 127, 62), b3From: num(c.b3From, 0, 23, 17), b3To: num(c.b3To, 0, 24, 19), b3Pct: num(c.b3Pct, 0, 150, 15), b4On: c.b4On ? 1 : 0, b4Days: num(c.b4Days, 0, 127, 31), b4From: num(c.b4From, 0, 23, 22), b4To: num(c.b4To, 0, 24, 6), b4Pct: num(c.b4Pct, 0, 150, 25), b5On: c.b5On ? 1 : 0, b5Days: num(c.b5Days, 0, 127, 96), b5From: num(c.b5From, 0, 23, 21), b5To: num(c.b5To, 0, 24, 4), b5Pct: num(c.b5Pct, 0, 150, 40), didiKm3: num(c.didiKm3, 0, 10000, 1500), floorPct: num(c.floorPct, 30, 100, 70), at: Date.now()
  };
  const saved = pushMessage(getRoom(b.room), { type: 'cfg-price', key: 'cfg:price', src: 'admin', data });
  console.log('Tarifas actualizadas', JSON.stringify(data));
  res.json({ ok: true, data, id: saved && saved.id });
});

/* V351 · suspender / reactivar una cuenta (por los últimos 8 dígitos del celular) · solo administrador */
app.post('/api/admin/suspend', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const tail = String(b.tail || '').replace(/\D/g, '').slice(-8);
  if (tail.length < 6) return res.status(400).json({ ok: false, error: 'celular' });
  const data = {
    tail, susp: !!b.susp, reason: String(b.reason || '').slice(0, 300), name: String(b.name || '').slice(0, 80),
    ids: Array.isArray(b.ids) ? b.ids.slice(0, 10).map(x => String(x).slice(0, 40)) : [], at: Date.now()
  };
  const saved = pushMessage(getRoom(b.room), { type: 'acct-susp', key: 'su:' + tail, src: 'admin', data });
  console.log('Cuenta ' + (data.susp ? 'SUSPENDIDA' : 'reactivada') + ' · …' + tail.slice(-4));
  res.json({ ok: true, data, id: saved && saved.id });
});
app.post('/api/docs/get', async (req, res) => {
  const b = req.body || {}, owner = String(b.owner || '');
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin_only' });
  if (!okOwner(owner)) return res.status(400).json({ ok: false, error: 'bad_owner' });
  res.json({ ok: true, docs: await docsOf(owner) });
});

/* ---------------- recuperar cuenta (celular nuevo o app reinstalada) ----------------
   Requiere haber verificado el número por WhatsApp en los últimos 30 minutos.
   Busca los registros de pasajero y conductor con ese mismo número. */
app.post('/api/account/find', async (req, res) => {
  const userId = String((req.body && req.body.userId) || '').slice(0, 60), v = waVerified.get(userId);
  if (!v || Date.now() - (v.at || 0) > 30 * 60_000) return res.status(403).json({ ok: false, error: 'verify_first' });
  let pax = null, drv = null;
  for (const room of rooms.values()) for (const m of room.sticky.values()) {
    const d = m && m.data; if (!d || typeof d !== 'object') continue;
    if (tail8(d.phone) !== v.tail) continue;
    const when = Number(d.upd || d.updatedAt || m.at || 0);
    if (m.type === 'pax-reg' && (!pax || when > pax._w)) pax = Object.assign({}, d, { _w: when });
    if (m.type === 'driver-reg' && !d.hiddenAt && (!drv || when > drv._w)) drv = Object.assign({}, d, { _w: when });
  }
  let drvDocs = null;
  if (drv && drv.id) drvDocs = await docsOf(drv.id);
  if (pax) delete pax._w; if (drv) delete drv._w;
  console.log('Recuperar cuenta · …' + v.tail.slice(-4), pax ? 'pasajero' : '', drv ? 'conductor' : '');
  res.json({ ok: true, pax, drv, drvDocs });
});

/* ---------------- limpieza: registros de pasajeros nunca verificados (90 días) ----------------
   Ley 25.326: los datos se guardan solo mientras hagan falta. Se borran los pasajeros que en 90 días
   nunca verificaron su WhatsApp ni hicieron un viaje. */
async function purgeUnverified() {
  const limit = Date.now() - 90 * 86400_000; let n = 0;
  for (const room of rooms.values()) {
    const trips = [...room.sticky.values()].filter((m) => m && (m.type === 'trip-done' || m.type === 'trip-end')).map((m) => JSON.stringify(m.data || ''));
    for (const [k, m] of [...room.sticky.entries()]) {
      if (!m || m.type !== 'pax-reg') continue;
      const d = m.data || {}, born = Number(d.at || m.at || Date.now());
      if (d.wa || waVerified.has(d.id) || born > limit) continue;
      if (d.id && trips.some((t) => t.includes(d.id))) continue;
      room.sticky.delete(k); n++;
      if (db) { try { await db.query('DELETE FROM mobi_sticky WHERE room = $1 AND k = $2', [room.name, k]); } catch (e) { console.warn('purga', e.message); } }
    }
  }
  if (n) console.log('Limpieza 90 días: se borraron ' + n + ' registros de pasajeros sin verificar');
}
setTimeout(purgeUnverified, 60_000).unref();
setInterval(purgeUnverified, 6 * 3600_000).unref();

await Promise.race([dbInit(), new Promise((r) => setTimeout(r, 25_000))]);
app.listen(PORT, () => console.log(`MOBI-SERVER v5 escuchando en el puerto ${PORT} · base de datos: ${dbState}`));
/* al apagar, guardar lo pendiente */
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { for (const [k, v] of dirtySlow) dirty.set(k, v); await flushSticky(); } catch (e) {} process.exit(0); });
