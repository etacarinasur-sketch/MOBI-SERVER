import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

/* ===================== V607 · CONSUMO DE DATOS: compresión + contador por tipo =====================
   Render cobra por lo que SALE del servidor (plan Hobby: 5 GB por mes incluidos). Todo lo que pase de 1 KB (JSON o texto) viaja comprimido (gzip),
   la página de la app se manda comprimida y con ETag (si no cambió, el celular no la baja de nuevo) y se cuenta cuánto sale por tipo de pedido. */
const NOTE = { on: false, rooms: new Map(), rate: new Map() };
const LP = { on: false };   // V607 · consulta en espera (ver más abajo)
const LP_LOW = new Set(['drv-pres', 'driver-pos', 'pax-pos']);   // estos avisos no despiertan al instante (se juntan hasta 4 s)
const USE = { since: Date.now(), days: {} };   // days['AAAA-MM-DD'][categoría] = { n, out, inb, raw }
const useDay = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
function useCat(req) {
  const u = String(req.originalUrl || req.url || '').split('?')[0];
  if (u === '/' || u === '/index.html') return 'La app (index.html)';
  const m = u.match(/^\/api\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return 'Otros';
  if (m[1] === 'bus') return req.method === 'GET' ? 'Consulta de novedades (bus GET)' : 'Envío de novedades (bus POST)';
  if (m[1] === 'admin') return 'Administración';
  if (m[1] === 'drv' && m[2] === 'offers') return 'Viajes ofrecidos (APK)';
  if (m[1] === 'push') return 'Avisos (push)';
  if (m[1] === 'my') return 'Historial y recorridos';
  return '/api/' + m[1];
}
function useAdd(cat, out, inb, raw) {
  const d = useDay(), day = USE.days[d] || (USE.days[d] = {}), c = day[cat] || (day[cat] = { n: 0, out: 0, inb: 0, raw: 0 });
  c.n++; c.out += out; c.inb += inb; c.raw += raw;
  USE.dirty = true;
}
app.use((req, res, next) => {
  const cat = useCat(req); let out = 0, raw = 0;
  const w = res.write, e = res.end;
  const len = c => c == null ? 0 : (Buffer.isBuffer(c) ? c.length : (typeof c === 'string' ? Buffer.byteLength(c) : 0));
  res.write = function (c, ...a) { out += len(c); return w.call(this, c, ...a); };
  res.end = function (c, ...a) { out += len(c); return e.call(this, c, ...a); };
  res.on('finish', () => { try { useAdd(cat, out + 250, Number(req.headers['content-length']) || 0, raw || out); } catch (x) {} });
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const send = res.send;
    res.send = function (body) {
      try {
        if (!this.headersSent && !this.getHeader('Content-Encoding') && req.method !== 'HEAD' && (typeof body === 'string' || Buffer.isBuffer(body))) {
          const n = len(body), ct = String(this.getHeader('Content-Type') || '');
          if (n >= 1024 && (!ct || /json|text|javascript|xml|html|svg/i.test(ct))) {
            if (!ct && typeof body === 'string') this.setHeader('Content-Type', 'text/html; charset=utf-8');
            const z = zlib.gzipSync(Buffer.isBuffer(body) ? body : Buffer.from(body), { level: 5 });
            raw += n; this.setHeader('Content-Encoding', 'gzip'); this.setHeader('Vary', 'Accept-Encoding'); this.removeHeader('Content-Length');
            return send.call(this, z);
          }
        }
      } catch (x) {}
      return send.call(this, body);
    };
  }
  next();
});
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
let idxC = { m: 0, raw: null, gz: null, tag: '' };
app.get(['/', '/index.html'], (req, res) => {
  if (fs.existsSync(indexFile)) {
    try {   /* V607 · comprimida (de ~3 MB a ~0,6 MB) y con ETag: si no cambió, el celular recibe solo un «304» */
      const st = fs.statSync(indexFile);
      if (st.mtimeMs !== idxC.m) { const raw = fs.readFileSync(indexFile); idxC = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), tag: 'W/"' + Math.round(st.mtimeMs) + '-' + raw.length + '"' }; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('ETag', idxC.tag);
      if (String(req.headers['if-none-match'] || '').split(',').some((t) => t.trim().replace(/^W\//, '') === idxC.tag.replace(/^W\//, ''))) return res.status(304).end();
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Length', idxC.gz.length); return res.end(idxC.gz); }
      res.setHeader('Content-Length', idxC.raw.length); return res.end(idxC.raw);
    } catch (e) { return res.sendFile(indexFile); }
  }
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
let db = null, dbState = DATABASE_URL ? 'starting' : 'off', dbError = '', dbDownSince = 0;
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
      { const cur = room.sticky.get(row.k); if (cur && Number(cur.at || 0) > Number((msg && msg.at) || 0)) continue; }   /* V533 · al reconectar: lo nuevo en memoria no se pisa con lo viejo de la base */
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
    try { const tp = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'tpax' AND at > now() - interval '120 days'`); for (const row of tp.rows) if (row.data && row.data.h && !tripPax.has(row.id)) tripPax.set(row.id, row.data.h); } catch (e) { console.warn('tpax', e.message); }
    try { const wl = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'wel'`); for (const row of wl.rows) { const d = row.data; if (d && d.tk && !d.gone && (d.done || Date.now() - Number(d.at || 0) < WEL_HOLD_MS)) welRec.set(row.id, d); } } catch (e) { console.warn('wel', e.message); }   /* V576 */
    try { const ic = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'inc' AND at > now() - interval '180 days'`); for (const row of ic.rows) { const d = row.data; if (d && d.room && d.id) { const l = incList({ name: d.room }); if (!l.some((x) => x.id === d.id)) l.push(d); } } for (const l of INC.mem.values()) { l.sort((a, b) => b.at - a.at); if (l.length > 300) l.length = 300; }
      const sn = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'incsnap'`); for (const row of sn.rows) if (row.data && row.data.m) INC.snap.set(row.id, row.data);
      const icf = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'inccfg' AND id = 'cfg'`); if (icf.rows[0] && icf.rows[0].data && Number(icf.rows[0].data.big) >= 1000) INC.big = Number(icf.rows[0].data.big); } catch (e) { console.warn('incidentes', e.message); }   /* V629 */
    try { const er = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'erased'`); for (const row of er.rows) ERASED.set(row.id, Number(row.data && row.data.at) || 1); } catch (e) { console.warn('erased', e.message); }   /* V630 */
    try { const rr = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'remind'`); for (const row of rr.rows) if (row.data) remMem.set(row.id, row.data); } catch (e) { console.warn('remind', e.message); }   /* V576 */
    try { const ow = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'own'`); for (const row of ow.rows) if (row.data && row.data.h && !ownMap.has(row.id)) ownMap.set(row.id, row.data.h); } catch (e) { console.warn('own', e.message); }
    try { const mo = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'mpord' AND at > now() - interval '60 days'`); for (const row of mo.rows) if (!mpOrders.has(row.id)) mpOrders.set(row.id, row.data); } catch (e) { console.warn('mpord', e.message); }
    try { const lp = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'lp' AND id = 'cfg'`); if (lp.rows[0] && lp.rows[0].data) LP.on = !!lp.rows[0].data.on; } catch (e) { console.warn('lp', e.message); }   /* V607 */
    try { const us = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'usage' AND id = 'all'`); if (us.rows[0] && us.rows[0].data && us.rows[0].data.days) { for (const [d, v] of Object.entries(us.rows[0].data.days)) if (!USE.days[d]) USE.days[d] = v; if (us.rows[0].data.since) USE.since = Math.min(USE.since, Number(us.rows[0].data.since) || USE.since); } } catch (e) { console.warn('usage', e.message); }   /* V607 */
    try { const nc = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'notecfg' AND id = 'cfg'`); if (nc.rows[0] && nc.rows[0].data) NOTE.on = !!nc.rows[0].data.on; const nn = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'notes'`); for (const row of nn.rows) if (row.data && Array.isArray(row.data.list) && !NOTE.rooms.has(row.id)) NOTE.rooms.set(row.id, row.data.list); } catch (e) { console.warn('notes', e.message); }   /* V611 */
    try { const fk = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'fb'`); for (const row of fk.rows) if (row.data && !fbDone.has(row.id)) fbDone.set(row.id, row.data); } catch (e) { console.warn('fb', e.message); }   /* V586 */
    try { const rv = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'revisor' AND id = 'cfg'`); if (rv.rows[0] && rv.rows[0].data) REV = Object.assign(REV, rv.rows[0].data); } catch (e) { console.warn('revisor', e.message); }   /* V584 */
    const w = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'wa'`);
    for (const row of w.rows) if (!waVerified.has(row.id)) waVerified.set(row.id, row.data);
    try { const g = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'wacfg' AND id = 'regblock'`); if (g.rows[0]) waRegBlockUntil = Number(g.rows[0].data.until) || 0; } catch (e) {}
    dbState = 'on';
    if (dbDownSince) {   /* V533 · la base volvió: se guarda lo que se hizo mientras estuvo caída */
      let n = 0;
      for (const room of rooms.values()) for (const [k, m] of room.sticky) if (m && DURABLE.has(m.type) && Number(m.at || 0) >= dbDownSince - 60000) { dirty.set(room.name + '\u0001' + k, { room: room.name, k, msg: m }); n++; }
      for (const [id, h] of ownMap) kvSet('own', id, { h });
      for (const [id, v] of waVerified) if (Number(v && v.at || 0) >= dbDownSince - 60000) kvSet('wa', id, v);
      for (const [id, o] of mpOrders) if (Number(o && o.at || 0) >= dbDownSince - 60000) kvSet('mpord', id, o);
      console.log('Base de datos RECUPERADA: se guardan ' + n + ' registros hechos mientras estuvo caída');
      dbDownSince = 0;
    }
    histLoad().catch(() => {});
    console.log(`Base de datos conectada: ${r.rows.length} registros, ${w.rows.length} verificaciones`);
  } catch (e) {
    dbState = 'error'; dbError = e.message; try { if (db) db.end().catch(() => {}); } catch (e2) {} db = null; pushLoaded = true;
    if (!dbDownSince) dbDownSince = Date.now();
    console.warn('No se pudo conectar la base de datos (sigo en memoria, reintento en 60 s):', e.message);
    setTimeout(() => { dbState = 'retrying'; dbInit().catch(() => {}); }, Number(process.env.DB_RETRY_MS || 60_000)).unref();   /* V533 · antes no reintentaba nunca: quedaba sin datos hasta el próximo reinicio */
  }
}
/* qué se guarda: solo lo que importa conservar. Las ubicaciones GPS cambian todo el tiempo y quedan en memoria
   (así la base "duerme" cuando no hay actividad y no se gastan las horas gratis). El viaje en curso se guarda cada 20 s. */
const DURABLE = new Set(['pax-reg', 'driver-reg', 'debt-charge', 'debt-pay', 'rating', 'report', 'trip-end', 'trip-done', 'acct-susp', 'pax-chg', 'pax-adj', 'cfg-price', 'cfg-debt', 'cfg-cupo', 'drv-slots', 'cfg-founder', 'drv-founders', 'refund-req', 'cfg-push', 'cfg-maint', 'cfg-prelaunch', 'cfg-reset', 'drv-chg', 'seller-reg', 'flex-pkg', 'flex-run', 'flex-cfg', 'cfg-welcome', 'cfg-remind', 'cfg-natpush', 'cfg-drvphoto', 'cfg-delacct', 'cfg-wshare', 'cfg-selftrip', 'cfg-voice', 'cfg-xstreet', 'cfg-tripsave', 'cfg-fb', 'cfg-vrem', 'cfg-pin', 'cfg-apkupd', 'cfg-tripwatch', 'pay-proof-meta', 'acct-erased']);   /* V629 · la ficha de cada comprobante se guarda en la base (antes se perdía al reiniciar) */   /* V558 · MOBI Flex (vendedores) · V576 viajes de bienvenida */
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
/* V584 · CUENTA DE PRUEBA PARA EL REVISOR DE GOOGLE PLAY (apagada de fábrica).
   Encendida, el celular de prueba que cargás en Administración: (1) queda aprobado como conductor al registrarse (con su auto) y
   (2) se verifica "por mail" con un código fijo, sin mandar ningún mail. Cualquier otro celular sigue el camino normal. */
let REV = { on: false, phone: '', code: '' };
/* V586 · SEGUINOS EN FACEBOOK (apagado de fábrica). Facebook no deja comprobar quién sigue una página: la persona toca «Ya los seguí» y se confía en ella.
   Pasajero: con el interruptor encendido, el viaje de bienvenida pide haber tocado «Ya los seguí» (lo decide el servidor).
   Conductor: solo una invitación (no condiciona nada; los fundadores lo siguen siendo). */
const fbDone = new Map();   // 'sala|id' -> { at, role }
function fbCfg(room) { const m = room.sticky.get('cfg-fb|cfg:fb'), d = (m && m.data) || {}; const url = String(d.url || ''); return { on: !!(d.on && url), url, notifiedAt: Number(d.notifiedAt) || 0 }; }
const fbUrlOk = (u) => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' && /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i.test(x.hostname) && u.length <= 300; } catch (e) { return false; } };
const revOn = (phone) => !!(REV.on && REV.phone && tail8(REV.phone).length >= 8 && tail8(phone) === tail8(REV.phone));
async function kvSet(ns, id, data) {
  if (!db) return;
  try { await db.query(`INSERT INTO mobi_kv (ns, id, data, at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (ns, id) DO UPDATE SET data = EXCLUDED.data, at = now()`, [ns, String(id), JSON.stringify(data)]); }
  catch (e) { dbError = e.message; console.warn('kv', e.message); }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MOBI-SERVER', version: 5, database: dbState, databaseError: dbState === 'on' ? undefined : (dbError || undefined), mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN), adminConfigured: Boolean(ADMIN_KEY), whatsappConfigured: Boolean(WA_NUMBER), rooms: rooms.size, uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1048576) });
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


/* V538 · MAIL AL REGISTRARSE · si en Render está REG_NOTIFY_TO (tu mail) y Gmail está configurado, avisa cada pasajero/conductor nuevo.
   Máx. REG_NOTIFY_MAX por día (30 por defecto). Se apaga borrando la variable. Nunca frena el registro si falla. */
const regMail = { d: '', n: 0, chain: Promise.resolve() };
function regNotify(room, msg) {
  const to = String(process.env.REG_NOTIFY_TO || '').trim(); if (!to || !GM_ON) return;
  if (/sbx|sandbox|test/i.test(room.name)) return;
  const t = msg.type, d = msg.data; if ((t !== 'pax-reg' && t !== 'driver-reg') || !d || typeof d !== 'object' || !msg.key) return;
  const prev = room.sticky.get(t + '|' + msg.key), pd = prev && prev.data;
  let fresh = false;
  if (t === 'pax-reg') fresh = !prev && !!(d.name || d.phone);
  else fresh = d.status === 'pendiente' && !(pd && (pd.status === 'pendiente' || pd.status === 'aprobado'));
  if (!fresh) return;
  const day = new Date().toISOString().slice(0, 10); if (regMail.d !== day) { regMail.d = day; regMail.n = 0; }
  const max = Number(process.env.REG_NOTIFY_MAX) || 30; if (regMail.n >= max) return; regMail.n++;
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const who = t === 'pax-reg' ? 'Nuevo PASAJERO' : 'Nuevo CONDUCTOR (pendiente de aprobar)';
  const rows = [['Nombre', ((d.name || '') + ' ' + (d.lastName || d.surname || '')).trim()], ['Celular', d.phone], ['Mail', d.email], ['Ciudad / zona', d.city || d.zone || d.localidad]].filter((r) => r[1]);
  const html = '<div style="font-family:system-ui,sans-serif"><h3>' + who + '</h3>' + rows.map((r) => '<p><b>' + r[0] + ':</b> ' + esc(r[1]) + '</p>').join('') + '<p style="color:#666">Revisalo en Administración.</p></div>';
  const text = who + '\n' + rows.map((r) => r[0] + ': ' + r[1]).join('\n') + '\nRevisalo en Administración.';
  regMail.chain = regMail.chain.then(() => gmSend(to, '🆕 MOBI · ' + who.replace(/ \(.*/, ''), html, text)).catch((e) => console.log('regNotify', String(e && e.message || e).slice(0, 120)));
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
  try { if (msg.type === 'trip-done') histIngest(room, msg); else if (msg.type === 'drv-pres') presIngest(room, msg); } catch (e) {}
  try { if ((msg.type === 'trip-done' || msg.type === 'trip-end') && welRec.size) welIngest(room, msg); } catch (e) {}   /* V576 · viajes de bienvenida */   /* V485 · historial de conductores (viajes y conexiones) */
  try { regNotify(room, msg); } catch (e) {}   /* V538 · aviso por mail al administrador cuando alguien se registra */
  try { supNotify(room, msg); } catch (e) {}   /* V633 · aviso por mail cuando alguien escribe a Soporte */
  if (msg.type === 'trip-done' && room.doneTk && msg.data && msg.data.tripKey) room.doneTk.add(String(msg.data.tripKey));   /* V568 */
  try { twNote(room, msg); } catch (e) {}   /* V623 · última señal del conductor de cada viaje */
  /* V576 · el administrador aprobó o rechazó la cuenta del conductor: aviso con la app cerrada, con su mensaje */
  try { if (msg.type === 'driver-reg' && msg.key && msg.data) {   /* solo el administrador puede pasar una cuenta a aprobada o rechazada */
    const pv0 = room.sticky.get('driver-reg|' + msg.key), ps = String((pv0 && pv0.data && pv0.data.status) || ''), ns = String(msg.data.status || '');
    if (ps !== ns && (ns === 'aprobado' || ns === 'rechazado')) { const why = String(msg.data.reason || '').trim().slice(0, 180);
      pushNotify(String(msg.data.id || ''), ns === 'aprobado' ? { title: '✅ ¡Tu cuenta de conductor fue aprobada!', body: why || 'Ya podés trabajar con MOBI. Conectate para recibir viajes.' } : { title: 'Tu documentación necesita un cambio', body: why || 'Revisá tus documentos en Configuración y volvé a enviarlos.' }); } } } catch (e) {}
  /* V571 · el administrador aprobó o rechazó un vehículo agregado (moto o auto): aviso al celular del conductor aunque tenga la app cerrada */
  try { if (msg.type === 'driver-reg' && msg.key && msg.data && Array.isArray(msg.data.cars)) {
    const pv = room.sticky.get('driver-reg|' + msg.key), pc = (pv && pv.data && Array.isArray(pv.data.cars)) ? pv.data.cars : null;
    if (pc) for (const c of msg.data.cars) { const o = pc.find((x) => x && c && String(x.plate || '') === String(c.plate || '')); const st = String((c && c.status) || '');
      if (o && (st === 'aprobado' || st === 'rechazado') && String(o.status || 'pendiente') !== st) { const mo = c.vtype === 'moto';
        pushNotify(String(msg.data.id || ''), st === 'aprobado' ? { title: mo ? '🏍️ ¡Tu moto fue aprobada!' : '🚗 ¡Tu auto fue aprobado!', body: 'Ya podés trabajar con ' + (c.model || 'tu vehículo') + '. Abrí MOBI y elegilo en «Trabajás con».' } : { title: mo ? 'Tu moto no fue aprobada' : 'Tu auto no fue aprobado', body: 'Revisá los datos y la documentación de ' + (c.model || 'tu vehículo') + ' en Configuración.' }); } } } } catch (e) {}
  try { incWatch(room, msg); } catch (e) {}   /* V629 · incidentes de dinero (solo registra y avisa) */
  room.ring.push(msg);
  try { lpWake(room, LP_LOW.has(msg.type)); } catch (e) {}   /* V607 */
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
  if (m && m.data && (m.type === 'pax-reg' || m.type === 'driver-reg') && ERASED.has(room.name + '|' + String(m.data.id || ''))) return true;   /* V630 · cuenta de prueba eliminada: no se vuelve a crear con el mismo id */
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
const MP_RELEASE_DAYS = Number.isFinite(Number(process.env.MP_RELEASE_DAYS)) && process.env.MP_RELEASE_DAYS !== '' ? Math.max(0, Math.min(60, Number(process.env.MP_RELEASE_DAYS))) : 18;   /* V525 · días que tarda Mercado Pago en liberar un cobro con tarjeta */
const isCardCredit = (y) => y && y.type === 'credit' && !isCancelCredit(y) && y.kind !== 'paxcredit' && (!!y.mpOrd || /tarjeta/i.test(String(y.note || '')));
const MP_FEE_PCT = Number.isFinite(Number(process.env.MP_FEE_PCT)) && process.env.MP_FEE_PCT !== '' ? Math.max(0, Math.min(15, Number(process.env.MP_FEE_PCT))) : 4.3;   /* V520 · comisión de Mercado Pago por pago con tarjeta (%) */
const mpOrders = new Map();               // orderId -> { amount, ok, used, at }
function skHash(v) { v = String(v || ''); return /^[a-f0-9]{32,64}$/.test(v) ? crypto.createHash('sha256').update('mobi-sk|' + v).digest('hex').slice(0, 40) : ''; }
function authOf(req, room) {
  const h = req.headers || {}, b = req.body || {};
  const adm = String(h['x-mobi-adm'] || '');
  const admin = !!adm && (adminOk(adm) || sbxOk({ token: adm, room }));
  return { admin, sbx: admin && !adminOk(adm), tried: !!adm && !admin, sk: skHash(h['x-mobi-sk']) };
}
const OWN_RE = { drv: /^drv_[a-z0-9]{3,24}$/, pax: /^pax_[a-z0-9]{3,24}$/, seller: /^sel_[a-z0-9]{3,24}$/ };
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
function waViaFor(id, phone) { const v = waVerified.get(String(id || '')); return v && v.tail && v.tail === tail8(phone) ? (v.via || 'wa') : ''; }   /* V530 · por dónde verificó: wa / tg / mail */
function waOkFor(id, phone) { const v = waVerified.get(String(id || '')); return !!(v && v.tail && v.tail === tail8(phone)); }
const ADMIN_ONLY_DRV = ['reviewedAt', 'approvedAt', 'approvedSig', 'reason', 'hiddenAt', 'deletedAt'];
const LOCK_APPROVED_DRV = ['name', 'dni', 'plate', 'vehicle', 'vtype', 'docSig', 'docs', 'registeredAt', 'submittedAt', 'submittedSig'];   /* V555 · el tipo (auto/moto) de un aprobado solo cambia con revisión */
/* V555 · el celular no se cambia, salvo que el guardado esté incompleto (menos de 10 números) y el nuevo esté completo */
function keepPhone(prevPh, newPh) { const a = String(prevPh || '').replace(/\D/g, ''), b = String(newPh || '').replace(/\D/g, ''); if (!a) return newPh; if (a.length < 10 && b.length >= 10) return newPh; return prevPh; }
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
  const L = { charges: 0, paid: 0, cred: 0, held: 0, cancelCr: 0, payDone: 0, payPend: 0, unrel: 0, nextRel: 0, list: [] }, now = Date.now();
  for (const x of room.sticky.values()) {
    const y = x && (x.type === 'debt-charge' || x.type === 'debt-pay') && x.data; if (!y || String(y.driver) !== drv) continue;
    L.list.push(y);
    const a = Number(y.amount) || 0;
    if (x.type === 'debt-charge') {
      if (y.type === 'charge') L.charges += a;
      else if (y.type === 'credit') {
        if (y.hold || y.ver === false) { L.held += a; continue; }
        L.cred += a; if (isCancelCredit(y) || y.kind === 'welcome') L.cancelCr += a;   /* V576 · saldo de viajes de bienvenida: descuenta deuda/comisiones, no se retira */
        /* V525 · cobro con tarjeta: Mercado Pago entrega la plata a los MP_RELEASE_DAYS días; hasta entonces suma al saldo pero no se puede retirar */
        if (MP_RELEASE_DAYS > 0 && isCardCredit(y)) { const mo = y.mpOrd && mpOrders.get(String(y.mpOrd)), t0 = Number((mo && mo.at) || y.paidAt || y.at || 0), rel = t0 + MP_RELEASE_DAYS * 86400_000;
          if (rel > now) { L.unrel += a; if (!L.nextRel || rel < L.nextRel) L.nextRel = rel; } }
      }
    } else if (y.type === 'payment' && y.status === 'confirmado') L.paid += a;
    else if (y.type === 'payout') { if (y.status === 'hecho') L.payDone += a; else if (y.status === 'pendiente') L.payPend += a; }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const netv = L.charges - L.paid - L.cred + L.payDone, favor = Math.max(0, -netv);
  const cancelLeft = Math.max(0, L.cancelCr - Math.max(0, L.charges - L.paid));   /* lo acreditado por cancelaciones solo baja deuda: no se retira */
  L.debt = r2(Math.max(0, netv)); L.favor = r2(favor);
  L.avail = r2(Math.max(0, Math.max(0, favor - cancelLeft) - L.payPend - L.unrel));
  L.unrel = r2(L.unrel);
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
  const FLEX = t === 'seller-reg' || t === 'flex-pkg' || t === 'flex-run' || t === 'flex-cfg';
  if (FLEX) return guardFlex(room, m, auth);
  const SENS = t === 'driver-reg' || t === 'pax-reg' || t === 'debt-charge' || t === 'debt-pay' || t === 'pax-chg' || t === 'pax-adj' || t === 'drv-chg';
  if (!SENS) return m;
  if (!d || typeof d !== 'object') return null;
  if (auth.admin) {
    /* V526 · en el sandbox (sala de prueba) el cobro con tarjeta también descuenta la comisión de Mercado Pago, igual que en la app real */
    if (auth.sbx && t === 'debt-charge' && d.type === 'credit' && !d.mpFee && MP_FEE_PCT > 0 && isCardCredit(d)) {
      const a0 = Math.round((Number(d.amount) || 0) * 100) / 100, fee = Math.round(a0 * MP_FEE_PCT) / 100;
      if (fee > 0) m.data = Object.assign({}, d, { mpFee: fee, amount: Math.round((a0 - fee) * 100) / 100, note: String(d.note || 'Viaje cobrado por MOBI (tarjeta)') + ' · menos comisión de Mercado Pago ($' + Math.round(fee) + ')' });
    }
    return m;
  }
  if (t === 'pax-adj') return null;   /* V682 · los ajustes de saldo de pasajeros solo los manda el administrador */
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
      if (String(prev.phone || '').trim()) o.phone = keepPhone(prev.phone, o.phone);                      /* el celular no se cambia (V555: salvo completar uno incompleto) */
      ['prov', 'zone', 'email', 'alias', 'color'].forEach((k) => { if (String(prev[k] || '').trim() && !String(o[k] || '').trim()) o[k] = prev[k]; });   /* V579 · lo ya declarado nunca se borra con un dato vacío */
      if (ps === 'aprobado' && o.status === 'aprobado') {
        LOCK_APPROVED_DRV.forEach((k) => { if (prev[k] === undefined) delete o[k]; else o[k] = prev[k]; });
        if (String(prev.email || '').trim()) o.email = prev.email;   /* V530 · el mail, una vez cargado, solo cambia con revisión */
        const pc = Array.isArray(prev.cars) ? prev.cars : [];
        if (Array.isArray(o.cars)) o.cars = o.cars.slice(0, 6).map((c) => { const old = pc.find((x) => x && c && String(x.plate || '') === String(c.plate || '')); return Object.assign({}, c, { status: old ? old.status : 'pendiente' }); });
      }
    } else { ADMIN_ONLY_DRV.forEach((k) => delete o[k]); }
    o.wa = waOkFor(id, o.phone); o.waVia = o.wa ? waViaFor(id, o.phone) : '';
    if (revOn(o.phone) && (o.status === 'pendiente' || o.status === 'aprobado')) {   /* V584 · conductor de prueba del revisor: aprobado al instante, con su auto */
      const now = Date.now(); o.status = 'aprobado'; o.approvedAt = (prev && prev.approvedAt) || now; o.reviewedAt = (prev && prev.reviewedAt) || now; o.revisor = 1;
      if (Array.isArray(o.cars)) o.cars = o.cars.map((c) => Object.assign({}, c, { status: 'aprobado' }));
    }
    m.data = o; return m;
  }
  if (t === 'pax-reg') {
    const id = String(d.id || ''); if (!OWN_RE.pax.test(id)) return null;
    m.key = 'pr:' + id;
    const prev = stickyData(room, 'pax-reg|pr:' + id);
    if (!isOwner(room, 'pax', id, auth.sk, !prev || !ownGet(room, 'pax', id))) return null;
    const o = Object.assign({}, d);
    if (prev) {
      ['name', 'dni', 'dniImg', 'at', 'email'].forEach((k) => { if (prev[k] !== undefined && String(prev[k] || '') !== '') o[k] = prev[k]; });   /* nombre, DNI y (V530) mail: solo con revisión */
      if (String(prev.phone || '').trim()) o.phone = keepPhone(prev.phone, o.phone);   /* V555 · completar un celular incompleto */
      ['prov', 'zone', 'emName', 'emPhone', 'photo'].forEach((k) => { if (String(prev[k] || '').trim() && !String(o[k] || '').trim()) o[k] = prev[k]; });   /* V579 · lo ya declarado (provincia, zona…) nunca se borra con un dato vacío */
      if (String(prev.photo || '')) o.photo = prev.photo;                                                  /* la foto de perfil, una vez cargada, no se cambia */
      ['deletedAt'].forEach((k) => { if (prev[k] === undefined) delete o[k]; else o[k] = prev[k]; });
    }
    o.wa = waOkFor(id, o.phone); o.waVia = o.wa ? waViaFor(id, o.phone) : '';
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
    const k = String(d.tripKey || ''); if (!k) { console.log('Saldo a favor rechazado: sin viaje', drv, d.note || ''); incReject(room, d, 'saldo a favor sin viaje', 'Pidió saldo a favor sin un viaje asociado'); return null; }
    const tr = stickyData(room, 'trip|tr:' + k + ':drv'), cl = room.claims.get(k);
    const who = String((tr && tr.active && tr.active.driver && tr.active.driver.id) || (cl && cl.driverId) || '');
    if (who !== drv) { console.log('Saldo a favor rechazado: el viaje no es de este conductor', drv, who || '-', k); incReject(room, d, 'saldo a favor de un viaje que no es suyo', who ? 'El viaje figura de otro conductor (' + who + ')' : 'El viaje no figura como suyo'); return null; }
    const kind = String(d.kind || ''), o = Object.assign({}, d); if (kind === 'welcome') { incReject(room, d, 'saldo de viaje de bienvenida cargado desde el celular', 'Ese saldo solo lo pone el servidor'); return null; }   /* V576 · ese saldo lo pone solo el servidor */
    delete o.ver; delete o.hold; delete o.holdWhy; delete o.paxIdent; delete o.paxSk; delete o.releasedAt; o.at = Date.now();
    let n = 0, nc = 0; for (const x of room.sticky.values()) if (x && x.type === 'debt-charge' && x.data && x.data.type === 'credit' && String(x.data.tripKey || '') === k) { n++; if (isCancelCredit(x.data)) nc++; }
    if (n >= 3) { incReject(room, d, 'más de 3 saldos a favor en el mismo viaje', ''); return null; }
    if (isCancelCredit(o)) {   /* V510 · cancelación: queda retenida hasta que MOBI le cobre el cargo al pasajero */
      if (nc >= 1) return null;                                     /* una sola por viaje */
      o.kind = 'cancel'; o.hold = true; o.holdWhy = 'cobro'; o.paxIdent = paxIdentOfTrip(room, k) || ''; o.paxSk = tripPax.get(room.name + '|' + k) || '';
      m.data = o; return m;
    }
    if (kind === 'paxcredit') {   /* saldo a favor del pasajero usado: solo si lo tiene de verdad */
      const ident = paxIdentOfTrip(room, k), have = paxCreditOf(room, ident);
      if (!(ident && have + 0.5 >= amt)) { o.hold = true; o.holdWhy = 'saldo'; incAdd(room, { kind: 'frenado', title: 'Saldo a favor del pasajero que no tiene (quedó retenido)', drv, tk: k, amount: amt, dk: 'paxsaldo|' + drv + '|' + k, detail: 'El pasajero tiene ' + incMoney(have) + ' de saldo a favor en el servidor. No baja la deuda del conductor hasta que se revise.' }); }
      m.data = o; return m;
    }
    if (hasCardCredit(room, k)) return null;   /* V520 · un solo saldo con tarjeta por viaje (aunque ya lo haya registrado el servidor) */
    /* viaje cobrado con tarjeta: tiene que haber un cobro real de Mercado Pago */
    const amt2 = Math.round(amt * 100) / 100; let ord = null;
    const pid = paxIdentOfTrip(room, k), byPax = (mo) => !mo.sk || !pid || paxIdentOfSk(room, mo.sk) === pid;   /* el cobro lo tuvo que hacer el pasajero de ESE viaje */
    { const oid = String(d.mpOrderId || ''), mo = oid && mpOrders.get(oid); if (mo && (mo.ok || mo.auth) && !mo.used && !mo.credited && Number(mo.amount) + 0.01 >= amt2 && byPax(mo)) ord = [oid, mo]; }   /* el cobro exacto de ese viaje */
    if (!ord) for (const [oid, mo] of mpOrders) { if (mo && (mo.ok || mo.auth) && !mo.used && !mo.credited && mo.ref !== 'deuda' && mo.sk && pid && paxIdentOfSk(room, mo.sk) === pid && Number(mo.amount) + 0.01 >= amt2 && Date.now() - Number(mo.at || 0) < 12 * 3600_000 && (!ord || mo.amount < ord[1].amount)) ord = [oid, mo]; }
    if (ord) {
      ord[1].credited = drv; kvSet('mpord', ord[0], ord[1]); o.mpOrd = ord[0];
      const cf = Math.round((Number(ord[1].amount) - amt2) * 100) / 100; if (cf > 0.5) releaseHolds(room, paxIdentOfTrip(room, k), cf, 'tarjeta');   /* lo que pagó de más con tarjeta = cargo de cancelación anterior */
    } else { o.hold = true; o.holdWhy = 'tarjeta'; }
    /* V520 · Mercado Pago le cobra a MOBI una comisión por cada pago con tarjeta: se descuenta del saldo del conductor (porcentaje en MP_FEE_PCT, por defecto 4,3) */
    if (MP_FEE_PCT > 0) {
      const fee = Math.round(amt2 * MP_FEE_PCT) / 100;
      if (fee > 0) { o.mpFee = fee; o.amount = Math.round((amt2 - fee) * 100) / 100; o.note = String(o.note || 'Viaje cobrado por MOBI (tarjeta)').replace(/ · menos comisión de Mercado Pago.*$/, '') + ' · menos comisión de Mercado Pago ($' + Math.round(fee) + ')'; }
    }
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
      if (amt > L.avail + 0.5) { auth.why = { error: 'over', avail: L.avail }; incReject(room, d, 'retiro mayor al saldo disponible', 'Pidió ' + incMoney(amt) + ' y tiene ' + incMoney(L.avail) + ' disponible'); return null; }   /* V510 · no puede pedir más que su saldo disponible */
      m.data = o; return m; }
    if (o.type !== 'payment') return null;
    if (o.status === 'confirmado') {
      const mo = mpOrders.get(String(o.mpOrderId || ''));
      if (mo && mo.ok && !mo.used && !mo.credited && Math.abs(Number(mo.amount) - amt) < 0.01 && (!mo.sk || mo.sk === auth.sk || ownHas(room, 'drv', drv, mo.sk))) {   /* V508 · el cobro solo lo puede acreditar el celular que pagó (o uno vinculado a la misma cuenta) */ mo.used = drv; kvSet('mpord', String(o.mpOrderId), mo); }
      else { o.status = 'pendiente'; o.note = 'Sin confirmación de Mercado Pago: revisar'; incAdd(room, { kind: 'frenado', title: 'Pago marcado como confirmado sin cobro real de Mercado Pago', drv, amount: amt, dk: 'pagosinmp|' + drv + '|' + id, detail: 'Quedó «pendiente» para revisar: no baja la deuda hasta que lo confirmes.' }); }
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
/* ===================== V558 · MOBI Flex: vendedores, paquetes y colectas =====================
   seller-reg (sr:<id>)  · lo crea el vendedor; aprobar/rechazar solo el administrador
   flex-pkg   (fp:<id>)  · lo carga el vendedor; el chofer de la colecta solo cambia el estado de la entrega
   flex-run   (fr:<id>)  · la pide el vendedor; la toma el primer chofer (después nadie más); el chofer avanza los estados
   flex-cfg   (cfg)      · precios: solo el administrador */
const FLEX_ID = /^[a-z0-9_]{4,40}$/;
const FLEX_DRV_PKG = ['status', 'deliveredAt', 'failedAt', 'failReason', 'proof', 'receiver', 'pickedAt', 'returnedAt', 'driver', 'driverName', 'upd'];
const FLEX_DRV_RUN = ['status', 'driver', 'driverName', 'driverPhone', 'driverPlate', 'driverVehicle', 'driverVType', 'takenAt', 'atPickupAt', 'pickedAt', 'doneAt', 'pos', 'posAt', 'order', 'upd'];
function guardFlex(room, m, auth) {
  const t = m.type, d = m.data; if (!d || typeof d !== 'object') return null;
  if (t === 'flex-cfg') { if (!auth.admin) return null; m.key = 'cfg'; return m; }
  const id = String(d.id || ''); if (!FLEX_ID.test(id)) return null;
  if (t === 'seller-reg') {
    m.key = 'sr:' + id; if (auth.admin) return m;
    const prev = stickyData(room, 'seller-reg|sr:' + id);
    if (!isOwner(room, 'seller', id, auth.sk, !prev || !ownGet(room, 'seller', id))) return null;
    const o = Object.assign({}, d), ps = String((prev && prev.status) || 'pendiente');
    if (o.status !== ps && o.status !== 'pendiente') o.status = ps;                 /* aprobar o rechazar: solo el administrador */
    if (prev && ps === 'aprobado') o.status = 'aprobado';
    ['reviewedAt', 'reason', 'approvedAt'].forEach((k) => { if (prev && prev[k] !== undefined) o[k] = prev[k]; else delete o[k]; });
    m.data = o; return m;
  }
  const seller = String(d.seller || '');
  if (t === 'flex-pkg') {
    m.key = 'fp:' + id; if (auth.admin) return m;
    const prev = stickyData(room, 'flex-pkg|fp:' + id), sel = String((prev && prev.seller) || seller);
    if (ownHas(room, 'seller', sel, auth.sk) || (!prev && isOwner(room, 'seller', sel, auth.sk, false))) { if (prev) m.data = Object.assign({}, d, { seller: sel }); return m; }
    const drv = String(d.driver || '');   /* el chofer de la colecta de ese paquete: solo el estado de la entrega */
    if (!prev || !drv || !ownHas(room, 'drv', drv, auth.sk)) return null;
    const run = prev.run ? stickyData(room, 'flex-run|fr:' + String(prev.run)) : null;
    if (!run || String(run.driver || '') !== drv) return null;
    const o = Object.assign({}, prev); FLEX_DRV_PKG.forEach((k) => { if (d[k] !== undefined) o[k] = d[k]; }); o.driver = drv; m.data = o; return m;
  }
  if (t === 'flex-run') {
    m.key = 'fr:' + id; if (auth.admin) return m;
    const prev = stickyData(room, 'flex-run|fr:' + id), sel = String((prev && prev.seller) || seller);
    if (ownHas(room, 'seller', sel, auth.sk) || (!prev && isOwner(room, 'seller', sel, auth.sk, false))) {
      if (prev && prev.driver) { const o = Object.assign({}, prev); if (d.status === 'cancelada' && /buscando|asignada/.test(String(prev.status))) { o.status = 'cancelada'; o.cancelledAt = Date.now(); o.upd = d.upd; } else return null; m.data = o; return m; }
      return m;
    }
    if (!prev) return null;
    const drv = String(d.driver || ''); if (!drv || !ownHas(room, 'drv', drv, auth.sk)) return null;
    if (prev.driver && prev.driver !== drv) return null;                                  /* ya la tomó otro chofer */
    if (!prev.driver && String(prev.status) !== 'buscando') return null;
    const o = Object.assign({}, prev); FLEX_DRV_RUN.forEach((k) => { if (d[k] !== undefined) o[k] = d[k]; }); o.driver = drv; m.data = o; return m;
  }
  return null;
}
function flexView(room, x, auth) {
  const t = x.type, d = x.data || {};
  if (t === 'flex-cfg') return x;
  if (t === 'seller-reg') return ownHas(room, 'seller', String(d.id || ''), auth.sk) ? x : null;
  if (t === 'flex-pkg') return (ownHas(room, 'seller', String(d.seller || ''), auth.sk) || (d.driver && ownHas(room, 'drv', String(d.driver), auth.sk))) ? x : null;
  if (t === 'flex-run') {
    if (ownHas(room, 'seller', String(d.seller || ''), auth.sk) || (d.driver && ownHas(room, 'drv', String(d.driver), auth.sk))) return x;
    if (String(d.status) !== 'buscando') return Object.assign({}, x, { data: { id: d.id, status: 'no_disponible', upd: d.upd } });   /* ya la tomó otro: los demás solo se enteran de que no está más */
    const o = {}; ['id', 'seller', 'status', 'business', 'pickup', 'count', 'price', 'pay', 'at', 'upd', 'vtypes'].forEach((k) => { if (d[k] !== undefined) o[k] = d[k]; });
    return Object.assign({}, x, { data: o });
  }
  return x;
}
/* qué ve cada celular de los datos de otros */
const DRV_PUBLIC = ['id', 'name', 'status', 'plate', 'vehicle', 'registeredAt', 'submittedAt', 'reviewedAt', 'approvedAt', 'updatedAt', 'hiddenAt', 'deletedAt', 'wa', 'docs'];
function viewFor(room, x, auth) {
  if (auth.admin) { const d0 = x && x.data; if (x && (x.type === 'pax-reg' || x.type === 'driver-reg') && d0 && d0.wa && !d0.waVia) { const via = waViaFor(d0.id, d0.phone); if (via) return Object.assign({}, x, { data: Object.assign({}, d0, { waVia: via }) }); } return x; }   /* V530 · registros viejos: se agrega por dónde verificó */
  const t = x.type, d = x.data;
  if (t === 'seller-reg' || t === 'flex-pkg' || t === 'flex-run' || t === 'flex-cfg') return flexView(room, x, auth);   /* V558 */
  if (t === 'offer-lag') return null;   /* V532 · mediciones de demora: solo las ve el administrador */
  if (!d || typeof d !== 'object') return x;
  if (t === 'pax-reg') return ownHas(room, 'pax', String(d.id || ''), auth.sk) ? x : null;
  if (t === 'pax-chg') return ownHas(room, 'pax', String(d.id || ''), auth.sk) ? x : null;
  if (t === 'pax-adj') return ownHas(room, 'pax', String(d.id || ''), auth.sk) ? x : null;
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
    if (m && (m.type === 'acct-susp' || m.type === 'cfg-price' || m.type === 'cfg-debt' || m.type === 'cfg-maint' || m.type === 'cfg-prelaunch' || m.type === 'cfg-reset' || m.type === 'cfg-cupo' || m.type === 'cfg-push' || m.type === 'drv-slots' || m.type === 'cfg-founder' || m.type === 'drv-founders' || m.type === 'cfg-welcome' || m.type === 'cfg-remind' || m.type === 'cfg-natpush' || m.type === 'cfg-drvphoto' || m.type === 'cfg-delacct' || m.type === 'cfg-wshare' || m.type === 'cfg-selftrip' || m.type === 'cfg-voice' || m.type === 'cfg-xstreet' || m.type === 'cfg-tripsave' || m.type === 'cfg-fb' || m.type === 'cfg-vrem' || m.type === 'cfg-pin' || m.type === 'cfg-apkupd' || m.type === 'cfg-tripwatch' || m.type === 'acct-erased')) continue;   // solo el administrador (endpoint propio)
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
  if (m && (m.type === 'acct-susp' || m.type === 'cfg-price' || m.type === 'cfg-debt' || m.type === 'cfg-maint' || m.type === 'cfg-prelaunch' || m.type === 'cfg-reset' || m.type === 'cfg-cupo' || m.type === 'cfg-push' || m.type === 'drv-slots' || m.type === 'cfg-founder' || m.type === 'drv-founders' || m.type === 'cfg-welcome' || m.type === 'cfg-remind' || m.type === 'cfg-natpush' || m.type === 'cfg-drvphoto' || m.type === 'cfg-delacct' || m.type === 'cfg-wshare' || m.type === 'cfg-selftrip' || m.type === 'cfg-voice' || m.type === 'cfg-xstreet' || m.type === 'cfg-tripsave' || m.type === 'cfg-fb' || m.type === 'cfg-vrem' || m.type === 'cfg-pin' || m.type === 'cfg-apkupd' || m.type === 'cfg-tripwatch' || m.type === 'acct-erased' || (m.type === 'pax-chg' && !(m.data && (m.data.status === 'pendiente' || m.data.status === 'cancelado'))))) return res.status(403).json({ ok: false, error: 'admin' });
  if (regBlocked(getRoom(room), m)) return res.status(409).json({ ok: false, error: 'dup_reg' });
  const saved = pushMessage(getRoom(room), m);
  if (!saved) return res.status(400).json({ ok: false, error: 'invalid message' });
  res.json({ ok: true, id: saved.id });
});

function busHandle(req, res) {
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
    if ((x.type === 'pay-proof' || x.type === 'pay-proof-meta') && !(set && set.has(me))) continue;   /* V470 · el comprobante nunca va a todos (el conductor lo baja de /api/proof/get) · V629 · su ficha tampoco */
    if (!set || set.has(me)) { out.push(x); continue; }            // sin datos del viaje (p. ej. tras reinicio): se entrega como antes
    if (x.priv === 'trip') { const a = x.data.active; out.push({ id: x.id, type: x.type, src: x.src, key: x.key, ts: x.ts, at: x.at, data: { active: { tripKey: a.tripKey, status: a.status }, from: x.data.from, rev: x.data.rev, by: x.data.by } }); }
  }
  /* V448 · sin pérdidas: si hay más de 400, se entregan los primeros y el resto en el próximo sondeo */
  let last = r.seq, list = out;
  if (list.length > 400) { list = list.slice(0, 400); last = list[list.length - 1].id; }
  res.json(LP.on ? { ok: true, messages: list.map(({ priv, tk, ...m }) => m), last, lp: 1 } : { ok: true, messages: list.map(({ priv, tk, ...m }) => m), last });
}
/* V607 · CONSULTA EN ESPERA (apagada de fábrica; la enciende Administración): en vez de preguntar «¿hay novedades?» cada 1-2 segundos, el celular deja
   la pregunta abierta hasta 20 s y el servidor contesta apenas hay algo (o a los 20 s). Mismo resultado, muchísimos menos pedidos. */
app.get('/api/bus', (req, res) => {
  const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0)), after = Number(req.query.after) || 0;
  if (!LP.on || !wait || after <= 0) return busHandle(req, res);
  const r = getRoom(req.query.room);
  if (r.seq > after) return busHandle(req, res);   // ya hay novedades
  if (!r.lp) r.lp = new Set();
  let done = false;
  const w = () => { if (done) return; done = true; clearTimeout(t); r.lp.delete(w); try { busHandle(req, res); } catch (e) { try { res.status(500).json({ ok: false }); } catch (x) {} } };
  const t = setTimeout(w, wait * 1000);
  r.lp.add(w);
  req.on('close', () => { if (done) return; done = true; clearTimeout(t); r.lp.delete(w); });
});
function lpWake(room, low) {
  if (!LP.on || !room.lp || !room.lp.size) return;
  const k = low ? 'lpL' : 'lpH';
  if (room[k]) return;
  room[k] = setTimeout(() => { room[k] = null; for (const w of [...(room.lp || [])]) w(); }, low ? 4000 : 30);
}

/* ------------- adjudicación atómica de viajes ------------- */
/* V532 · el servicio nativo «Estás en línea» de la APK pregunta acá si hay pedidos esperando cerca (liviano: no baja todo el bus).
   Solo para un conductor APROBADO, desde su propio celular. Así el aviso llega aunque Android haya dormido la app. */
app.get('/api/drv/offers', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {}, r = getRoom(String(q.room || '')), d = String(q.id || ''), lat = Number(q.lat), lng = Number(q.lng);
  const au = authOf(req, r.name), dr = stickyData(r, 'driver-reg|dr:' + d);
  if (!OWN_RE.drv.test(d) || (!au.admin && !isOwner(r, 'drv', d, au.sk, legacyBind(r, 'drv', d))) || !dr || dr.status !== 'aprobado' || drvHidden(dr) || dr.deletedAt || cupoWaiting(r, d)) return res.status(403).json({ ok: false });
  const now = Date.now(), out = [], R = 6;
  const km = (a, b) => { const t = Math.PI / 180, x = Math.sin((b.lat - a.lat) * t / 2), y = Math.sin((b.lng - a.lng) * t / 2), h = x * x + Math.cos(a.lat * t) * Math.cos(b.lat * t) * y * y; return 12742 * Math.asin(Math.sqrt(h)); };
  const lab = (v) => v == null ? '' : (typeof v === 'object' ? String(v.label || '') : String(v));
  for (const [key, m] of r.sticky) {
    if (!m || m.type !== 'trip' || !/:pax$/.test(key) || !m.data || !m.data.active) continue;
    const a = m.data.active, k = String(a.tripKey || ''); if (!k || now - Number(m.at || 0) > 240000) continue;
    if (!/Esperando conductor|Buscando conductor|Solicitud/i.test(String(a.status || ''))) continue;
    if (r.sticky.get('trip-end|te:' + k) || r.claims.get(k)) continue;
    const o = a.originPlace || {}; let dist = null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng))) { dist = km({ lat, lng }, { lat: Number(o.lat), lng: Number(o.lng) }); if (dist > R) continue; }
    out.push({ k, from: lab(a.originPlace || a.origin).slice(0, 80), to: lab(a.destinationPlace || a.destination).slice(0, 80), fare: Number(a.fare) || 0, km: dist == null ? null : Math.round(dist * 10) / 10, env: a.kind === 'envio' ? 1 : 0 });
    if (out.length >= 5) break;
  }
  res.json({ ok: true, at: now, offers: out });
});
app.post('/api/trip/claim', (req, res) => {
  const { room, tripKey, driverId } = req.body || {};
  if (!tripKey || !driverId) return res.status(400).json({ ok: false, error: 'tripKey and driverId are required' });
  const r = getRoom(room), k = String(tripKey), d = String(driverId);
  /* V470 · un pedido que el pasajero ya canceló no se puede tomar */
  const te = r.sticky.get('trip-end|te:' + k), tp = r.sticky.get('trip|tr:' + k + ':pax');
  /* V568 · un viaje ya TERMINADO no lo puede tomar nadie, ni el mismo conductor que lo hizo */
  if (!r.doneTk) { r.doneTk = new Set(); for (const x of r.sticky.values()) if (x && x.type === 'trip-done' && x.data && x.data.tripKey) r.doneTk.add(String(x.data.tripKey)); }
  const td = r.doneTk.has(k);
  if (te || td || (tp && tp.data && tp.data.active && /Cancel/i.test(String(tp.data.active.status || '')))) return res.json({ ok: false, error: 'ended' });
  if (cupoWaiting(r, d)) return res.json({ ok: false, error: 'cupo' });   /* V473 · en lista de espera */
  { const au = authOf(req, r.name), dr = stickyData(r, 'driver-reg|dr:' + d);   /* V500 · solo un conductor APROBADO por el administrador, desde su propio celular, puede tomar viajes */
    if (!au.admin && (!isOwner(r, 'drv', d, au.sk, legacyBind(r, 'drv', d)) || !dr || dr.status !== 'aprobado' || drvHidden(dr) || dr.deletedAt)) return res.json({ ok: false, error: 'not_approved' }); }
  const cur = r.claims.get(k);
  if (cur && cur.driverId !== d) return res.json({ ok: false, winner: cur.driverId });
  /* V625 · viajes de bienvenida: cada conductor puede tomar como mucho WEL_DRV_DAY por día (los que hizo + los que tiene en curso) */
  if (!cur) { try { const wr = welRec.get(r.name + '|' + k); if (wr && !wr.done && !wr.end && welDrvToday(r, d, k) >= WEL_DRV_DAY) return res.json({ ok: false, error: 'wel_limit', max: WEL_DRV_DAY }); } catch (e) {} }
  r.claims.set(k, { driverId: d, at: Date.now() });
  /* V470 · quién tomó cada viaje se guarda en la base EN SEGUNDO PLANO (no frena a nadie) y se recupera si el servidor se reinicia */
  if (db && !cur) db.query(`INSERT INTO mobi_kv (ns, id, data, at) VALUES ('claim', $1, $2::jsonb, now()) ON CONFLICT (ns, id) DO UPDATE SET data = EXCLUDED.data, at = now()`, [r.name + '|' + k, JSON.stringify({ driverId: d, at: Date.now() })]).catch(() => {});
  res.json({ ok: true, winner: d });
});
/* V668 · RESCATE DE VIAJE AL REABRIR: el celular que reabre la app con una copia vieja del viaje («Buscando conductor») pregunta acá
   cómo está de verdad antes de darlo por vencido. Devuelve solo si terminó y la parte del conductor (la misma que ya reparte el bus). */
function tripSaveOn(room) { const m = room.sticky.get('cfg-tripsave|cfg:tripsave'); return !(m && m.data && m.data.on === false); }   /* encendido de fábrica */
app.get('/api/trip/state', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = getRoom(req.query.room), k = String(req.query.tk || '').slice(0, 80);
  if (!k) return res.status(400).json({ ok: false });
  if (!tripSaveOn(r)) return res.json({ ok: true, off: true });
  if (!r.doneTk) { r.doneTk = new Set(); for (const x of r.sticky.values()) if (x && x.type === 'trip-done' && x.data && x.data.tripKey) r.doneTk.add(String(x.data.tripKey)); }
  const te = r.sticky.get('trip-end|te:' + k), tp = stickyData(r, 'trip|tr:' + k + ':pax'), td = stickyData(r, 'trip|tr:' + k + ':drv');
  const pa = (tp && tp.active) || null, da = (td && td.active) || null;
  const ended = !!(te || r.doneTk.has(k) || (pa && /Cancel/i.test(String(pa.status || ''))));
  let done = null;   /* V679 · si el viaje terminó bien, se devuelve su resumen para que el pasajero lo pueda cerrar como corresponde (calificar, saldar cargos) */
  if (ended && r.doneTk.has(k)) { for (const x of r.sticky.values()) if (x && x.type === 'trip-done' && x.data && String(x.data.tripKey || '') === k) { done = { type: 'trip-done', data: x.data, src: x.src || 'srv' }; break; } }
  res.json({ ok: true, ended, done, drv: !ended && da && String(da.tripKey || '') === k ? da : null });
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
    if (now - r.touched > (/^sandbox/.test(k) ? 3 * 3600_000 : ROOM_TTL)) { rooms.delete(k); continue; }   /* V535 · salas de prueba se sueltan a las 3 h sin uso */
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
async function mpCall(method, url, body, idem, extraH) {
  const r = await fetch(MP_API + url, { method, headers: Object.assign(mpHeaders(idem), extraH || {}), body: body ? JSON.stringify(body) : undefined });
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
  /* V517 · más datos para el antifraude de Mercado Pago (rechazos «riesgo alto»): huella del celular, nombre del pagador y detalle del ítem.
     Si Mercado Pago no acepta algún dato extra, se reintenta con el pedido de siempre. */
  const dev = /^[A-Za-z0-9:_.-]{8,200}$/.test(String(b.deviceId || '')) ? String(b.deviceId) : '';
  const rich = JSON.parse(JSON.stringify(payload));
  const nm = String(b.payerName || '').replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!b.customerId && nm.length >= 2) { rich.payer.first_name = nm.slice(0, -1).join(' ').slice(0, 60); rich.payer.last_name = nm[nm.length - 1].slice(0, 60); }
  rich.items = [{ title: 'Viaje MOBI', quantity: 1, unit_price: amountStr }];
  try {
    let r = await mpCall('POST', '/v1/orders', rich, `pay_${reference}`, dev ? { 'X-meli-session-id': dev } : null);
    if (!r.ok && r.status === 400 && !/cc_rejected|high_risk|insufficient/.test(JSON.stringify(r.data || {}))) { console.log('MP: datos extra no aceptados, reintento simple', JSON.stringify(r.data).slice(0, 300)); r = await mpCall('POST', '/v1/orders', payload, `pay2_${reference}`, dev ? { 'X-meli-session-id': dev } : null); }
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
  if (revOn(b.phone)) { mailPending.set(userId, { code: REV.code, email, tail, at: Date.now(), tries: 0 }); return res.json({ ok: true, configured: true, sent: true }); }   /* V584 · celular de prueba: código fijo, no se manda mail */
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
  res.json({ ok: true, at: Date.now(), debt: L.debt, favor: L.favor, avail: L.avail, held: L.held, unrel: L.unrel, nextRel: L.nextRel, relDays: MP_RELEASE_DAYS, payPend: Math.round(L.payPend * 100) / 100, list: L.list.map((y) => { const o = Object.assign({}, y); delete o.paxIdent; delete o.paxSk; return o; }) });
});
/* V596 · totales del administrador calculados por el SERVIDOR (iguales en todos los celulares): volumen de viajes, comisión generada, deuda y pagos de los conductores */
const finCache = new Map();
app.post('/api/admin/finance', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), hit = finCache.get(room.name); if (hit && Date.now() - hit.t < 8000) return res.json(hit.d);
  let vol = 0, fee = 0, trips = 0; const seen = new Set(), drivers = new Set();
  for (const x of room.sticky.values()) {
    if (!x) continue;
    if (x.type === 'trip-done' && x.data && x.data.sum) {
      const sm = x.data.sum, k = String(x.data.tripKey || sm.tripKey || sm.tripId || ''); if (k) { if (seen.has(k)) continue; seen.add(k); }
      vol += Number(sm.fare) || 0; fee += Number(sm.fee) || 0; trips++;
    } else if ((x.type === 'debt-charge' || x.type === 'debt-pay') && x.data && x.data.driver) drivers.add(String(x.data.driver));
  }
  let owed = 0, paid = 0; const names = new Map(), rows = [], byKind = {}, byTk = new Map();
  for (const x of room.sticky.values()) if (x && x.type === 'driver-reg' && x.data && x.data.id) names.set(String(x.data.id), String(x.data.name || ''));
  for (const d of drivers) { const L = ledgerOf(room, d); owed += L.debt; paid += L.paid;
    for (const y of L.list) { if (y.type !== 'charge') continue; const k = String(y.kind || (/^Comisión de viaje/.test(y.note || '') ? 'comision' : 'otro')); const o = byKind[k] || (byKind[k] = { n: 0, amt: 0 }); o.n++; o.amt += Number(y.amount) || 0;
      if (y.tripKey && k === 'comision') { const t = byTk.get(y.tripKey) || { n: 0, amt: 0, drv: d }; t.n++; t.amt += Number(y.amount) || 0; byTk.set(y.tripKey, t); } }
    if (L.debt || L.paid || L.charges || L.cred) rows.push({ id: d, name: names.get(d) || '', charges: Math.round(L.charges), paid: Math.round(L.paid), cred: Math.round(L.cred), payDone: Math.round(L.payDone), debt: Math.round(L.debt), favor: Math.round(L.favor) }); }
  rows.sort((a, b) => b.debt - a.debt);
  const dup = []; for (const [k, t] of byTk) if (t.n > 1) dup.push({ tripKey: k, n: t.n, amt: Math.round(t.amt) });
  for (const k of Object.keys(byKind)) byKind[k].amt = Math.round(byKind[k].amt);
  const r2 = (n) => Math.round(n * 100) / 100, d = { ok: true, at: Date.now(), vol: r2(vol), fee: r2(fee), trips, owed: r2(owed), paid: r2(paid), drivers: drivers.size, audit: { byKind, rows: rows.slice(0, 40), dup: dup.slice(0, 20), dupN: dup.length } };
  finCache.set(room.name, { t: Date.now(), d }); res.json(d);
});
/* V682 · Administrador de balances: ver, anular y cargar movimientos de plata de conductores y ajustar pasajeros. Todo queda en un registro. */
const balLog = [];
function balNote(rec) { rec.at = Date.now(); balLog.unshift(rec); if (balLog.length > 300) balLog.pop(); try { kvSet('balog', 'b' + rec.at + Math.random().toString(36).slice(2, 5), rec); } catch (e) {} console.log('Balance admin:', rec.action, rec.driver || rec.pax || '', rec.amount || '', rec.reason || ''); }
app.post('/api/admin/balance', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), act = String(b.action || ''), r0 = (n) => Math.round(n * 100) / 100;
  const reason = String(b.reason || '').trim().slice(0, 200);
  const nameOf = (id) => { const d = stickyData(r, 'driver-reg|dr:' + id); return d ? { name: String(d.name || ''), plate: String(d.plate || ''), phone: String(d.phone || '') } : { name: '', plate: '', phone: '' }; };
  try {
    if (act === 'drivers') {
      const ids = new Set();
      for (const x of r.sticky.values()) { if (x && x.type === 'driver-reg' && x.data && OWN_RE.drv.test(String(x.data.id || ''))) ids.add(String(x.data.id)); else if (x && (x.type === 'debt-charge' || x.type === 'debt-pay') && x.data && OWN_RE.drv.test(String(x.data.driver || ''))) ids.add(String(x.data.driver)); }
      const q = String(b.q || '').toLowerCase().trim(), out = [];
      for (const id of ids) { const n = nameOf(id), L = ledgerOf(r, id); if (q && !(id.toLowerCase().includes(q) || n.name.toLowerCase().includes(q) || n.plate.toLowerCase().includes(q))) continue; out.push({ id, name: n.name, plate: n.plate, debt: L.debt, favor: L.favor, n: L.list.length }); }
      out.sort((x, y) => (y.debt + y.favor) - (x.debt + x.favor) || x.name.localeCompare(y.name));
      return res.json({ ok: true, drivers: out.slice(0, 60) });
    }
    if (act === 'entries') {
      const drv = String(b.driver || ''); if (!OWN_RE.drv.test(drv)) return res.status(400).json({ ok: false, error: 'datos' });
      const L = ledgerOf(r, drv), n = nameOf(drv);
      return res.json({ ok: true, driver: drv, name: n.name, plate: n.plate, charges: r0(L.charges), paid: r0(L.paid), cred: r0(L.cred), payDone: r0(L.payDone), held: L.held, debt: L.debt, favor: L.favor, list: L.list.slice(-80).reverse().map((y) => ({ id: y.id, type: y.type, kind: y.kind || '', amount: Number(y.amount) || 0, at: y.at, note: String(y.note || '').slice(0, 140), hold: !!y.hold, status: y.status || '', voided: !!y.voidAt })) });
    }
    if (act === 'void') {
      const drv = String(b.driver || ''), id = String(b.id || ''); if (!OWN_RE.drv.test(drv) || !id) return res.status(400).json({ ok: false, error: 'datos' });
      if (reason.length < 3) return res.status(400).json({ ok: false, error: 'motivo' });
      let hit = null; for (const x of r.sticky.values()) if (x && (x.type === 'debt-charge' || x.type === 'debt-pay') && x.data && String(x.data.id) === id && String(x.data.driver) === drv) { hit = x; break; }
      if (!hit) return res.status(404).json({ ok: false, error: 'no_existe' });
      const d = hit.data, amt = Number(d.amount) || 0; if (d.voidAt) return res.json({ ok: true, already: true });
      pushMessage(r, { type: hit.type, key: hit.key, src: 'admin', data: Object.assign({}, d, { amount: 0, hold: false, voidAt: Date.now(), voidedAmt: amt, voidReason: reason, note: '🗑 Anulado por Administración · ' + String(d.note || '').slice(0, 100) }) });
      balNote({ action: 'void', driver: drv, id, amount: amt, type: d.type, reason, note: String(d.note || '').slice(0, 80) });
      return res.json({ ok: true });
    }
    if (act === 'add') {
      const drv = String(b.driver || ''), typ = b.type === 'charge' ? 'charge' : 'credit', amt = Math.round(Number(b.amount) || 0);
      if (!OWN_RE.drv.test(drv) || !(amt > 0) || amt > 5_000_000) return res.status(400).json({ ok: false, error: 'datos' });
      if (reason.length < 3) return res.status(400).json({ ok: false, error: 'motivo' });
      const id = 'adj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pushMessage(r, { type: 'debt-charge', key: 'dc:' + id, src: 'admin', data: { id, type: typ, kind: 'admin-adj', amount: amt, at: Date.now(), driver: drv, note: (typ === 'credit' ? 'Saldo a favor cargado por Administración · ' : 'Deuda cargada por Administración · ') + reason, srv: 1 } });
      balNote({ action: typ === 'credit' ? 'add-credit' : 'add-charge', driver: drv, id, amount: amt, reason });
      return res.json({ ok: true, id });
    }
    if (act === 'pax') {
      const q = String(b.q || '').toLowerCase().trim(), qd = q.replace(/\D/g, ''), out = [];
      for (const x of r.sticky.values()) { const d = x && x.type === 'pax-reg' && x.data; if (!d || !OWN_RE.pax.test(String(d.id || '')) || d.deletedAt) continue; const nm = String(d.name || ''), ph = String(d.phone || '').replace(/\D/g, ''); if (q && !(nm.toLowerCase().includes(q) || (qd.length >= 3 && ph.includes(qd)) || String(d.id).includes(q))) continue; out.push({ id: String(d.id), name: nm, phone: String(d.phone || '') }); }
      return res.json({ ok: true, pax: out.slice(0, 30) });
    }
    if (act === 'paxadj') {
      const pid = String(b.pax || ''), what = String(b.what || ''); if (!OWN_RE.pax.test(pid) || !['clearFee', 'clearCredit', 'addCredit'].includes(what)) return res.status(400).json({ ok: false, error: 'datos' });
      const amt = Math.round(Number(b.amount) || 0); if (what === 'addCredit' && !(amt > 0 && amt <= 5_000_000)) return res.status(400).json({ ok: false, error: 'datos' });
      if (reason.length < 3) return res.status(400).json({ ok: false, error: 'motivo' });
      const id = 'pa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      pushMessage(r, { type: 'pax-adj', key: 'pa:' + pid + ':' + id, src: 'admin', data: { id: pid, aid: id, what, amount: amt, reason, at: Date.now() } });
      balNote({ action: 'pax-' + what, pax: pid, amount: amt, reason });
      return res.json({ ok: true, aid: id });
    }
    if (act === 'log') {
      let rows = balLog.slice();
      if (db) { try { const q = await db.query(`SELECT data FROM mobi_kv WHERE ns = 'balog'`); rows = q.rows.map((x) => x.data).filter(Boolean); } catch (e) {} }
      rows.sort((x, y) => Number(y.at || 0) - Number(x.at || 0));
      return res.json({ ok: true, log: rows.slice(0, 60) });
    }
  } catch (e) { console.warn('balance', e.message); return res.status(500).json({ ok: false, error: 'server' }); }
  res.status(400).json({ ok: false, error: 'accion' });
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
  /* V527 · también desde el resumen final del viaje («trip-done»), que queda guardado en la base: si Render reinicia el servidor, la red de seguridad no se pierde */
  for (const x of room.sticky.values()) {
    if (!x || x.type !== 'trip-done' || !x.data || !x.data.sum) continue;
    const d = x.data, sm = d.sum, k = String(d.tripKey || sm.tripKey || '').slice(0, 80); if (!k) continue;
    const t0 = Number(sm.at || x.at || 0); if (now - Number(x.at || t0) < G || now - t0 > 2 * 86400_000) continue;
    const drv = String(sm.driverId || ''); if (!OWN_RE.drv.test(drv) || (fs.ids && fs.ids[drv])) continue;
    if (room.sticky.has('debt-charge|dc:com:' + k) || room.sticky.has('pay-dispute|pd:pd_' + k)) continue;
    const fare = Number(sm.fare || 0), cf = Math.max(0, Math.min(fare, Number(sm.cf || 0))); if (!(fare > 0)) continue;
    if (charges.some((c) => String(c.driver) === drv && (String(c.tripKey || '') === k || (!c.tripKey && Math.abs(Number(c.fare || 0) - fare) < 1 && Math.abs(Number(c.at || 0) - t0) < 3 * 3600_000)))) continue;
    const base = Number(sm.comm) > 0 && Number(sm.fee) > 0 ? Number(sm.fee) / Number(sm.comm) : fare - cf;
    const fee = Math.round(base * pct) / 100; if (!(fee > 0)) continue;
    pushMessage(room, { type: 'debt-charge', key: 'dc:com:' + k, src: 'admin', data: { id: 'com_' + k.slice(0, 40), type: 'charge', amount: fee, at: now, driver: drv, note: 'Comisión de viaje (' + pct + '%) · registrada por MOBI', fare, tripKey: k, srv: 1 } });
    charges.push({ driver: drv, tripKey: k, fare, at: now });
    console.log('Comisión registrada por el servidor (resumen del viaje)', drv, k, fee);
  }
}
/* V520 · red de seguridad del saldo con tarjeta: si un viaje pagado con tarjeta terminó y el celular del conductor no registró su saldo a favor,
   lo registra el servidor (uno solo por viaje, también para fundadores), ya sin la comisión de Mercado Pago */
const CARD_GRACE = Number(process.env.CARD_GRACE_MS || 10 * 60_000);
const hasCardCredit = (room, k) => { for (const y of room.sticky.values()) { const d = y && y.type === 'debt-charge' && y.data; if (d && d.type === 'credit' && String(d.tripKey || '') === k && !isCancelCredit(d) && d.kind !== 'paxcredit') return true; } return false; };
function cardSweep(room, grace) {
  /* se basa en el resumen final del viaje («trip-done»), que queda guardado en la base aunque el servidor se reinicie */
  const G = Number.isFinite(grace) ? grace : CARD_GRACE, now = Date.now();
  for (const [key, x] of room.sticky) {
    if (!x || x.type !== 'trip-done' || !x.data || !x.data.sum) continue;
    const d = x.data, sm = d.sum, k = String(d.tripKey || sm.tripKey || sm.tripId || '').slice(0, 80);
    if (!k || !(sm.paidOnline || /tarjeta|mercado/i.test(String(sm.payment || '')))) continue;
    const t0 = Number(sm.at || x.at || 0), age = now - Number(x.at || t0 || 0); if (age < G || now - t0 > 7 * 86400_000) continue;
    const drv = String(sm.driverId || ''); if (!OWN_RE.drv.test(drv)) continue;
    if (room.sticky.has('debt-charge|dc:card:' + k) || hasCardCredit(room, k)) continue;
    const fare = Number(sm.fare || 0), cf = Math.max(0, Math.min(fare, Number(sm.cf || 0))); if (!(fare > 0)) continue;
    const base = Math.round((fare - cf) * 100) / 100, fee = MP_FEE_PCT > 0 ? Math.round(base * MP_FEE_PCT) / 100 : 0;
    const good = (mo) => mo && (mo.ok || mo.auth) && !mo.credited && mo.ref !== 'deuda' && Number(mo.amount) + 0.01 >= base;
    let oid = String(sm.mpOrderId || ''), mo = oid && mpOrders.get(oid);
    if (!good(mo)) {   /* sin número de cobro: se busca UN cobro real del mismo monto cerca de la hora del viaje */
      const c = []; for (const [id, o] of mpOrders) if (good(o) && Math.abs(Number(o.amount) - fare) < 0.01 && Math.abs(Number(o.at || 0) - t0) < 3 * 3600_000) c.push([id, o]);
      if (c.length === 1) { oid = c[0][0]; mo = c[0][1]; } else { oid = ''; mo = null; }
    }
    const ok = !!(mo && good(mo));
    const data = { id: 'card_' + k.slice(0, 40), type: 'credit', amount: Math.round((base - fee) * 100) / 100, at: now, driver: drv, tripKey: k, route: (String(sm.origin || '') + ' → ' + String(sm.destination || '')).slice(0, 200),
      note: 'Viaje cobrado por MOBI (tarjeta) · registrado por MOBI' + (fee > 0 ? ' · menos comisión de Mercado Pago ($' + Math.round(fee) + ')' : '') };
    if (fee > 0) data.mpFee = fee;
    if (ok) { mo.credited = drv; kvSet('mpord', oid, mo); data.mpOrd = oid; } else { data.hold = true; data.holdWhy = 'tarjeta'; }
    pushMessage(room, { type: 'debt-charge', key: 'dc:card:' + k, src: 'admin', data });
    console.log('Saldo con tarjeta registrado por el servidor', drv, k, data.amount, ok ? 'verificado' : 'retenido');
  }
}
setInterval(() => { for (const r of rooms.values()) { try { commissionSweep(r); } catch (e) { console.warn('comision', e.message); } try { cardSweep(r); } catch (e) { console.warn('tarjeta', e.message); } } }, 5 * 60_000).unref();
app.post('/api/admin/cardsweep', (req, res) => { const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false }); cardSweep(getRoom(b.room), Number.isFinite(Number(b.grace)) ? Number(b.grace) : undefined); res.json({ ok: true }); });
app.post('/api/admin/commsweep', (req, res) => { const b = req.body || {}; if (!adminOk(b.token)) return res.status(401).json({ ok: false }); commissionSweep(getRoom(b.room), Number.isFinite(Number(b.grace)) ? Number(b.grace) : undefined); res.json({ ok: true }); });

/* V574.14 · una persona = un nombre: el cambio aprobado de nombre, DNI o mail (sea como pasajero o como conductor)
   se aplica también a su otra cuenta (mismo celular) y se le avisa a ese celular para que actualice los dos roles. */
function crossRoleSync(rm, from, phone, vals) {
  try {
    const t = tail8(phone); if (!t || t.length < 6) return;
    const v = {}; ['name', 'dni', 'email'].forEach((k) => { if (vals[k] !== undefined && vals[k] !== null && String(vals[k]).trim()) v[k] = String(vals[k]).trim(); });
    if (!Object.keys(v).length) return;
    for (const [k, m] of rm.sticky) {
      if (!m || !m.data || typeof m.data !== 'object') continue;
      const isPax = m.type === 'pax-reg' && k.startsWith('pax-reg|pr:'), isDrv = m.type === 'driver-reg' && k.startsWith('driver-reg|dr:');
      if (!(isPax && from === 'drv') && !(isDrv && from === 'pax')) continue;
      const d = m.data; if (d.deletedAt || tail8(d.phone) !== t) continue;
      const n = Object.assign({}, d, v); if (isPax) n.upd = Date.now(); else { n.updatedAt = Date.now(); n.chgAt = Date.now(); }
      pushMessage(rm, { type: m.type, key: m.key, src: 'admin', data: n });
      const ck = isPax ? 'pax-chg|pc:' + d.id : 'drv-chg|xc:' + d.id, cp = stickyData(rm, ck);
      if (!cp || cp.status !== 'pendiente') pushMessage(rm, { type: isPax ? 'pax-chg' : 'drv-chg', key: (isPax ? 'pc:' : 'xc:') + d.id, src: 'admin', data: Object.assign({ id: d.id, rid: 'sync' + Date.now().toString(36), status: 'aprobado', sync: 1, at: Date.now() }, v) });
    }
  } catch (e) { console.warn('crossRoleSync', e.message); }
}
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
    crossRoleSync(rm, 'pax', n.phone, { name: pend.name, dni: pend.dni, email: pend.email });
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
    ['name', 'dni', 'plate', 'vehicle', 'email'].forEach((k) => { if (pend[k] !== undefined && String(pend[k] || '').trim()) n[k] = String(pend[k]).trim(); });
    const imgs = pend.imgs && typeof pend.imgs === 'object' ? pend.imgs : {};
    if (adminOk(b.token)) for (const kind of Object.keys(imgs)) { const img = String(imgs[kind] || ''); if (!['cedula', 'license', 'dniF', 'dniB', 'profile'].includes(kind) || !/^data:image\/(jpeg|png|webp);base64,/.test(img)) continue;
      const item = { img, at: Date.now() }; docMem.set(id + '|' + kind, item); await kvSet('doc', id + '|' + kind, item); n.docs = Object.assign({}, n.docs, { [kind]: true }); }
    n.updatedAt = Date.now(); n.chgAt = Date.now();
    pushMessage(rm, { type: 'driver-reg', key: 'dr:' + id, src: 'admin', data: n });
    crossRoleSync(rm, 'drv', n.phone, { name: pend.name, dni: pend.dni, email: pend.email });
  }
  const data = { id, rid: String(pend.rid || '').slice(0, 40), status, reason: String(b.reason || '').slice(0, 200), at: Date.now() };
  if (status === 'aprobado') Object.assign(data, { name: pend.name, dni: pend.dni, plate: pend.plate, vehicle: pend.vehicle, email: pend.email, imgs: pend.imgs });   /* el celular del conductor guarda lo aprobado */
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
    gPct: num(c.gPct, -60, 200, 0),   /* V606 · ajuste general de precios (Administración) */
    base: num(c.base, 0, 50000, 2000), kmRate: num(c.kmRate, 0, 5000, 480), minRate: num(c.minRate, 0, 500, 20),
    commissionPct: num(c.commissionPct, 0, 30, 3), promoPct: num(c.promoPct, 0, 30, 0), promoUntil: num(c.promoUntil, 0, 4102444800000, 0),
    farOn: c.farOn ? 1 : 0, farFrom: num(c.farFrom, 0, 20, 2), farRate: num(c.farRate, 0, 3000, 300), farCap: num(c.farCap, 0, 20000, 2000),
    demandOn: c.demandOn === 0 || c.demandOn === false ? 0 : 1,
    adjPct: num(c.adjPct, 0, 100, 0), adjUntil: num(c.adjUntil, 0, 4102444800000, 0),
    ruleOn: c.ruleOn ? 1 : 0, ruleDays: num(c.ruleDays, 0, 127, 96), ruleFrom: num(c.ruleFrom, 0, 23, 21), ruleTo: num(c.ruleTo, 0, 23, 3), rulePct: num(c.rulePct, 0, 100, 15),
    rainOn: c.rainOn ? 1 : 0, rainPct: num(c.rainPct, 0, 100, 10), capPct: num(c.capPct, 0, 100, 60),
    envioOn: c.envioOn === 0 || c.envioOn === false ? 0 : 1, envioPct: num(c.envioPct, 0, 100, 15),
    motoOn: c.motoOn === 0 || c.motoOn === false ? 0 : 1, motoPct: num(c.motoPct, 0, 90, 30), routeMax: num(c.routeMax, 1, 3, 1.5),   /* V596 · faltaban: el % de la moto volvía siempre a 30 */
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
  let cand = el;   /* V586 · con «Seguinos en Facebook» encendido, los fundadores NUEVOS son los que siguieron la página, en el orden en que lo confirmaron (los que ya eran fundadores se conservan) */
  if (fbCfg(r).on) cand = el.filter((x) => fbDone.has(r.name + '|' + x.id)).sort((a, b) => (fbDone.get(r.name + '|' + a.id).at || 0) - (fbDone.get(r.name + '|' + b.id).at || 0));
  if (cfg.auto) for (const x of cand) { if (n >= cfg.cap) break; if (x.id === first || ids[x.id] || removed[x.id]) continue; ids[x.id] = now; n++; }
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
/* V642 · AUTOVIAJES: viaje donde el conductor y el pasajero son la misma persona (mismo DNI o mismo teléfono, o el mismo celular dueño de las dos cuentas).
   Con el interruptor encendido no cuentan para nada: ni estadísticas, ni viaje de bienvenida, ni premios. No se bloquea el viaje ni se toca el cobro. */
function selfOn(room) { const m = room.sticky.get('cfg-selftrip|cfg:selftrip'); return !!(m && m.data && m.data.on); }
function selfPair(room, drvId, paxId, paxSk) {
  try {
    drvId = String(drvId || ''); paxId = String(paxId || '');
    if (drvId && paxSk && ownHas(room, 'drv', drvId, paxSk)) return true;
    if (!drvId || !paxId) return false;
    const dk = welKeys(stickyData(room, 'driver-reg|dr:' + drvId)), pk = welKeys(stickyData(room, 'pax-reg|pr:' + paxId));
    return dk.some((x) => pk.includes(x));
  } catch (e) { return false; }
}
function histIngest(room, msg) {
  const d = msg.data; if (!d || !Array.isArray(d.hist)) return;
  const it = (d.hist.find((h) => h && h.role === 'drv') || {}).item; if (!it || !it.driverId) return;
  const k = HK(room, it.driverId), l = dHist.get(k) || [], id = String((d.ledger && d.ledger.tripId) || it.id || '');
  const tsk0 = d.tripKey ? tripPax.get(room.name + '|' + String(d.tripKey)) || '' : '', idt0 = tsk0 ? paxIdentOfSk(room, tsk0) : '', self0 = selfOn(room) && selfPair(room, it.driverId, idt0.startsWith('pax:') ? idt0.slice(4) : '', tsk0);
  if (!id || l.some((x) => x.id === id)) return;
  l.push({ id, at: Number(it.at) || Date.now(), route: String(it.route || '').slice(0, 200), stop: String(it.stop || '').slice(0, 120), fare: Number(it.fare) || 0, net: Number(it.net) || 0, fee: Number(it.fee) || 0, payment: String(it.payment || '').slice(0, 30), status: String(it.status || '').slice(0, 30), pax: String(it.other || '').slice(0, 60), plate: String((d.ledger && d.ledger.plate) || it.plate || '').slice(0, 12), self: self0 ? true : undefined });
  if (l.length > 1500) l.splice(0, l.length - 1500);
  dHist.set(k, l); dDirty.add('dhist|' + k);
  /* V495 · viajes por pasajero (para el buscador de Administración) */
  /* V513 · el pasajero real del viaje sale de quién pidió el viaje (antes se tomaba un dato del celular del conductor) */
  const tsk = d.tripKey ? tripPax.get(room.name + '|' + String(d.tripKey)) || '' : '', idt = tsk ? paxIdentOfSk(room, tsk) : '';
  const pid = idt.startsWith('pax:') ? idt.slice(4) : (tsk ? 'sk:' + tsk : '');   /* V516 · sin saber quién pidió el viaje no se anota (antes caía en el pasajero del celular del conductor) */
  if (pid) { const pk = HK(room, 'p:' + pid), pl = dHist.get(pk) || []; if (!pl.some((x) => x.id === id)) { const sd = (d.sum && d.sum.driver) || {}; pl.push({ id, at: Number(it.at) || Date.now(), fare: Number(it.fare) || 0, route: String(it.route || '').slice(0, 200), stop: String(it.stop || '').slice(0, 120), payment: String(it.payment || '').slice(0, 30), status: String(it.status || '').slice(0, 30), drvName: String(sd.name || '').slice(0, 60), plate: String(sd.plate || (d.ledger && d.ledger.plate) || '').slice(0, 12), driverId: String(it.driverId || ''), self: self0 ? true : undefined }); if (pl.length > 1500) pl.splice(0, pl.length - 1500); dHist.set(pk, pl); dDirty.add('dhist|' + pk); } }
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
  try { const r = await db.query(`SELECT ns, id, data FROM mobi_kv WHERE ns IN ('dhist','dsess','dgeo')`); for (const row of r.rows) { if (row.ns === 'dgeo') { if (row.data && row.data.geo) tGeo.set(row.id, row.data.geo); } else if (row.ns === 'dhist') dHist.set(row.id, (row.data && row.data.list) || []); else dSess.set(row.id, row.data || { list: [], cur: null }); } console.log('Historial de conductores cargado:', dHist.size, 'con viajes,', dSess.size, 'con conexiones'); } catch (e) { console.warn('histLoad', e.message); }
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
/* V599 · el RECORRIDO de cada viaje queda guardado en el servidor (antes solo vivía en el celular y se perdía al actualizar/reinstalar) */
const tGeo = new Map();
const baseTid = (id) => String(id || '').replace(/^srv_/, '').replace(/^(trip_\d+)[pd]$/, '$1');
const geoOf = (room, id) => tGeo.get(HK(room, baseTid(id))) || undefined;
function cleanGeo(g) {
  if (!g || typeof g !== 'object') return null;
  const pt = (q) => (Array.isArray(q) && q.length >= 2 && isFinite(q[0]) && isFinite(q[1]) && Math.abs(q[0]) <= 90 && Math.abs(q[1]) <= 180) ? [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5] : null;
  const arr = (a, n) => Array.isArray(a) ? a.slice(0, n).map(pt).filter(Boolean) : null;
  const o = { o: pt(g.o), d: pt(g.d), s: pt(g.s), ss: arr(g.ss, 6), plan: arr(g.plan, 160), real: arr(g.real, 160) };
  if (!o.o && !o.d && !(o.plan && o.plan.length > 1) && !(o.real && o.real.length > 1)) return null;
  for (const k of Object.keys(o)) if (!o[k] || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
  return o;
}
app.post('/api/my/geo', (req, res) => {
  const b = req.body || {}, r = getRoom(b.room), au = authOf(req, r.name);
  const drv = String(b.drv || ''), pax = String(b.pax || '');
  const okD = OWN_RE.drv.test(drv) && (au.admin || ownHas(r, 'drv', drv, au.sk)), okP = OWN_RE.pax.test(pax) && (au.admin || ownHas(r, 'pax', pax, au.sk));
  if (!okD && !okP && !au.sk) return res.status(403).json({ ok: false, error: 'forbidden' });
  const items = Array.isArray(b.items) ? b.items.slice(0, 25) : [], done = [];
  for (const it of items) {
    const id = baseTid(it && it.id), g = cleanGeo(it && it.geo); if (!id || !g) continue;
    const k = HK(r, id); if (!tGeo.has(k)) { tGeo.set(k, g); kvSet('dgeo', k, { geo: g }).catch(() => {}); }
    done.push(String(it.id));
  }
  res.json({ ok: true, done });
});
app.post('/api/my/history', (req, res) => {
  const b = req.body || {}, r = getRoom(b.room), au = authOf(req, r.name);
  const drv = String(b.drv || ''), pax = String(b.pax || ''), out = { drv: [], pax: [] };
  const okD = OWN_RE.drv.test(drv) && (au.admin || ownHas(r, 'drv', drv, au.sk));
  const okP = OWN_RE.pax.test(pax) && (au.admin || ownHas(r, 'pax', pax, au.sk));
  if (!okD && !okP && !au.sk) return res.status(403).json({ ok: false, error: 'forbidden' });
  const byId = new Map();   /* viajes de conductores por id (para completar los del pasajero viejos) */
  if (okP) for (const [k, l] of dHist) if (k.startsWith(r.name + '|') && !k.startsWith(r.name + '|p:')) for (const x of l) byId.set(x.id, Object.assign({ driverId: k.slice(r.name.length + 1) }, x));
  if (okD) for (const x of (dHist.get(HK(r, drv)) || [])) out.drv.push({ geo: geoOf(r, x.id), id: 'srv_' + x.id, at: x.at, route: x.route, stop: x.stop, fare: x.fare, net: x.net, fee: x.fee, payment: x.payment, status: x.status || 'Finalizado', other: x.pax, driverId: drv, srv: 1, bad: x.bad ? true : undefined });
  const okS = !!au.sk && !au.admin;   /* viajes pedidos desde ESTE celular aunque la cuenta no esté vinculada */
  if (okS && !byId.size) for (const [k, l] of dHist) if (k.startsWith(r.name + '|') && !k.startsWith(r.name + '|p:')) for (const x of l) byId.set(x.id, Object.assign({ driverId: k.slice(r.name.length + 1) }, x));
  const paxLists = [].concat(okP ? (dHist.get(HK(r, 'p:' + pax)) || []) : [], okS ? (dHist.get(HK(r, 'p:sk:' + au.sk)) || []) : []), seenP = new Set();
  if (paxLists.length) for (const x of paxLists) {
    if (seenP.has(x.id)) continue; seenP.add(x.id);
    const dx = byId.get(x.id) || {};
    if (!x.route && !x.bad) continue;   /* V514 · anotaciones viejas mal hechas (eran del conductor) */
    if (au.sk && ownHas(r, 'drv', String(x.driverId || dx.driverId || ''), au.sk)) continue;   /* un viaje que manejaste vos no es un viaje tuyo como pasajero */
    out.pax.push({ geo: geoOf(r, x.id), id: 'srv_' + x.id, at: x.at, route: x.route || dx.route || '', stop: x.stop || dx.stop || '', fare: x.fare || dx.fare || 0, payment: x.payment || dx.payment || '', status: x.status || dx.status || 'Finalizado', bad: x.bad ? true : undefined, other: x.drvName || '', plate: x.plate || dx.plate || '', paxId: pax, driverId: x.driverId || dx.driverId || '', srv: 1 });
  }
  out.drv.sort((p, q) => q.at - p.at); out.pax.sort((p, q) => q.at - p.at);
  res.json({ ok: true, drv: out.drv.slice(0, 300), pax: out.pax.slice(0, 300) });
});

/* V514 · cancelaciones al historial del servidor (solo la anota quien participó: conductor dueño de su cuenta o el celular que pidió el viaje) */
app.post('/api/my/cancel', (req, res) => {
  const b = req.body || {}, r = getRoom(b.room), au = authOf(req, r.name), it = b.item || {}, tk = String(b.tripKey || '').slice(0, 80);
  if (!tk || !au.sk) return res.status(400).json({ ok: false });
  const rec = { id: 'c_' + tk, at: Math.min(Date.now(), Number(it.at) || Date.now()), route: String(it.route || '').slice(0, 200), fare: 0, net: 0, fee: 0, payment: '—', status: String(it.status || 'Cancelado').slice(0, 40), bad: true };
  let key = '';
  if (b.role === 'drv') { const drv = String(b.drv || ''); if (!OWN_RE.drv.test(drv) || !ownHas(r, 'drv', drv, au.sk)) return res.status(403).json({ ok: false }); key = HK(r, drv); rec.pax = String(it.other || '').slice(0, 60); }
  else {
    const tsk = tripPax.get(r.name + '|' + tk) || ''; if (tsk && tsk !== au.sk && !(OWN_RE.pax.test(String(b.pax || '')) && ownHas(r, 'pax', String(b.pax), au.sk) && paxIdentOfSk(r, tsk) === 'pax:' + b.pax)) return res.status(403).json({ ok: false });
    const idt = paxIdentOfSk(r, au.sk); key = HK(r, 'p:' + (idt.startsWith('pax:') ? idt.slice(4) : 'sk:' + au.sk)); rec.drvName = String(it.other || '').slice(0, 60);
  }
  const l = dHist.get(key) || []; if (!l.some((x) => x.id === rec.id)) { l.push(rec); if (l.length > 1500) l.splice(0, l.length - 1500); dHist.set(key, l); dDirty.add('dhist|' + key); }
  res.json({ ok: true });
});

/* V495 · estadísticas de usuarios para el buscador de Administración (viajes por conductor y por pasajero) */
app.post('/api/admin/user-stats', (req, res) => {
  const bd = req.body || {};
  if (!adminOk(bd.token) && !sbxOk(bd)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(bd.room), out = { drv: {}, pax: {} };
  const ids = (a) => (Array.isArray(a) ? a : []).map((x) => String(x || '')).filter(Boolean).slice(0, 2000);
  const seenT = new Set();
  const add = (kind, id, tid, at) => { const o = out[kind][id] || (out[kind][id] = { trips: 0, last: 0 }); o.trips++; if (at > o.last) o.last = at; seenT.add(kind + '|' + id + '|' + tid); };
  for (const id of ids(bd.drv)) for (const x of (dHist.get(HK(r, id)) || [])) { if (x.bad || x.self) seenT.add('drv|' + id + '|' + x.id); else add('drv', id, x.id, Number(x.at) || 0); }   /* V661 · el viaje salteado (autoviaje/anulado) se marca visto: así no se vuelve a sumar desde el bus */
  for (const id of ids(bd.drv)) { try { const L = ledgerOf(r, id), o = out.drv[id] || (out.drv[id] = { trips: 0, last: 0 }); o.debt = L.debt; o.favor = L.favor; o.charges = Math.round(L.charges * 100) / 100; } catch (e) {} }   /* V632 · la deuda de la ficha = la que calcula el servidor (la misma que ve el conductor) */
  for (const id of ids(bd.pax)) for (const x of (dHist.get(HK(r, 'p:' + id)) || [])) { if (x.bad || x.self) seenT.add('pax|' + id + '|' + x.id); else add('pax', id, x.id, Number(x.at) || 0); }
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

/* V537 · AVISO DE PRE-LANZAMIENTO · el administrador lo prende/apaga y escribe un texto para pasajeros y otro para conductores.
   Se muestra una sola vez a quien está registrado (cada vez que se vuelve a ACTIVAR cuenta como aviso nuevo). Se reparte por el bus y se consulta por GET. */
function prelClean(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n); }
function prelGet(roomName) {
  const m = getRoom(roomName).sticky.get('cfg-prelaunch|cfg:prelaunch'), d = m && m.data;
  const R = (x) => ({ title: prelClean(x && x.title, 80), text: prelClean(x && x.text, 600) });
  if (!d || typeof d !== 'object') return { on: false, sid: 0, at: 0, pax: R(), drv: R() };
  return { on: !!d.on, sid: Number(d.sid) || 0, at: Number(d.at) || 0, pax: R(d.pax), drv: R(d.drv) };
}
app.get('/api/prelaunch', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true, serverTime: Date.now() }, prelGet(req.query.room))); });
app.post('/api/admin/prelaunch', (req, res) => {
  const bd = req.body || {};
  if (!adminOk(bd.token) && !sbxOk(bd)) return res.status(401).json({ ok: false, error: 'admin' });
  const prev = prelGet(bd.room), on = !!bd.on, R = (x) => ({ title: prelClean(x && x.title, 80), text: prelClean(x && x.text, 600) });
  const now = Date.now(), sid = on ? ((prev.on && prev.sid) ? prev.sid : now) : prev.sid;
  const data = { on, sid, at: now, pax: R(bd.pax), drv: R(bd.drv) };
  const saved = pushMessage(getRoom(bd.room), { type: 'cfg-prelaunch', key: 'cfg:prelaunch', src: 'admin', data });
  console.log('Aviso de pre-lanzamiento', on ? 'ACTIVADO' : 'desactivado');
  res.json({ ok: true, data, id: saved && saved.id });
});

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

/* ---------------- V515 · GOOGLE MAPS (direcciones exactas y navegación) ----------------
   La clave vive SOLO en el servidor (variable GOOGLE_MAPS_KEY en Render). Si no está, o se pasa el tope diario, la app sigue con lo gratuito.
   Topes diarios para no salir nunca de la cuota gratis (10.000 por mes y por servicio): GOOGLE_GEOCODE_DAY y GOOGLE_ROUTE_DAY (300 por defecto). */
const GMK = String(process.env.GOOGLE_MAPS_KEY || '').trim();
const G_GEO_URL = process.env.GOOGLE_GEOCODE_BASE || 'https://maps.googleapis.com', G_RT_URL = process.env.GOOGLE_ROUTES_BASE || 'https://routes.googleapis.com';
const G_DAY = { geo: Number(process.env.GOOGLE_GEOCODE_DAY || 300), route: Number(process.env.GOOGLE_ROUTE_DAY || 300) };
const gUse = { d: '', geo: 0, route: 0 };
const gGeoCache = new Map(), gRate = new Map();
function gAllow(kind, req) {
  if (!GMK) return 'nokey';
  const day = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10); if (gUse.d !== day) { gUse.d = day; gUse.geo = 0; gUse.route = 0; }
  if (gUse[kind] >= G_DAY[kind]) return 'cap';
  const who = String(req.headers['x-mobi-sk'] || req.ip || ''), now = Date.now(), r = gRate.get(who) || { n: 0, t: now };
  if (now - r.t > 3600_000) { r.n = 0; r.t = now; } if (++r.n > 120) return 'rate'; gRate.set(who, r); if (gRate.size > 5000) gRate.delete(gRate.keys().next().value);
  gUse[kind]++; return '';
}
function gDecode(str) {   /* polilínea codificada de Google → [[lat,lng],...] */
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    let b, sh = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32); lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    sh = 0; r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32); lng += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
app.get('/api/geo/status', (_req, res) => res.json({ ok: true, google: !!GMK, used: gUse, cap: G_DAY }));
app.post('/api/geo/geocode', async (req, res) => {
  const b = req.body || {}, q = String(b.q || '').trim().slice(0, 200);
  if (q.length < 4) return res.status(400).json({ ok: false, error: 'q' });
  const key = q.toLowerCase().replace(/\s+/g, ' '), hit = gGeoCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 86400_000) return res.json(Object.assign({ ok: true, cached: true }, hit.r));
  const why = gAllow('geo', req); if (why) return res.json({ ok: false, error: why });
  try {
    let url = G_GEO_URL + '/maps/api/geocode/json?language=es&region=ar&components=country:AR&address=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(GMK);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) url += '&bounds=' + (lat - 0.35) + ',' + (lng - 0.45) + '|' + (lat + 0.35) + ',' + (lng + 0.45);
    const r = await fetch(url), j = await r.json();
    const x = j && Array.isArray(j.results) && j.results[0];
    if (!x) { const out = { found: false, status: String((j && j.status) || '') }; gGeoCache.set(key, { at: Date.now(), r: out }); return res.json(Object.assign({ ok: true }, out)); }
    const g = x.geometry || {}, t = String(g.location_type || ''), types = x.types || [];
    const out = { found: true, lat: g.location.lat, lng: g.location.lng, label: String(x.formatted_address || ''), type: t, partial: !!x.partial_match,
      exact: (t === 'ROOFTOP' || t === 'RANGE_INTERPOLATED') && (types.includes('street_address') || types.includes('premise') || types.includes('subpremise') || types.includes('establishment') || types.includes('point_of_interest')) };
    gGeoCache.set(key, { at: Date.now(), r: out }); if (gGeoCache.size > 20000) gGeoCache.delete(gGeoCache.keys().next().value);
    res.json(Object.assign({ ok: true }, out));
  } catch (e) { res.json({ ok: false, error: 'google' }); }
});
const G_MAN = { TURN_LEFT: ['turn', 'left'], TURN_RIGHT: ['turn', 'right'], TURN_SLIGHT_LEFT: ['turn', 'slight left'], TURN_SLIGHT_RIGHT: ['turn', 'slight right'], TURN_SHARP_LEFT: ['turn', 'sharp left'], TURN_SHARP_RIGHT: ['turn', 'sharp right'],
  UTURN_LEFT: ['turn', 'uturn'], UTURN_RIGHT: ['turn', 'uturn'], STRAIGHT: ['continue', 'straight'], RAMP_LEFT: ['off ramp', 'left'], RAMP_RIGHT: ['off ramp', 'right'], MERGE: ['merge', ''], FORK_LEFT: ['fork', 'left'], FORK_RIGHT: ['fork', 'right'],
  ROUNDABOUT_LEFT: ['roundabout', ''], ROUNDABOUT_RIGHT: ['roundabout', ''], DEPART: ['depart', ''], NAME_CHANGE: ['new name', ''] };
app.post('/api/geo/route', async (req, res) => {
  const b = req.body || {}, o = b.o || {}, d = b.d || {};
  const ok = (p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
  if (!ok(o) || !ok(d)) return res.status(400).json({ ok: false, error: 'datos' });
  const why = gAllow('route', req); if (why) return res.json({ ok: false, error: why });
  try {
    const wp = (p) => ({ location: Object.assign({ latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } }, Number.isFinite(Number(p.heading)) && p.heading !== null ? { heading: Math.round(Number(p.heading)) % 360 } : {}) });
    const body = { origin: wp(o), destination: wp({ lat: d.lat, lng: d.lng }), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', languageCode: 'es-419', units: 'METRIC' };
    const r = await fetch(G_RT_URL + '/directions/v2:computeRoutes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GMK,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation,routes.legs.steps.navigationInstruction' }, body: JSON.stringify(body) });
    const j = await r.json(), rt = j && Array.isArray(j.routes) && j.routes[0];
    if (!rt || !rt.polyline) return res.json({ ok: false, error: 'sin_ruta' });
    const coords = gDecode(String(rt.polyline.encodedPolyline || ''));
    const steps = [];
    for (const lg of rt.legs || []) for (const st of lg.steps || []) {
      const ni = st.navigationInstruction || {}, mm = G_MAN[ni.maneuver] || ['continue', ''], ll = st.startLocation && st.startLocation.latLng;
      steps.push({ t: mm[0], m: mm[1], x: 0, n: '', g: String(ni.instructions || '').replace(/\s+/g, ' ').slice(0, 160), loc: ll ? [ll.latitude, ll.longitude] : null, d: Number(st.distanceMeters) || 0 });
    }
    if (coords.length) steps.push({ t: 'arrive', m: '', x: 0, n: '', g: '', loc: coords[coords.length - 1], d: 0 });
    const sec = parseFloat(String(rt.duration || '0').replace('s', '')) || 0;
    res.json({ ok: true, src: 'google', coords, km: (Number(rt.distanceMeters) || 0) / 1000, min: sec / 60, steps });
  } catch (e) { res.json({ ok: false, error: 'google' }); }
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
/* V575 · un mismo celular puede recibir avisos como conductor y como pasajero (uid principal + uids) */
function subUids(x) { const o = [String((x && x.uid) || '')]; if (x && Array.isArray(x.uids)) for (const u of x.uids) { const v = String(u || ''); if (v && !o.includes(v)) o.push(v); } return o.filter(Boolean); }
function pushNotify(uid, note, acc) {
  if (note && note.skip) return 0; pushVapidEnsure(); if (!uid || !pushPriv) return 0; let n = 0;
  for (const [h, sub] of pushSubs) {
    if (!subUids(sub).includes(String(uid))) continue;
    const q = pushQueue.get(h) || []; q.push({ id: crypto.randomBytes(8).toString('hex'), title: String(note.title || 'MOBI').slice(0, 80), body: String(note.body || '').slice(0, 200), url: './', at: Date.now() }); pushQueue.set(h, q.slice(-5));
    const pr = sub.native ? Promise.resolve({ ok: true, status: 202 }) : pushTouch(h, sub); if (acc) acc.push(pr); n++;   /* V577 · la app de Android lo busca sola */
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
  const ex = (Array.isArray(b.uids) ? b.uids : []).map((u) => String(u || '').slice(0, 60)).filter((u) => /^[A-Za-z0-9_.:-]{3,60}$/.test(u)).slice(0, 4);   /* V575 */
  if (ex.length) item.uids = [...new Set([uid].concat(ex))];
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
    const c = pushCfg(r), drv = pushDrivers(r), uids = [...new Set(subsHere.flatMap((x) => subUids(x)))].filter((id) => drv.has(id));
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
  const r = getRoom(b.room), drv = pushDrivers(r), subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name).flatMap((x) => subUids(x)));
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
  const subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name).flatMap((x) => subUids(x)));
  for (const [id, x] of drv) {
    if (!subs.has(id)) continue;
    if (aud === 'recent' && now - x.seenAt > 24 * 3600_000) continue;
    if (aud === 'offline' && x.present) continue;
    if (pushNotify(id, { title, body }, acc)) n++;
  }
  const rs = await Promise.all(acc); console.log('Aviso manual enviado a', n, 'conductores · aceptados por el servicio:', rs.filter((x) => x.ok).length); res.json({ ok: true, sent: n, eligible: drv.size, accepted: rs.filter((x) => x.ok).length, codes: rs.map((x) => x.status) });
});

/* V575 · aviso manual por ZONA, a pasajeros o a conductores (dry: solo cuenta a cuántos llega) */
app.post('/api/admin/push-zone', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const role = b.role === 'drv' ? 'drv' : 'pax', prov = String(b.prov || '').trim(), zone = String(b.zone || '').trim();
  const title = String(b.title || '').trim().slice(0, 80), body = String(b.body || '').trim().slice(0, 200);
  if (!b.dry && (!title || !body)) return res.status(400).json({ ok: false, error: 'texto' });
  const r = getRoom(b.room), ids = new Set();
  for (const [k, m] of r.sticky) {
    const d = m && m.data; if (!d || typeof d !== 'object' || !d.id || d.deletedAt) continue;
    if (role === 'pax' ? !(m.type === 'pax-reg' && k.startsWith('pax-reg|pr:')) : !(m.type === 'driver-reg' && k.startsWith('driver-reg|dr:') && d.status === 'aprobado' && !drvHidden(d))) continue;
    if (prov && String(d.prov || '').trim() !== prov) continue;
    if (zone && String(d.zone || '').trim() !== zone) continue;
    ids.add(String(d.id));
  }
  const subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === r.name).flatMap((x) => subUids(x)));
  const reach = [...ids].filter((id) => subs.has(id));
  if (b.dry) return res.json({ ok: true, people: ids.size, withPush: reach.length });
  if (!pushLoaded) return res.status(503).json({ ok: false });
  const acc = []; let n = 0; for (const id of reach) if (pushNotify(id, { title, body }, acc)) n++;
  const rs = await Promise.all(acc); console.log('Aviso por zona', role, prov || 'todas', zone || '', '→', n);
  res.json({ ok: true, people: ids.size, sent: n, accepted: rs.filter((x) => x.ok).length, codes: rs.map((x) => x.status) });
});

/* V577b · FOTO DE PERFIL OBLIGATORIA para mandar a evaluación (apagado de fábrica = opcional, como siempre) */
app.post('/api/admin/drvphoto', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  const m0 = room.sticky.get('cfg-drvphoto|cfg:drvphoto'), d0 = (m0 && m0.data) || {};
  if (b.on !== undefined || b.vtc !== undefined || b.mdl !== undefined) pushMessage(room, { type: 'cfg-drvphoto', key: 'cfg:drvphoto', src: 'admin', data: { on: b.on !== undefined ? !!b.on : !!d0.on, vtc: b.vtc !== undefined ? !!b.vtc : !!d0.vtc, mdl: b.mdl !== undefined ? !!b.mdl : !!d0.mdl, at: Date.now() } });   /* V578b · mdl = controlar «Marca y modelo» */   /* V577c · vtc = confirmar auto o moto al enviar */
  const m = room.sticky.get('cfg-drvphoto|cfg:drvphoto'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on), vtc: !!(d && d.vtc), mdl: !!(d && d.mdl) });
});

/* ===================== V582 · ELIMINAR MI CUENTA ===================================================
   (1) Interruptor «Eliminar mi cuenta» (apagado de fábrica): con él apagado la app no muestra el botón.
   (2) Herramienta de borrado para el administrador: dado el celular de quien lo pidió, MUESTRA qué se borraría (vista previa) y,
       recién con dry:false, lo borra: registro de pasajero y de conductor, fotos y documentos, avisos y verificaciones.
       Se CONSERVAN (obligación legal e impositiva, ver Política de Privacidad): viajes, pagos, comisiones, calificaciones y reportes. */
app.post('/api/admin/delacct', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-delacct', key: 'cfg:delacct', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const m = room.sticky.get('cfg-delacct|cfg:delacct'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
/* V638 · «Compartir viaje de bienvenida» (interruptor, apagado de fábrica): muestra u oculta la tercera opción de «Compartir MOBI» */
app.post('/api/admin/wshare', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-wshare', key: 'cfg:wshare', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const m = room.sticky.get('cfg-wshare|cfg:wshare'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
/* V642 · «Autoviajes no cuentan» (interruptor, apagado de fábrica) */
app.post('/api/admin/selftrip', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-selftrip', key: 'cfg:selftrip', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const m = room.sticky.get('cfg-selftrip|cfg:selftrip'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
/* V652 · «Búsqueda por voz» en los campos de dirección (interruptor, apagado de fábrica) */
app.post('/api/admin/voice', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-voice', key: 'cfg:voice', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const m = room.sticky.get('cfg-voice|cfg:voice'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
/* V662 · «Entre calles» en las sugerencias de dirección (interruptor, apagado de fábrica) */
app.post('/api/admin/xstreet', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-xstreet', key: 'cfg:xstreet', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const m = room.sticky.get('cfg-xstreet|cfg:xstreet'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
/* V668 · «Rescate de viaje al reabrir» (interruptor, ENCENDIDO de fábrica) */
app.post('/api/admin/tripsave', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-tripsave', key: 'cfg:tripsave', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  res.json({ ok: true, on: tripSaveOn(room) });
});
/* V589 · recordatorio «verificá tu cuenta» (interruptor, apagado de fábrica): la app muestra el aviso a quien no verificó teléfono o mail */
app.post('/api/admin/vrem', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) { pushMessage(room, { type: 'cfg-vrem', key: 'cfg:vrem', src: 'admin', data: { on: !!b.on, at: Date.now() } }); console.log('Recordatorio de verificación', b.on ? 'ACTIVADO' : 'desactivado'); }
  const m = room.sticky.get('cfg-vrem|cfg:vrem'), d = m && m.data;
  res.json({ ok: true, on: !!(d && d.on) });
});
app.post('/api/admin/revisor', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  if (b.phone !== undefined) { const ph = String(b.phone || '').replace(/\D/g, ''); REV.phone = ph.length >= 10 && ph.length <= 15 ? ph : ''; if (!REV.phone) REV.on = false; }
  if (b.code !== undefined) { const c = String(b.code || '').replace(/\D/g, ''); if (c.length >= 4 && c.length <= 8) REV.code = c; }
  if (!REV.code) REV.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  if (b.on !== undefined) { if (b.on && !REV.phone) return res.status(400).json({ ok: false, error: 'phone' }); REV.on = !!b.on; }
  kvSet('revisor', 'cfg', REV);
  res.json({ ok: true, on: REV.on, phone: REV.phone, code: REV.code });
});
function fbOwner(req, res) {
  const b = req.body || {}, room = getRoom(b.room), role = b.role === 'drv' ? 'drv' : 'pax', id = String(b.id || ''), au = authOf(req, room.name);
  if (!OWN_RE[role].test(id)) { res.status(400).json({ ok: false, error: 'id' }); return null; }
  if (!au.admin && !isOwner(room, role, id, au.sk, legacyBind(room, role, id))) { res.status(403).json({ ok: false, error: 'owner' }); return null; }
  return { room, role, id };
}
app.post('/api/fb/status', (req, res) => { res.setHeader('Cache-Control', 'no-store'); const x = fbOwner(req, res); if (!x) return; const c = fbCfg(x.room); res.json({ ok: true, on: c.on, url: c.on ? c.url : '', done: fbDone.has(x.room.name + '|' + x.id) }); });
app.post('/api/fb/claim', (req, res) => {
  const x = fbOwner(req, res); if (!x) return; const c = fbCfg(x.room); if (!c.on) return res.json({ ok: false, why: 'off' });
  const k = x.room.name + '|' + x.id; if (!fbDone.has(k)) { const v = { at: Date.now(), role: x.role }; fbDone.set(k, v); kvSet('fb', k, v); }
  if (x.role === 'drv') { try { founderCompute(x.room); } catch (e) {} }   /* puede quedar como fundador */
  res.json({ ok: true, done: true });
});
function fbCounts(room) { let pax = 0, drv = 0; for (const [k, v] of fbDone) if (k.startsWith(room.name + '|')) { if (v && v.role === 'drv') drv++; else pax++; } return { pax, drv }; }
/* aviso a los pasajeros que todavía no siguieron la página y que podrían usar su viaje de bienvenida */
function fbNotify(room) {
  if (!welCfg(room).on) return 0; pushVapidEnsure(); if (!pushPriv) return 0; let n = 0;
  const note = { title: '🎁 Tu viaje de bienvenida', body: 'Para obtener tu viaje gratis solo tenés que seguirnos en Facebook. ¡Disfrutá tu viaje!' };
  for (const [h, sub] of pushSubs) {
    if (!sub || sub.room !== room.name) continue; const uid = subUids(sub).find((u) => OWN_RE.pax.test(u)); if (!uid) continue;
    if (welStatus(room, uid).why !== 'fb') continue;
    const q = pushQueue.get(h) || []; q.push({ id: crypto.randomBytes(8).toString('hex'), title: note.title, body: note.body, url: './', at: Date.now() }); pushQueue.set(h, q.slice(-5));
    if (!sub.native) pushTouch(h, sub); n++;
  }
  return n;
}
app.post('/api/admin/fb', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), m = room.sticky.get('cfg-fb|cfg:fb'), prev = (m && m.data) || {};
  let url = String(prev.url || ''), on = !!(prev.on && url), notifiedAt = Number(prev.notifiedAt) || 0, sent = 0, changed = false;
  if (b.url !== undefined) { const u = String(b.url || '').trim(); if (u && !fbUrlOk(u)) return res.status(400).json({ ok: false, error: 'url' }); url = u; if (!url) on = false; changed = true; }
  if (b.on !== undefined) { if (b.on && !url) return res.status(400).json({ ok: false, error: 'url' }); const was = on; on = !!b.on; changed = true; if (on && !was && !notifiedAt) { notifiedAt = Date.now(); b.__send = 1; } }
  if (changed) { pushMessage(room, { type: 'cfg-fb', key: 'cfg:fb', src: 'admin', data: { on, url, notifiedAt, at: Date.now() } }); try { founderCompute(room); } catch (e) {} }
  if (b.__send || (b.resend && on)) { sent = fbNotify(room); if (b.resend && !notifiedAt) { notifiedAt = Date.now(); pushMessage(room, { type: 'cfg-fb', key: 'cfg:fb', src: 'admin', data: { on, url, notifiedAt, at: Date.now() } }); } }
  console.log('Seguinos en Facebook', on ? 'ACTIVADO' : 'desactivado', '· avisos enviados', sent);
  res.json({ ok: true, on, url, notifiedAt, sent, counts: fbCounts(room), welcomeOn: welCfg(room).on });
});
/* V614 · código de 4 dígitos para conductores: lo prende o apaga el administrador (apagado de fábrica). Le llega a todos los celulares por el bus. */
app.post('/api/admin/pin', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), m = room.sticky.get('cfg-pin|cfg:pin'); let on = !!(m && m.data && m.data.on);
  if (b.on !== undefined) { on = !!b.on; pushMessage(room, { type: 'cfg-pin', key: 'cfg:pin', src: 'admin', data: { on, at: Date.now() } }); console.log('Código de conductores', on ? 'ACTIVADO' : 'desactivado'); }
  res.json({ ok: true, on });
});
/* V620 · configuración pública chiquita (código de 4 dígitos y aviso de app nueva): cada celular la pide al abrir,
   por si se perdió el aviso del bus al arrancar. Sin datos personales. */
app.get('/api/cfg/pub', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = getRoom(req.query.room), p = room.sticky.get('cfg-pin|cfg:pin'), a = room.sticky.get('cfg-apkupd|cfg:apkupd');
  const f = room.sticky.get('cfg-drvphoto|cfg:drvphoto'), fd = (f && f.data) || {};   /* V622 · foto obligatoria / auto-moto / modelo */
  res.json({ ok: true, pin: !!(p && p.data && p.data.on), apk: { on: !!(a && a.data && a.data.on), ver: Math.max(0, Math.floor(Number(a && a.data && a.data.ver) || 0)) }, drv: { photo: !!fd.on, vtc: !!fd.vtc, mdl: !!fd.mdl } });
});
/* V618 · aviso de app de Android nueva (solo se ve en el APK). Apagado de fábrica. */
app.post('/api/admin/apkupd', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), m = room.sticky.get('cfg-apkupd|cfg:apkupd'); let on = !!(m && m.data && m.data.on), ver = Math.max(0, Math.floor(Number(m && m.data && m.data.ver) || 0)), ch = false;
  if (b.on !== undefined) { on = !!b.on; ch = true; }
  /* V619 · versión de referencia: la toma sola del APK del administrador (solo sube), o la pone a mano */
  if (b.ver !== undefined) { const v = Math.max(0, Math.min(1e7, Math.floor(Number(b.ver) || 0))); if (b.auto ? v > ver : v !== ver) { ver = v; ch = true; } }
  if (ch) { pushMessage(room, { type: 'cfg-apkupd', key: 'cfg:apkupd', src: 'admin', data: { on, ver, at: Date.now() } }); console.log('Aviso de app nueva', on ? 'ACTIVADO' : 'desactivado', '· versión de referencia', ver); }
  res.json({ ok: true, on, ver });
});
/* V623 · VIAJE SIN RESPUESTA DEL CONDUCTOR: el servidor anota la última señal del conductor de cada viaje (ubicación o avance del viaje)
   y si el viaje terminó o se canceló. La app del pasajero lo consulta mientras espera. Apagado de fábrica (cfg-tripwatch). */
const TW_BOOT = Date.now(), TW_MIN_MS = Math.max(1000, Number(process.env.TW_MINUTE_MS) || 60000);   /* TW_MINUTE_MS solo para pruebas */
function twNote(room, msg) {
  const d = msg && msg.data; if (!d || typeof d !== 'object') return;
  if (!room.tw) room.tw = { seen: new Map(), end: new Map() };
  const now = Date.now(), tw = room.tw;
  let tk = '';
  if (msg.type === 'driver-pos' && d.tripKey) tk = String(d.tripKey);
  else if (msg.type === 'trip' && d.from === 'drv' && d.active && d.active.tripKey) tk = String(d.active.tripKey);
  if (tk) { tw.seen.set(tk, now); if (tw.seen.size > 3000) tw.seen.delete(tw.seen.keys().next().value); }
  if ((msg.type === 'trip-done' || msg.type === 'trip-end') && (d.tripKey || (d.sum && d.sum.tripKey))) { tw.end.set(String(d.tripKey || d.sum.tripKey), now); if (tw.end.size > 3000) tw.end.delete(tw.end.keys().next().value); }
}
function twCfg(room) { const m = room.sticky.get('cfg-tripwatch|cfg:tripwatch'), d = (m && m.data) || {}; const min = [5, 10, 15].includes(Number(d.min)) ? Number(d.min) : 10; return { on: !!d.on, min }; }
app.post('/api/admin/tripwatch', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), c = twCfg(room); let ch = false;
  if (b.on !== undefined) { c.on = !!b.on; ch = true; }
  if (b.min !== undefined && [5, 10, 15].includes(Number(b.min))) { c.min = Number(b.min); ch = true; }
  if (ch) { pushMessage(room, { type: 'cfg-tripwatch', key: 'cfg:tripwatch', src: 'admin', data: { on: c.on, min: c.min, at: Date.now() } }); console.log('Aviso de conductor sin respuesta', c.on ? 'ACTIVADO' : 'desactivado', c.min, 'min'); }
  res.json({ ok: true, on: c.on, min: c.min });
});
app.get('/api/trip/alive', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = getRoom(req.query.room), c = twCfg(room); if (!c.on) return res.json({ ok: true, on: false });
  const tk = String(req.query.tk || '').slice(0, 80), drv = String(req.query.drv || '').slice(0, 60); if (!tk) return res.status(400).json({ ok: false });
  const tw = room.tw || { seen: new Map(), end: new Map() }, now = Date.now();
  /* sin datos (por ejemplo, el servidor se reinició) se cuenta desde el arranque: nunca da una falsa alarma */
  const last = Math.max(tw.seen.get(tk) || 0, (drv && room.seen && room.seen.get(drv)) || 0, TW_BOOT);
  res.json({ ok: true, on: true, min: c.min, ended: tw.end.has(tk), silentMin: Math.floor((now - last) / TW_MIN_MS) });
});
const ERASE_TYPES = new Set(['pax-reg', 'driver-reg', 'pax-chg', 'drv-chg', 'seller-reg']);
app.post('/api/admin/erase', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const tail = tail8(b.phone), dry = b.dry !== false;
  if (tail.length < 8) return res.status(400).json({ ok: false, error: 'phone' });
  const room = getRoom(b.room), ids = new Set(), accounts = [], keys = [];
  for (const [k, m] of room.sticky) {
    if (!m || (m.type !== 'pax-reg' && m.type !== 'driver-reg')) continue;
    const d = m.data; if (!d || typeof d !== 'object' || tail8(d.phone) !== tail) continue;
    keys.push(k); if (d.id) ids.add(String(d.id));
    const nm = String(d.name || '').trim().split(/\s+/);
    accounts.push({ role: m.type === 'pax-reg' ? 'pasajero' : 'conductor', name: (nm[0] || '') + (nm[1] ? ' ' + nm[1][0] + '.' : ''), status: String(d.status || ''), id: String(d.id || '') });
  }
  for (const [k, m] of room.sticky) {   // pedidos de cambio y registros ligados a esos ids
    if (!m || !ERASE_TYPES.has(m.type) || m.type === 'pax-reg' || m.type === 'driver-reg' || keys.includes(k)) continue;
    const d = m.data, id = String((d && d.id) || ''); if (id && ids.has(id)) keys.push(k);
  }
  const drvIds = [...ids].filter((x) => /^drv_[a-z0-9]{3,20}$/.test(x));
  const pats = []; drvIds.forEach((x) => { pats.push(x + '|%', 'car:' + x + ':%'); });
  let docIds = [];
  if (db) for (const pt of pats) { try { const r = await db.query(`SELECT id FROM mobi_kv WHERE ns = 'doc' AND id LIKE $1`, [pt]); r.rows.forEach((x) => docIds.push(x.id)); } catch (e) { console.warn('erase docs', e.message); } }
  const memDocs = [...docMem.keys()].filter((k) => drvIds.some((x) => k.startsWith(x + '|') || k.startsWith('car:' + x + ':')));
  const subs = [...pushSubs.entries()].filter(([, x]) => x && (ids.has(String(x.uid || '')) || (Array.isArray(x.uids) && x.uids.some((u) => ids.has(String(u))))));
  const vers = [...waVerified.entries()].filter(([, v]) => v && v.tail === tail);
  const plan = { accounts, docs: new Set(docIds.concat(memDocs)).size, avisos: subs.length, verificaciones: vers.length, otros: Math.max(0, keys.length - accounts.length) };
  if (!accounts.length && !plan.docs && !plan.avisos && !plan.verificaciones) return res.json({ ok: true, dry, found: false, plan });
  if (dry) return res.json({ ok: true, dry: true, found: true, plan, retained: 'viajes, pagos, comisiones, calificaciones y reportes' });
  const kill = new Set(keys);
  for (const k of keys) { room.sticky.delete(k); dirtyDrop(room.name, k); if (db) { try { await db.query('DELETE FROM mobi_sticky WHERE room = $1 AND k = $2', [room.name, k]); } catch (e) { console.warn('erase sticky', e.message); } } }
  for (let i = room.ring.length - 1; i >= 0; i--) { const x = room.ring[i]; if (x && x.key && kill.has(x.type + '|' + x.key)) room.ring.splice(i, 1); }
  if (db) for (const di of docIds) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'doc' AND id = $1`, [di]); } catch (e) { console.warn('erase docs borrar', e.message); } }
  memDocs.forEach((k) => docMem.delete(k));
  for (const [h] of subs) { pushSubs.delete(h); pushQueue.delete(h); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'push' AND id = $1`, [h]); } catch (e) { console.warn('erase push', e.message); } } }
  for (const [u] of vers) { waVerified.delete(u); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'wa' AND id = $1`, [u]); } catch (e) { console.warn('erase wa', e.message); } } }
  for (const id of ids) { const k = room.name + '|' + id; if (fbDone.delete(k) && db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'fb' AND id = $1`, [k]); } catch (e) { console.warn('erase fb', e.message); } } }   /* V586 */
  for (const id of ids) { if (!OWN_RE.pax.test(id) && !OWN_RE.drv.test(id)) continue; ERASED.set(room.name + '|' + id, Date.now()); kvSet('erased', room.name + '|' + id, { at: Date.now() }); pushMessage(room, { type: 'acct-erased', key: 'er:' + id, src: 'admin', data: { id, mode: 'real', at: Date.now(), debtIds: [], tks: [] } }); }   /* V635 · el celular cierra la sesión y no la vuelve a crear */
  console.log('Cuenta eliminada · …' + tail.slice(-4), '· cuentas', accounts.length, '· documentos', plan.docs, '· avisos', plan.avisos);
  res.json({ ok: true, dry: false, found: true, done: true, plan, retained: 'viajes, pagos, comisiones, calificaciones y reportes' });
});
/* ===================== V630 · ELIMINAR CUENTA desde la ficha del buscador de Administración =====================
   Siempre primero una VISTA PREVIA (dry) y después la confirmación. Dos modos:
   · real  → igual que «Eliminar mi cuenta»: la cuenta, sus fotos y documentos, avisos y verificación. Se CONSERVAN sus viajes, pagos,
             comisiones, calificaciones y reportes (registros contables).
   · test  → cuenta de PRUEBA: además se borran sus viajes, cobros, pagos, comisiones, saldos e historial, para que no sumen en los totales.
             Si el celular de prueba vuelve a mandar esa misma cuenta, no se vuelve a crear (tiene que reinstalar la app).
   Al borrar se avisa a todos los celulares («acct-erased») para que la saquen de su memoria (la lista de Administración, los totales). */
const ERASED = new Map();   // 'sala|id' -> fecha (solo modo prueba)
const ER_TRIP_TYPES = new Set(['trip', 'trip-done', 'trip-end', 'rating', 'report', 'pay-proof', 'pay-proof-meta', 'pay-dispute', 'chat', 'driver-pos', 'pax-pos', 'approach-route', 'cancel', 'trip-abort', 'trip-close', 'refund-req']);
function erTripKeyOf(m) {
  const d = m && m.data; if (!d || typeof d !== 'object') return '';
  const k = d.tripKey || d.tk || (d.active && d.active.tripKey) || (d.sum && d.sum.tripKey) || ''; if (k) return String(k);
  const mm = /^tr:([^:]+):/.exec(String(m.key || '')); return mm ? mm[1] : '';
}
async function erasePlan(room, id, mode) {
  const kind = id.startsWith('drv_') ? 'drv' : 'pax', regK = (kind === 'drv' ? 'driver-reg|dr:' : 'pax-reg|pr:') + id;
  const reg = room.sticky.get(regK), d = (reg && reg.data) || {}, keys = new Set(), tks = new Set(), debtIds = [];
  if (reg) keys.add(regK);
  for (const [k, m] of room.sticky) if (m && ERASE_TYPES.has(m.type) && m.data && String(m.data.id || '') === id) keys.add(k);
  const accounts = reg ? [{ role: kind === 'drv' ? 'conductor' : 'pasajero', name: String(d.name || '').trim(), status: String(d.status || ''), id }] : [];
  let docIds = [];
  if (kind === 'drv' && db) for (const pt of [id + '|%', 'car:' + id + ':%']) { try { const r = await db.query(`SELECT id FROM mobi_kv WHERE ns = 'doc' AND id LIKE $1`, [pt]); r.rows.forEach((x) => docIds.push(x.id)); } catch (e) { console.warn('borrar cuenta docs', e.message); } }
  const memDocs = kind === 'drv' ? [...docMem.keys()].filter((k) => k.startsWith(id + '|') || k.startsWith('car:' + id + ':')) : [];
  const subs = [...pushSubs.entries()].filter(([, x]) => x && (String(x.uid || '') === id || (Array.isArray(x.uids) && x.uids.includes(id))));
  const ver = waVerified.has(id);
  let movs = 0, money = 0; const histK = [], wel = [];
  if (mode === 'test') {
    if (kind === 'drv') {
      for (const [k, m] of room.sticky) {
        if (!m || !m.data) continue;
        if ((m.type === 'debt-charge' || m.type === 'debt-pay') && String(m.data.driver || '') === id) { keys.add(k); movs++; if (m.data.id) debtIds.push(String(m.data.id)); if (m.data.tripKey) tks.add(String(m.data.tripKey));
          const a = Number(m.data.amount) || 0; money += m.type === 'debt-charge' && m.data.type === 'charge' ? a : 0; }
        else if (m.type === 'trip-done') { const it = ((Array.isArray(m.data.hist) ? m.data.hist : []).find((h) => h && h.role === 'drv') || {}).item || {}; if (String(it.driverId || (m.data.sum && m.data.sum.driverId) || '') === id) { const t = erTripKeyOf(m); if (t) tks.add(t); } }
        else if (m.type === 'trip' && m.data.active && m.data.active.driver && String(m.data.active.driver.id || '') === id) { const t = erTripKeyOf(m); if (t) tks.add(t); }
      }
      for (const [k, c] of room.claims) if (c && String(c.driverId || '') === id) tks.add(String(k));
      for (const [k, r] of welRec) if (r && String(r.drv || '') === id && k.startsWith(room.name + '|')) wel.push(k);
      histK.push(HK(room, id));
    } else {
      for (const [k, sk] of tripPax) if (k.startsWith(room.name + '|') && paxIdentOfSk(room, sk) === 'pax:' + id) tks.add(k.slice(room.name.length + 1));
      histK.push(HK(room, 'p:' + id));
    }
    for (const [k, m] of room.sticky) if (m && ER_TRIP_TYPES.has(m.type)) { const t = erTripKeyOf(m); if (t && tks.has(t)) keys.add(k); }
    if (db && tks.size) for (const t of tks) for (const kd of ['proof', 'delivery']) docIds.push('trip_' + t + '|' + kd);
  }
  docIds = [...new Set(docIds)];
  return { kind, reg, d, keys, tks, debtIds, docIds, memDocs, subs, ver, histK, wel,
    plan: { mode, accounts, docs: new Set(docIds.filter((x) => !/^trip_/.test(x)).concat(memDocs)).size, avisos: subs.length, verificaciones: ver ? 1 : 0,
      viajes: mode === 'test' ? tks.size : 0, movimientos: mode === 'test' ? movs : 0, comisiones: mode === 'test' ? Math.round(money) : 0,
      retained: mode === 'test' ? '' : 'viajes, pagos, comisiones, calificaciones y reportes' } };
}
app.post('/api/admin/erase-acct', async (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const id = String(b.id || ''); if (!OWN_RE.pax.test(id) && !OWN_RE.drv.test(id)) return res.status(400).json({ ok: false, error: 'id' });
  const mode = b.mode === 'test' ? 'test' : 'real', dry = b.dry !== false, room = getRoom(b.room);
  const P = await erasePlan(room, id, mode);
  if (!P.reg && !P.keys.size && !P.docIds.length && !P.subs.length && !P.ver) return res.json({ ok: true, dry, found: false, plan: P.plan });
  if (dry) return res.json({ ok: true, dry: true, found: true, plan: P.plan });
  const kill = P.keys;
  for (const k of kill) { room.sticky.delete(k); dirtyDrop(room.name, k); if (db) { try { await db.query('DELETE FROM mobi_sticky WHERE room = $1 AND k = $2', [room.name, k]); } catch (e) { console.warn('borrar cuenta', e.message); } } }
  for (let i = room.ring.length - 1; i >= 0; i--) { const x = room.ring[i]; if (x && x.key && kill.has(x.type + '|' + x.key)) room.ring.splice(i, 1); }
  if (db) for (const di of P.docIds) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'doc' AND id = $1`, [di]); } catch (e) { console.warn('borrar cuenta docs', e.message); } }
  P.memDocs.forEach((k) => docMem.delete(k)); P.docIds.forEach((k) => docMem.delete(k));
  for (const [h] of P.subs) { pushSubs.delete(h); pushQueue.delete(h); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'push' AND id = $1`, [h]); } catch (e) {} } }
  if (P.ver) { waVerified.delete(id); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'wa' AND id = $1`, [id]); } catch (e) {} } }
  { const fk = room.name + '|' + id; if (fbDone.delete(fk) && db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'fb' AND id = $1`, [fk]); } catch (e) {} } }
  if (mode === 'test') {
    for (const hk of P.histK) { dHist.delete(hk); dSess.delete(hk); dDirty.delete('dhist|' + hk); dDirty.delete('dsess|' + hk); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns IN ('dhist','dsess') AND id = $1`, [hk]); } catch (e) {} } }
    for (const wk of P.wel) { welRec.delete(wk); if (db) { try { await db.query(`DELETE FROM mobi_kv WHERE ns = 'wel' AND id = $1`, [wk]); } catch (e) {} } }
    for (const t of P.tks) { room.claims.delete(t); room.parts.delete(t); }
    try { const sn = INC.snap.get(room.name); if (sn && sn.m) { let ch = false; for (const k of kill) if (sn.m[k]) { delete sn.m[k]; ch = true; } if (ch) kvSet('incsnap', room.name, sn); } } catch (e) {}   /* lo borrado a propósito no es un «movimiento que desapareció» */
  }
  ERASED.set(room.name + '|' + id, Date.now()); kvSet('erased', room.name + '|' + id, { at: Date.now() });   /* V635 · en los dos modos: el celular no la vuelve a crear */
  try { finCache.delete(room.name); } catch (e) {}   /* los totales de Administración se recalculan ya */
  pushMessage(room, { type: 'acct-erased', key: 'er:' + id, src: 'admin', data: { id, mode, at: Date.now(), debtIds: P.debtIds.slice(0, 2000), tks: [...P.tks].slice(0, 2000) } });
  console.log('Cuenta eliminada desde la ficha ·', id, '· modo', mode, '· registros', kill.size, '· viajes', P.tks.size, '· movimientos', P.plan.movimientos);
  res.json({ ok: true, dry: false, found: true, done: true, plan: P.plan });
});
function dirtyDrop(roomName, k) { try { dirty.delete(roomName + '\u0001' + k); } catch (e) {} try { dirtySlow.delete(roomName + '\u0001' + k); } catch (e) {} }

/* ===================== V577 · AVISOS CON LA APP DE ANDROID CERRADA =====================
   La app de Android no puede usar los avisos del navegador. Con el interruptor encendido, cada celular con la app nueva
   se anota acá y pregunta solo cada ~15 minutos si tiene avisos (aunque la app esté cerrada). Se guarda como una suscripción
   más («nat:…»), así todos los avisos existentes (zona, recordatorios, aprobación…) le llegan igual que al navegador.
   Apagado (de fábrica): no se anota ningún celular y todo funciona igual que antes. */
function natCfg(room) { const m = room.sticky.get('cfg-natpush|cfg:natpush'), d = m && m.data; return { on: !!(d && d.on), at: Number(d && d.at) || 0 }; }
const NAT_RE = /^[a-f0-9]{32}$/;
function natDrop(roomName) {
  for (const [h, x] of pushSubs) if (x && x.native && (!roomName || (x.room || 'pilot') === roomName)) { pushSubs.delete(h); pushQueue.delete(h); if (db) db.query(`DELETE FROM mobi_kv WHERE ns = 'push' AND id = $1`, [h]).catch(() => {}); }
}
app.post('/api/push/native-reg', (req, res) => {
  const b = req.body || {}, room = getRoom(b.room), au = authOf(req, room.name), dev = String(b.dev || '');
  if (!natCfg(room).on) return res.json({ ok: true, on: false });
  if (!NAT_RE.test(dev) || !au.sk) return res.status(400).json({ ok: false });
  const ip = String(req.ip || ''), now = Date.now(), rt = pushRate.get(ip) || { n: 0, t: now };
  if (now - rt.t > 3600_000) { rt.n = 0; rt.t = now; } if (++rt.n > 30) return res.status(429).json({ ok: false }); pushRate.set(ip, rt);
  if (pushSubs.size > 20000) return res.status(503).json({ ok: false });
  const kindOf = (u) => (OWN_RE.drv.test(u) ? 'drv' : (OWN_RE.pax.test(u) ? 'pax' : ''));
  const uids = [...new Set([b.uid].concat(Array.isArray(b.uids) ? b.uids : []).map((u) => String(u || '').slice(0, 60)))]
    .filter((u) => { const k = kindOf(u); return k && (!ownGet(room, k, u) || ownHas(room, k, u, au.sk)); }).slice(0, 4);
  if (!uids.length) return res.status(403).json({ ok: false });
  const h = 'nat:' + crypto.createHash('sha256').update('mobi-nat|' + dev).digest('hex').slice(0, 36), old = pushSubs.get(h);
  if (old && old.skh && old.skh !== au.sk) return res.status(403).json({ ok: false });
  const item = { endpoint: h, native: 1, uid: uids[0], uids, room: room.name, skh: au.sk, at: now, seen: now };
  pushSubs.set(h, item); kvSet('push', h, item); res.json({ ok: true, on: true });
});
app.post('/api/push/native-poll', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const b = req.body || {}, room = getRoom(b.room), au = authOf(req, room.name), dev = String(b.dev || '');
  if (!natCfg(room).on) return res.json({ ok: true, on: false, msgs: [] });
  if (!NAT_RE.test(dev)) return res.status(400).json({ ok: false });
  const h = 'nat:' + crypto.createHash('sha256').update('mobi-nat|' + dev).digest('hex').slice(0, 36), x = pushSubs.get(h);
  if (!x) return res.json({ ok: true, on: true, msgs: [], reg: false });
  if (!au.sk || x.skh !== au.sk) return res.status(403).json({ ok: false });
  const now = Date.now(), q = (pushQueue.get(h) || []).filter((m) => now - m.at < 86400_000);
  pushQueue.set(h, q);   /* V577 · el aviso queda en espera hasta que la app lo muestra (native-ack) */
  if (now - Number(x.seen || 0) > 6 * 3600_000) { x.seen = now; kvSet('push', h, x); } else x.seen = now;
  res.json({ ok: true, on: true, msgs: q.map((m) => ({ id: m.id || '', title: m.title, body: m.body })) });
});
/* V577 · la app confirma los avisos que ya mostró (los saca de la espera) */
app.post('/api/push/native-ack', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const b = req.body || {}, room = getRoom(b.room), au = authOf(req, room.name), dev = String(b.dev || '');
  if (!NAT_RE.test(dev)) return res.status(400).json({ ok: false });
  const h = 'nat:' + crypto.createHash('sha256').update('mobi-nat|' + dev).digest('hex').slice(0, 36), x = pushSubs.get(h);
  if (!x) return res.json({ ok: true });
  if (!au.sk || x.skh !== au.sk) return res.status(403).json({ ok: false });
  const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map((v) => String(v || '').slice(0, 40)).slice(0, 20));
  pushQueue.set(h, (pushQueue.get(h) || []).filter((m) => !ids.has(String(m.id || ''))));
  res.json({ ok: true });
});
app.post('/api/admin/natpush', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) { pushMessage(room, { type: 'cfg-natpush', key: 'cfg:natpush', src: 'admin', data: { on: !!b.on, at: Date.now() } }); if (!b.on) natDrop(room.name); }
  const nat = [...pushSubs.values()].filter((x) => x && x.native && (x.room || 'pilot') === room.name), now = Date.now();
  res.json({ ok: true, cfg: natCfg(room), phones: nat.length, active: nat.filter((x) => now - Number(x.seen || 0) < 24 * 3600_000).length });
});
/* celulares con la app que no preguntan hace 10 días (desinstalada): se olvidan */
setInterval(() => { const now = Date.now(); for (const [h, x] of pushSubs) if (x && x.native && now - Number(x.seen || x.at || 0) > 10 * 86400_000) { pushSubs.delete(h); pushQueue.delete(h); if (db) db.query(`DELETE FROM mobi_kv WHERE ns = 'push' AND id = $1`, [h]).catch(() => {}); } }, 3600_000).unref();

/* ===================== V576 · VIAJES DE BIENVENIDA =====================
   Los activa el administrador (apagado = la app funciona exactamente igual que antes).
   Pasajero: 3 viajes gratis por persona (DNI y celular), de hasta 3 km, directos, 1 por día, dentro de los 30 días desde el primero.
   Solo para quien todavía no hizo ningún viaje. Cuenta recién cuando el viaje TERMINA (si se cancela, no se pierde). */
const WEL_MAX = 3, WEL_KM = 3, WEL_DAYS = 30, WEL_HOLD_MS = 3 * 3600_000, WEL_DRV_DAY = 2;   /* V625 · máximo de viajes de bienvenida por conductor por día */
function welDrvToday(room, drv, skipTk) {
  const today = welDay(Date.now()), now = Date.now(); let n = 0;
  for (const r of welOf(room)) {
    if (!r || r.tk === skipTk) continue;
    if (r.done) { if (!r.self && String(r.drv || '') === drv && welDay(r.done) === today) n++; continue; }
    const cl = room.claims && room.claims.get(String(r.tk));
    if (welLive(r, now) && cl && cl.driverId === drv && welDay(cl.at || r.at) === today) n++;
  }
  return n;
}
const welRec = new Map();   // 'sala|tripKey' -> { tk, pax, keys, at, val, km, vk, end, done, drv, self }
function welCfg(room) { const m = room.sticky.get('cfg-welcome|cfg:welcome'), d = m && m.data; return { on: !!(d && d.on), cap: Math.max(0, Math.round(Number(d && d.cap) || 0)), max: welMaxOf(d), at: Number(d && d.at) || 0 }; }
/* V577d · cantidad de viajes de bienvenida por pasajero: la elige el administrador (1 a 3). Sin elegir = 3, como antes */
function welMaxOf(d) { const n = Math.round(Number(d && d.max)); return n >= 1 && n <= WEL_MAX ? n : WEL_MAX; }
function welDay(t) { return new Date(Number(t) - 3 * 3600_000).toISOString().slice(0, 10); }   /* día en Argentina */
function welHash(v) { return crypto.createHash('sha256').update('mobi-wel|' + v).digest('hex').slice(0, 24); }
function welKeys(reg) { const k = [], dni = String((reg && reg.dni) || '').replace(/\D/g, ''), ph = tail8(reg && reg.phone); if (dni.length >= 6) k.push('d' + welHash(dni)); if (ph.length >= 8) k.push('p' + welHash(ph)); return k; }
function welSave(k, r) { kvSet('wel', k, r || { gone: 1 }); }
function welOf(room) { const p = room.name + '|', out = []; for (const [k, r] of welRec) if (k.startsWith(p) && r) out.push(r); return out; }
function welLive(r, now) { return !r.done && !r.end && now - Number(r.at || 0) < WEL_HOLD_MS; }
function welPaidBefore(room, paxId, until, skip) {   /* ¿ya hizo algún viaje normal? */
  for (const m of room.sticky.values()) {
    if (!m || m.type !== 'trip-done' || !m.data || !Array.isArray(m.data.hist) || Number(m.at || 0) >= until) continue;
    if (skip.has(String(m.data.tripKey || ''))) continue;
    if (m.data.hist.some((h) => h && h.item && String(h.item.paxId || '') === paxId && !(selfOn(room) && selfPair(room, h.item.driverId, paxId, '')))) return true;   /* V642 · un autoviaje no cuenta como viaje hecho */
  }
  return false;
}
function welStatus(room, paxId) {
  const c = welCfg(room), now = Date.now(), out = { ok: true, on: c.on, max: c.max, km: WEL_KM, days: WEL_DAYS, used: 0, left: 0 };
  if (!c.on) return Object.assign(out, { can: false, why: 'off' });
  const reg = stickyData(room, 'pax-reg|pr:' + paxId), keys = welKeys(reg);
  if (!reg || reg.deletedAt || !keys.length) return Object.assign(out, { can: false, why: 'noreg' });
  const all = welOf(room), mine = all.filter((r) => r.done && (r.keys || []).some((x) => keys.includes(x))).sort((a, b) => a.done - b.done);
  const live = all.filter((r) => welLive(r, now) && (r.keys || []).some((x) => keys.includes(x)));
  const first = mine.length ? mine[0].done : 0;
  Object.assign(out, { used: mine.length, left: Math.max(0, c.max - mine.length), first, until: first ? first + WEL_DAYS * 86400_000 : 0 });
  if (mine.length >= c.max) return Object.assign(out, { can: false, why: 'used' });
  if (first && now > out.until) return Object.assign(out, { can: false, why: 'expired' });
  if (mine.some((r) => welDay(r.done) === welDay(now))) return Object.assign(out, { can: false, why: 'today' });
  if (welPaidBefore(room, paxId, first || now, new Set(mine.map((r) => r.tk)))) return Object.assign(out, { can: false, why: 'traveled' });
  if (c.cap && !live.length) { const d = welDay(now); const n = all.filter((r) => (r.done && welDay(r.done) === d) || (welLive(r, now) && welDay(r.at) === d)).length; if (n >= c.cap) return Object.assign(out, { can: false, why: 'cap' }); }
  if (fbCfg(room).on && !fbDone.has(room.name + '|' + paxId)) return Object.assign(out, { can: false, why: 'fb' });   /* V586 · falta seguir la página */
  if (live.length) out.hold = live[0].tk;
  return Object.assign(out, { can: true });
}
function welIngest(room, msg) {
  const d = msg.data; if (!d || !d.tripKey) return;
  const k = room.name + '|' + String(d.tripKey), r = welRec.get(k); if (!r || r.done) return;
  if (msg.type === 'trip-end') { if (!r.end) { r.end = Date.now(); welSave(k, r); } return; }   /* cancelado: no cuenta (si después llega «terminado», cuenta) */
  const hd = Array.isArray(d.hist) ? ((d.hist.find((h) => h && h.role === 'drv') || {}).item || {}) : {}, cl = room.claims && room.claims.get(String(d.tripKey));
  r.drv = String(hd.driverId || (cl && cl.driverId) || '');
  const dk = welKeys(stickyData(room, 'driver-reg|dr:' + r.drv)); r.self = dk.some((x) => (r.keys || []).includes(x));   /* el conductor se llevó a sí mismo: no suma saldo */
  r.done = Date.now(); welSave(k, r);
  console.log('Viaje de bienvenida terminado', d.tripKey, '$' + r.val, r.self ? '(mismo dueño: sin saldo)' : '');
  /* saldo a favor del conductor por el valor del viaje (sin recargos). Nunca vence y no se retira: descuenta lo que deba (comisiones, cancelaciones u otros cargos) */
  if (!r.self && OWN_RE.drv.test(r.drv) && r.val > 0 && !room.sticky.has('debt-charge|dc:wel:' + r.tk)) {
    pushMessage(room, { type: 'debt-charge', key: 'dc:wel:' + r.tk, src: 'admin', data: { id: 'wel_' + String(r.tk).slice(0, 40), type: 'credit', kind: 'welcome', amount: r.val, at: Date.now(), driver: r.drv, note: '🎁 Viaje de bienvenida · saldo a favor', route: String(hd.route || '').slice(0, 200), tripKey: r.tk, srv: 1 } });
  }
}
function welPax(req, res) {
  const b = req.body || {}, room = getRoom(b.room), id = String(b.paxId || ''), au = authOf(req, room.name);
  if (!OWN_RE.pax.test(id)) { res.status(400).json({ ok: false, error: 'pax' }); return null; }
  if (!au.admin && !isOwner(room, 'pax', id, au.sk, legacyBind(room, 'pax', id))) { res.status(403).json({ ok: false, error: 'owner' }); return null; }
  return { room, id };
}
app.post('/api/welcome/status', (req, res) => { res.setHeader('Cache-Control', 'no-store'); const x = welPax(req, res); if (x) res.json(welStatus(x.room, x.id)); });
app.post('/api/welcome/hold', (req, res) => {
  const x = welPax(req, res); if (!x) return; const b = req.body || {}, tk = String(b.tripKey || '');
  if (!/^[A-Za-z0-9]{6,30}$/.test(tk)) return res.status(400).json({ ok: false, error: 'trip' });
  const k = x.room.name + '|' + tk, prev = welRec.get(k); if (prev) return res.json({ ok: true, hold: tk, done: !!prev.done });
  const km = Number(b.km), val = Math.round(Number(b.value) || 0);
  if (!(km > 0 && km <= WEL_KM + 0.05) || !(val > 0 && val <= 50000)) return res.json({ ok: false, why: 'km' });
  const st = welStatus(x.room, x.id); if (!st.can) return res.json({ ok: false, why: st.why });
  if (st.hold && st.hold !== tk) { const ok = x.room.name + '|' + st.hold, o = welRec.get(ok); if (o) { o.end = Date.now(); welSave(ok, o); } }   /* un pedido anterior que quedó colgado */
  const r = { tk, pax: x.id, keys: welKeys(stickyData(x.room, 'pax-reg|pr:' + x.id)), at: Date.now(), val, km: Math.round(km * 100) / 100, vk: b.vkind === 'moto' ? 'moto' : 'auto', end: 0, done: 0 };
  welRec.set(k, r); welSave(k, r); res.json({ ok: true, hold: tk });
});
app.post('/api/admin/welcome', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), prev = welCfg(room);
  const data = { on: b.on === undefined ? prev.on : !!b.on, cap: b.cap === undefined ? prev.cap : Math.max(0, Math.min(10000, Math.round(Number(b.cap) || 0))), max: b.max === undefined ? prev.max : welMaxOf({ max: b.max }), at: Date.now() };
  pushMessage(room, { type: 'cfg-welcome', key: 'cfg:welcome', src: 'admin', data });
  console.log('Viajes de bienvenida', data.on ? 'ACTIVADOS' : 'desactivados', 'tope diario', data.cap || 'sin tope', 'viajes por pasajero', data.max);
  res.json(Object.assign({ ok: true }, data));
});
app.post('/api/admin/welcome-info', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), now = Date.now(), day = welDay(now), all = welOf(room), done = all.filter((r) => r.done);
  const sum = (l) => l.reduce((a, r) => a + (r.self ? 0 : Number(r.val) || 0), 0), td = done.filter((r) => welDay(r.done) === day);
  const zones = {}, seen = room.seen || new Map();
  for (const [k, m] of room.sticky) {
    const d = m && m.data; if (!d || m.type !== 'driver-reg' || !k.startsWith('driver-reg|dr:') || d.status !== 'aprobado' || d.deletedAt || drvHidden(d)) continue;
    const z = (String(d.prov || '').trim() || 'Sin provincia') + ' · ' + (String(d.zone || '').trim() || 'sin zona'), o = zones[z] || (zones[z] = { zone: z, auto: 0, moto: 0, online: 0 });
    if (String(d.vtype || '') === 'moto') o.moto++; else o.auto++;
    if (now - Number(seen.get(String(d.id)) || 0) < 3 * 60_000) o.online++;
  }
  const nm = (t, id) => { const x = stickyData(room, t + id); return (x && x.name) || ''; };
  const recent = done.sort((a, b) => b.done - a.done).slice(0, 15).map((r) => ({ at: r.done, val: r.val, km: r.km, vk: r.vk, self: !!r.self, pax: nm('pax-reg|pr:', r.pax), drv: nm('driver-reg|dr:', r.drv) }));
  res.json({ ok: true, cfg: welCfg(room), today: { n: td.length, val: sum(td) }, total: { n: done.length, val: sum(done), pax: new Set(done.map((r) => r.pax)).size }, live: all.filter((r) => welLive(r, now)).length, zones: Object.values(zones).sort((x, y) => (y.auto + y.moto) - (x.auto + x.moto)), recent });
});

/* ===================== V576 · RECORDATORIO A CONDUCTORES «SIN ENVIAR» =====================
   Conductores que empezaron el registro pero no tocaron «Enviar a evaluación»: un aviso al celular (con la app cerrada)
   cada 4 horas diciendo qué les falta, hasta que lo envíen. No se manda de noche (22 a 9). Lo prende el administrador. */
const REM_EVERY = 4 * 3600_000, remMem = new Map();   // 'sala|drv' -> { n, last }
function remCfg(room) { const m = room.sticky.get('cfg-remind|cfg:remind'), d = m && m.data; return { on: !!(d && d.on), at: Number(d && d.at) || 0 }; }
function remHourAR(t) { return new Date(Number(t) - 3 * 3600_000).getUTCHours(); }
function remDrafts(room) {
  const out = [];
  for (const [k, m] of room.sticky) {
    const d = m && m.data; if (!d || m.type !== 'driver-reg' || !k.startsWith('driver-reg|dr:') || !OWN_RE.drv.test(String(d.id || ''))) continue;
    const st = String(d.status || 'borrador'); if (st !== 'borrador' || d.deletedAt || d.hiddenAt) continue;
    const nm = String(d.name || '').trim(), real = nm && !/^(Conductor|Conductor MOBI|Tu conductor)$/i.test(nm), dc = d.docs || {};
    if (!real && !String(d.plate || '').replace(/[—\-\s]/g, '') && !Object.keys(dc).some((x) => dc[x])) continue;   /* abrió el modo conductor sin cargar nada: no se lo molesta */
    out.push(d);
  }
  return out;
}
function remMissing(d) {
  const f = [], dc = d.docs || {};
  if (!String(d.name || '').trim() || /^(Conductor|Conductor MOBI|Tu conductor)$/i.test(String(d.name || '').trim())) f.push('tu nombre');
  if (tail8(d.phone).length < 8) f.push('tu celular');
  if (String(d.dni || '').replace(/\D/g, '').length < 6) f.push('tu DNI');
  if (!dc.cedula) f.push('la foto de la cédula');
  if (!dc.license) f.push('la foto del registro');
  return f;
}
function remNote(d) {
  const f = remMissing(d), list = f.length > 1 ? f.slice(0, -1).join(', ') + ' y ' + f[f.length - 1] : (f[0] || '');
  return { title: '🚗 Terminá tu registro en MOBI', body: f.length ? 'Te falta ' + list + '. Completalo en Conductor → Configuración y tocá «Enviar a evaluación».' : 'Ya cargaste todo: solo te falta tocar «Enviar a evaluación» en Conductor → Configuración.' };
}
function remSend(room, d) {
  const id = String(d.id), k = room.name + '|' + id, n = pushNotify(id, remNote(d));
  const r = remMem.get(k) || { n: 0, last: 0 }; r.last = Date.now(); if (n) r.n++; remMem.set(k, r); kvSet('remind', k, r);
  return n;
}
function remTick() {
  const now = Date.now(), h = remHourAR(now); if (h < 9 || h >= 22 || !pushLoaded) return;
  for (const room of rooms.values()) {
    if (/^sandbox/.test(room.name) || !remCfg(room).on) continue;
    for (const d of remDrafts(room)) {
      const k = room.name + '|' + String(d.id), r = remMem.get(k);
      if (r && now - Number(r.last || 0) < REM_EVERY) continue;
      if (now - Number(d.updatedAt || 0) < 3600_000) continue;   /* lo está completando ahora: no se lo interrumpe */
      if (![...pushSubs.values()].some((x) => (x.room || 'pilot') === room.name && subUids(x).includes(String(d.id)))) continue;
      remSend(room, d);
    }
  }
}
setInterval(() => { try { remTick(); } catch (e) {} }, 10 * 60_000).unref();
app.post('/api/admin/remind', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room);
  if (b.on !== undefined) pushMessage(room, { type: 'cfg-remind', key: 'cfg:remind', src: 'admin', data: { on: !!b.on, at: Date.now() } });
  const subs = new Set([...pushSubs.values()].filter((x) => (x.room || 'pilot') === room.name).flatMap((x) => subUids(x)));
  const list = remDrafts(room).map((d) => { const r = remMem.get(room.name + '|' + String(d.id)) || {}; return { id: d.id, push: subs.has(String(d.id)), n: Number(r.n) || 0, last: Number(r.last) || 0, missing: remMissing(d) }; });
  res.json({ ok: true, cfg: remCfg(room), drafts: list.length, withPush: list.filter((x) => x.push).length, list });
});
app.post('/api/admin/remind-one', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), d = stickyData(room, 'driver-reg|dr:' + String(b.id || ''));
  if (!d) return res.status(404).json({ ok: false, error: 'no_existe' });
  if (!pushLoaded) return res.status(503).json({ ok: false });
  const n = remSend(room, d); res.json({ ok: true, sent: n, note: remNote(d) });
});

app.post('/api/addr/find', (req, res) => {
  const q = String((req.body || {}).q || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60).trim();
  if (q.length < 3) return res.json({ ok: true, items: [] });
  const items = [];
  for (const [k, e] of addrMem) { if (!k.startsWith(q + '|')) continue; const b = addrBest(e); if (b) items.push({ key: k, label: e.label, lat: b.lat, lng: b.lng, w: b.w }); if (items.length >= 15) break; }
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
  /* V613 · solo algunas fotos (por ejemplo la de perfil para la lista de Administración): mucho más liviano que traer todos los documentos */
  const kinds = Array.isArray(b.kinds) ? b.kinds.map((k) => String(k || '')).filter((k) => /^[a-zA-Z]{2,12}$/.test(k)).slice(0, 6) : null;
  if (kinds && kinds.length) {
    const out = {};
    if (db) { try { const r = await db.query(`SELECT id, data FROM mobi_kv WHERE ns = 'doc' AND id = ANY($1)`, [kinds.map((k) => owner + '|' + k)]); for (const row of r.rows) out[row.id.split('|')[1]] = row.data.img; } catch (e) { console.warn('docs', e.message); } }
    for (const k of kinds) { const v = docMem.get(owner + '|' + k); if (v && !out[k]) out[k] = v.img; }
    return res.json({ ok: true, docs: out });
  }
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

/* V629 · COMPROBANTES: recupera las fichas que se perdieron en reinicios anteriores.
   La foto de cada comprobante siempre quedó guardada (docs «trip_<viaje>|proof»), pero su ficha (viaje, monto, pasajero) vivía solo en memoria.
   Al arrancar, para cada foto sin ficha se arma una con los datos del viaje terminado y se guarda. Solo la ve Administración. */
async function proofMetaRestore() {
  if (!db) return; let rows = [];
  try { rows = (await db.query(`SELECT id, data->>'at' AS at FROM mobi_kv WHERE ns = 'doc' AND id LIKE 'trip\_%|proof' AND at > now() - interval '180 days'`)).rows; } catch (e) { console.warn('comprobantes', e.message); return; }
  if (!rows.length) return;
  const done = new Map(); let main = null, mainN = -1;
  for (const r of rooms.values()) { if (r.sticky.size > mainN) { main = r; mainN = r.sticky.size; }
    for (const m of r.sticky.values()) if (m && m.type === 'trip-done' && m.data && m.data.tripKey) done.set(String(m.data.tripKey), { r, d: m.data }); }
  let n = 0;
  for (const row of rows) {
    const k = String(row.id).replace(/^trip_/, '').replace(/\|proof$/, ''); if (!k) continue;
    let has = false; for (const r of rooms.values()) if (r.sticky.has('pay-proof-meta|' + k)) { has = true; break; } if (has) continue;
    const t = done.get(k), room = (t && t.r) || main; if (!room || /sbx|sandbox|test/i.test(room.name) && !t) continue;
    const d = (t && t.d) || {}, it = ((Array.isArray(d.hist) ? d.hist : []).find((h) => h && h.role === 'drv') || {}).item || {}, sd = (d.sum && d.sum.driver) || {};
    if (!room.parts.has(k)) room.parts.set(k, new Set());   /* sin participantes conocidos: solo la ve Administración */
    pushMessage(room, { type: 'pay-proof-meta', key: k, src: 'srv', data: { tripKey: k, at: Number(row.at) || Number(it.at) || Date.now(), fare: Number(it.fare) || Number(d.sum && d.sum.fare) || 0, route: String(it.route || '').slice(0, 200), pax: 'Pasajero', driver: String(sd.name || '').slice(0, 80), plate: String(sd.plate || '').slice(0, 20), payment: String(it.payment || 'Transferencia').slice(0, 40), restored: 1 } });
    n++;
  }
  if (n) console.log('Comprobantes: se recuperaron ' + n + ' fichas que se habían perdido en reinicios anteriores');
}
setTimeout(() => { proofMetaRestore().catch((e) => console.warn('comprobantes', e.message)); }, Number(process.env.PROOF_RESTORE_MS) || 20_000).unref();
/* la lista completa de fichas para Administración (la app la pide al abrir: así no depende de haber estado conectada cuando llegó cada una) */
app.post('/api/admin/proofs', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), list = [];
  for (const m of room.sticky.values()) if (m && m.type === 'pay-proof-meta' && m.data && m.data.tripKey) list.push(m.data);
  list.sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0));
  res.json({ ok: true, list: list.slice(0, 300) });
});

/* V633 · MAIL CUANDO ALGUIEN ESCRIBE A SOPORTE: cada mensaje nuevo que manda un pasajero o conductor desde «Soporte»
   (no las respuestas de Administración). A SUP_NOTIFY_TO (de fábrica el mismo mail de los incidentes). Como mucho 1 mail por consulta cada 10 min
   (si escribe varios seguidos van juntos en el próximo) y 80 por día. Las salas de prueba no mandan mail. */
const SUP = { last: new Map(), pend: new Map(), day: { d: '', n: 0 }, log: [] };
function supNotify(room, msg) {
  if (msg.type !== 'report' || !msg.key || !msg.data || typeof msg.data !== 'object') return;
  const d = msg.data; if (!d.sup || d.from !== 'u' || d.kind === 'resolve') return;
  if (room.sticky.has('report|' + msg.key)) return;   /* ya estaba: no es un mensaje nuevo */
  if (/sbx|sandbox|test/i.test(room.name)) return;
  const tid = String(d.tid || msg.key), k = room.name + '|' + tid, l = SUP.pend.get(k) || [];
  l.push({ at: Date.now(), name: String(d.name || '').slice(0, 80), role: d.role === 'drv' ? 'Conductor' : 'Pasajero', phone: String(d.phone || '').slice(0, 30), plate: String(d.plate || '').slice(0, 20), why: String(d.rlabel || d.reason || '').slice(0, 80), text: String(d.text || '').slice(0, 1500), tid });
  SUP.pend.set(k, l.slice(-10));
}
async function supTick() {
  const now = Date.now(), to = String(process.env.SUP_NOTIFY_TO || INC_MAIL_TO || '').trim();
  for (const [k, l] of [...SUP.pend]) {
    if (!l.length || now - (SUP.last.get(k) || 0) < 10 * 60_000) continue;
    const day = new Date().toISOString().slice(0, 10); if (SUP.day.d !== day) SUP.day = { d: day, n: 0 }; if (SUP.day.n >= 80) return;
    SUP.pend.delete(k); SUP.last.set(k, now); SUP.day.n++;
    const f = l[l.length - 1], esc = (x) => String(x == null ? '' : x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const hora = (t) => new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const subject = '🎧 MOBI Soporte · ' + (f.name || f.role) + (f.why ? ' · ' + f.why : '');
    const head = [f.role + ': ' + (f.name || 'sin nombre'), f.phone ? 'Celular: ' + f.phone : '', f.plate ? 'Patente: ' + f.plate : '', f.why ? 'Motivo: ' + f.why : '', 'Consulta N.º ' + f.tid].filter(Boolean);
    const text = 'Nuevo mensaje en Soporte de MOBI.\n\n' + head.join('\n') + '\n\n' + l.map((m) => '[' + hora(m.at) + '] ' + m.text).join('\n\n') + '\n\nRespondé desde Administración → 🎧 Soporte.';
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#10202a"><h2 style="margin:0 0 6px">🎧 Nuevo mensaje en Soporte</h2><p style="margin:0 0 10px;color:#555">' + head.map(esc).join('<br>') + '</p>' +
      l.map((m) => '<div style="border:1px solid #e3e8eb;border-left:4px solid #20c997;border-radius:8px;padding:10px 12px;margin:0 0 8px"><small style="color:#777">' + esc(hora(m.at)) + '</small><br>' + esc(m.text).replace(/\n/g, '<br>') + '</div>').join('') +
      '<p style="color:#555">Respondé desde <b>Administración → 🎧 Soporte</b>.</p></div>';
    if (process.env.INC_MAIL_DRY) { SUP.log.push({ at: now, to, subject, text }); console.log('[mail de prueba] ' + subject); continue; }
    if (!GM_ON || !to) continue;
    try { await gmSend(to, subject, html, text); console.log('Mail de Soporte enviado a', to, '·', f.tid); } catch (e) { console.warn('mail soporte', e.message); SUP.pend.set(k, l); SUP.last.delete(k); }
  }
}
setInterval(() => { supTick().catch(() => {}); }, Number(process.env.INC_TICK_MS) || 60_000).unref();
if (process.env.INC_MAIL_DRY) app.get('/api/admin/supmaillog', (req, res) => res.json({ ok: true, log: SUP.log }));
/* ===================== V629 · INCIDENTES DE DINERO (solo REPORTES: nunca frena viajes, pagos ni la app) =====================
   Registra en Administración («🚨 Incidentes de dinero») y avisa por mail (agrupado: como mucho uno cada 15 min) cuando:
   - un movimiento queda DUPLICADO (mismo viaje cobrado o acreditado dos veces, mismo pago de Mercado Pago dos veces);
   - el servidor FRENA un intento sospechoso (saldo a favor sin viaje real, retiro mayor al saldo, saldo de pasajero que no tiene, pago «confirmado» sin Mercado Pago…);
   - un solo movimiento es muy GRANDE (monto configurable, $100.000 de fábrica);
   - un movimiento ya registrado vuelve con OTRO MONTO;
   - CONTROL DIARIO: un movimiento que estaba ayer ya no está (borrado), o un pasajero usó más saldo a favor del que tenía.
   Mail: INC_MAIL_TO (de fábrica gabrielmajorana@live.com). Las salas de prueba (sandbox/test) se registran pero no mandan mail. */
const INC_MAIL_TO = String(process.env.INC_MAIL_TO || 'gabrielmajorana@live.com').trim();
const INC_MAIL_GAP = Number(process.env.INC_MAIL_GAP_MS) || 15 * 60_000, INC_FIRST_WAIT = Number(process.env.INC_FIRST_WAIT_MS) || 2 * 60_000;
const INC = { big: 100000, mem: new Map(), snap: new Map(), lastCheck: new Map(), queue: [], lastMail: 0, firstQ: 0, day: { d: '', n: 0 }, mailLog: [] };
const incTest = (room) => /sbx|sandbox|test/i.test(String(room && room.name || ''));
const incList = (room) => { let l = INC.mem.get(room.name); if (!l) { l = []; INC.mem.set(room.name, l); } return l; };
const incMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
function incDrvName(room, drv) { const d = drv && stickyData(room, 'driver-reg|dr:' + drv); return String((d && d.name) || '').trim(); }
function incAdd(room, o) {
  try {
    const l = incList(room), now = Date.now(), dk = String(o.dk || (o.kind + '|' + (o.drv || '') + '|' + (o.tk || '') + '|' + (o.key || '')));
    if (l.some((x) => x.dk === dk && now - x.at < 6 * 3600_000)) return null;   /* el mismo caso no se repite (reintentos del celular) */
    const it = { id: 'i' + now.toString(36) + crypto.randomBytes(2).toString('hex'), at: now, room: room.name, dk, kind: String(o.kind || ''), title: String(o.title || 'Inconsistencia').slice(0, 120),
      drv: String(o.drv || ''), who: String(o.who || incDrvName(room, o.drv) || ''), tk: String(o.tk || ''), key: String(o.key || ''),
      amount: o.amount == null ? null : Math.round(Number(o.amount) * 100) / 100, before: o.before == null ? null : Math.round(Number(o.before) * 100) / 100, after: o.after == null ? null : Math.round(Number(o.after) * 100) / 100,
      detail: String(o.detail || '').slice(0, 400), by: String(o.by || '').slice(0, 40), seen: false };
    l.unshift(it); if (l.length > 300) l.length = 300;
    kvSet('inc', room.name + '|' + it.id, it);
    console.warn('INCIDENTE DE DINERO ·', room.name, '·', it.title, '·', it.who || it.drv || '-', it.amount != null ? incMoney(it.amount) : '', it.detail);
    if (!incTest(room)) { INC.queue.push(it); if (!INC.firstQ) INC.firstQ = now; }
    return it;
  } catch (e) { console.warn('incidente', e.message); return null; }
}
/* lo llama pushMessage ANTES de guardar: compara con lo que ya había (no cambia nada del mensaje) */
function incWatch(room, msg) {
  const t = msg.type; if ((t !== 'debt-charge' && t !== 'debt-pay') || !msg.key || !msg.data || typeof msg.data !== 'object') return;
  const d = msg.data, prev = room.sticky.get(t + '|' + msg.key), pd = prev && prev.data, amt = Number(d.amount) || 0, drv = String(d.driver || ''), tk = String(d.tripKey || '');
  const what = t === 'debt-pay' ? (d.type === 'payout' ? 'retiro' : 'pago') : (d.type === 'credit' ? 'saldo a favor' : 'cobro');
  if (pd && typeof pd === 'object') {
    const pa = Number(pd.amount) || 0;
    if (Math.abs(pa - amt) > 0.5 || String(pd.type || '') !== String(d.type || '')) incAdd(room, { kind: 'modif', title: 'Movimiento modificado: ' + what + ' con otro monto', drv, tk, key: msg.key, before: pa, after: amt, amount: amt - pa, by: msg.src, dk: 'modif|' + msg.key + '|' + amt,
      detail: (pd.note ? '«' + String(pd.note).slice(0, 80) + '» · ' : '') + 'Antes ' + incMoney(pa) + ', ahora ' + incMoney(amt) + (msg.src === 'admin' ? ' (cambio hecho desde Administración o por el servidor)' : '') });
    return;
  }
  if (amt > INC.big) incAdd(room, { kind: 'grande', title: 'Movimiento muy grande: ' + what, drv, tk, key: msg.key, amount: amt, by: msg.src, detail: (d.note ? '«' + String(d.note).slice(0, 80) + '» · ' : '') + 'Supera el tope de aviso de ' + incMoney(INC.big) });
  if (tk) for (const x of room.sticky.values()) {
    const y = x && x.type === t && x.key !== msg.key && x.data; if (!y || String(y.driver || '') !== drv || String(y.tripKey || '') !== tk || String(y.type || '') !== String(d.type || '')) continue;
    let dup = false;
    if (t === 'debt-charge' && d.type === 'charge') dup = /^Comisi[oó]n de viaje/i.test(String(d.note || '')) && /^Comisi[oó]n de viaje/i.test(String(y.note || ''));
    else if (t === 'debt-charge' && d.type === 'credit') dup = String(y.kind || '') === String(d.kind || '') && Math.abs((Number(y.amount) || 0) - amt) < 0.5 && isCancelCredit(y) === isCancelCredit(d);
    if (dup) { incAdd(room, { kind: 'dup', title: 'Movimiento duplicado: el mismo viaje con dos ' + (d.type === 'credit' ? 'saldos a favor' : 'comisiones'), drv, tk, key: msg.key, amount: amt, by: msg.src, dk: 'dup|' + drv + '|' + tk + '|' + d.type, detail: 'Ya existía ' + incMoney(y.amount) + ' para el mismo viaje. Quedaron los dos registrados.' }); break; }
  }
  if (t === 'debt-pay' && d.type === 'payment' && d.status === 'confirmado' && d.mpOrderId) for (const x of room.sticky.values()) {
    const y = x && x.type === 'debt-pay' && x.key !== msg.key && x.data; if (!y || y.type !== 'payment' || y.status !== 'confirmado' || String(y.mpOrderId || '') !== String(d.mpOrderId)) continue;
    incAdd(room, { kind: 'dup', title: 'Pago duplicado: el mismo cobro de Mercado Pago acreditado dos veces', drv, key: msg.key, amount: amt, by: msg.src, dk: 'duppay|' + d.mpOrderId, detail: 'Orden de Mercado Pago ' + String(d.mpOrderId).slice(0, 40) }); break;
  }
}
/* lo llama guardMsg cuando FRENA algo sospechoso (el rechazo sigue igual que antes) */
function incReject(room, d, title, detail) {
  try { const drv = String((d && d.driver) || ''), tk = String((d && d.tripKey) || '');
    incAdd(room, { kind: 'frenado', title: 'Intento frenado: ' + title, drv, tk, amount: Number(d && d.amount) || 0, dk: 'frenado|' + title + '|' + drv + '|' + tk + '|' + Math.round(Number(d && d.amount) || 0), detail: String(detail || '') + (d && d.note ? (detail ? ' · ' : '') + '«' + String(d.note).slice(0, 80) + '»' : '') + ' · No se registró: el servidor lo rechazó.' });
  } catch (e) {}
}
/* control diario: lo que estaba y ya no está, y saldos de pasajero imposibles */
function incCheck(room, why) {
  if (!room || !room.sticky) return; const cur = {}, now = Date.now();
  for (const [k, m] of room.sticky) if (m && (m.type === 'debt-charge' || m.type === 'debt-pay') && m.data) cur[k] = [Math.round((Number(m.data.amount) || 0) * 100) / 100, String(m.data.driver || ''), String(m.data.tripKey || ''), String(m.data.note || '').slice(0, 60)];
  const snap = INC.snap.get(room.name);
  if (snap && snap.m) {
    const gone = Object.keys(snap.m).filter((k) => !cur[k]);
    for (const k of gone.slice(0, 20)) { const s = snap.m[k]; incAdd(room, { kind: 'falta', title: 'Movimiento que desapareció', drv: s[1], tk: s[2], key: k, before: s[0], after: 0, amount: -s[0], dk: 'falta|' + k, detail: (s[3] ? '«' + s[3] + '» · ' : '') + 'Estaba en el control anterior (' + new Date(snap.at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ') y ya no está.' }); }
    if (gone.length > 20) incAdd(room, { kind: 'falta', title: 'Faltan ' + gone.length + ' movimientos', dk: 'faltan|' + snap.at, amount: -gone.reduce((a, k) => a + snap.m[k][0], 0), detail: 'Desaparecieron ' + gone.length + ' cobros/pagos desde el control anterior. Puede ser un problema de la base de datos.' });
    for (const k of Object.keys(snap.m)) { const s = snap.m[k], c = cur[k]; if (c && Math.abs(c[0] - s[0]) > 0.5) incAdd(room, { kind: 'modif', title: 'Movimiento modificado (control diario)', drv: s[1], tk: s[2], key: k, before: s[0], after: c[0], amount: c[0] - s[0], dk: 'modif|' + k.split('|').slice(1).join('|') + '|' + c[0], detail: (s[3] ? '«' + s[3] + '» · ' : '') + 'Cambió de monto desde el control anterior.' }); }
  }
  try { const ids = new Set(); for (const m of room.sticky.values()) { const y = m && m.type === 'debt-charge' && m.data; if (y && y.tripKey && (isRefundCharge(y) || y.kind === 'paxcredit')) { const id = paxIdentOfTrip(room, String(y.tripKey)); if (id) ids.add(id); } }
    for (const id of ids) { const c = paxCreditOf(room, id); if (c < -0.5) incAdd(room, { kind: 'paxneg', title: 'Pasajero usó más saldo a favor del que tenía', amount: c, after: c, dk: 'paxneg|' + id + '|' + Math.round(c), detail: 'Su saldo a favor calculado quedó en ' + incMoney(c) + '.' }); } } catch (e) {}
  INC.snap.set(room.name, { at: now, m: cur }); INC.lastCheck.set(room.name, now); kvSet('incsnap', room.name, { at: now, m: cur });
  if (why) console.log('Control de dinero', room.name, '·', Object.keys(cur).length, 'movimientos ·', why);
}
setInterval(() => { const now = Date.now(); for (const r of rooms.values()) { try { if (now - (INC.lastCheck.get(r.name) || 0) >= 24 * 3600_000) incCheck(r, 'diario'); } catch (e) { console.warn('control dinero', e.message); } } }, 60 * 60_000).unref();
setTimeout(() => { for (const r of rooms.values()) { try { if (INC.snap.has(r.name)) incCheck(r, 'al arrancar'); } catch (e) {} } }, Number(process.env.INC_BOOT_MS) || 10 * 60_000).unref();   /* al arrancar: compara con el último control guardado */
async function incMailTick() {
  if (!INC.queue.length) return; const now = Date.now();
  if (now - INC.firstQ < INC_FIRST_WAIT || now - INC.lastMail < INC_MAIL_GAP) return;
  const day = new Date().toISOString().slice(0, 10); if (INC.day.d !== day) INC.day = { d: day, n: 0 }; if (INC.day.n >= 30) return;
  const items = INC.queue.splice(0, 40); INC.firstQ = INC.queue.length ? now : 0; INC.lastMail = now; INC.day.n++;
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const hora = (t) => new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const line = (i) => [i.title, i.who || i.drv ? 'Conductor: ' + (i.who || '') + (i.drv ? ' (' + i.drv + ')' : '') : '', i.amount != null ? 'Monto: ' + incMoney(i.amount) : '', i.before != null || i.after != null ? 'Antes: ' + incMoney(i.before) + ' → Después: ' + incMoney(i.after) : '', i.detail, 'Hora: ' + hora(i.at)].filter(Boolean);
  const subject = '🚨 MOBI · ' + items.length + (items.length === 1 ? ' incidente de dinero' : ' incidentes de dinero');
  const text = 'MOBI detectó ' + items.length + (items.length === 1 ? ' movimiento raro' : ' movimientos raros') + ' en la plata. Este aviso no frena nada: la app sigue funcionando normalmente.\n\n' + items.map((i, n) => (n + 1) + '. ' + line(i).join('\n   ')).join('\n\n') + '\n\nRevisalo en Administración → 🚨 Incidentes de dinero.';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#10202a"><h2 style="margin:0 0 6px">🚨 Incidentes de dinero</h2><p style="margin:0 0 12px;color:#555">MOBI detectó ' + items.length + (items.length === 1 ? ' movimiento raro' : ' movimientos raros') + '. <b>Este aviso no frena nada</b>: la app sigue funcionando normalmente.</p>' +
    items.map((i) => { const l = line(i); return '<div style="border:1px solid #e3e8eb;border-left:4px solid #e5484d;border-radius:8px;padding:10px 12px;margin:0 0 10px"><b>' + esc(l[0]) + '</b><br>' + l.slice(1).map(esc).join('<br>') + '</div>'; }).join('') +
    '<p style="color:#555">Revisalo en <b>Administración → 🚨 Incidentes de dinero</b>.</p></div>';
  if (process.env.INC_MAIL_DRY) { INC.mailLog.push({ at: now, to: INC_MAIL_TO, subject, text }); console.log('[mail de prueba] ' + subject + '\n' + text); return; }
  if (!GM_ON || !INC_MAIL_TO) return;
  try { await gmSend(INC_MAIL_TO, subject, html, text); console.log('Mail de incidentes enviado a', INC_MAIL_TO, '·', items.length); }
  catch (e) { console.warn('mail incidentes', e.message); INC.queue.unshift(...items); INC.firstQ = now; }
}
setInterval(() => { incMailTick().catch(() => {}); }, Number(process.env.INC_TICK_MS) || 60_000).unref();
app.post('/api/admin/incidents', (req, res) => {
  const b = req.body || {}; if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const room = getRoom(b.room), l = incList(room);
  if (b.seen) { for (const it of l) if (!it.seen && (b.seen === 'all' || it.id === b.seen)) { it.seen = true; it.seenAt = Date.now(); kvSet('inc', room.name + '|' + it.id, it); } }
  if (b.big !== undefined) { const v = Math.round(Number(b.big)); if (v >= 1000 && v <= 100_000_000) { INC.big = v; kvSet('inccfg', 'cfg', { big: v }); } }
  if (b.check) { try { incCheck(room, 'pedido desde Administración'); } catch (e) {} }
  res.json({ ok: true, list: l.slice(0, 200), unseen: l.filter((x) => !x.seen).length, big: INC.big, mail: { on: GM_ON || !!process.env.INC_MAIL_DRY, to: INC_MAIL_TO, last: INC.lastMail, pending: INC.queue.length }, lastCheck: INC.lastCheck.get(room.name) || 0, testRoom: incTest(room) });
});
if (process.env.INC_MAIL_DRY) app.get('/api/admin/incmaillog', (req, res) => res.json({ ok: true, log: INC.mailLog, queue: INC.queue.length }));

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

/* V535 · el servidor no se cae por un error suelto: se anota en el registro y sigue atendiendo */
process.on('unhandledRejection', (e) => { console.warn('aviso: promesa sin manejar (el servidor sigue arriba):', (e && e.stack) || e); });
process.on('uncaughtException', (e) => { console.error('aviso: error no capturado (el servidor sigue arriba):', (e && e.stack) || e); });

/* V535 · mantenerlo despierto: Render (plan gratis) duerme el servicio tras 15 min sin visitas.
   Cada 10 min se visita a sí mismo por la dirección pública. Se apaga con KEEPALIVE=0. */
const SELF_URL = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (SELF_URL && process.env.KEEPALIVE !== '0') {
  setInterval(() => { fetch(SELF_URL + '/health?ka=1', { signal: AbortSignal.timeout(15_000) }).catch(() => {}); }, 10 * 60_000).unref();
}

await Promise.race([dbInit(), new Promise((r) => setTimeout(r, 25_000))]);

/* V607 · consumo del servidor (solo Administración) */
setInterval(() => { try { if (!USE.dirty) return; USE.dirty = false; const keep = Object.keys(USE.days).sort().slice(-35), o = {}; for (const k of keep) o[k] = USE.days[k]; USE.days = o; kvSet('usage', 'all', { since: USE.since, days: o }).catch(() => {}); } catch (e) {} }, 300_000);
app.post('/api/admin/lp', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  if (b.on !== undefined) { LP.on = !!b.on; kvSet('lp', 'cfg', { on: LP.on }).catch(() => {}); console.log('Consulta en espera', LP.on ? 'ENCENDIDA' : 'apagada'); if (!LP.on) for (const r of rooms.values()) if (r.lp) for (const w of [...r.lp]) w(); }
  res.json({ ok: true, on: LP.on });
});
app.post('/api/admin/usage', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, since: USE.since, today: useDay(), days: USE.days, upMin: Math.round(process.uptime() / 60), lp: LP.on });
});

/* V611 · mensajes directos de Administración (advertencia / suspensión / premio / aviso) a una persona o a todos los conductores o pasajeros.
   El texto NO viaja por el bus (lo vería cualquiera): se guarda acá y cada celular lo pide con su propio identificador. Apagado por defecto. */
const NOTE_KINDS = { advertencia: '⚠️ Advertencia', suspension: '🚫 Suspensión', premio: '🏆 Premio', aviso: '📢 Aviso' };
const noteList = (rn) => { let l = NOTE.rooms.get(rn); if (!l) { l = []; NOTE.rooms.set(rn, l); } return l; };
const noteSave = (rn) => { const l = noteList(rn); if (l.length > 300) l.splice(0, l.length - 300); kvSet('notes', rn, { list: l }).catch(() => {}); };
const noteIds = (a) => (Array.isArray(a) ? a : []).map((u) => String(u || '').slice(0, 60)).filter((u) => /^[A-Za-z0-9_.:-]{3,60}$/.test(u)).slice(0, 4);
const noteRate = (req) => { const ip = String(req.ip || ''), now = Date.now(), r = NOTE.rate.get(ip) || { n: 0, t: now }; if (now - r.t > 60000) { r.n = 0; r.t = now; } r.n++; NOTE.rate.set(ip, r); if (NOTE.rate.size > 5000) NOTE.rate.delete(NOTE.rate.keys().next().value); return r.n <= 40; };
app.post('/api/admin/note-cfg', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token)) return res.status(401).json({ ok: false, error: 'admin' });
  if (b.on !== undefined) { NOTE.on = !!b.on; kvSet('notecfg', 'cfg', { on: NOTE.on }).catch(() => {}); console.log('Mensajes directos', NOTE.on ? 'ENCENDIDOS' : 'apagados'); }
  res.json({ ok: true, on: NOTE.on });
});
app.post('/api/admin/note', async (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  if (!NOTE.on) return res.status(409).json({ ok: false, error: 'off' });
  const kind = Object.prototype.hasOwnProperty.call(NOTE_KINDS, b.kind) ? b.kind : '', text = String(b.text || '').trim().slice(0, 500), ids = noteIds(b.ids), all = b.all === 'drv' || b.all === 'pax' ? b.all : '';
  if (!kind || !text || (!ids.length && !all)) return res.status(400).json({ ok: false, error: 'datos' });
  const r = getRoom(b.room), now = Date.now(), note = { id: 'n' + now.toString(36) + crypto.randomBytes(3).toString('hex'), at: now, kind, text, ids, all, read: {} };
  noteList(r.name).push(note); noteSave(r.name);
  const title = NOTE_KINDS[kind] + ' · MOBI', body = text.slice(0, 180), acc = []; let sent = 0, people = ids.length;
  const targets = new Set(ids);
  if (all) { for (const [k, m] of r.sticky) { const d = m && m.data; if (!d || typeof d !== 'object' || !d.id || d.deletedAt) continue;
    if (all === 'pax' ? !(m.type === 'pax-reg' && k.startsWith('pax-reg|pr:')) : !(m.type === 'driver-reg' && k.startsWith('driver-reg|dr:') && d.status === 'aprobado' && !drvHidden(d))) continue; targets.add(String(d.id)); } people = targets.size; }
  try { for (const id of targets) if (pushNotify(id, { title, body }, acc)) sent++; await Promise.all(acc); } catch (e) {}
  try { pushMessage(r, { type: 'note-ping', src: 'server', data: { id: note.id, ids, all } }); } catch (e) {}
  console.log('Mensaje directo', kind, all || ids.join(','), '→', sent, 'con aviso al celular');
  res.json({ ok: true, id: note.id, people, sent });
});
/* V640 · borrar un mensaje directo ya enviado: deja de llegarle a quien todavía no lo leyó */
app.post('/api/admin/note-del', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room), l = noteList(r.name), i = l.findIndex((n) => n.id === String(b.id || ''));
  if (i >= 0) { l.splice(i, 1); noteSave(r.name); }
  res.json({ ok: true, deleted: i >= 0 });
});
app.post('/api/admin/note-list', (req, res) => {
  const b = req.body || {};
  if (!adminOk(b.token) && !sbxOk(b)) return res.status(401).json({ ok: false, error: 'admin' });
  const r = getRoom(b.room);
  res.json({ ok: true, on: NOTE.on, list: noteList(r.name).slice(-60).reverse().map((n) => ({ id: n.id, at: n.at, kind: n.kind, text: n.text, ids: n.ids, all: n.all, read: Object.keys(n.read || {}).length })) });
});
app.post('/api/note/pull', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!noteRate(req)) return res.status(429).json({ ok: false });
  const b = req.body || {}, ids = noteIds(b.ids), roles = (Array.isArray(b.roles) ? b.roles : []).filter((x) => x === 'drv' || x === 'pax');
  if (!NOTE.on || !ids.length) return res.json({ ok: true, on: NOTE.on, notes: [] });
  const r = getRoom(b.room), now = Date.now(), out = [];
  for (const n of noteList(r.name)) {
    if (now - n.at > 30 * 86400_000) continue;
    if (ids.some((i) => n.read && n.read[i])) continue;
    if (!(n.ids.some((i) => ids.includes(i)) || (n.all && roles.includes(n.all)))) continue;
    out.push({ id: n.id, kind: n.kind, text: n.text, at: n.at }); if (out.length >= 5) break;
  }
  res.json({ ok: true, on: true, notes: out });
});
app.post('/api/note/ack', (req, res) => {
  if (!noteRate(req)) return res.status(429).json({ ok: false });
  const b = req.body || {}, ids = noteIds(b.ids), nids = (Array.isArray(b.notes) ? b.notes : []).map((x) => String(x || '').slice(0, 40)).slice(0, 10);
  if (!ids.length || !nids.length) return res.json({ ok: true });
  const r = getRoom(b.room), now = Date.now(); let ch = false;
  for (const n of noteList(r.name)) if (nids.includes(n.id)) { n.read = n.read || {}; for (const i of ids) if (!n.read[i] && Object.keys(n.read).length < 3000) { n.read[i] = now; ch = true; } }
  if (ch) noteSave(r.name);
  res.json({ ok: true });
});
app.listen(PORT, () => console.log(`MOBI-SERVER v5 escuchando en el puerto ${PORT} · base de datos: ${dbState}`));
/* al apagar, guardar lo pendiente */
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { for (let i = 0; i < 50 && flushing; i++) await new Promise((r) => setTimeout(r, 100)); for (const [k, v] of dirtySlow) dirty.set(k, v); await flushSticky(); } catch (e) {} process.exit(0); });
