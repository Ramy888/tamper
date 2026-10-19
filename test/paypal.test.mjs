import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhook, createOrder, SANDBOX_CARD } from "../lib/paypal.mjs";

const H = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "c2ln",
  "paypal-transmission-time": "2026-10-18T12:00:00Z",
};

// PayPal checks the signature against the event as delivered. Re-serializing a parsed event can
// change its bytes (here the é escape would become a literal é), so the raw body goes in as is.
test("verifyWebhook sends the delivered event byte-for-byte", async () => {
  Object.assign(process.env, { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WH-ID" });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init.body });
    const json = String(url).includes("oauth2") ? { access_token: "t", expires_in: 3600 } : { verification_status: "SUCCESS" };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  try {
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","summary":"Caf\\u00e9 $30.00","resource":{"id":"CAP-1"}}';
    const res = await verifyWebhook(H, JSON.parse(raw), raw);
    assert.equal(res.verification_status, "SUCCESS");
    const body = sent.find((s) => s.url.includes("verify-webhook-signature")).body;
    assert.ok(body.includes(`"webhook_event":${raw}`), "raw delivery spliced in unchanged");
    const parsed = JSON.parse(body);
    assert.equal(parsed.webhook_id, "WH-ID");
    assert.equal(parsed.transmission_id, "tx-1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The agent-retry fix: the cart's own id goes to PayPal as the idempotency key, so a retried
// checkout gets PayPal's same order back instead of a second charge.
test("createOrder sends the request id it is given", async () => {
  Object.assign(process.env, { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers });
    const json = String(url).includes("oauth2") ? { access_token: "t", expires_in: 3600 } : { id: "ORD-1", status: "COMPLETED" };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  try {
    await createOrder("5.00", { card: SANDBOX_CARD, requestId: "tamper-cart-1" });
    const order = sent.find((s) => s.url.endsWith("/v2/checkout/orders"));
    assert.equal(order.headers["PayPal-Request-Id"], "tamper-cart-1");
  } finally {
    globalThis.fetch = realFetch;
  }
});
