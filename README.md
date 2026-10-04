# MOBI-SERVER

Backend base for MOBI.

Includes:
- health check
- GPS position update/read endpoints for the prototype
- Mercado Pago Checkout API Orders endpoint in manual mode
- private Mercado Pago Access Token kept on the server

## Local

```bash
npm install
MP_ACCESS_TOKEN="YOUR_TEST_ACCESS_TOKEN" npm start
```

## Render

Build command: `npm install`
Start command: `npm start`

Environment variable:
`MP_ACCESS_TOKEN` = Mercado Pago test Access Token.

Never put the real Access Token in GitHub or in the MOBI HTML.
