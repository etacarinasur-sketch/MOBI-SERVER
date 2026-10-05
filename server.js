import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import http from 'node:http';
import realtime from './MOBI_V328_SERVIDOR_REALTIME.cjs';

const { attachMobiRealtime } = realtime;

const app = express();
const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Temporary in-memory GPS store for the prototype.
// Later this can be replaced by a database without changing the MOBI frontend contract.
const gps = new Map();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MOBI-SERVER', mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN) });
});

app.post('/api/gps/update', (req, res) => {
  const { driverId, passengerId, lat, lng, accuracy, heading, speed, timestamp } = req.body || {};
  const ownerId = driverId || passengerId;

  if (!ownerId || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return res.status(400).json({ ok: false, error: 'driverId/passengerId, lat and lng are required' });
  }

  const position = {
    lat: Number(lat),
    lng: Number(lng),
    accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
    heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
    speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
    timestamp: timestamp || new Date().toISOString()
  };

  gps.set(String(ownerId), position);
  res.json({ ok: true, id: String(ownerId), position });
});

app.get('/api/gps/:id', (req, res) => {
  const position = gps.get(String(req.params.id));
  if (!position) return res.status(404).json({ ok: false, error: 'Position not found' });
  res.json({ ok: true, id: String(req.params.id), position });
});

// Creates a Checkout API Orders order in manual mode.
// The private Access Token stays only on the server.
// The frontend receives only orderId/clientToken.
app.post('/api/mercadopago/order', async (req, res) => {
  if (!MP_ACCESS_TOKEN) {
    return res.status(503).json({ ok: false, error: 'MP_ACCESS_TOKEN is not configured on the server' });
  }

  const { amount, externalReference, payerEmail } = req.body || {};
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
  }

  const reference = String(externalReference || `mobi_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const amountString = numericAmount.toFixed(2);

  const payload = {
    type: 'online',
    processing_mode: 'manual',
    total_amount: amountString,
    external_reference: reference,
    payer: {
      email: String(payerEmail || 'test@testuser.com')
    },
    items: [
      {
        title: 'Viaje MOBI',
        quantity: 1,
        unit_price: amountString
      }
    ]
  };

  try {
    const response = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: 'Mercado Pago rejected the order', details: data });
    }

    res.status(201).json({
      ok: true,
      orderId: data.id,
      clientToken: data.client_token,
      status: data.status,
      totalAmount: data.total_amount
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: 'Could not reach Mercado Pago', details: error.message });
  }
});

app.get('/api/mercadopago/order/:id', async (req, res) => {
  if (!MP_ACCESS_TOKEN) {
    return res.status(503).json({ ok: false, error: 'MP_ACCESS_TOKEN is not configured on the server' });
  }

  try {
    const response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(req.params.id)}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ ok: false, error: 'Could not reach Mercado Pago', details: error.message });
  }
});

const server = http.createServer(app);
attachMobiRealtime(server, { path: '/ws' });

server.listen(PORT, () => {
  console.log(`MOBI-SERVER listening on port ${PORT}`);
  console.log('MOBI realtime WebSocket listening on /ws');
});
