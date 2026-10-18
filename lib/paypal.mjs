// Minimal PayPal REST client for the Judge's source of truth and for driving a sandbox checkout.
// Read-first by design: the auditor never moves real money; it reads PayPal's own records to
// confirm whether a demo shop's integration mistake actually mis-settled an order.

const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

let cached = { token: "", exp: 0 };

export async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set (see .env.example)");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token: ${res.status} ${JSON.stringify(json)}`);
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// A sandbox card lets the spike run headless (no buyer redirect): with a card payment_source
// and intent CAPTURE, PayPal processes the payment inline and returns a COMPLETED order.
export const SANDBOX_CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

export const createOrder = (amount, { currency = "USD", intent = "CAPTURE", card } = {}) =>
  call(
    "POST",
    "/v2/checkout/orders",
    {
      intent,
      purchase_units: [{ amount: { currency_code: currency, value: amount } }],
      ...(card ? { payment_source: { card: { ...card, name: "Test Buyer" } } } : {}),
    },
    // Processing a payment inline requires an idempotency key.
    card ? { "PayPal-Request-Id": crypto.randomUUID() } : {},
  );

// The Judge reads these back from PayPal, never trusting the shop's own record.
export const getOrder = (id) => call("GET", `/v2/checkout/orders/${id}`);
export const captureOrder = (id) => call("POST", `/v2/checkout/orders/${id}/capture`, {});
export const getCapture = (id) => call("GET", `/v2/payments/captures/${id}`);

// The forged-webhook check: PayPal itself says whether an event's signature is genuine. PayPal
// checks against the event as delivered, so a known raw body is spliced in byte-for-byte;
// re-serializing the parsed event can change its bytes and fail a genuine delivery.
export function verifyWebhook(headers, event, rawBody) {
  const fields = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
  };
  const body = rawBody ? `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}` : { ...fields, webhook_event: event };
  return call("POST", "/v1/notifications/verify-webhook-signature", body);
}

// Where PayPal posts this app's events; the server checks it points here before waiting on it.
export const getWebhook = (id) => call("GET", `/v1/notifications/webhooks/${id}`);
