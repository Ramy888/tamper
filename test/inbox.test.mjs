import { test } from "node:test";
import assert from "node:assert/strict";
import { makeInbox, MAX_BODY } from "../lib/inbox.mjs";

const H = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "c2ln",
  "paypal-transmission-time": "2026-10-18T12:00:00Z",
  "content-type": "application/json",
};
const body = (captureId, type = "PAYMENT.CAPTURE.COMPLETED", extra = {}) =>
  JSON.stringify({ id: `WH-${captureId}`, event_type: type, resource: { id: captureId }, ...extra });

test("stores a PayPal capture delivery with its signature headers and raw body", () => {
  const inbox = makeInbox();
  const raw = body("CAP-1");
  assert.equal(inbox.accept(H, raw), true);
  const got = inbox.find("CAP-1");
  assert.equal(got.rawBody, raw, "raw body kept byte-for-byte for signature diagnosis");
  assert.equal(got.paypalHeaders["paypal-transmission-id"], "tx-1");
  assert.equal(got.paypalHeaders["content-type"], undefined, "only PayPal's signature headers are kept");
});

test("an oversized body stores nothing", () => {
  const inbox = makeInbox();
  assert.equal(inbox.accept(H, body("CAP-1", undefined, { pad: "x".repeat(MAX_BODY) })), false);
  assert.equal(inbox.size, 0);
});

test("non-capture events, bad JSON and missing PayPal headers store nothing", () => {
  const inbox = makeInbox();
  assert.equal(inbox.accept(H, body("CAP-1", "CHECKOUT.ORDER.APPROVED")), false);
  assert.equal(inbox.accept(H, "{not json"), false);
  const { "paypal-transmission-sig": _, ...unsigned } = H;
  assert.equal(inbox.accept(unsigned, body("CAP-2")), false);
  assert.equal(inbox.size, 0);
});

test("keeps only the most recent deliveries", () => {
  const inbox = makeInbox({ keep: 3 });
  for (let i = 1; i <= 5; i++) inbox.accept(H, body(`CAP-${i}`));
  assert.equal(inbox.size, 3);
  assert.equal(inbox.find("CAP-1"), null);
  assert.ok(inbox.find("CAP-5"));
});

test("waitFor resolves when PayPal's delivery arrives later", async () => {
  const inbox = makeInbox();
  setTimeout(() => inbox.accept(H, body("CAP-9")), 10);
  const got = await inbox.waitFor("CAP-9", 1000);
  assert.equal(got.event.resource.id, "CAP-9");
});

test("waitFor gives up with null after the timeout", async () => {
  const inbox = makeInbox();
  assert.equal(await inbox.waitFor("CAP-never", 20), null);
});
