# MOBI · piloto multidispositivo

Archivos en la RAÍZ del repositorio de GitHub: `index.html`, `server.js`, `package.json`.

## Render (Web Service)
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: `MP_ACCESS_TOKEN` = Access Token PRIVADO de Mercado Pago (nunca en el HTML). Opcional: `MP_PUBLIC_KEY`, `ALLOWED_ORIGIN`.
- Abrir la app SIEMPRE desde la URL de Render (ej. `https://mobi.onrender.com`). Todos los teléfonos comparten la sala `pilot`.
  Para separar grupos de prueba: `https://mobi.onrender.com/?room=prueba2`.

## Notas
- El estado vive en memoria: si Render reinicia o duerme el servicio (plan gratis) se pierde.
- Sin servidor (abriendo el HTML suelto) funciona en modo local de un solo dispositivo.
- OSRM público no es para uso comercial; Waze no se puede cerrar desde una web; el GPS en segundo plano requiere app (Capacitor).
