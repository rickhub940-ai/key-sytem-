# Render realtime gateway

This is a standalone WebSocket service for loader lifecycle status and optional server-to-client commands. It does not use `identifyExecutor` and does not contact Luarmor hosts.

## Render deployment

1. Push this repository to the Git provider connected to Render.
2. In Render, create a Blueprint from the repository-root `render.yaml`, or create a Node Web Service with:
   - Root Directory: `realtime-render`
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Set two distinct secrets in Render:
   - `REALTIME_TICKET_SECRET`: at least 32 characters; share only with the future key/API service.
   - `SOCKET_ADMIN_TOKEN`: at least 32 characters; protects `/admin/command`.
4. After Render creates the public host, set the future API variables:

```text
REALTIME_WS_URL=wss://your-render-service.onrender.com/realtime
REALTIME_TICKET_SECRET=<the identical Render value>
```

The API must issue a short-lived HMAC realtime ticket only after normal key/HWID verification. The gateway then verifies the ticket, HWID hash, and script name before accepting a client socket.

## Protocol

Client authentication:

```json
{"type":"authenticate","token":"<ticket>","hwid":"<hwid>","scriptName":"main"}
```

After authentication the client may send `heartbeat` and bounded `status` messages. The optional admin endpoint supports `notice`, `reauth`, and `disconnect` commands for a connected ticket ID.

The client helper is `client.lua`. It feature-detects available WebSocket APIs without checking executor identity. If WebSocket support is unavailable, it returns a compatibility state rather than disconnecting the user.

## Run locally

A local `.env` is initialized for this workspace and is excluded from Git. Start the gateway with:

```bash
cd realtime-render
npm install
npm run dev
```

It listens on `http://localhost:10000` and the WebSocket endpoint is `ws://localhost:10000/realtime`. Verify it at `http://localhost:10000/health`.

Keep the same `REALTIME_TICKET_SECRET` in the future API and the Render service. Do not commit `.env` or publish either secret.

## Local test

```bash
cd realtime-render
npm test
```
