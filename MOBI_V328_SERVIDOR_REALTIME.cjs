
/*
 * MOBI V328 — servidor central de tiempo real
 *
 * Integración:
 *   const { attachMobiRealtime } = require('./MOBI_V328_SERVIDOR_REALTIME.cjs');
 *   const server = http.createServer(app);
 *   attachMobiRealtime(server);
 *   server.listen(PORT);
 *
 * Requiere:
 *   npm install ws
 *
 * Endpoint WebSocket:
 *   wss://TU-DOMINIO-RENDER/ws
 *
 * Este módulo NO reemplaza el servidor actual de MOBI: se acopla al
 * http.Server existente. Mantiene los viajes activos en memoria y conecta
 * todos los teléfonos que tengan V328 abierto.
 */

'use strict';

const WebSocket = require('ws');

function attachMobiRealtime(httpServer, options = {}) {
  if (!httpServer) throw new Error('MOBI realtime: falta el http.Server');

  const path = options.path || '/ws';
  const wss = new WebSocket.Server({ server: httpServer, path });

  const clients = new Map(); // ws -> {deviceId, role, online, gps, lastSeen}
  const trips = new Map();   // tripId -> canonical trip

  const TRIP_TTL_MS = Number(options.tripTtlMs || 2 * 60 * 60 * 1000);
  const PING_MS = 30000;

  function now() { return Date.now(); }

  function send(ws, type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type, at: now(), data: data || null }));
    } catch (_) {}
  }

  function broadcast(type, data, predicate) {
    for (const [ws, meta] of clients) {
      if (predicate && !predicate(meta, ws)) continue;
      send(ws, type, data);
    }
  }

  function safeTrip(trip) {
    if (!trip) return null;
    const copy = JSON.parse(JSON.stringify(trip));
    delete copy._rejectedBy;
    delete copy._excludedDrivers;
    return copy;
  }

  function driverAvailable(meta) {
    return meta &&
      meta.role === 'driver' &&
      meta.online !== false &&
      meta.wsReady !== false;
  }

  function sendOffersForTrip(trip, excludeDeviceId) {
    if (!trip || trip.cancelled || trip.claimedBy) return;
    for (const [ws, meta] of clients) {
      if (!driverAvailable(meta)) continue;
      if (meta.deviceId === excludeDeviceId) continue;
      if (trip._rejectedBy && trip._rejectedBy.has(meta.deviceId)) continue;
      if (trip._excludedDrivers && trip._excludedDrivers.has(meta.deviceId)) continue;
      send(ws, 'trip:offer', { trip: safeTrip(trip) });
    }
  }

  function canonicalFromIncoming(data, existing) {
    const incoming = data && data.trip;
    if (!incoming || !incoming.id) return existing || null;

    const base = existing || {};
    const merged = {
      ...base,
      ...incoming,
      id: String(incoming.id),
      updatedAt: now()
    };

    if (!base.started) merged.started = Number(incoming.started || now());
    if (!base._rejectedBy) base._rejectedBy = new Set();
    if (!base._excludedDrivers) base._excludedDrivers = new Set();
    merged._rejectedBy = base._rejectedBy;
    merged._excludedDrivers = base._excludedDrivers;
    return merged;
  }

  function sendSnapshot(ws, meta) {
    const list = [];
    if (meta.role === 'driver') {
      for (const trip of trips.values()) {
        if (trip.cancelled || trip.claimedBy) continue;
        if (trip._rejectedBy && trip._rejectedBy.has(meta.deviceId)) continue;
        if (trip._excludedDrivers && trip._excludedDrivers.has(meta.deviceId)) continue;
        list.push(safeTrip(trip));
      }
    }
    send(ws, 'hello:ok', { trips: list, connectedDrivers: countDrivers() });
  }

  function countDrivers() {
    let n = 0;
    for (const [, meta] of clients) if (driverAvailable(meta)) n++;
    return n;
  }

  function tripFor(id) {
    return trips.get(String(id || ''));
  }

  function handleMessage(ws, meta, msg) {
    const type = String(msg?.type || '');
    const data = msg?.data || {};

    meta.lastSeen = now();

    if (type === 'hello') {
      meta.deviceId = String(msg.deviceId || data.deviceId || meta.deviceId || '');
      meta.role = msg.role === 'driver' ? 'driver' : 'passenger';
      meta.wsReady = true;
      sendSnapshot(ws, meta);
      return;
    }

    if (type === 'heartbeat') {
      if (data.role === 'driver') meta.role = 'driver';
      if (data.role === 'passenger') meta.role = 'passenger';
      return;
    }

    if (type === 'driver:presence') {
      meta.role = 'driver';
      meta.online = data.online !== false;
      meta.gps = data.gps || null;
      meta.lastSeen = now();
      send(ws, 'presence:ok', { online: meta.online, connectedDrivers: countDrivers() });
      return;
    }

    if (type === 'trip:sync') {
      const incoming = data.trip;
      if (!incoming?.id) return;

      const id = String(incoming.id);
      let trip = tripFor(id);

      // El primer "sync" del pasajero crea la solicitud central.
      trip = canonicalFromIncoming(data, trip);
      if (!trip) return;

      if (!trip.passengerDevice) trip.passengerDevice = meta.deviceId;
      if (meta.role === 'passenger') trip.passengerDevice = meta.deviceId;
      trip.updatedAt = now();
      trips.set(id, trip);

      if (trip.status === 'Esperando conductor' ||
          trip.status === 'Buscando conductores' ||
          trip.status === 'Solicitud rechazada') {
        sendOffersForTrip(trip);
      }

      // Mantiene al pasajero actualizado si se reconecta.
      if (trip.passengerDevice) {
        broadcast('trip:sync', { trip: safeTrip(trip) },
          m => m.deviceId === trip.passengerDevice);
      }
      return;
    }

    if (type === 'trip:accept') {
      const incoming = data.trip;
      if (!incoming?.id) return;
      const id = String(incoming.id);
      let trip = tripFor(id) || canonicalFromIncoming(data, null);
      if (!trip) return;

      // Primer conductor que acepta gana.
      if (trip.claimedBy && trip.claimedBy !== meta.deviceId) {
        send(ws, 'trip:accepted', { trip: safeTrip(trip) });
        return;
      }

      trip.claimedBy = meta.deviceId;
      trip.claimedAt = now();
      trip.driverDevice = meta.deviceId;
      trip.status = 'Conductor en camino';
      trip.acceptedAt = now();
      trip.updatedAt = now();
      trips.set(id, trip);

      const out = { trip: safeTrip(trip) };
      broadcast('trip:accepted', out);
      return;
    }

    if (type === 'trip:reject') {
      const incoming = data.trip;
      if (!incoming?.id) return;
      const id = String(incoming.id);
      let trip = tripFor(id);
      if (!trip) trip = canonicalFromIncoming(data, null);
      if (!trip) return;

      trip._rejectedBy = trip._rejectedBy || new Set();
      trip._rejectedBy.add(meta.deviceId);
      trip.updatedAt = now();
      trips.set(id, trip);

      // Solo confirmamos al conductor que rechazó.
      send(ws, 'trip:rejected', { trip: safeTrip(trip) });

      // Los demás conductores siguen viendo el viaje.
      sendOffersForTrip(trip, meta.deviceId);
      return;
    }

    if (type === 'trip:cancel') {
      const incoming = data.trip;
      if (!incoming?.id) return;
      const id = String(incoming.id);
      let trip = tripFor(id) || canonicalFromIncoming(data, null);
      if (!trip) return;

      trip.status = 'Viaje cancelado por el pasajero';
      trip.cancelled = true;
      trip.cancelledBy = 'passenger';
      trip.cancelledAt = now();
      trip.claimedBy = null;
      trip.updatedAt = now();
      trips.set(id, trip);

      broadcast('trip:cancelled', { trip: safeTrip(trip) });
      return;
    }

    if (type === 'trip:driver-cancel') {
      const incoming = data.trip;
      if (!incoming?.id) return;
      const id = String(incoming.id);
      let trip = tripFor(id) || canonicalFromIncoming(data, null);
      if (!trip) return;

      trip._excludedDrivers = trip._excludedDrivers || new Set();
      trip._excludedDrivers.add(meta.deviceId);
      trip._rejectedBy = trip._rejectedBy || new Set();
      trip.claimedBy = null;
      trip.driverDevice = null;
      trip.claimedAt = null;
      trip.acceptedAt = null;
      trip.status = 'Esperando conductor';
      trip.cancelled = false;
      trip.cancelledBy = null;
      trip.updatedAt = now();
      trips.set(id, trip);

      // Pasajero vuelve a búsqueda.
      broadcast('trip:driver-cancelled', { trip: safeTrip(trip) });

      // Y la solicitud vuelve a estar disponible para los demás conductores.
      sendOffersForTrip(trip, meta.deviceId);
      return;
    }
  }

  wss.on('connection', (ws) => {
    const meta = {
      deviceId: '',
      role: 'passenger',
      online: false,
      gps: null,
      wsReady: true,
      lastSeen: now()
    };

    clients.set(ws, meta);

    send(ws, 'server:ready', {
      version: 'MOBI-V328',
      connectedDrivers: countDrivers()
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      try { handleMessage(ws, meta, msg); } catch (err) {
        send(ws, 'server:error', { message: 'Error procesando solicitud MOBI.' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  const timer = setInterval(() => {
    const cutoff = now() - TRIP_TTL_MS;

    for (const [id, trip] of trips) {
      if (Number(trip.updatedAt || trip.started || 0) < cutoff) {
        trips.delete(id);
      }
    }

    for (const [ws, meta] of clients) {
      if (now() - Number(meta.lastSeen || 0) > 90000) {
        try { ws.terminate(); } catch (_) {}
        clients.delete(ws);
      } else {
        try { ws.ping(); } catch (_) {}
      }
    }
  }, PING_MS);

  // Evita que el proceso conserve referencias si el servidor se desmonta.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    wss,
    clients,
    trips,
    path,
    connectedDrivers: countDrivers
  };
}

module.exports = { attachMobiRealtime };
