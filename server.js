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
  },
  maxAge: 7200
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
let waRegBlockUntil = 0;
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
    /* V470 · después de un reinicio (deploy o caída): se reconstruye quién participa de cada viaje y qué conductor lo tomó,
       y la numeración salta hacia adelante para que ningún celular saltee mensajes nuevos creyendo que ya los tenía */
    try {
      const cl = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'claim' AND at > now() - interval '6 hours'`);
      for (const row of cl.rows) { const i = row.id.indexOf('|'); if (i < 0 || !row.data || !row.data.driverId) continue; getRoom(row.id.slice(0, i)).claims.set(row.id.slice(i + 1), { driverId: String(row.data.driverId), at: Number(row.data.at) || Date.now() }); }
    } catch (e) { console.warn('claims', e.message); }
    for (const room of rooms.values()) {
      const list = [...room.sticky.values()].filter((m) => m && m.type === 'trip' && m.data && m.data.active && m.data.active.tripKey).sort((x, y) => x.id - y.id);
      for (const m of list) {
        const a = m.data.active, k = String(a.tripKey), set = room.parts.get(k) || new Set();
        [a.__paxSrc, a.__drvSrc, m.data.by, m.src].forEach((x) => { if (x) set.add(String(x)); }); room.parts.set(k, set);
        if (m.data.from === 'drv') {
          const c0 = room.claims.get(k);
          if (a.driver && a.driver.id && !/Esperando|Buscando|Solicitud/i.test(String(a.status || ''))) { if (!c0 || c0.at < Number(m.at || 0)) room.claims.set(k, { driverId: String(a.driver.id), at: Number(m.at) || Date.now() }); }
          else if (/Esperando|Buscando/i.test(String(a.status || '')) && c0 && c0.at < Number(m.at || 0)) room.claims.delete(k);
        }
      }
      room.seq += 1_000_000;
    }
    try { const st = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'addrstat' AND id = 'all'`); if (st.rows[0]) Object.assign(addrStat, st.rows[0].data); } catch (e) { console.warn('addrstat', e.message); }
    try { const pv = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'push'`); for (const row of pv.rows) { if (row.id === 'vapid') pushVapidLoad(row.data); else if (row.id === 'last') { Object.assign(pushLast.periodic, row.data.periodic || {}); Object.assign(pushLast.demand, row.data.demand || {}); } else pushSubs.set(row.id, row.data); } } catch (e) { console.warn('push', e.message); } pushLoaded = true;
    try { const ad = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'addr'`); for (const row of ad.rows) addrMem.set(row.id, row.data); } catch (e) { console.warn('addr', e.message); }
    try { const dl = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'dl' AND id = 'counts'`); if (dl.rows[0] && dl.rows[0].data) for (const k of DL_KINDS) { const o = dl.rows[0].data[k]; if (o) { dlStat[k].t = Number(o.t) || 0; dlStat[k].d = o.d || {}; } } } catch (e) { console.warn('dl', e.message); }
    try { const at = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'admtok'`); for (const row of at.rows) if (row.data && row.data.t && Number(row.data.exp) > Date.now()) adminTokens.set(String(row.data.t), Number(row.data.exp)); db.query(`DELETE FROM mobi_kv WHERE ns = 'admtok' AND at < now() - interval '13 hours'`).catch(() => {}); } catch (e) { console.warn('admtok', e.message); }
    try { const tp = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'tpax' AND at > now() - interval '120 days'`); for (const row of tp.rows) if (row.data && row.data.h) tripPax.set(row.id, row.data.h); } catch (e) { console.warn('tpax', e.message); }
    try { const ow = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'own'`); for (const row of ow.rows) if (row.data && row.data.h) ownMap.set(row.id, row.data.h); } catch (e) { console.warn('own', e.message); }
    try { const mo = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'mpord' AND at > now() - interval '60 days'`); for (const row of mo.rows) mpOrders.set(row.id, row.data); } catch (e) { console.warn('mpord', e.message); }
    const w = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'wa'`);
    for (const row of w.rows) waVerified.set(row.id, row.data);
    try { const g = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'wacfg' AND id = 'regblock'`); if (g.rows[0]) waRegBlockUntil = Number(g.rows[0].data.until) || 0; } catch (e) {}
    dbState = 'on';
    histLoad().catch(() => {});
    console.log(`Base de datos conectada: ${r.rows.length} registros, ${w.rows.length} verificaciones`);
  } catch (e) {
    dbState = 'error'; dbError = e.message; db = null; pushLoaded = true;
    console.warn('No se pudo conectar la base de datos (sigo en memoria):', e.message);
  }
}
/* qué se guarda: solo lo que importa conservar. Las ubicaciones GPS cambian todo el tiempo y quedan en memoria
   (así la base "duerme" cuando no hay actividad y no se gastan las horas gratis). El viaje en curso se guarda cada 20 s. */
const DURABLE = new Set(['pax-reg', 'driver-reg', 'debt-charge', 'debt-pay', 'rating', 'report', 'trip-end', 'trip-done', 'acct-susp', 'pax-chg', 'cfg-price', 'cfg-debt', 'cfg-cupo', 'drv-slots', 'cfg-founder', 'drv-founders', 'refund-req', 'cfg-push', 'cfg-maint', 'cfg-reset', 'drv-chg']);
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
  if (!r) { r = { name: key, seq: 0, ring: [], sticky: new Map(), claims: new Map(), parts: new Map(), touched: Date.now() }; rooms.set(key, r); }
  if (!r.parts) r.parts = new Map();
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
  /* V448 · quién participa de cada viaje: la ubicación y los avances de un viaje ya tomado van solo a ellos (y al administrador) */
  if (msg.type === 'trip' && msg.data && msg.data.active && msg.data.active.tripKey) {
    const a = msg.data.active, k = String(a.tripKey);
    const set = room.parts.get(k) || new Set(); [a.__paxSrc, a.__drvSrc, msg.data.by, msg.src].forEach(x => { if (x) set.add(String(x)); }); room.parts.set(k, set);
    if (room.parts.size > 5000) room.parts.delete(room.parts.keys().next().value);
    if (!/Esperando|Buscando|Solicitud/i.test(String(a.status || ''))) { msg.tk = k; msg.priv = 'trip'; }
  } else if ((msg.type === 'driver-pos' || msg.type === 'pax-pos' || msg.type === 'pay-proof' || msg.type === 'pay-proof-meta') && msg.data && msg.data.tripKey) { msg.tk = String(msg.data.tripKey); msg.priv = 'pos'; }
  else if (msg.type === 'chat' && msg.data && msg.data.tk) { msg.tk = String(msg.data.tk); msg.priv = 'pos'; if (!msg.key && msg.data.m && msg.data.m.id) msg.key = 'ch:' + String(msg.data.m.id).slice(0, 60); }   /* V469 · comprobantes y chat: solo a los dos del viaje (y al administrador) */
  if (msg.type === 'drv-pres' && msg.data && msg.data.id && msg.data.online !== false) { if (!room.seen) room.seen = new Map(); room.seen.set(String(msg.data.id), Date.now()); }   /* V473 · última vez conectado (para el cupo) */
  try { if (msg.type === 'trip-done') histIngest(room, msg); else if (msg.type === 'drv-pres') presIngest(room, msg); } catch (e) {}   /* V485 · historial de conductores (viajes y conexiones) */
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
/* V497 · después de «Empezar de cero» no se aceptan registros viejos que un celular sin limpiar quiera volver a mandar */
function resetAtOf(room) { const m = room.sticky.get('cfg-reset|cfg:reset'); return Number(m && m.data && m.data.at) || 0; }
function staleReg(room, m) {
  if (!m || !m.data || (m.type !== 'pax-reg' && m.type !== 'driver-reg')) return false;
  const ra = resetAtOf(room); if (!ra) return false;
  const born = Number(m.type === 'pax-reg' ? m.data.at : m.data.registeredAt) || 0;
  return !!born && born < ra - 5 * 60_000;
}
function regBlocked(room, m) {
  if (staleReg(room, m)) return true;
  if (!m || !m.data) return false;
  if (m.type === 'driver-reg' && m.data.status === 'pendiente') return !!findDupReg(room, 'driver-reg', m.data);
  if (m.type === 'pax-reg' && !room.sticky.has('pax-reg|' + (m.key || ''))) return !!findDupReg(room, 'pax-reg', m.data);
  return false;
}

/* =====================================================================
   V500 · SEGURIDAD
   - Cada celular tiene una llave propia (x-mobi-sk). La cuenta (pasajero o conductor) queda atada al celular que la creó;
     otro celular no puede modificarla. Al recuperar la cuenta ("Ya tengo cuenta", con Telegram o mail) pasa al celular nuevo.
   - Aprobar o rechazar conductores, confirmar pagos y retiros: SOLO el administrador (clave verificada en el servidor).
   - Pagos con Mercado Pago: el servidor confirma que el cobro existió de verdad.
   - Datos personales (DNI, fotos, celulares, alias, movimientos): solo el administrador y el dueño de la cuenta.
   ===================================================================== */
const ownMap = new Map();                 // 'sala|drv|id' o 'sala|pax|id' -> huella de la llave del celular
const mpOrders = new Map();               // orderId -> { amount, ok, used, at }
function skHash(v) { v = String(v || ''); return /^[a-f0-9]{32,64}$/.test(v) ? crypto.createHash('sha256').update('mobi-sk|' + v).digest('hex').slice(0, 40) : ''; }
function authOf(req, room) {
  const h = req.headers || {}, b = req.body || {};
  const adm = String(h['x-mobi-adm'] || '');
  const admin = !!adm && (adminOk(adm) || sbxOk({ token: adm, room }));
  return { admin, tried: !!adm && !admin, sk: skHash(h['x-mobi-sk']) };
}
const OWN_RE = { drv: /^drv_[a-z0-9]{3,24}$/, pax: /^pax_[a-z0-9]{3,24}$/ };
function ownKey(room, kind, id) { return (typeof room === 'string' ? room : room.name) + '|' + kind + '|' + id; }
function ownGet(room, kind, id) { return ownMap.get(ownKey(room, kind, id)) || ''; }
function ownHas(room, kind, id, sk) { return !!sk && ownGet(room, kind, id).split(',').includes(sk); }
/* V504 · una cuenta puede usarse en hasta 2 celulares/navegadores del mismo dueño (APK + navegador). El segundo se suma solo al verificar la cuenta («Ya tengo cuenta»); un tercero reemplaza al más viejo. */
function ownSet(room, kind, id, sk, add) {
  if (!sk) return; const k = ownKey(room, kind, id), cur = ownMap.get(k) || '';
  let list = add && cur ? [sk].concat(cur.split(',').filter((x) => x && x !== sk)).slice(0, 2) : [sk];
  const v = list.join(','); if (cur === v) return; ownMap.set(k, v); kvSet('own', k, { h: v, at: Date.now() });
}
function isOwner(room, kind, id, sk, bind) {
  if (!sk || !OWN_RE[kind] || !OWN_RE[kind].test(String(id || ''))) return false;
  const cur = ownGet(room, kind, id);
  if (!cur) { if (bind) ownSet(room, kind, id, sk); return !!bind; }
  return cur.split(',').includes(sk);
}
/* cuentas creadas antes de la V500 (todavía sin celular asignado): quedan con el primer celular que las usa */
function legacyBind(room, kind, id) { return !ownGet(room, kind, id) && !!stickyData(room, (kind === 'pax' ? 'pax-reg|pr:' : 'driver-reg|dr:') + id); }
function stickyData(room, k) { const m = room.sticky.get(k); return (m && m.data && typeof m.data === 'object') ? m.data : null; }
function waOkFor(id, phone) { const v = waVerified.get(String(id || '')); return !!(v && v.tail && v.tail === tail8(phone)); }
const ADMIN_ONLY_DRV = ['reviewedAt', 'approvedAt', 'approvedSig', 'reason', 'hiddenAt', 'deletedAt'];
const LOCK_APPROVED_DRV = ['name', 'dni', 'plate', 'vehicle', 'docSig', 'docs', 'registeredAt', 'submittedAt', 'submittedSig'];
/* V509 · saldo a favor: el servidor verifica de dónde sale y pone topes (antes cualquiera podía inventar viajes y cancelarlos para bajar su deuda) */
/* V510 · CUENTA DEL CONDUCTOR CALCULADA POR EL SERVIDOR
   - Lo que MOBI todavía no cobró NO se acredita: queda «retenido» (hold) y no baja la deuda ni se puede retirar.
     · cancelaciones del pasajero: se liberan cuando ese pasajero paga el cargo en su próximo viaje
     · viaje con tarjeta: se acredita solo si hay un cobro real de Mercado Pago que lo respalde
     · saldo a favor del pasajero usado en un viaje: solo si ese pasajero tiene ese saldo en el servidor
   - El retiro no puede superar el saldo disponible que calcula el servidor. */
const tripPax = new Map();   // 'sala|tripKey' -> huella de la llave del celular del pasajero que pidió el viaje
function tripPaxSet(room, k, sk) { if (!k || !sk) return; const id = room.name + '|' + k; if (tripPax.has(id)) return; tripPax.set(id, sk); kvSet('tpax', id, { h: sk, at: Date.now() }); }
/* identidad del pasajero de un viaje: su cuenta (si el celular está vinculado) o, si no, la llave de su celular */
function paxIdentOfSk(room, sk) {
  if (!sk) return ''; const pre = room.name + '|pax|';
  for (const [k, v] of ownMap) if (k.startsWith(pre) && String(v).split(',').includes(sk)) return 'pax:' + k.slice(pre.length);
  return 'sk:' + sk;
}
function paxIdentOfTrip(room, k) { return k ? paxIdentOfSk(room, tripPax.get(room.name + '|' + k) || '') : ''; }
const isCancelCredit = (y) => y && y.type === 'credit' && (y.kind === 'cancel' || /^Cancelaci[oó]n del pasajero|^Viaje terminado antes|^Devoluci[oó]n de env[ií]o/i.test(String(y.note || '')));
const isCollectCharge = (y) => y && y.type === 'charge' && (y.kind === 'cf-collect' || /^Cargo por cancelaci[oó]n que cobraste/i.test(String(y.note || '')));
const isRefundCharge = (y) => y && y.type === 'charge' && y.kind === 'cancel-refund';
function ledgerOf(room, drv) {
  const L = { charges: 0, paid: 0, cred: 0, held: 0, cancelCr: 0, payDone: 0, payPend: 0, list: [] };
  for (const x of room.sticky.values()) {
    const y = x && (x.type === 'debt-charge' || x.type === 'debt-pay') && x.data; if (!y || String(y.driver) !== drv) continue;
    L.list.push(y);
    const a = Number(y.amount) || 0;
    if (x.type === 'debt-charge') {
      if (y.type === 'charge') L.charges += a;
      else if (y.type === 'credit') {
        if (y.hold || y.ver === false) { L.held += a; continue; }
        L.cred += a; if (isCancelCredit(y)) L.cancelCr += a;
      }
    } else if (y.type === 'payment' && y.status === 'confirmado') L.paid += a;
    else if (y.type === 'payout') { if (y.status === 'hecho') L.payDone += a; else if (y.status === 'pendiente') L.payPend += a; }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const netv = L.charges - L.paid - L.cred + L.payDone, favor = Math.max(0, -netv);
  const cancelLeft = Math.max(0, L.cancelCr - Math.max(0, L.charges - L.paid));   /* lo acreditado por cancelaciones solo baja deuda: no se retira */
  L.debt = r2(Math.max(0, netv)); L.favor = r2(favor);
  L.avail = r2(Math.max(0, Math.max(0, favor - cancelLeft) - L.payPend));
  L.held = r2(L.held);
  L.list.sort((p, q) => Number(p.at || 0) - Number(q.at || 0));
  return L;
}
/* saldo a favor de un pasajero (en el servidor): lo que le devolvieron por envíos cancelados menos lo que ya usó */
function paxCreditOf(room, ident) {
  if (!ident) return 0; let n = 0;
  for (const x of room.sticky.values()) {
    const y = x && x.type === 'debt-charge' && x.data; if (!y || !y.tripKey) continue;
    if (isRefundCharge(y) && paxIdentOfTrip(room, String(y.tripKey)) === ident) n += Number(y.amount) || 0;
    else if (y.type === 'credit' && y.kind === 'paxcredit' && !y.hold && paxIdentOfTrip(room, String(y.tripKey)) === ident) n -= Number(y.amount) || 0;
  }
  return Math.round(n * 100) / 100;
}
/* el pasajero pagó cargos de cancelación: se liberan los créditos retenidos de los conductores que fueron en vano (los más viejos primero) */
function releaseHolds(room, ident, amount, why) {
  if (!ident || !(amount > 0)) return 0; let left = amount, done = 0;
  const held = [...room.sticky.values()].filter((x) => x && x.type === 'debt-charge' && x.data && x.data.hold && x.data.holdWhy === 'cobro' && (x.data.paxIdent === ident || (x.data.paxSk && paxIdentOfSk(room, x.data.paxSk) === ident))).sort((p, q) => Number(p.data.at || 0) - Number(q.data.at || 0));
  for (const x of held) {
    const a = Number(x.data.amount) || 0; if (a > left + 0.5) break;
    left -= a; done += a;
    pushMessage(room, { type: 'debt-charge', key: x.key, src: 'admin', data: Object.assign({}, x.data, { hold: false, releasedAt: Date.now(), releasedBy: why || 'cobro' }) });
  }
  if (done) console.log('Cancelaciones cobradas: se liberaron $' + done + ' retenidos');
  return done;
}

/* revisa un mensaje que manda un celular. Devuelve el mensaje (a veces corregido) o null si no se acepta */
function guardMsg(room, m, auth) {
  if (!m || typeof m.type !== 'string') return m;
  const t = m.type, d = m.data;
  const SENS = t === 'driver-reg' || t === 'pax-reg' || t === 'debt-charge' || t === 'debt-pay' || t === 'pax-chg' || t === 'drv-chg';
  if (!SENS) return m;
  if (!d || typeof d !== 'object') return null;
  if (auth.admin) return m;
  if (auth.tried) return null;   /* clave de administrador vencida: no se toma como un celular común (no se apropia de cuentas) */
  if (t === 'driver-reg') {
    const id = String(d.id || ''); if (!OWN_RE.drv.test(id)) return null;
    m.key = 'dr:' + id;
    const prev = stickyData(room, 'driver-reg|dr:' + id);
    if (!isOwner(room, 'drv', id, auth.sk, !prev || !ownGet(room, 'drv', id))) return null;
    const o = Object.assign({}, d), ps = String((prev && prev.status) || 'borrador');
    if (!(o.status === 'borrador' || o.status === 'pendiente' || o.status === ps)) o.status = ps;     /* aprobar o rechazar: solo el administrador */
    if (prev) {
      ADMIN_ONLY_DRV.forEach((k) => { if (prev[k] === undefined) delete o[k]; else o[k] = prev[k]; });
      if (o.status === 'pendiente' && ps !== 'pendiente' && Number(d.submittedAt || 0) > Number(prev.hiddenAt || 0)) o.hiddenAt = prev.hiddenAt;   /* reenvío: vuelve a aparecer (el admin lo ve) */
      if (String(prev.phone || '').trim()) o.phone = prev.phone;                                          /* el celular no se cambia nunca */
      if (ps === 'aprobado' && o.status === 'aprobado') {
        LOCK_APPROVED_DRV.forEach((k) => { if (prev[k] === undefined) delete o[k]; else o[k] = prev[k]; });
        const pc = Array.isArray(prev.cars) ? prev.cars : [];
        if (Array.isArray(o.cars)) o.cars = o.cars.slice(0, 6).map((c) => { const old = pc.find((x) => x && c && String(x.plate || '') === String(c.plate || '')); return Object.assign({}, c, { status: old ? old.status : 'pendiente' }); });
      }
    } else { ADMIN_ONLY_DRV.forEach((k) => delete o[k]); }
    o.wa = waOkFor(id, o.phone);
    m.data = o; return m;
  }
  if (t === 'pax-reg') {
    const id = String(d.id || ''); if (!OWN_RE.pax.test(id)) return null;
    m.key = 'pr:' + id;
    const prev = stickyData(room, 'pax-reg|pr:' + id);
    if (!isOwner(room, 'pax', id, auth.sk, !prev || !ownGet(room, 'pax', id))) return null;
    const o = Object.assign({}, d);
    if (prev) {
      ['name', 'dni', 'dniImg', 'at'].forEach((k) => { if (prev[k] !== undefined && String(prev[k] || '') !== '') o[k] = prev[k]; });   /* nombre y DNI: solo con revisión */
      if (String(prev.phone || '').trim()) o.phone = prev.phone;
      if (String(prev.photo || '')) o.photo = prev.photo;                                                  /* la foto de perfil, una vez cargada, no se cambia */
      ['deletedAt'].forEach((k) => { if (prev[k] === undefined) delete o[k]; else o[k] = prev[k]; });
    }
    o.wa = waOkFor(id, o.phone);
    m.data = o; return m;
  }
  if (t === 'pax-chg') {
    if (!(d.status === 'pendiente' || d.status === 'cancelado')) return null;
    if (!isOwner(room, 'pax', String(d.id || ''), auth.sk, legacyBind(room, 'pax', String(d.id || '')))) return null;
    m.key = 'pc:' + d.id; return m;
  }
  if (t === 'drv-chg') {
    if (!(d.status === 'pendiente' || d.status === 'cancelado')) return null;
    if (!isOwner(room, 'drv', String(d.id || ''), auth.sk, legacyBind(room, 'drv', String(d.id || '')))) return null;
    m.key = 'xc:' + d.id; return m;
  }
  /* movimientos de la cuenta del conductor: solo los suyos, nuevos (no se pisan), y lo que confirma el admin no lo puede confirmar él */
  const drv = String(d.driver || '');
  if (!isOwner(room, 'drv', drv, auth.sk, legacyBind(room, 'drv', drv))) return null;
  const id = String(d.id || ''); if (!/^[a-z0-9_-]{2,60}$/i.test(id)) return null;
  if (t === 'debt-charge') {
    m.key = 'dc:' + id;
    if (room.sticky.has('debt-charge|dc:' + id)) return null;
    const amt = Number(d.amount); if (!(amt > 0 && amt <= MP_MAX)) return null;
    if (d.type === 'charge') {
      const o = Object.assign({}, d); delete o.hold; delete o.holdWhy; delete o.paxIdent; delete o.paxSk; delete o.srv; o.at = Date.now();
      const k = String(d.tripKey || '');
      if (k && /^Comisi[oó]n de viaje/i.test(String(d.note || ''))) { m.key = 'dc:com:' + k; if (room.sticky.has('debt-charge|dc:com:' + k)) return null; }   /* V510 · una sola comisión por viaje */
      if (k && isCollectCharge(o)) { o.kind = 'cf-collect'; releaseHolds(room, paxIdentOfTrip(room, k), amt, 'cargo'); }   /* el pasajero pagó su cargo de cancelación en este viaje */
      m.data = o; return m;
    }
    if (d.type !== 'credit') return null;
    /* saldo a favor: tiene que venir de un viaje real que hizo este conductor */
    const k = String(d.tripKey || ''); if (!k) return null;
    const tr = stickyData(room, 'trip|tr:' + k + ':drv'), cl = room.claims.get(k);
    const who = String((tr && tr.active && tr.active.driver && tr.active.driver.id) || (cl && cl.driverId) || '');
    if (who !== drv) return null;
    const kind = String(d.kind || ''), o = Object.assign({}, d); delete o.ver; delete o.hold; delete o.holdWhy; delete o.paxIdent; delete o.paxSk; delete o.releasedAt; o.at = Date.now();
    let n = 0, nc = 0; for (const x of room.sticky.values()) if (x && x.type === 'debt-charge' && x.data && x.data.type === 'credit' && String(x.data.tripKey || '') === k) { n++; if (isCancelCredit(x.data)) nc++; }
    if (n >= 3) return null;
    if (isCancelCredit(o)) {   /* V510 · cancelación: queda retenida hasta que MOBI le cobre el cargo al pasajero */
      if (nc >= 1) return null;                                     /* una sola por viaje */
      o.kind = 'cancel'; o.hold = true; o.holdWhy = 'cobro'; o.paxIdent = paxIdentOfTrip(room, k) || ''; o.paxSk = tripPax.get(room.name + '|' + k) || '';
      m.data = o; return m;
    }
    if (kind === 'paxcredit') {   /* saldo a favor del pasajero usado: solo si lo tiene de verdad */
      const ident = paxIdentOfTrip(room, k), have = paxCreditOf(room, ident);
      if (!(ident && have + 0.5 >= amt)) { o.hold = true; o.holdWhy = 'saldo'; }
      m.data = o; return m;
    }
    /* viaje cobrado con tarjeta: tiene que haber un cobro real de Mercado Pago */
    const amt2 = Math.round(amt * 100) / 100; let ord = null;
    const pid = paxIdentOfTrip(room, k), byPax = (mo) => !mo.sk || !pid || paxIdentOfSk(room, mo.sk) === pid;   /* el cobro lo tuvo que hacer el pasajero de ESE viaje */
    { const oid = String(d.mpOrderId || ''), mo = oid && mpOrders.get(oid); if (mo && (mo.ok || mo.auth) && !mo.used && !mo.credited && Number(mo.amount) + 0.01 >= amt2 && byPax(mo)) ord = [oid, mo]; }   /* el cobro exacto de ese viaje */
    if (!ord) for (const [oid, mo] of mpOrders) { if (mo && (mo.ok || mo.auth) && !mo.used && !mo.credited && mo.ref !== 'deuda' && mo.sk && pid && paxIdentOfSk(room, mo.sk) === pid && Number(mo.amount) + 0.01 >= amt2 && Date.now() - Number(mo.at || 0) < 12 * 3600_000 && (!ord || mo.amount < ord[1].amount)) ord = [oid, mo]; }
    if (ord) {
      ord[1].credited = drv; kvSet('mpord', ord[0], ord[1]); o.mpOrd = ord[0];
      const cf = Math.round((Number(ord[1].amount) - amt2) * 100) / 100; if (cf > 0.5) releaseHolds(room, paxIdentOfTrip(room, k), cf, 'tarjeta');   /* lo que pagó de más con tarjeta = cargo de cancelación anterior */
    } else { o.hold = true; o.holdWhy = 'tarjeta'; }
    m.data = o; return m;
  }
  if (t === 'debt-pay') {
    m.key = 'dp:' + id;
    if (room.sticky.has('debt-pay|dp:' + id)) return null;
    const amt = Number(d.amount); if (!(amt > 0 && amt <= MP_MAX)) return null;
    const o = Object.assign({}, d);
    if (o.type === 'payout') {   /* V508 · retiros: como mucho 3 pendientes por conductor y ninguno repetido */
      let np = 0, dup = false; for (const x of room.sticky.values()) { const y = x && x.type === 'debt-pay' && x.data; if (y && y.type === 'payout' && y.status === 'pendiente' && String(y.driver) === drv) { np++; if (Math.abs(Number(y.amount) - amt) < 0.01 && Date.now() - Number(y.at || 0) < 600_000) dup = true; } }
      if (np >= 3 || dup) { auth.why = { error: dup ? 'dup' : 'many' }; return null; }
      const L = ledgerOf(room, drv); o.status = 'pendiente'; delete o.flag; delete o.verified;
      if (amt > L.avail + 0.5) { auth.why = { error: 'over', avail: L.avail }; return null; }   /* V510 · no puede pedir más que su saldo disponible */
      m.data = o; return m; }
    if (o.type !== 'payment') return null;
    if (o.status === 'confirmado') {
      const mo = mpOrders.get(String(o.mpOrderId || ''));
      if (mo && mo.ok && !mo.used && !mo.credited && Math.abs(Number(mo.amount) - amt) < 0.01 && (!mo.sk || mo.sk === auth.sk || ownHas(room, 'drv', drv, mo.sk))) {   /* V508 · el cobro solo lo puede acreditar el celular que pagó (o uno vinculado a la misma cuenta) */ mo.used = drv; kvSet('mpord', String(o.mpOrderId), mo); }
      else { o.status = 'pendiente'; o.note = 'Sin confirmación de Mercado Pago: revisar'; }
    } else o.status = 'pendiente';
    if (o.status !== 'confirmado') delete o.confirmedAt;
    m.data = o; return m;
  }
  return m;
}
/* V507 · ¿el mensaje se rechazó porque la cuenta es de OTRO celular? (para avisarle al usuario que vincule este) */
function notOwnerMsg(room, m, auth) {
  try {
    if (!m || !auth || !auth.sk || auth.admin) return false;
    const d = m.data || {}, t = m.type; let kind = 'drv', id = String(d.driver || '');
    if (t === 'pax-reg' || t === 'pax-chg') { kind = 'pax'; id = String(d.id || ''); } else if (t === 'driver-reg' || t === 'drv-chg') id = String(d.id || '');
    else if (t !== 'debt-charge' && t !== 'debt-pay') return false;
    const cur = ownGet(room, kind, id); return !!cur && !cur.split(',').includes(auth.sk);
  } catch (e) { return false; }
}
/* qué ve cada celular de los datos de otros */
const DRV_PUBLIC = ['id', 'name', 'status', 'plate', 'vehicle', 'registeredAt', 'submittedAt', 'reviewedAt', 'approvedAt', 'updatedAt', 'hiddenAt', 'deletedAt', 'wa', 'docs'];
function viewFor(room, x, auth) {
  if (auth.admin) return x;
  const t = x.type, d = x.data;
  if (!d || typeof d !== 'object') return x;
  if (t === 'pax-reg') return ownHas(room, 'pax', String(d.id || ''), auth.sk) ? x : null;
  if (t === 'pax-chg') return ownHas(room, 'pax', String(d.id || ''), auth.sk) ? x : null;
  if (t === 'driver-reg') {
    if (ownHas(room, 'drv', String(d.id || ''), auth.sk)) return x;
    const o = {}; DRV_PUBLIC.forEach((k) => { if (d[k] !== undefined) o[k] = d[k]; });
    if (Array.isArray(d.cars)) o.cars = d.cars.map((c) => c && ({ model: c.model, plate: c.plate, color: c.color, status: c.status }));
    return Object.assign({}, x, { data: o });
  }
  if (t === 'debt-charge' && (d.paxIdent || d.paxSk)) { if (!ownHas(room, 'drv', String(d.driver || ''), auth.sk)) return null; const o = Object.assign({}, d); delete o.paxIdent; delete o.paxSk; return Object.assign({}, x, { data: o }); }
  if (t === 'drv-chg' || t === 'debt-charge' || t === 'debt-pay') return ownHas(room, 'drv', String(d.id && t === 'drv-chg' ? d.id : d.driver || ''), auth.sk) ? x : null;
  return x;
}
app.post('/api/reg/check', (req, res) => {
  const b = req.body || {}, role = b.role === 'drv' ? 'driver-reg' : 'pax-reg';
  const o = findDupReg(getRoom(b.room), role, { id: String(b.id || ''), phone: b.phone, dni: b.dni });
  res.json({ ok: true, dup: !!o, status: o ? String(o.status || 'aprobado') : '' });
});

app.post('/api/bus/batch', (req, res) => {
  const { room, messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages must be an array' });
  const r = getRoom(room), auth = authOf(req, r.name);
  let last = r.seq, denied = 0;
  for (const m0 of messages.slice(0, 100)) {
    const m = guardMsg(r, m0, auth); if (!m) { if (notOwnerMsg(r, m0, auth)) denied++; continue; }
    if (m.type === 'trip' && m.data && m.data.from === 'pax' && m.data.active && m.data.active.tripKey) tripPaxSet(r, String(m.data.active.tripKey), auth.sk);   /* V510 · quién es el pasajero de cada viaje */   /* V500 · seguridad */
    if (m && (m.type === 'acct-susp' || m.type === 'cfg-price' || m.type === 'cfg-debt' || m.type === 'cfg-maint' || m.type === 'cfg-reset' || m.type === 'cfg-cupo' || m.type === 'cfg-push' || m.type === 'drv-slots' || m.type === 'cfg-founder' || m.type === 'drv-founders')) continue;   // solo el administrador (endpoint propio)
    if (regBlocked(r, m)) continue;               // registro doble en el mismo rol
    if (m && m.type === 'pax-chg' && !(m.data && (m.data.status === 'pendiente' || m.data.status === 'cancelado'))) continue;
    if (m && m.type === 'trip' && m.data && m.data.active) {
      const a = m.data.active, k = a.tripKey, claim = k ? r.claims.get(k) : null;
      const drvId = a.driver && a.driver.id;
      if (claim && drvId && drvId !== claim.driverId && !/Esperando|Buscando/i.test(String(a.status || ''))) continue;
      if (!claim && drvId && k && m.data.from === 'drv' && !/Esperando|Buscando|Solicitud|Cancel|Finaliz/i.test(String(a.status || ''))) r.claims.set(String(k), { driverId: String(drvId), at: Date.now() });   /* V470 */
    }
    const saved = pushMessage(r, m);
    if (saved) last = saved.id;
  }
  res.json(denied ? { ok: true, last, denied } : { ok: true, last });
});

app.post('/api/bus', (req, res) => {
  const { room, ...m0 } = req.body || {};
  const au0 = authOf(req, getRoom(room).name), m = guardMsg(getRoom(room), m0, au0);   /* V500 · seguridad */
  if (!m && au0.why) return res.status(409).json(Object.assign({ ok: false }, au0.why));
  if (!m) return res.status(403).json({ ok: false, error: 'forbidden', notOwner: notOwnerMsg(getRoom(room), m0, au0) });
  if (m.type === 'trip' && m.data && m.data.from === 'pax' && m.data.active && m.data.active.tripKey) tripPaxSet(getRoom(room), String(m.data.active.tripKey), au0.sk);
  if (m && (m.type === 'acct-susp' || m.type === 'cfg-price' || m.type === 'cfg-debt' || m.type === 'cfg-maint' || m.type === 'cfg-reset' || m.type === 'cfg-cupo' || m.type === 'cfg-push' || m.type === 'drv-slots' || m.type === 'cfg-founder' || m.type === 'drv-founders' || (m.type === 'pax-chg' && !(m.data && (m.data.status === 'pendiente' || m.data.status === 'cancelado'))))) return res.status(403).json({ ok: false, error: 'admin' });
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
    const r0 = r.ring.length ? r.ring[0].id : r.seq + 1;
    if (after < r0 - 1) {
      /* V469 · el celular se atrasó (sin señal, en segundo plano) más de lo que guarda la memoria corta:
         se le manda el ÚLTIMO estado de cada cosa que se perdió (viaje, fin, cancelación, chat) y después lo nuevo */
      const lost = [];
      for (const x of r.sticky.values()) if (x.id > after && x.id < r0) lost.push(x);
      lost.sort((a, b) => a.id - b.id);
      messages = lost.concat(r.ring.filter(x => x.id > after));
      r.catchups = (r.catchups || 0) + 1;
    } else messages = r.ring.filter(x => x.id > after);
  }
  /* V448 · cada celular recibe lo suyo: los demás conductores solo se enteran de que el viaje ya fue tomado (aviso corto) */
  const auth = authOf(req, r.name);
  const all = String(req.query.all || '') === '1' && auth.admin;   /* V500 · «todo» solo para el administrador */
  /* V450 · zona: si el celular dice dónde está, solo recibe pedidos y conductores a menos de GEO_KM (el retiro máximo es 4 km; el resto es margen) */
  const GEO_KM = 6.5;
  const geo = all ? [] : String(req.query.geo || '').split(';').slice(0, 3).map(t => t.split(',').map(Number)).filter(v => v.length === 2 && v.every(Number.isFinite));
  const near = pt => { if (!geo.length || !pt || !Number.isFinite(Number(pt.lat)) || !Number.isFinite(Number(pt.lng))) return true;
    for (const g of geo) { const dl = (Number(pt.lat) - g[0]) * 111.32, dg = (Number(pt.lng) - g[1]) * 111.32 * Math.cos(g[0] * Math.PI / 180); if (dl * dl + dg * dg <= GEO_KM * GEO_KM) return true; } return false; };
  const inZone = x => {
    if (!geo.length) return true;
    if (x.type === 'trip' && x.data && x.data.active && x.data.active.originPlace) { const set = r.parts.get(x.tk || String(x.data.active.tripKey || '')); if (set && set.has(me)) return true; return near(x.data.active.originPlace); }
    if (x.type === 'drv-pres' && x.data) return near(x.data.pos) || (x.data.dest && near(x.data.dest));
    return true;
  };
  /* V469 · el pasajero no necesita la ruta de los pedidos ajenos: solo dónde y cuándo (para la demanda) */
  const lite = String(req.query.lite || '') === '1' && !all;
  const out = [];
  for (const x0 of messages) {
    if (me && x0.src === me) continue;
    const x = viewFor(r, x0, auth); if (!x) continue;   /* V500 · datos personales solo para el dueño y el administrador */
    if (!inZone(x)) continue;
    if (lite && x.type === 'trip' && !x.priv && x.data && x.data.active) {
      const a = x.data.active, set = r.parts.get(String(a.tripKey || ''));
      if (!(set && set.has(me)) && a.__paxSrc !== me) {
        out.push({ id: x.id, type: x.type, src: x.src, key: x.key, ts: x.ts, at: x.at, data: { active: { tripKey: a.tripKey, status: a.status, started: a.started, originPlace: a.originPlace && { lat: a.originPlace.lat, lng: a.originPlace.lng } }, from: x.data.from, rev: x.data.rev, by: x.data.by } });
        continue;
      }
    }
    if (!x.priv || all) { out.push(x); continue; }
    const set = r.parts.get(x.tk);
    if (x.type === 'pay-proof' && !(set && set.has(me))) continue;   /* V470 · el comprobante nunca va a todos (el conductor lo baja de /api/proof/get) */
    if (!set || set.has(me)) { out.push(x); continue; }            // sin datos del viaje (p. ej. tras reinicio): se entrega como antes
    if (x.priv === 'trip') { const a = x.data.active; out.push({ id: x.id, type: x.type, src: x.src, key: x.key, ts: x.ts, at: x.at, data: { active: { tripKey: a.tripKey, status: a.status }, from: x.data.from, rev: x.data.rev, by: x.data.by } }); }
  }
  /* V448 · sin pérdidas: si hay más de 400, se entregan los primeros y el resto en el próximo sondeo */
  let last = r.seq, list = out;
  if (list.length > 400) { list = list.slice(0, 400); last = list[list.length - 1].id; }
  res.json({ ok: true, messages: list.map(({ priv, tk, ...m }) => m), last });
});

/* ------------- adjudicación atómica de viajes ------------- */
app.post('/api/trip/claim', (req, res) => {
  const { room, tripKey, driverId } = req.body || {};
  if (!tripKey || !driverId) return res.status(400).json({ ok: false, error: 'tripKey and driverId are required' });
  const r = getRoom(room), k = String(tripKey), d = String(driverId);
  /* V470 · un pedido que el pasajero ya canceló no se puede tomar */
  const te = r.sticky.get('trip-end|te:' + k), tp = r.sticky.get('trip|tr:' + k + ':pax');
  if (te || (tp && tp.data && tp.data.active && /Cancel/i.test(String(tp.data.active.status || '')))) return res.json({ ok: false, error: 'ended' });
  if (cupoWaiting(r, d)) return res.json({ ok: false, error: 'cupo' });   /* V473 · en lista de espera */
  { const au = authOf(req, r.name), dr = stickyData(r, 'driver-reg|dr:' + d);   /* V500 · solo un conductor APROBADO por el administrador, desde su propio celular, puede tomar viajes */
    if (!au.admin && (!isOwner(r, 'drv', d, au.sk, legacyBind(r, 'drv', d)) || !dr || dr.status !== 'aprobado' || drvHidden(dr) || dr.deletedAt)) return res.json({ ok: false, error: 'not_approved' }); }
  const cur = r.claims.get(k);
  if (cur && cur.driverId !== d) return res.json({ ok: false, winner: cur.driverId });
  r.claims.set(k, { driverId: d, at: Date.now() });
  /* V470 · quién tomó cada viaje se guarda en la base EN SEGUNDO PLANO (no frena a nadie) y se recupera si el servidor se reinicia */
  if (db && !cur) db.query(`INSERT INTO mobi_kv (ns, id, data, at) VALUES ('claim', $1, $2::jsonb, now()) ON CONFLICT (ns, id) DO UPDATE SET data = EXCLUDED.data, at = now()`, [r.name + '|' + k, JSON.stringify({ driverId: d, at: Date.now() })]).catch(() => {});
  res.json({ ok: true, winner: d });
});
app.post('/api/trip/release', (req, res) => {
  const { room, tripKey, driverId } = req.body || {};
  const r = getRoom(room), k = String(tripKey);
  const cur = r.claims.get(k);
  if (cur && (!driverId || cur.driverId === String(driverId))) {
    r.claims.delete(k);
    if (db) db.query(`DELETE FROM mobi_kv WHERE ns = 'claim' AND id = $1`, [r.name + '|' + k]).catch(() => {});
  }
  res.json({ ok: true });
});

setInterval(() => { if (db) db.query(`DELETE FROM mobi_kv WHERE ns = 'claim' AND at < now() - interval '6 hours'`).catch(() => {}); }, 30 * 60_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) {
    if (now - r.touched > ROOM_TTL) { rooms.delete(k); continue; }
    for (const [ck, c] of r.claims) if (now - c.at > 6 * 3600_000) r.claims.delete(ck);
  }
}, 10 * 60_000).unref();

/* V469 · la memoria de "último estado" no crece sin fin: posiciones viejas, chats y viajes de más de 3 días se sueltan */
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) for (const [k, m] of r.sticky) {
    if (!m) continue; const age = now - Number(m.at || 0);
    if ((m.type === 'driver-pos' || m.type === 'pax-pos' || m.type === 'approach-route') && age > 30 * 60_000) r.sticky.delete(k);
    else if (m.type === 'chat' && age > 6 * 3600_000) r.sticky.delete(k);
    else if (m.type === 'trip' && age > 3 * 86400_000) r.sticky.delete(k);
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
    if (r.data.id) { const mo = { amount, ok: authorized && captureMode === 'automatic', used: '', auth: authorized, ref: /^mobideuda_/.test(reference) ? 'deuda' : 'viaje', at: Date.now(), sk: authOf(req, 'pilot').sk || '' }; mpOrders.set(String(r.data.id), mo); kvSet('mpord', String(r.data.id), mo); }   /* V500 · el servidor recuerda los cobros reales */
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
    if (r.ok) { const k = String(req.params.orderId), mo = mpOrders.get(k); if (mo) { mo.ok = true; kvSet('mpord', k, mo); } }
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
  kvSet('admtok', crypto.createHash('sha256').update(token).digest('hex'), { exp: now + 12 * 3600_000, t: token });   /* V500 · la sesión del administrador sobrevive a un reinicio del servidor */
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
/* V459: si Meta responde 133016 (demasiados intentos de registro) no se vuelve a intentar por 24 h, aunque el servidor se reinicie
   (el momento se guarda en la base). Cualquier otro fallo espera 30 min. Así los reinicios no queman el límite de Meta. */
function waBlockRegister(ms) { waRegBlockUntil = Date.now() + ms; kvSet('wacfg', 'regblock', { until: waRegBlockUntil }); }
async function waRegister() {                                   // error 133010: el número de MOBI no está registrado → registrarlo
  if (!WA_TOKEN || !WA_PHONE_ID || Date.now() - waRegisterTried < 60_000) return false;
  if (Date.now() < waRegBlockUntil) { console.log('WA register: en pausa hasta', new Date(waRegBlockUntil).toISOString()); return false; }
  waRegisterTried = Date.now();
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/register`, {
      method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: WA_PIN })
    });
    const t = (await r.text()).slice(0, 300);
    console.log('WA register', r.status, t);
    if (r.ok) { waReady = true; await waSubscribe(); }
    else waBlockRegister(/133016/.test(t) ? 24 * 3600_000 : 30 * 60_000);
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
      if (st.ok && String(st.j.platform_type || '').toUpperCase() === 'CLOUD_API') waReady = true;
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
  res.json({ ok: true, verified: Boolean(v), at: v ? v.at : null, via: v ? (v.via || 'wa') : null, email: v && v.email || null });
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

/* ---------------- V494 · verificación sin Meta: Telegram (teléfono) y mail (Gmail API) ----------------
   Las dos dejan al usuario en waVerified igual que WhatsApp, así /api/wa/status y /api/account/find siguen igual.
   Se activan solas cuando están cargadas las variables en Render:
     Telegram: TG_BOT_TOKEN
     Mail:     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN  (opcional GMAIL_FROM_NAME) */
const TG_TOKEN = String(process.env.TG_BOT_TOKEN || '').trim();
const TG_API = String(process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const TG_SECRET = TG_TOKEN ? crypto.createHash('sha256').update('mobi-tg|' + TG_TOKEN).digest('hex').slice(0, 40) : '';
let tgUser = '';
const tgPending = new Map();   // token -> { userId, tail, at }
const tgChat = new Map();      // chatId -> token
async function tgCall(method, body) {
  const r = await fetch(`${TG_API}/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return j;
}
async function tgSetup() {
  if (!TG_TOKEN) return;
  try {
    const me = await tgCall('getMe');
    if (!me.ok) { console.log('Telegram: el token no funciona', JSON.stringify(me).slice(0, 160)); return; }
    tgUser = String(me.result.username || '');
    const base = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!base) { console.log('Telegram: falta la dirección pública del servidor (PUBLIC_URL)'); return; }
    const w = await tgCall('setWebhook', { url: base + '/api/tg/webhook', secret_token: TG_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
    console.log('Telegram listo · bot @' + tgUser, '· webhook', w.ok ? 'ok' : JSON.stringify(w).slice(0, 160));
  } catch (e) { console.warn('Telegram setup', e.message); }
}
setTimeout(tgSetup, 4000);
app.post('/api/tg/start', (req, res) => {
  const b = req.body || {}, userId = String(b.userId || '').slice(0, 60), tail = tail8(b.phone);
  if (!userId || tail.length < 8) return res.status(400).json({ ok: false, error: 'bad_input' });
  if (!TG_TOKEN || !tgUser) return res.json({ ok: true, configured: false });
  for (const [t, v] of tgPending) if (v.userId === userId) tgPending.delete(t);
  const token = crypto.randomBytes(12).toString('base64url');
  tgPending.set(token, { userId, tail, at: Date.now() });
  res.json({ ok: true, configured: true, link: `https://t.me/${tgUser}?start=${token}` });
});
app.post('/api/tg/webhook', (req, res) => {
  if (!TG_TOKEN || req.get('x-telegram-bot-api-secret-token') !== TG_SECRET) return res.sendStatus(403);
  res.sendStatus(200);
  (async () => {
    const m = (req.body && req.body.message) || null; if (!m || !m.chat) return;
    const chat = m.chat.id, text = String(m.text || '');
    if (/^\/start/.test(text)) {
      const token = text.split(/\s+/)[1] || '';
      if (!tgPending.has(token)) { await tgCall('sendMessage', { chat_id: chat, text: 'Este link venció. Volvé a MOBI y tocá «Verificar con Telegram» otra vez.' }); return; }
      tgChat.set(chat, token);
      await tgCall('sendMessage', { chat_id: chat, text: '👋 Hola, soy el verificador de MOBI.\nTocá el botón de abajo «📱 Compartir mi número» para confirmar tu celular.', reply_markup: { keyboard: [[{ text: '📱 Compartir mi número', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true } });
      return;
    }
    if (m.contact) {
      const token = tgChat.get(chat), p = token && tgPending.get(token);
      if (!p) { await tgCall('sendMessage', { chat_id: chat, text: 'Este pedido venció. Volvé a MOBI y empezá de nuevo.', reply_markup: { remove_keyboard: true } }); return; }
      if (!m.from || m.contact.user_id !== m.from.id) { await tgCall('sendMessage', { chat_id: chat, text: 'Tiene que ser tu propio número. Tocá el botón «📱 Compartir mi número».' }); return; }
      if (tail8(m.contact.phone_number) !== p.tail) { await tgCall('sendMessage', { chat_id: chat, text: 'Este número no coincide con el que cargaste en MOBI. Revisalo en la app y probá de nuevo.', reply_markup: { remove_keyboard: true } }); return; }
      tgPending.delete(token); tgChat.delete(chat);
      const v = { tail: p.tail, at: Date.now(), via: 'tg' }; waVerified.set(p.userId, v); kvSet('wa', p.userId, v);
      console.log('Telegram: número verificado · …' + p.tail.slice(-4));
      await tgCall('sendMessage', { chat_id: chat, text: '✅ Número verificado. Ya podés volver a MOBI.', reply_markup: { remove_keyboard: true } });
    }
  })().catch((e) => console.warn('Telegram webhook', e.message));
});
setInterval(() => { const now = Date.now(); for (const [t, v] of tgPending) if (now - v.at > 30 * 60_000) tgPending.delete(t); for (const [c, t] of tgChat) if (!tgPending.has(t)) tgChat.delete(c); }, 5 * 60_000).unref();

const GM_ID = String(process.env.GMAIL_CLIENT_ID || '').trim(), GM_SECRET = String(process.env.GMAIL_CLIENT_SECRET || '').trim(), GM_REFRESH = String(process.env.GMAIL_REFRESH_TOKEN || '').trim();
const GM_TOKEN_URL = process.env.GMAIL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GM_API = String(process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com').replace(/\/$/, '');
const GM_ON = Boolean(GM_ID && GM_SECRET && GM_REFRESH);
let gmAccess = { token: '', exp: 0 };
async function gmToken() {
  if (gmAccess.token && Date.now() < gmAccess.exp - 60_000) return gmAccess.token;
  const r = await fetch(GM_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GM_ID, client_secret: GM_SECRET, refresh_token: GM_REFRESH, grant_type: 'refresh_token' }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('gmail token ' + r.status + ' ' + JSON.stringify(j).slice(0, 120));
  gmAccess = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 }; return gmAccess.token;
}
async function gmSend(to, subject, html, text) {
  const tok = await gmToken(), bd = 'mobi' + crypto.randomBytes(8).toString('hex'), name = process.env.GMAIL_FROM_NAME || 'MOBI';
  const enc = (s) => '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
  const mime = [`From: ${enc(name)} <me>`, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${bd}"`, '',
    `--${bd}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(text, 'utf8').toString('base64'),
    `--${bd}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), `--${bd}--`, ''].join('\r\n');
  const r = await fetch(`${GM_API}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }) });
  if (!r.ok) throw new Error('gmail send ' + r.status + ' ' + (await r.text()).slice(0, 160));
}
const mailPending = new Map();   // userId -> { code, email, tail, at, tries }
const mailRate = new Map();      // email -> [timestamps]
let mailDay = { d: '', n: 0 };
const okMailAddr = (e) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i.test(e);
app.post('/api/mail/start', async (req, res) => {
  const b = req.body || {}, userId = String(b.userId || '').slice(0, 60), email = String(b.email || '').trim().toLowerCase().slice(0, 200), tail = tail8(b.phone);
  if (!userId || !okMailAddr(email)) return res.status(400).json({ ok: false, error: 'bad_email' });
  if (!GM_ON) return res.json({ ok: true, configured: false });
  const prev = mailPending.get(userId);
  if (prev && Date.now() - prev.at < 55_000) return res.status(429).json({ ok: false, error: 'wait', retryInSec: Math.ceil((60_000 - (Date.now() - prev.at)) / 1000) });
  const hist = (mailRate.get(email) || []).filter((t) => Date.now() - t < 3600_000);
  if (hist.length >= 5) return res.status(429).json({ ok: false, error: 'too_many' });
  const day = new Date().toISOString().slice(0, 10); if (mailDay.d !== day) mailDay = { d: day, n: 0 };
  if (mailDay.n >= 400) return res.status(429).json({ ok: false, error: 'daily' });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    await gmSend(email, `Tu código de MOBI: ${code}`,
      `<div style="background:#eef6f4;padding:24px 12px"><div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:28px 24px;border-radius:18px;background:#06212d;color:#eafff8;text-align:center"><img src="https://mobi-c6uo.onrender.com/icon-192.png" width="72" height="72" alt="MOBI" style="display:block;margin:0 auto 10px;border-radius:16px"><h2 style="margin:0 0 4px;color:#20e0ad;letter-spacing:3px">MOBI</h2><p style="margin:0 0 18px;color:#9fc3cf;font-size:13px">Viajes y envíos</p><p style="margin:0 0 14px">Tu código para verificar tu cuenta es:</p><div style="font-size:36px;font-weight:900;letter-spacing:10px;background:#0a3a52;border-radius:12px;padding:16px 6px;color:#ffffff">${code}</div><p style="font-size:13px;color:#9fc3cf;margin:18px 0 0">Vence en 15 minutos.<br>Si no lo pediste vos, ignorá este mail.</p></div></div>`,
      `Tu código de MOBI es ${code}. Vence en 15 minutos. Si no lo pediste vos, ignorá este mail.`);
  } catch (e) { console.warn('Mail', e.message); return res.status(502).json({ ok: false, error: 'send_failed' }); }
  hist.push(Date.now()); mailRate.set(email, hist); mailDay.n++;
  mailPending.set(userId, { code, email, tail, at: Date.now(), tries: 0 });
  console.log('Mail: código enviado a …@' + email.split('@')[1]);
  res.json({ ok: true, configured: true, sent: true });
});
app.post('/api/mail/check', (req, res) => {
  const b = req.body || {}, userId = String(b.userId || '').slice(0, 60), code = String(b.code || '').replace(/\D/g, '');
  const p = mailPending.get(userId);
  if (!p || Date.now() - p.at > 15 * 60_000) return res.json({ ok: false, error: 'expired' });
  if (++p.tries > 5) { mailPending.delete(userId); return res.json({ ok: false, error: 'too_many' }); }
  if (code !== p.code) return res.json({ ok: false, error: 'wrong', left: 5 - p.tries });
  mailPending.delete(userId);
  const v = { tail: p.tail, email: p.email, at: Date.now(), via: 'mail' }; waVerified.set(userId, v); kvSet('wa', userId, v);
  res.json({ ok: true, verified: true, email: p.email });
});
setInterval(() => { const now = Date.now(); for (const [u, v] of mailPending) if (now - v.at > 20 * 60_000) mailPending.delete(u); }, 5 * 60_000).unref();
let waReady = WA_IS_TEST;
app.get('/api/verify/methods', (_req, res) => { res.json({ ok: true, tg: Boolean(TG_TOKEN && tgUser), mail: GM_ON, wa: Boolean(WA_NUMBER && waReady) }); });


/* ---------------- fotos de documentos (conductores y vehículos) ----------------
   El conductor sube cada foto una vez al enviar a evaluación. Solo el administrador (con su token) puede verlas,
   y el propio dueño cuando recupera su cuenta con WhatsApp. */
const DOC_KINDS = new Set(['cedula', 'license', 'dniF', 'dniB', 'profile', 'proof', 'delivery']);
const docMem = new Map();                                        // owner|kind -> { img, at }  (respaldo si no hay base)
const okOwner = (o) => /^(drv_[a-z0-9]{3,20}|car:drv_[a-z0-9]{3,20}:[A-Z0-9]{5,8}|trip_[A-Za-z0-9]{6,30})$/.test(String(o || ''));
app.post('/api/docs/put', async (req, res) => {
  const b = req.body || {}, owner = String(b.owner || ''), kind = String(b.kind || ''), img = String(b.img || '');
  if (!okOwner(owner) || !DOC_KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'bad_owner_or_kind' });
  { const au = authOf(req, String(b.room || 'pilot')), oid = owner.replace(/^car:/, '').split(':')[0], kd = /^drv_/.test(oid) ? 'drv' : '';   /* V500 · las fotos de una cuenta solo las sube su dueño */
    if (kd && !adminOk(String((req.headers || {})['x-mobi-adm'] || ''))) { const rm = getRoom(/^sandbox/.test(String(b.room || '')) ? 'pilot' : b.room); if (!isOwner(rm, kd, oid, au.sk, !ownGet(rm, kd, oid))) return res.status(403).json({ ok: false, error: 'forbidden' }); } }   /* las fotos se guardan para todas las salas: el sandbox no sirve para pisarlas */
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
function sbxOk(b) { return String(b && b.token) === 'sbx' && /^sandbox/.test(String((b && b.room) || '')); }   /* el sandbox no tiene clave real: solo vale para su propia sala de pruebas */
function adminOk(t) { const exp = adminTokens.get(String(t || '')); return !!(exp && exp > Date.now()); }

/* V352 · aprobar / rechazar cambios de datos de un pasajero · solo administrador */
/* V503 · contador de descargas: la landing avisa con una imagen invisible (GET), sin datos personales */
app.get('/api/dl', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const k = String(req.query.k || '');
    if (DL_KINDS.includes(k)) {
      const ip = String((req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim();
      const who = crypto.createHash('sha256').update(ip + '|' + String(req.headers['user-agent'] || '')).digest('hex').slice(0, 24) + k;
      const now = Date.now(), last = dlSeen.get(who) || 0;
      if (now - last > 20 * 60_000) {
        dlSeen.set(who, now);
        if (dlSeen.size > 20000) for (const [h, t] of dlSeen) if (now - t > 20 * 60_000) dlSeen.delete(h);
        const o = dlStat[k], day = dlDay(now); o.t++; o.d[day] = (o.d[day] || 0) + 1;
        const keys = Object.keys(o.d).sort(); while (keys.length > 120) delete o.d[keys.shift()];
        dlSave();
      }
    }
  } catch (e) {}
  res.status(204).end();
});
app.post('/api/admin/downloads', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const out = {};
  for (const k of DL_KINDS) {
    const o = dlStat[k], days = [];
    for (let i = 13; i >= 0; i--) { const d = dlDay(Date.now() - i * 86400_000); days.push({ d, n: o.d[d] || 0 }); }
    out[k] = { total: o.t, today: days[13].n, d7: days.slice(7).reduce((a, x) => a + x.n, 0), days };
  }
  res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, counts: out, serverTime: Date.now() });
});
/* V510 · la cuenta del conductor, calculada por el servidor (la misma en la APK y en el navegador) */
app.post('/api/debt/me', (req, res) => {
  const b = req.body || {}, r = getRoom(b.room), drv = String(b.driver || ''), au = authOf(req, r.name);
  if (!OWN_RE.drv.test(drv)) return res.status(400).json({ ok: false, error: 'datos' });
  if (!au.admin && !ownHas(r, 'drv', drv, au.sk)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const L = ledgerOf(r, drv);
  res.json({ ok: true, at: Date.now(), debt: L.debt, favor: L.favor, avail: L.avail, held: L.held, payPend: Math.round(L.payPend * 100) / 100, list: L.list.map((y) => { const o = Object.assign({}, y); delete o.paxIdent; delete o.paxSk; return o; }) });
});
/* V510 · el administrador libera a mano un saldo retenido (por ejemplo, un cobro con tarjeta que no se pudo comprobar solo) */
app.post('/api/admin/release', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), id = String(b.id || ''), x = r.sticky.get('debt-charge|dc:' + id);
  if (!x || !x.data || !x.data.hold) return res.status(404).json({ ok: false, error: 'no_retenido' });
  const ok = b.ok !== false;
  const saved = pushMessage(r, { type: 'debt-charge', key: x.key, src: 'admin', data: Object.assign({}, x.data, ok ? { hold: false, releasedAt: Date.now(), releasedBy: 'admin' } : { hold: true, voidAt: Date.now(), amount: x.data.amount }) });
  res.json({ ok: true, id: saved && saved.id });
});
/* V510 · comisión: si un viaje terminó y el celular del conductor no registró la comisión, la registra el servidor (una sola por viaje) */
const COMM_GRACE = Number(process.env.COMM_GRACE_MS || 30 * 60_000);
function commissionSweep(room, grace) {
  const G = Number.isFinite(grace) ? grace : COMM_GRACE;
  const now = Date.now(), pm = room.sticky.get('cfg-price|cfg:price'), pc = Object.assign({ commissionPct: 3, promoPct: 0, promoUntil: 0 }, (pm && pm.data) || {});
  const pct = Number(pc.promoUntil) > now ? Number(pc.promoPct) || 0 : Number(pc.commissionPct); if (!(pct > 0)) return;
  const fs = fState(room), charges = [];
  for (const x of room.sticky.values()) if (x && x.type === 'debt-charge' && x.data && x.data.type === 'charge' && /^Comisi[oó]n de viaje/i.test(String(x.data.note || ''))) charges.push(x.data);
  for (const [key, x] of room.sticky) {
    if (!x || x.type !== 'trip' || !/:drv$/.test(key) || !x.data || !x.data.active) continue;
    const a = x.data.active, k = String(a.tripKey || ''), st = String(a.status || '');
    if (!k || !/^(Cobro pendiente|Finalizado|Entregado)$/i.test(st)) continue;
    if (now - Number(x.at || 0) < G || now - Number(x.at || 0) > 2 * 86400_000) continue;
    const drv = String((a.driver && a.driver.id) || ''); if (!OWN_RE.drv.test(drv) || (fs.ids && fs.ids[drv])) continue;
    if (room.sticky.has('debt-charge|dc:com:' + k) || room.sticky.has('pay-dispute|pd:pd_' + k)) continue;
    const pax = stickyData(room, 'trip|tr:' + k + ':pax'), pa = (pax && pax.active) || {};
    if (/Cancel/i.test(String(pa.status || ''))) continue;
    const fare = Number(pa.fare || a.fare || 0), cf = Math.max(0, Math.min(fare, Number(pa.cancelFee || a.cancelFee || 0))), pu = Math.max(0, Number(pa.paxCredit || a.paxCredit || 0));
    if (!(fare > 0)) continue;
    const t0 = Number(x.at || 0);
    if (charges.some((c) => String(c.driver) === drv && (String(c.tripKey || '') === k || (!c.tripKey && Math.abs(Number(c.fare || 0) - fare) < 1 && Math.abs(Number(c.at || 0) - t0) < 3 * 3600_000)))) continue;
    const fee = Math.round((fare + pu - cf) * pct) / 100; if (!(fee > 0)) continue;
    pushMessage(room, { type: 'debt-charge', key: 'dc:com:' + k, src: 'admin', data: { id: 'com_' + k.slice(0, 40), type: 'charge', amount: fee, at: now, driver: drv, note: 'Comisión de viaje (' + pct + '%) · registrada por MOBI', fare, tripKey: k, srv: 1 } });
    console.log('Comisión registrada por el servidor', drv, k, fee);
  }
}
setInterval(() => { for (const r of rooms.values()) { try { commissionSweep(r); } catch (e) { console.warn('comision', e.message); } } }, 5 * 60_000).unref();
app.post('/api/admin/commsweep', (req, res) => { const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false }); commissionSweep(getRoom(b.room), Number.isFinite(Number(b.grace)) ? Number(b.grace) : undefined); res.json({ ok: true }); });

app.post('/api/admin/paxchg', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const id = String(b.id || ''), status = b.status === 'aprobado' ? 'aprobado' : b.status === 'rechazado' ? 'rechazado' : '';
  if (!/^pax_[a-z0-9]{3,20}$/.test(id) || !status) return res.status(400).json({ ok: false, error: 'datos' });
  const rm = getRoom(b.room), pend = stickyData(rm, 'pax-chg|pc:' + id);
  const data = { id, rid: String((pend && pend.rid) || b.rid || '').slice(0, 40), status, reason: String(b.reason || '').slice(0, 200), at: Date.now() };
  const _unused = null, cur = stickyData(rm, 'pax-reg|pr:' + id);
  if (status === 'aprobado' && pend && cur && pend.status === 'pendiente') {   /* V500 · el servidor aplica el cambio aprobado (el celular ya no puede cambiar nombre ni DNI solo) */
    const n = Object.assign({}, cur);
    ['name', 'dni', 'email', 'emName', 'emPhone', 'dniImg', 'photo'].forEach((k) => { if (pend[k] !== undefined && pend[k] !== null && String(pend[k]) !== '') n[k] = pend[k]; });
    n.upd = Date.now(); pushMessage(rm, { type: 'pax-reg', key: 'pr:' + id, src: 'admin', data: n });
  }
  const saved = pushMessage(rm, { type: 'pax-chg', key: 'pc:' + id, src: 'admin', data });
  res.json({ ok: true, data, id: saved && saved.id });
});

/* V500 · cambios de datos de un conductor aprobado (nombre, DNI, vehículo, fotos): los pide el conductor y los aprueba el administrador */
app.post('/api/admin/drvchg', async (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const id = String(b.id || ''), status = b.status === 'aprobado' ? 'aprobado' : b.status === 'rechazado' ? 'rechazado' : '';
  if (!OWN_RE.drv.test(id) || !status) return res.status(400).json({ ok: false, error: 'datos' });
  const rm = getRoom(b.room), pend = stickyData(rm, 'drv-chg|xc:' + id), cur = stickyData(rm, 'driver-reg|dr:' + id);
  if (!pend || pend.status !== 'pendiente') return res.status(409).json({ ok: false, error: 'sin_pedido' });
  if (status === 'aprobado' && cur) {
    const n = Object.assign({}, cur);
    ['name', 'dni', 'plate', 'vehicle'].forEach((k) => { if (pend[k] !== undefined && String(pend[k] || '').trim()) n[k] = String(pend[k]).trim(); });
    const imgs = pend.imgs && typeof pend.imgs === 'object' ? pend.imgs : {};
    if (adminOk(b.token)) for (const kind of Object.keys(imgs)) { const img = String(imgs[kind] || ''); if (!['cedula', 'license', 'dniF', 'dniB', 'profile'].includes(kind) || !/^data:image\/(jpeg|png|webp);base64,/.test(img)) continue;
      const item = { img, at: Date.now() }; docMem.set(id + '|' + kind, item); await kvSet('doc', id + '|' + kind, item); n.docs = Object.assign({}, n.docs, { [kind]: true }); }
    n.updatedAt = Date.now(); n.chgAt = Date.now();
    pushMessage(rm, { type: 'driver-reg', key: 'dr:' + id, src: 'admin', data: n });
  }
  const data = { id, rid: String(pend.rid || '').slice(0, 40), status, reason: String(b.reason || '').slice(0, 200), at: Date.now() };
  if (status === 'aprobado') Object.assign(data, { name: pend.name, dni: pend.dni, plate: pend.plate, vehicle: pend.vehicle, imgs: pend.imgs });   /* el celular del conductor guarda lo aprobado */
  const saved = pushMessage(rm, { type: 'drv-chg', key: 'xc:' + id, src: 'admin', data });
  console.log('Cambio de datos de conductor', id, status);
  res.json({ ok: true, data: { id, status }, id: saved && saved.id });
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
    envioOn: c.envioOn === 0 || c.envioOn === false ? 0 : 1, envioPct: num(c.envioPct, 0, 100, 15),
    tgtOn: c.tgtOn === 0 || c.tgtOn === false ? 0 : 1, tgtDisc: num(c.tgtDisc, 0, 40, 15), didiBase: num(c.didiBase, 0, 50000, 3000), didiMin: num(c.didiMin, 0, 100000, 3700), didiKm: num(c.didiKm, 0, 5000, 580), didiTierKm: num(c.didiTierKm, 0, 100, 6), didiKm2: num(c.didiKm2, 0, 5000, 170), didiTier2Km: num(c.didiTier2Km, 0, 200, 12), b1On: c.b1On ? 1 : 0, b1Days: num(c.b1Days, 0, 127, 62), b1From: num(c.b1From, 0, 23, 6), b1To: num(c.b1To, 0, 24, 8), b1Pct: num(c.b1Pct, 0, 150, 20), b2On: c.b2On ? 1 : 0, b2Days: num(c.b2Days, 0, 127, 62), b2From: num(c.b2From, 0, 23, 12), b2To: num(c.b2To, 0, 24, 13), b2Pct: num(c.b2Pct, 0, 150, 20), b3On: c.b3On ? 1 : 0, b3Days: num(c.b3Days, 0, 127, 62), b3From: num(c.b3From, 0, 23, 17), b3To: num(c.b3To, 0, 24, 19), b3Pct: num(c.b3Pct, 0, 150, 15), b4On: c.b4On ? 1 : 0, b4Days: num(c.b4Days, 0, 127, 31), b4From: num(c.b4From, 0, 23, 22), b4To: num(c.b4To, 0, 24, 6), b4Pct: num(c.b4Pct, 0, 150, 25), b5On: c.b5On ? 1 : 0, b5Days: num(c.b5Days, 0, 127, 96), b5From: num(c.b5From, 0, 23, 21), b5To: num(c.b5To, 0, 24, 4), b5Pct: num(c.b5Pct, 0, 150, 40), didiKm3: num(c.didiKm3, 0, 10000, 1500), floorPct: num(c.floorPct, 30, 100, 70), at: Date.now()
  };
  const saved = pushMessage(getRoom(b.room), { type: 'cfg-price', key: 'cfg:price', src: 'admin', data });
  console.log('Tarifas actualizadas', JSON.stringify(data));
  res.json({ ok: true, data, id: saved && saved.id });
});


/* ---------------- V473 · CUPO de conductores con lista de espera (todo automático) ----------------
   El administrador aprueba a todos; el sistema habilita por fecha de registro hasta el cupo (0 = sin límite).
   Si un habilitado pasa N días sin conectarse, su lugar pasa solo al siguiente de la fila (y él vuelve al final). */
const CUPO_BOOT = Date.now();
function cupoCfg(r) { const m = r.sticky.get('cfg-cupo|cfg:cupo'); const d = (m && m.data) || {}; return { cupo: Math.max(0, Math.min(5000, Math.floor(Number(d.cupo)) || 0)), days: Math.max(1, Math.min(60, Math.floor(Number(d.days)) || 3)) }; }
function cupoState(r) { const m = r.sticky.get('drv-slots|slots'); const d = (m && m.data) || {}; return { enabled: Object.assign({}, d.enabled), waited: Object.assign({}, d.waited), notify: Object.assign({}, d.notify), lapsed: Object.assign({}, d.lapsed) }; }
function cupoWaiting(r, id) {
  const m = r.sticky.get('drv-slots|slots'); const d = m && m.data; if (!d || !(d.cupo > 0)) return false;
  return !(d.enabled && d.enabled[id]) && !!(d.known && d.known[id]);
}
/* V487 · un conductor oculto de la lista solo queda afuera si no se reenvió después de ocultarlo (igual que la app) */
const drvHidden = (d) => !!(d.hiddenAt && !(Number(d.submittedAt || 0) > Number(d.hiddenAt)));
function cupoCompute(r) {
  const cfg = cupoCfg(r), st = cupoState(r), now = Date.now(), dayMs = 86400000;
  const el = [];
  for (const m of r.sticky.values()) {
    if (!m || m.type !== 'driver-reg' || !m.data) continue; const d = m.data;
    if (d.status !== 'aprobado' || drvHidden(d) || d.deletedAt || !d.id) continue;
    el.push({ id: String(d.id), t: Number(st.lapsed[d.id]) || Number(d.registeredAt) || Number(d.submittedAt) || Number(d.reviewedAt) || 0 });
  }
  el.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const ids = new Set(el.map((x) => x.id)), known = {}; el.forEach((x) => { known[x.id] = 1; });
  const enabled = {}, waited = Object.assign({}, st.waited), notify = Object.assign({}, st.notify), lapsed = Object.assign({}, st.lapsed);
  if (!(cfg.cupo > 0)) { for (const x of el) { enabled[x.id] = st.enabled[x.id] || now; if (waited[x.id] && !st.enabled[x.id]) notify[x.id] = now; } }
  else {
    let n = 0;
    for (const x of el) {   // los que ya tenían lugar y siguen activos lo conservan
      const at = st.enabled[x.id]; if (!at) continue;
      const seen = Math.max(Number(r.seen && r.seen.get(x.id)) || 0, Number(at) || 0, CUPO_BOOT);
      if (now - seen > cfg.days * dayMs) { lapsed[x.id] = now; delete notify[x.id]; continue; }
      if (n >= cfg.cupo) continue;   /* se bajó el cupo: quedan los más antiguos */
      enabled[x.id] = at; n++;
    }
    for (const x of el) {   // el resto, por orden de fila
      if (enabled[x.id]) continue;
      if (n < cfg.cupo) { enabled[x.id] = now; n++; if (waited[x.id]) notify[x.id] = now; }
      else waited[x.id] = waited[x.id] || now;
    }
  }
  for (const k of Object.keys(notify)) if (!ids.has(k) || !enabled[k]) delete notify[k];
  const waiting = el.filter((x) => !enabled[x.id]).map((x) => x.id);
  if (r.sticky.has('drv-slots|slots')) {   /* V478 · avisos push: lugar nuevo / lista de espera (textos editables en Administración) */
    for (const id of Object.keys(enabled)) if (!st.enabled[id]) pushNotify(id, pushText(r, waited[id] ? 'freed' : 'approved'));
    for (const id of waiting) if (!st.waited[id]) pushNotify(id, pushText(r, 'waiting'));
  }
  const sig = JSON.stringify([Object.keys(enabled).sort(), waiting, Object.keys(notify).sort(), cfg.cupo, cfg.days]);
  if (r._cupoSig === sig) return; r._cupoSig = sig;
  pushMessage(r, { type: 'drv-slots', key: 'slots', src: 'server', data: { enabled, waiting, waited, notify, lapsed, known, cupo: cfg.cupo, days: cfg.days, total: el.length, at: now } });
}
setInterval(() => { for (const r of rooms.values()) { try { cupoCompute(r); } catch (e) { console.warn('cupo', e.message); } } }, 30_000).unref();
app.post('/api/admin/cupo', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), num = (v, lo, hi, d) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const data = { cupo: num(b.cupo, 0, 5000, 0), days: num(b.days, 1, 60, 3), at: Date.now() };
  pushMessage(r, { type: 'cfg-cupo', key: 'cfg:cupo', src: 'admin', data });
  cupoCompute(r);
  console.log('Cupo actualizado', JSON.stringify(data));
  res.json({ ok: true, data });
});
app.post('/api/admin/cupo-notified', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), m = r.sticky.get('drv-slots|slots'), id = String(b.id || '');
  if (m && m.data && m.data.notify && m.data.notify[id]) { const d = Object.assign({}, m.data, { notify: Object.assign({}, m.data.notify) }); delete d.notify[id]; r._cupoSig = ''; pushMessage(r, { type: 'drv-slots', key: 'slots', src: 'server', data: d }); }
  res.json({ ok: true });
});


/* ---------------- V484 · CHOFERES FUNDADORES ----------------
   Los primeros N conductores aprobados (por fecha de registro) quedan como fundadores: sin comisión y sin deuda con MOBI.
   El administrador puede quitar a uno (su lugar pasa al siguiente) o sumar a mano. Un fundador quitado no vuelve solo. */
function fCfg(r) { const m = r.sticky.get('cfg-founder|cfg:founder'); const d = (m && m.data) || {}; const cap = Math.floor(Number(d.cap)); const mp = Number(d.mp); return { cap: Number.isFinite(cap) ? Math.min(500, Math.max(0, cap)) : 30, auto: d.auto === undefined ? 1 : (d.auto ? 1 : 0), mp: Number.isFinite(mp) ? Math.min(30, Math.max(0, Math.round(mp * 100) / 100)) : 0 }; }
function fState(r) { const m = r.sticky.get('drv-founders|founders'); const d = (m && m.data) || {}; return { ids: Object.assign({}, d.ids), removed: Object.assign({}, d.removed) }; }
function fEligible(r) {
  const el = [];
  for (const m of r.sticky.values()) {
    if (!m || m.type !== 'driver-reg' || !m.data) continue; const d = m.data;
    if (d.status !== 'aprobado' || drvHidden(d) || d.deletedAt || !d.id) continue;
    el.push({ id: String(d.id), t: Number(d.registeredAt) || Number(d.submittedAt) || Number(d.reviewedAt) || 0, dni: String(d.dni || '').replace(/\D/g, ''), ph: String(d.phone || '').replace(/\D/g, '') });
  }
  el.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return el;
}
/* V486 · 1° chofer fundador (dueño de MOBI): se reconoce por DNI o teléfono. Fijo, no ocupa cupo, no se puede quitar. */
const FIRST_DNI = '28098817', FIRST_PH8 = '64634473';   /* teléfono: últimos 8 dígitos (sirve con 11… o 15…) */
function fFirst(el) { const x = el.find((e) => e.dni === FIRST_DNI || (e.ph && e.ph.slice(-8) === FIRST_PH8)); return x ? x.id : ''; }
function founderPublish(r, ids, removed, cfg, total, first) {
  first = first || '';
  if (first) { ids = Object.assign({}, ids, { [first]: 1 }); removed = Object.assign({}, removed); delete removed[first]; }
  const sig = JSON.stringify([Object.keys(ids).sort(), Object.keys(removed).sort(), cfg.cap, cfg.auto, cfg.mp, first]);
  if (r._fSig === sig) return false; r._fSig = sig;
  pushMessage(r, { type: 'drv-founders', key: 'founders', src: 'server', data: { ids, removed, cap: cfg.cap, auto: cfg.auto, mp: cfg.mp, total, first, at: Date.now() } });
  return true;
}
function founderCompute(r) {
  const cfg = fCfg(r), st = fState(r), el = fEligible(r), now = Date.now(), ok = new Set(el.map((x) => x.id));
  const ids = {}, removed = Object.assign({}, st.removed), first = fFirst(el);
  for (const k of Object.keys(st.ids)) if (ok.has(k) && !removed[k] && k !== first) ids[k] = st.ids[k];   /* los que ya son fundadores se conservan (aunque se baje el cupo) */
  let n = Object.keys(ids).length;
  if (cfg.auto) for (const x of el) { if (n >= cfg.cap) break; if (x.id === first || ids[x.id] || removed[x.id]) continue; ids[x.id] = now; n++; }
  founderPublish(r, ids, removed, cfg, el.length, first);
  try {   /* diagnóstico: una línea en el log cada vez que cambia algo */
    const by = {}; for (const m of r.sticky.values()) if (m && m.type === 'driver-reg' && m.data) { const k = m.data.status || '?'; by[k] = (by[k] || 0) + 1; if (k === 'aprobado' && !el.some((x) => x.id === String(m.data.id))) by.aprobado_excluido = (by.aprobado_excluido || 0) + 1; }
    const sg = JSON.stringify([by, el.length, Object.keys(ids).length, first]);
    if (r._fLog !== sg) { r._fLog = sg; console.log('Fundadores [' + r.name + '] conductores por estado ' + JSON.stringify(by) + ' · elegibles ' + el.length + ' · fundadores ' + Object.keys(ids).length + ' · primero ' + (first || 'no'));  }
  } catch (e) {}
}
setInterval(() => { for (const r of rooms.values()) { try { founderCompute(r); } catch (e) { console.warn('founder', e.message); } } }, 30_000).unref();
app.post('/api/admin/founder-cfg', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), n = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const data = { cap: Math.floor(n(b.cap, 0, 500, 30)), auto: b.auto ? 1 : 0, mp: Math.round(n(b.mp, 0, 30, 0) * 100) / 100, at: Date.now() };
  pushMessage(r, { type: 'cfg-founder', key: 'cfg:founder', src: 'admin', data });
  founderCompute(r);
  console.log('Fundadores config', JSON.stringify(data));
  res.json({ ok: true, data });
});
app.post('/api/admin/founder-set', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), id = String(b.id || ''), cfg = fCfg(r), st = fState(r), el = fEligible(r);
  if (!id || !el.some((x) => x.id === id)) return res.status(404).json({ ok: false, error: 'driver' });
  const first = fFirst(el); if (id === first) return res.status(409).json({ ok: false, error: 'first' });
  const ids = Object.assign({}, st.ids), removed = Object.assign({}, st.removed); if (first) delete ids[first];
  if (b.on) {
    if (!ids[id] && Object.keys(ids).length >= cfg.cap) return res.status(409).json({ ok: false, error: 'full', cap: cfg.cap });
    ids[id] = ids[id] || Date.now(); delete removed[id];
  } else { delete ids[id]; removed[id] = Date.now(); }
  r._fSig = '';
  founderPublish(r, ids, removed, cfg, el.length, first);
  founderCompute(r);   /* si sobra lugar y está el automático, pasa al siguiente */
  console.log('Fundador', id, b.on ? 'sumado' : 'quitado');
  res.json({ ok: true });
});


/* ---------------- V485 · HISTORIAL DE CONDUCTORES para el administrador (viajes con recorrido + horarios de conexión) ----------------
   Se guarda aparte de los mensajes del bus (que se limpian a los 3 días): un registro corto por viaje y por sesión conectada. */
const dHist = new Map(), dSess = new Map(), dDirty = new Set();
const HK = (room, id) => (typeof room === 'string' ? room : room.name) + '|' + String(id);
function histIngest(room, msg) {
  const d = msg.data; if (!d || !Array.isArray(d.hist)) return;
  const it = (d.hist.find((h) => h && h.role === 'drv') || {}).item; if (!it || !it.driverId) return;
  const k = HK(room, it.driverId), l = dHist.get(k) || [], id = String((d.ledger && d.ledger.tripId) || it.id || '');
  if (!id || l.some((x) => x.id === id)) return;
  l.push({ id, at: Number(it.at) || Date.now(), route: String(it.route || '').slice(0, 200), stop: String(it.stop || '').slice(0, 120), fare: Number(it.fare) || 0, net: Number(it.net) || 0, fee: Number(it.fee) || 0, payment: String(it.payment || '').slice(0, 30), status: String(it.status || '').slice(0, 30), pax: String(it.other || '').slice(0, 60), plate: String((d.ledger && d.ledger.plate) || it.plate || '').slice(0, 12) });
  if (l.length > 1500) l.splice(0, l.length - 1500);
  dHist.set(k, l); dDirty.add('dhist|' + k);
  /* V495 · viajes por pasajero (para el buscador de Administración) */
  /* V513 · el pasajero real del viaje sale de quién pidió el viaje (antes se tomaba un dato del celular del conductor) */
  const tsk = d.tripKey ? tripPax.get(room.name + '|' + String(d.tripKey)) || '' : '', idt = tsk ? paxIdentOfSk(room, tsk) : '';
  const pid = idt.startsWith('pax:') ? idt.slice(4) : (tsk ? 'sk:' + tsk : String(it.paxId || (d.sum && d.sum.paxId) || ''));
  if (pid) { const pk = HK(room, 'p:' + pid), pl = dHist.get(pk) || []; if (!pl.some((x) => x.id === id)) { const sd = (d.sum && d.sum.driver) || {}; pl.push({ id, at: Number(it.at) || Date.now(), fare: Number(it.fare) || 0, route: String(it.route || '').slice(0, 200), stop: String(it.stop || '').slice(0, 120), payment: String(it.payment || '').slice(0, 30), status: String(it.status || '').slice(0, 30), drvName: String(sd.name || '').slice(0, 60), plate: String(sd.plate || (d.ledger && d.ledger.plate) || '').slice(0, 12), driverId: String(it.driverId || '') }); if (pl.length > 1500) pl.splice(0, pl.length - 1500); dHist.set(pk, pl); dDirty.add('dhist|' + pk); } }
}
function presIngest(room, msg) {
  const d = msg.data; if (!d || !d.id) return;
  const k = HK(room, d.id), now = Date.now(), s = dSess.get(k) || { list: [], cur: null }, online = d.online !== false;
  if (online) {
    if (s.cur && now - s.cur.last <= 4 * 60_000) s.cur.last = now;
    else { if (s.cur) s.list.push({ from: s.cur.from, to: s.cur.last }); s.cur = { from: now, last: now }; }
  } else if (s.cur) { s.list.push({ from: s.cur.from, to: now }); s.cur = null; }
  if (s.list.length > 400) s.list.splice(0, s.list.length - 400);
  dSess.set(k, s); dDirty.add('dsess|' + k);
}
async function histFlush() {
  if (!dDirty.size) return; const keys = [...dDirty]; dDirty.clear();
  for (const x of keys) { const i = x.indexOf('|'), ns = x.slice(0, i), k = x.slice(i + 1); try { await kvSet(ns, k, ns === 'dhist' ? { list: dHist.get(k) || [] } : (dSess.get(k) || { list: [], cur: null })); } catch (e) { dDirty.add(x); } }
}
setInterval(() => { histFlush().catch(() => {}); }, 45_000).unref();
async function histLoad() {
  if (!db) return;
  try { const r = await db.query(`SELECT ns, id, data FROM mobi_kv WHERE ns IN ('dhist','dsess')`); for (const row of r.rows) { if (row.ns === 'dhist') dHist.set(row.id, (row.data && row.data.list) || []); else dSess.set(row.id, row.data || { list: [], cur: null }); } console.log('Historial de conductores cargado:', dHist.size, 'con viajes,', dSess.size, 'con conexiones'); } catch (e) { console.warn('histLoad', e.message); }
}
app.post('/api/admin/driver-history', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), id = String(b.id || ''); if (!id) return res.status(400).json({ ok: false, error: 'id' });
  const k = HK(r, id), seen = new Set(), trips = [];
  for (const x of (dHist.get(k) || [])) { seen.add(x.id); trips.push(x); }
  for (const m of r.sticky.values()) {   /* viajes que todavía están en el bus y no se anotaron (anteriores a esta versión) */
    if (!m || m.type !== 'trip-done' || !m.data || !Array.isArray(m.data.hist)) continue;
    const it = (m.data.hist.find((h) => h && h.role === 'drv') || {}).item; if (!it || String(it.driverId) !== id) continue;
    const tid = String((m.data.ledger && m.data.ledger.tripId) || it.id || ''); if (!tid || seen.has(tid)) continue; seen.add(tid);
    trips.push({ id: tid, at: Number(it.at) || m.at, route: String(it.route || ''), stop: String(it.stop || ''), fare: Number(it.fare) || 0, net: Number(it.net) || 0, fee: Number(it.fee) || 0, payment: String(it.payment || ''), status: String(it.status || ''), pax: String(it.other || ''), plate: String((m.data.ledger && m.data.ledger.plate) || it.plate || '') });
  }
  trips.sort((a, c) => c.at - a.at);
  const s = dSess.get(k) || { list: [], cur: null }, now = Date.now();
  const sessions = s.list.slice(-200).concat(s.cur ? [{ from: s.cur.from, to: s.cur.last, live: now - s.cur.last < 60_000 }] : []).reverse();
  res.json({ ok: true, trips: trips.slice(0, 500), totalTrips: trips.length, sessions: sessions.slice(0, 200), seenAt: Number(r.seen && r.seen.get(id)) || 0 });
});

/* V513 · «Mi historial» desde el servidor: los viajes no se pierden al reinstalar la app, cambiar de celular o pasar de la APK al navegador.
   Solo el dueño de la cuenta (celular vinculado) puede pedir el suyo. */
app.post('/api/my/history', (req, res) => {
  const b = req.body || {}, r = getRoom(b.room), au = authOf(req, r.name);
  const drv = String(b.drv || ''), pax = String(b.pax || ''), out = { drv: [], pax: [] };
  const okD = OWN_RE.drv.test(drv) && (au.admin || ownHas(r, 'drv', drv, au.sk));
  const okP = OWN_RE.pax.test(pax) && (au.admin || ownHas(r, 'pax', pax, au.sk));
  if (!okD && !okP && !au.sk) return res.status(403).json({ ok: false, error: 'forbidden' });
  const byId = new Map();   /* viajes de conductores por id (para completar los del pasajero viejos) */
  if (okP) for (const [k, l] of dHist) if (k.startsWith(r.name + '|') && !k.startsWith(r.name + '|p:')) for (const x of l) byId.set(x.id, Object.assign({ driverId: k.slice(r.name.length + 1) }, x));
  if (okD) for (const x of (dHist.get(HK(r, drv)) || [])) out.drv.push({ id: 'srv_' + x.id, at: x.at, route: x.route, stop: x.stop, fare: x.fare, net: x.net, fee: x.fee, payment: x.payment, status: x.status || 'Finalizado', other: x.pax, driverId: drv, srv: 1 });
  const okS = !!au.sk && !au.admin;   /* viajes pedidos desde ESTE celular aunque la cuenta no esté vinculada */
  if (okS && !byId.size) for (const [k, l] of dHist) if (k.startsWith(r.name + '|') && !k.startsWith(r.name + '|p:')) for (const x of l) byId.set(x.id, Object.assign({ driverId: k.slice(r.name.length + 1) }, x));
  const paxLists = [].concat(okP ? (dHist.get(HK(r, 'p:' + pax)) || []) : [], okS ? (dHist.get(HK(r, 'p:sk:' + au.sk)) || []) : []), seenP = new Set();
  if (paxLists.length) for (const x of paxLists) {
    if (seenP.has(x.id)) continue; seenP.add(x.id);
    const dx = byId.get(x.id) || {};
    out.pax.push({ id: 'srv_' + x.id, at: x.at, route: x.route || dx.route || '', stop: x.stop || dx.stop || '', fare: x.fare || dx.fare || 0, payment: x.payment || dx.payment || '', status: x.status || dx.status || 'Finalizado', other: x.drvName || '', plate: x.plate || dx.plate || '', paxId: pax, driverId: x.driverId || dx.driverId || '', srv: 1 });
  }
  out.drv.sort((p, q) => q.at - p.at); out.pax.sort((p, q) => q.at - p.at);
  res.json({ ok: true, drv: out.drv.slice(0, 300), pax: out.pax.slice(0, 300) });
});

/* V495 · estadísticas de usuarios para el buscador de Administración (viajes por conductor y por pasajero) */
app.post('/api/admin/user-stats', (req, res) => {
  const bd = req.body || {};
  if (!adminOk(bd.token) && !sbxOk(bd)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(bd.room), out = { drv: {}, pax: {} };
  const ids = (a) => (Array.isArray(a) ? a : []).map((x) => String(x || '')).filter(Boolean).slice(0, 2000);
  const seenT = new Set();
  const add = (kind, id, tid, at) => { const o = out[kind][id] || (out[kind][id] = { trips: 0, last: 0 }); o.trips++; if (at > o.last) o.last = at; seenT.add(kind + '|' + id + '|' + tid); };
  for (const id of ids(bd.drv)) for (const x of (dHist.get(HK(r, id)) || [])) add('drv', id, x.id, Number(x.at) || 0);
  for (const id of ids(bd.pax)) for (const x of (dHist.get(HK(r, 'p:' + id)) || [])) add('pax', id, x.id, Number(x.at) || 0);
  const wantD = new Set(ids(bd.drv)), wantP = new Set(ids(bd.pax));
  for (const m of r.sticky.values()) {   /* viajes que todavía están en el bus y no se anotaron */
    if (!m || m.type !== 'trip-done' || !m.data || !Array.isArray(m.data.hist)) continue;
    const tid = String((m.data.ledger && m.data.ledger.tripId) || '');
    for (const h of m.data.hist) { const it = h && h.item; if (!it) continue; const t2 = tid || String(it.id || '').replace(/[dp]$/, ''), at = Number(it.at) || m.at;
      if (it.driverId && wantD.has(String(it.driverId)) && !seenT.has('drv|' + it.driverId + '|' + t2)) add('drv', String(it.driverId), t2, at);
      if (it.paxId && wantP.has(String(it.paxId)) && !seenT.has('pax|' + it.paxId + '|' + t2)) add('pax', String(it.paxId), t2, at); }
  }
  for (const id of wantD) { const o = out.drv[id]; if (o) o.seen = Number(r.seen && r.seen.get(id)) || 0; else out.drv[id] = { trips: 0, last: 0, seen: Number(r.seen && r.seen.get(id)) || 0 }; }
  res.json({ ok: true, stats: out });
});

/* V495 · MODO MANTENIMIENTO · lo activa el administrador y lo ve cualquier dispositivo (se reparte por el bus y se consulta por GET) */
function maintGet(roomName) { const m = getRoom(roomName).sticky.get('cfg-maint|cfg:maint'); const d = m && m.data; return d && d.on ? { on: true, msg: String(d.msg || ''), eta: String(d.eta || ''), at: Number(d.at) || 0 } : { on: false, msg: '', eta: '', at: Number(d && d.at) || 0 }; }
app.get('/api/maint', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true, serverTime: Date.now(), reset: resetAtOf(getRoom(req.query.room)) }, maintGet(req.query.room))); });

/* V497 · EMPEZAR DE CERO · borra registros de pasajeros y conductores, viajes, deudas, pagos, calificaciones, fundadores,
   verificaciones, fotos e historial. La configuración (precios, deuda, cupo, fundadores, avisos, mantenimiento) queda igual.
   Los celulares reciben la orden y borran sus datos guardados (como una instalación nueva). */
app.post('/api/admin/maint', (req, res) => {
  const bd = req.body || {};
  if (!adminOk(bd.token) && !sbxOk(bd)) return res.status(401).json({ ok: false, error: 'admin' });
  const data = { on: !!bd.on, msg: String(bd.msg || '').trim().slice(0, 240), eta: String(bd.eta || '').trim().slice(0, 60), at: Date.now() };
  const saved = pushMessage(getRoom(bd.room), { type: 'cfg-maint', key: 'cfg:maint', src: 'admin', data });
  console.log('Modo mantenimiento', data.on ? 'ACTIVADO' : 'desactivado');
  res.json({ ok: true, data, id: saved && saved.id });
});

/* V445 · política de deuda (límite, % mínimo, alias de cobro) · solo administrador (se reparte a todos por el bus) */
app.post('/api/admin/debtpolicy', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const p = b.policy || {};
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const str = (v, n) => String(v || '').trim().slice(0, n);
  const data = { limit: num(p.limit, 1000, 10000000, 10000), minPct: num(p.minPct, 1, 100, 60), alias: str(p.alias, 60) || 'mobi.cobros', holder: str(p.holder, 80) || 'MOBI', link: str(p.link, 300), wa: str(p.wa, 20).replace(/\D/g, ''), depot: str(p.depot, 160), at: Date.now() };
  const saved = pushMessage(getRoom(b.room), { type: 'cfg-debt', key: 'cfg:debt', src: 'admin', data });
  console.log('Política de deuda actualizada', JSON.stringify(data));
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
/* V466 · comprobante de pago y foto de entrega de UN viaje: los ve quien tiene el código del viaje (pasajero y conductor, en su historial).
   Solo devuelve esas dos imágenes del viaje; los documentos personales siguen siendo solo para el administrador. */
/* ---------------- V471 · libreta de direcciones VERIFICADAS ----------------
   Cada vez que un pasajero corrige el pin ("Ajustar") o un conductor llega de verdad a una dirección, queda el lugar real.
   La próxima persona que escriba esa misma calle y número la ve primero y con el punto correcto. */
const addrMem = new Map();                                     // "calle numero|localidad" -> { label, pts:[{lat,lng,w,at}], at }
const ADDR_KEY = /^[a-z0-9 ]{3,60}\|[a-z0-9 ]{2,40}$/;
const addrRate = new Map();
const addrDist = (a, b) => { const k = Math.cos(a.lat * Math.PI / 180) * 111320, dx = (a.lng - b.lng) * k, dy = (a.lat - b.lat) * 110540; return Math.sqrt(dx * dx + dy * dy); };
function addrBest(e) {
  let best = null;
  for (const p of e.pts || []) {
    const grp = (e.pts || []).filter((o) => addrDist(o, p) <= 100), w = grp.reduce((n, o) => n + o.w, 0);
    if (!best || w > best.w) { const sw = grp.reduce((n, o) => n + o.w, 0) || 1; best = { w, lat: grp.reduce((n, o) => n + o.lat * o.w, 0) / sw, lng: grp.reduce((n, o) => n + o.lng * o.w, 0) / sw }; }
  }
  return best && best.w >= 2 ? { lat: +best.lat.toFixed(6), lng: +best.lng.toFixed(6), w: best.w } : null;   // un ajuste del pasajero (3) o dos llegadas (1+1)
}
app.post('/api/addr/verify', (req, res) => {
  const b = req.body || {}, key = String(b.key || ''), lat = Number(b.lat), lng = Number(b.lng), kind = b.kind === 'adjust' ? 'adjust' : 'arrival';
  if (!ADDR_KEY.test(key) || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -36 || lat > -33.5 || lng < -60 || lng > -57) return res.status(400).json({ ok: false });
  const ip = String(req.ip || ''), now = Date.now(), r = addrRate.get(ip) || { n: 0, t: now };
  if (now - r.t > 3600_000) { r.n = 0; r.t = now; } if (++r.n > 60) return res.status(429).json({ ok: false }); addrRate.set(ip, r);
  if (addrRate.size > 5000) addrRate.delete(addrRate.keys().next().value);
  const e = addrMem.get(key) || { label: '', pts: [], at: now };
  e.label = String(b.label || e.label || '').slice(0, 160); e.at = now;
  e.pts.push({ lat, lng, w: kind === 'adjust' ? 3 : 1, at: now }); if (e.pts.length > 14) e.pts.splice(0, e.pts.length - 14);
  addrMem.set(key, e); if (addrMem.size > 20000) addrMem.delete(addrMem.keys().next().value);
  kvSet('addr', key, e);
  res.json({ ok: true, verified: !!addrBest(e) });
});

/* V474 · acierto de cada fuente de direcciones: cuánto se equivocó el punto que mostró la lista frente a lo que confirmó la gente */
const addrStat = {};      // fuente -> { n, ok, sum, big }

/* V503 · contador de descargas de la landing: { apk:{t:total, d:{'2026-10-18':n}}, web:{...} } */
const DL_KINDS = ['apk', 'web'];
const dlStat = { apk: { t: 0, d: {} }, web: { t: 0, d: {} } };
const dlSeen = new Map();   /* hash(ip)+tipo → última vez (solo en memoria): un mismo celular no suma más de una vez cada 20 min */
let dlTimer = null;
function dlDay(ts) { return new Date((ts || Date.now()) - 3 * 3600_000).toISOString().slice(0, 10); }
function dlSave() { if (dlTimer) return; dlTimer = setTimeout(() => { dlTimer = null; kvSet('dl', 'counts', dlStat); }, 3000); dlTimer.unref && dlTimer.unref(); }

let addrStatDirty = false;
const statRate = new Map();
app.post('/api/addr/stat', (req, res) => {
  const b = req.body || {};
  if (/^sandbox/.test(String(b.room || ''))) return res.json({ ok: true });                 // el sandbox no mezcla sus pruebas
  const src = String(b.src || '').replace(/[^A-Za-z]/g, '').slice(0, 20), err = Number(b.err);
  if (!src || !Number.isFinite(err) || err < 0) return res.status(400).json({ ok: false });
  const ip = String(req.ip || ''), now = Date.now(), r = statRate.get(ip) || { n: 0, t: now };
  if (now - r.t > 3600_000) { r.n = 0; r.t = now; } if (++r.n > 120) return res.status(429).json({ ok: false }); statRate.set(ip, r);
  if (statRate.size > 5000) statRate.delete(statRate.keys().next().value);
  if (!addrStat[src] && Object.keys(addrStat).length >= 12) return res.json({ ok: true });
  const x = addrStat[src] || (addrStat[src] = { n: 0, ok: 0, sum: 0, big: 0 });
  x.n++; x.sum += Math.min(err, 5000); if (err < 30) x.ok++; if (err > 100) x.big++;
  addrStatDirty = true; res.json({ ok: true });
});
setInterval(() => { if (addrStatDirty) { addrStatDirty = false; kvSet('addrstat', 'all', addrStat); } }, 60_000).unref();
app.post('/api/admin/addrstats', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  res.json({ ok: true, stats: addrStat });
});


/* ---------------- V478 · avisos push reales (llegan aunque la app esté cerrada) ----------------
   Sin paquetes extra: el server crea solo su par de claves (VAPID), las guarda en la base y "toca" al celular con un aviso vacío;
   el celular le pregunta al server qué decía y lo muestra. Solo se le habla a servicios de push conocidos. */
let pushPriv = null, pushPub = '', pushLoaded = false;
const pushLast = { periodic: {}, demand: {} };
let pushLastDirty = false;
const pushSubs = new Map();         // hash(endpoint) -> { endpoint, uid, at }
const pushQueue = new Map();        // hash(endpoint) -> [{ title, body, url, at }]
const pushRate = new Map();
let pushLastStatus = null;
const pushHost = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
const b64u = (b) => Buffer.from(b).toString('base64url');
const pushHash = (ep) => crypto.createHash('sha256').update(String(ep)).digest('hex').slice(0, 40);
function pushVapidLoad(d) { try { pushPriv = crypto.createPrivateKey(d.pem); pushPub = String(d.pub); } catch (e) { pushPriv = null; } }
function pushVapidEnsure() {
  if (pushPriv || !pushLoaded) return;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' });
  const pub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]));
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  pushPriv = privateKey; pushPub = pub; kvSet('push', 'vapid', { pem, pub });
  console.log('Push: claves nuevas creadas');
}
function pushJwt(aud) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://mobi-server.onrender.com' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: pushPriv, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}
async function pushTouch(h, sub) {
  try {
    const u = new URL(sub.endpoint);
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', 'Content-Length': '0', Authorization: 'vapid t=' + pushJwt(u.origin) + ', k=' + pushPub } });
    if (r.status === 404 || r.status === 410) { pushSubs.delete(h); pushQueue.delete(h); if (db) db.query(`DELETE FROM mobi_kv WHERE ns = 'push' AND id = $1`, [h]).catch(() => {}); }
    else if (!r.ok) console.warn('Push', r.status);
    pushLastStatus = { status: r.status, at: Date.now() };
    return { ok: r.ok, status: r.status };
  } catch (e) { console.warn('Push', e.message); pushLastStatus = { status: 0, at: Date.now(), err: String(e.message || e).slice(0, 80) }; return { ok: false, status: 0 }; }
}
function pushNotify(uid, note, acc) {
  if (note && note.skip) return 0; pushVapidEnsure(); if (!uid || !pushPriv) return 0; let n = 0;
  for (const [h, sub] of pushSubs) {
    if (String(sub.uid) !== String(uid)) continue;
    const q = pushQueue.get(h) || []; q.push({ title: String(note.title || 'MOBI').slice(0, 80), body: String(note.body || '').slice(0, 200), url: './', at: Date.now() }); pushQueue.set(h, q.slice(-5));
    const pr = pushTouch(h, sub); if (acc) acc.push(pr); n++;
  }
  return n;
}
app.get('/api/push/key', (req, res) => { pushVapidEnsure(); res.json({ ok: !!pushPub, key: pushPub }); });
app.post('/api/push/sub', (req, res) => {
  const b = req.body || {}, ep = String((b.sub && b.sub.endpoint) || ''), uid = String(b.uid || '').slice(0, 60);
  let host = ''; try { const u = new URL(ep); if (u.protocol === 'https:') host = u.hostname; } catch (e) {}
  if (!host || ep.length > 700 || !pushHost.test(host) || !/^[A-Za-z0-9_.:-]{3,60}$/.test(uid)) return res.status(400).json({ ok: false });
  const ip = String(req.ip || ''), now = Date.now(), r = pushRate.get(ip) || { n: 0, t: now };
  if (now - r.t > 3600_000) { r.n = 0; r.t = now; } if (++r.n > 30) return res.status(429).json({ ok: false }); pushRate.set(ip, r);
  if (pushRate.size > 5000) pushRate.delete(pushRate.keys().next().value);
  if (pushSubs.size > 20000) return res.status(503).json({ ok: false });
  const rm = /^[a-zA-Z0-9_-]{1,40}$/.test(String(b.room || '')) ? String(b.room) : 'pilot', h = pushHash(ep), item = { endpoint: ep, uid, room: rm, at: now };
  pushSubs.set(h, item); kvSet('push', h, item); res.json({ ok: true });
});
app.post('/api/push/pending', (req, res) => {
  const ep = String((req.body || {}).endpoint || ''); const h = pushHash(ep);
  const q = (pushQueue.get(h) || []).filter((m) => Date.now() - m.at < 86400_000); pushQueue.delete(h);
  res.json({ ok: true, msgs: q });
});
app.post('/api/admin/push-test', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  res.json({ ok: true, sent: pushNotify(String(b.uid || ''), { title: String(b.title || 'MOBI'), body: String(b.body || 'Prueba de aviso') }) });
});


/* ---------------- V478 · avisos configurables desde Administración ---------------- */
const PUSH_DEF = {
  nightFrom: 23, nightTo: 7,
  approved: { on: 1, title: '¡Tu cuenta fue verificada!', body: 'Ya podés empezar a manejar con MOBI. Abrí la app y conectate.' },
  waiting: { on: 1, title: 'Tu cuenta fue verificada', body: 'Hoy no hay lugar disponible. Te avisamos apenas se libere uno.' },
  freed: { on: 1, title: '¡Se liberó un lugar!', body: 'Ya podés conectarte y manejar con MOBI.' },
  periodic: { on: 0, hours: 8, title: '¿Listo para manejar?', body: 'Conectate en MOBI y recibí viajes cerca tuyo.' },
  demand: { on: 1, minWait: 2, ratio: 1.5, sustainSec: 120, cooldownMin: 60, activeMin: 60, title: '📈 ¡Alta demanda en MOBI!', body: 'Las tarifas subieron. Conectate ahora y aprovechá la oportunidad.' }
};
function pushCfg(r) {
  const m = r.sticky.get('cfg-push|cfg:push'), d = (m && m.data) || {}, out = JSON.parse(JSON.stringify(PUSH_DEF));
  const num = (v, lo, hi, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const txt = (v, def, n) => { v = String(v == null ? '' : v).trim().slice(0, n); return v || def; };
  out.nightFrom = num(d.nightFrom, 0, 23, out.nightFrom); out.nightTo = num(d.nightTo, 0, 23, out.nightTo);
  for (const k of ['approved', 'waiting', 'freed', 'periodic', 'demand']) {
    const x = d[k] || {};
    out[k].on = (x.on === 0 || x.on === false) ? 0 : (x.on === undefined ? out[k].on : 1);
    out[k].title = txt(x.title, out[k].title, 80); out[k].body = txt(x.body, out[k].body, 200);
  }
  out.periodic.hours = num((d.periodic || {}).hours, 1, 72, out.periodic.hours);
  const dm = d.demand || {};
  out.demand.minWait = num(dm.minWait, 1, 50, out.demand.minWait); out.demand.ratio = num(dm.ratio, 1, 10, out.demand.ratio);
  out.demand.sustainSec = num(dm.sustainSec, 0, 1800, out.demand.sustainSec); out.demand.cooldownMin = num(dm.cooldownMin, 5, 1440, out.demand.cooldownMin);
  out.demand.activeMin = num(dm.activeMin, 5, 1440, out.demand.activeMin);
  return out;
}
function pushText(r, k) { const c = pushCfg(r)[k]; return c && c.on ? { title: c.title, body: c.body } : { skip: 1 }; }
const arHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())) % 24;
function pushNight(c) { const h = arHour(), a = c.nightFrom, b = c.nightTo; return a === b ? false : (a > b ? (h >= a || h < b) : (h >= a && h < b)); }
function pushDrivers(r) {   // conductores aprobados con lugar: id -> { present, seenAt }
  const out = new Map(), now = Date.now();
  for (const m of r.sticky.values()) {
    if (!m || m.type !== 'driver-reg' || !m.data || !m.data.id) continue;
    const d = m.data; if (d.status !== 'aprobado' || drvHidden(d) || d.deletedAt) continue;
    const id = String(d.id); if (cupoWaiting(r, id)) continue;
    const p = r.sticky.get('drv-pres|dpres:' + id), present = !!(p && p.data && p.data.online !== false && now - p.at < 90000);
    out.set(id, { present, seenAt: Number(r.seen && r.seen.get(id)) || 0 });
  }
  return out;
}
const pushSurge = new Map();
function pushTick() {
  if (!pushLoaded) return; pushVapidEnsure(); if (!pushPriv) return;
  const now = Date.now();
  for (const r of rooms.values()) {
    const subsHere = [...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name); if (!subsHere.length) continue;
    const c = pushCfg(r), drv = pushDrivers(r), uids = [...new Set(subsHere.map((x) => String(x.uid)))].filter((id) => drv.has(id));
    // 1) recordatorio periódico: nunca de noche; el primer ciclo arranca desde que el conductor activó los avisos
    if (c.periodic.on && !pushNight(c)) for (const id of uids) {
      const last = pushLast.periodic[id];
      if (last === undefined) { pushLast.periodic[id] = now; pushLastDirty = true; continue; }
      if (now - last >= c.periodic.hours * 3600_000 && !drv.get(id).present) { pushNotify(id, c.periodic); pushLast.periodic[id] = now; pushLastDirty = true; }
    }
    // 2) alta demanda: también de noche, solo a quienes estuvieron activos en la última hora y hoy no están conectados
    if (c.demand.on) {
      let wait = 0, avail = 0;
      for (const m of r.sticky.values()) {
        if (m.type === 'trip' && m.data && m.data.active && /Esperando|Buscando/i.test(String(m.data.active.status || '')) && now - m.at < 240000) wait++;
        else if (m.type === 'drv-pres' && m.data && m.data.online !== false && !m.data.busy && now - m.at < 90000) avail++;
      }
      const pm = r.sticky.get('cfg-price|cfg:price'), pd = (pm && pm.data) || {}, manual = Number(pd.adjUntil) > now && Number(pd.adjPct) > 0;
      const hot = manual || (wait >= c.demand.minWait && avail >= 1 && wait / avail >= c.demand.ratio);
      if (hot) { if (!pushSurge.has(r.name)) pushSurge.set(r.name, now); } else pushSurge.delete(r.name);
      if (hot && now - pushSurge.get(r.name) >= c.demand.sustainSec * 1000) for (const id of uids) {
        const x = drv.get(id), last = pushLast.demand[id] || 0;
        if (x.present || now - x.seenAt > c.demand.activeMin * 60000 || now - last < c.demand.cooldownMin * 60000) continue;
        pushNotify(id, c.demand); pushLast.demand[id] = now; pushLastDirty = true;
      }
    }
  }
  if (pushLastDirty) { pushLastDirty = false; kvSet('push', 'last', pushLast); }
}
setInterval(pushTick, 60_000).unref();
app.post('/api/admin/push-cfg', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), data = Object.assign({}, b.cfg || {}, { at: Date.now() });
  pushMessage(r, { type: 'cfg-push', key: 'cfg:push', src: 'admin', data });
  console.log('Avisos actualizados'); res.json({ ok: true, cfg: pushCfg(r) });
});
app.post('/api/admin/push-stats', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), drv = pushDrivers(r), subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name).map((x) => String(x.uid)));
  res.json({ ok: true, last: pushLastStatus, drivers: drv.size, subscribed: [...drv.keys()].filter((id) => subs.has(id)).length, cfg: pushCfg(r) });
});
/* V480 · prueba de aviso en el celular del administrador (no cuenta como conductor ni recibe avisos masivos) */
app.post('/api/admin/push-self', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  if (!pushLoaded) return res.status(503).json({ ok: false });
  const ep = String((b.sub && b.sub.endpoint) || ''); let host = ''; try { const u = new URL(ep); if (u.protocol === 'https:') host = u.hostname; } catch (e) {}
  if (!host || ep.length > 700 || !pushHost.test(host)) return res.status(400).json({ ok: false, error: 'sub' });
  const rm = /^[a-zA-Z0-9_-]{1,40}$/.test(String(b.room || '')) ? String(b.room) : 'pilot', h = pushHash(ep), item = { endpoint: ep, uid: 'adm_test', room: rm, at: Date.now() };
  pushSubs.set(h, item); kvSet('push', h, item);
  const acc = [], n = pushNotify('adm_test', { title: '✅ Los avisos funcionan', body: 'Así le llega un aviso de MOBI a un conductor, aunque la app esté cerrada.' }, acc);
  const rs = await Promise.all(acc); res.json({ ok: true, sent: n, accepted: rs.filter((x) => x.ok).length, codes: rs.map((x) => x.status) });
});

app.post('/api/admin/push-send', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const title = String(b.title || '').trim().slice(0, 80), body = String(b.body || '').trim().slice(0, 200), aud = ['all', 'recent', 'offline'].includes(b.audience) ? b.audience : 'all';
  if (!title || !body) return res.status(400).json({ ok: false, error: 'texto' });
  if (!pushLoaded) return res.status(503).json({ ok: false });
  const r = getRoom(b.room), drv = pushDrivers(r), now = Date.now(), acc = []; let n = 0;
  const subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name).map((x) => String(x.uid)));
  for (const [id, x] of drv) {
    if (!subs.has(id)) continue;
    if (aud === 'recent' && now - x.seenAt > 24 * 3600_000) continue;
    if (aud === 'offline' && x.present) continue;
    if (pushNotify(id, { title, body }, acc)) n++;
  }
  const rs = await Promise.all(acc); console.log('Aviso manual enviado a', n, 'conductores · aceptados por el servicio:', rs.filter((x) => x.ok).length); res.json({ ok: true, sent: n, eligible: drv.size, accepted: rs.filter((x) => x.ok).length, codes: rs.map((x) => x.status) });
});

app.post('/api/addr/find', (req, res) => {
  const q = String((req.body || {}).q || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60).trim();
  if (q.length < 3) return res.json({ ok: true, items: [] });
  const items = [];
  for (const [k, e] of addrMem) { if (!k.startsWith(q + '|')) continue; const b = addrBest(e); if (b) items.push({ key: k, label: e.label, lat: b.lat, lng: b.lng, w: b.w }); if (items.length >= 5) break; }
  res.json({ ok: true, items });
});

app.post('/api/proof/get', async (req, res) => {
  const b = req.body || {}, key = String(b.tripKey || ''), kind = String(b.kind || '');
  if (!/^[A-Za-z0-9]{6,30}$/.test(key) || (kind !== 'proof' && kind !== 'delivery')) return res.status(400).json({ ok: false, error: 'bad_request' });
  const d = await docsOf('trip_' + key);
  res.json({ ok: true, img: d[kind] || null });
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
  /* V508 · solo sirve una verificación hecha para «Ya tengo cuenta» (rst_…): el id de un pasajero o conductor se ve en los viajes y no puede usarse para entrar a su cuenta */
  if (!/^rst_[a-z0-9]{3,24}$/.test(userId)) return res.status(403).json({ ok: false, error: 'verify_first' });
  if (!v || Date.now() - (v.at || 0) > 30 * 60_000) return res.status(403).json({ ok: false, error: 'verify_first' });
  let pax = null, drv = null;
  for (const room of rooms.values()) for (const m of room.sticky.values()) {
    const d = m && m.data; if (!d || typeof d !== 'object') continue;
    if (v.via === 'mail' && v.email) { if (String(d.email || '').trim().toLowerCase() !== v.email) continue; if (v.tail && tail8(d.phone) !== v.tail) continue; }   /* V508 · por mail hacen falta las DOS cosas: el mail verificado y el celular de la cuenta */
    else if (tail8(d.phone) !== v.tail) continue;
    const when = Number(d.upd || d.updatedAt || m.at || 0);
    if (m.type === 'pax-reg') { const wv = d.wa ? 1 : 0; if (!pax || wv > pax._v || (wv === pax._v && when > pax._w)) pax = Object.assign({}, d, { _w: when, _v: wv }); }   /* V508 · gana la cuenta verificada, no la que alguien armó con ese número */
    if (m.type === 'driver-reg' && !d.hiddenAt) {   /* V496 · entre varios registros del mismo celular se elige el mejor estado (aprobado > pendiente > sin enviar > rechazado) y, a igual estado, el más reciente */
      const rk = { aprobado: 4, pendiente: 3, borrador: 2, rechazado: 1 }[String(d.status || 'borrador')] || 2;
      if (!drv || rk > drv._r || (rk === drv._r && when > drv._w)) drv = Object.assign({}, d, { _w: when, _r: rk });
    }
  }
  let drvDocs = null;
  if (drv && drv.id) drvDocs = await docsOf(drv.id);
  { const sk = authOf(req, 'pilot').sk;   /* V500 · verificado por Telegram o mail: la cuenta pasa a este celular */
    if (sk) for (const room of rooms.values()) { if (pax && pax.id && room.sticky.has('pax-reg|pr:' + pax.id)) ownSet(room, 'pax', String(pax.id), sk, true); if (drv && drv.id && room.sticky.has('driver-reg|dr:' + drv.id)) ownSet(room, 'drv', String(drv.id), sk, true); } }
  if (pax) { delete pax._w; delete pax._v; } if (drv) { delete drv._w; delete drv._r; }
  console.log('Recuperar cuenta · …' + v.tail.slice(-4), 'vía ' + (v.via || '?'), pax ? 'pasajero' : '', drv ? 'conductor(' + String(drv.status || 'borrador') + ')' : '');
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
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { for (let i = 0; i < 50 && flushing; i++) await new Promise((r) => setTimeout(r, 100)); for (const [k, v] of dirtySlow) dirty.set(k, v); await flushSticky(); } catch (e) {} process.exit(0); });
