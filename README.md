# Meta Webhook Gateway

Durable Meta webhook ingress and broadcaster for WhatsApp and Instagram. The API verifies Meta signatures and commits events plus delivery jobs to PostgreSQL before returning `200`. A separate worker forwards events with bounded retries and dead-letter status.

## Runtime flow

```text
Meta -> POST /hooks/meta/{provider}/{publicKey}
     -> verify X-Hub-Signature-256 against the raw body
     -> scope each Meta entry/change
     -> store WebhookEvent + one Delivery per matching active destination atomically
     -> 200

Worker -> claim deliveries with FOR UPDATE SKIP LOCKED
       -> POST scoped Meta payload to each destination
       -> delivered / retry / dead
```

Every accepted WhatsApp or Instagram event is broadcast to all active destinations with the same `type`. Each Meta entry/change is scoped before delivery so downstream receivers get the smallest relevant payload.

## Local setup

Requirements: Bun 1.3+, PostgreSQL, and optionally Docker Desktop.

```bash
bun install
cp .env.example .env
docker compose up -d
bun run db:generate
bun run db:deploy
bun run build
```

Generate the encryption key with `openssl rand -base64 32`. Replace `ADMIN_API_KEY` with a long random value.

Run the API and worker in separate terminals:

```bash
bun run start:prod
bun run start:worker
```

Development commands:

```bash
bun run start:dev
bun run worker:dev
bun run test
bun run lint
```

## Bootstrap configuration

All management calls require `X-Admin-Api-Key`.

Create one endpoint per Meta App/provider combination:

```http
POST /v1/admin/endpoints
X-Admin-Api-Key: <ADMIN_API_KEY>
Content-Type: application/json

{
  "name":"Meta WhatsApp",
  "provider":"whatsapp",
  "verifyToken":"the-token-entered-in-meta",
  "appSecret":"the-meta-app-secret"
}
```

For Instagram, use `"provider":"instagram"`. The response contains `callbackPath`, for example:

```text
/hooks/meta/whatsapp/88c03d5e-...
/hooks/meta/instagram/a99d82aa-...
```

Create a destination for either WhatsApp or Instagram:

```http
POST /v1/admin/destinations

{
  "type":"whatsapp",
  "name":"chat-ai",
  "url":"https://chat-ai.example.com/webhook/whatsapp",
  "timeoutMs":10000
}
```

Supported destination types are `whatsapp` and `instagram`. Add more destinations by repeating the request; each webhook is sent to every active destination whose type matches its provider.

## Delivery contract

Destinations receive the original scoped Meta JSON with these headers:

```text
X-Webhook-Provider
X-Webhook-Event-Id
X-Webhook-Delivery-Id
X-Webhook-Timestamp
X-Webhook-Signature: v1=<hex-hmac>   # when a signingSecret is configured
```

The destination signature is:

```text
HMAC-SHA256(signingSecret, timestamp + "." + rawBody)
```

Delivery behavior:

- HTTP `2xx`: delivered
- HTTP `408`, `429`, `5xx`, timeout, or network error: exponential retry with jitter
- Other HTTP responses: dead-letter
- Default maximum attempts: 8
- Redirects are not followed
- Duplicate Meta payloads do not create duplicate deliveries

List events and deliveries:

```text
GET /v1/admin/events?limit=50
GET /v1/admin/deliveries?limit=50
POST /v1/admin/deliveries/<id>/replay
```

Activate or deactivate configuration:

```http
PATCH /v1/admin/{endpoints|destinations}/<id>/active

{"isActive":false}
```

## Destination security

Private, loopback, link-local, and reserved destination addresses are blocked by default. Internal services must be explicitly listed in `DESTINATION_HOST_ALLOWLIST`; HTTP destinations additionally require `ALLOW_HTTP_DESTINATIONS=true`.

Endpoint verify tokens, Meta app secrets, destination signing secrets, and custom headers are encrypted with AES-256-GCM. Secret values are never returned by management APIs.

For the zero-code `chat-ai` integration, restrict its public `/webhook/whatsapp` or `/webhook/facebook` route at the reverse proxy so only the gateway can call it. Disable migrated WhatsApp/Instagram forwarders in `chat-ai` to avoid duplicate forwarding.

## Health

```text
GET /health/live
GET /health/ready
```

`ready` verifies PostgreSQL connectivity.
