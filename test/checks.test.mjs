import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS } from "../lib/checks.mjs";
import { makeShop, makeWeakShop, makeSecureShop } from "../shop/shop.mjs";
import { makeInbox } from "../lib/inbox.mjs";
import { makeFakePayPal, captureEvent } from "./helpers/fake-paypal.mjs";

const CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

for (const check of CHECKS) {
  test(`${check.id}: the weak shop is vulnerable`, async () => {
    const pp = makeFakePayPal();
    const res = await check.run({ shop: makeWeakShop(pp), pp, card: CARD });
    assert.equal(res.confirmed, true, `${check.id} should confirm on the weak shop`);
    assert.ok(res.proofIds.length > 0, "a finding carries PayPal proof ids");
  });

  test(`${check.id}: the secure shop is not`, async () => {
    const pp = makeFakePayPal();
    const res = await check.run({ shop: makeSecureShop(pp), pp, card: CARD });
    assert.equal(res.confirmed, false, `${check.id} must not confirm after the fix`);
  });
}

test("every check names a concrete code-level flaw for the Patcher", () => {
  for (const c of CHECKS) assert.ok(c.flaw && c.flaw.length > 10, `${c.id} needs a flaw description`);
});

// The replay check, hosted: PayPal posts a real signed PAYMENT.CAPTURE.COMPLETED to the inbox
// and the check replays THAT event. Without a delivery it falls back to a synthetic one and
// must say so — the report never implies a PayPal-signed replay it didn't do.
const replay = CHECKS.find((c) => c.id === "webhook_replay");

// A fake PayPal that "delivers" each capture's webhook to the inbox a moment later.
function deliveringPayPal(inbox, headersFor = (pp) => pp.sign()) {
  const pp = makeFakePayPal({
    onCapture: (c) => setTimeout(() => inbox.accept(headersFor(pp), JSON.stringify(captureEvent(c))), 5),
  });
  return pp;
}

test("webhook_replay replays PayPal's own signed delivery when one arrives", async () => {
  const inbox = makeInbox();
  const pp = deliveringPayPal(inbox);
  const notes = [];
  const res = await replay.run({ shop: makeWeakShop(pp), pp, card: CARD, inbox, waitMs: 500, note: (n) => notes.push(n) });
  assert.equal(res.confirmed, true);
  assert.equal(res.signedReplay, true);
  assert.match(res.proofIds.join(" "), /PayPal-signed/);
  assert.ok(notes.some((n) => /waiting/i.test(n)), "the wait for PayPal is visible in the log");
});

test("webhook_replay without a delivery falls back to a synthetic event, and says so", async () => {
  const pp = makeFakePayPal();
  const res = await replay.run({ shop: makeWeakShop(pp), pp, card: CARD, inbox: makeInbox(), waitMs: 20 });
  assert.equal(res.confirmed, true);
  assert.equal(res.signedReplay, false);
  assert.match(res.proofIds.join(" "), /synthetic/);
});

test("a delivery PayPal does not verify is never presented as signed", async () => {
  const inbox = makeInbox();
  const forged = { "paypal-auth-algo": "x", "paypal-cert-url": "x", "paypal-transmission-id": "forged", "paypal-transmission-sig": "x", "paypal-transmission-time": "x" };
  const pp = deliveringPayPal(inbox, () => forged);
  const res = await replay.run({ shop: makeWeakShop(pp), pp, card: CARD, inbox, waitMs: 500 });
  assert.equal(res.signedReplay, false);
  assert.match(res.proofIds.join(" "), /synthetic/);
});

test("a genuine replayed event beats a signature check alone; only dedupe stops it", async () => {
  const inbox = makeInbox();
  const pp = deliveringPayPal(inbox);
  const sigOnly = await replay.run({ shop: makeShop({ verifyWebhookSig: true }, pp), pp, card: CARD, inbox, waitMs: 500 });
  assert.equal(sigOnly.signedReplay, true);
  assert.equal(sigOnly.confirmed, true, "PayPal signs the replay too, so verifying alone still double-credits");
  const deduped = await replay.run({ shop: makeShop({ dedupeCaptures: true }, pp), pp, card: CARD, inbox, waitMs: 500 });
  assert.equal(deduped.confirmed, false);
});

test("if PayPal's signature check errors, the replay falls back (labelled) instead of aborting", async () => {
  const inbox = makeInbox();
  const pp = deliveringPayPal(inbox);
  pp.verifyWebhook = async () => {
    throw new Error("POST /v1/notifications/verify-webhook-signature: 503");
  };
  const notes = [];
  const res = await replay.run({ shop: makeWeakShop(pp), pp, card: CARD, inbox, waitMs: 500, note: (n) => notes.push(n) });
  assert.equal(res.signedReplay, false);
  assert.match(res.proofIds.join(" "), /synthetic/);
  assert.ok(notes.some((n) => /503/.test(n)), "the PayPal error is shown, not swallowed");
});

test("a shop that credits nothing is inconclusive for replay, not 'fixed'", async () => {
  const pp = makeFakePayPal();
  // Signature checking on, and the stand-in event fails PayPal's check, as it does live.
  const res = await replay.run({ shop: makeShop({ verifyWebhookSig: true }, pp), pp, card: CARD, genuineHeaders: {} });
  assert.equal(res.confirmed, false);
  assert.equal(res.inconclusive, true);
});

test("the audit runs six checks, the agent checkout two among them", () => {
  assert.deepEqual(CHECKS.map((c) => c.id), ["amount_mismatch", "browser_trusted_paid", "unverified_webhook", "webhook_replay", "agent_price", "agent_retry"]);
});

// The agent checks: an AI assistant drives the shop through its agent tools. Each new check has
// its own fix switch, and the switches that fix the older checks must not pass these.
const agentPrice = CHECKS.find((c) => c.id === "agent_price");
const agentRetry = CHECKS.find((c) => c.id === "agent_retry");

test("agent_price: only taking prices from the catalog fixes it; reading PayPal's capture back does not", async () => {
  const pp = makeFakePayPal();
  const readBack = await agentPrice.run({ shop: makeShop({ verifyBeforeShip: true }, pp), pp, card: CARD });
  assert.equal(readBack.confirmed, true, "PayPal really captured the assistant's $1.00, so a read-back still ships the $49 item");
  const catalog = await agentPrice.run({ shop: makeShop({ priceFromCatalog: true }, pp), pp, card: CARD });
  assert.equal(catalog.confirmed, false);
  assert.match(catalog.truth, /PayPal captured \$49\.00/);
});

test("agent_retry: only one PayPal order per cart fixes it; de-duplicating webhooks does not", async () => {
  const pp = makeFakePayPal();
  const deduped = await agentRetry.run({ shop: makeShop({ dedupeCaptures: true }, pp), pp, card: CARD });
  assert.equal(deduped.confirmed, true, "two separate orders both capture, whatever the webhook handler does");
  assert.equal(deduped.proofIds.length, 2);
  const fixed = await agentRetry.run({ shop: makeShop({ idempotentCheckout: true }, pp), pp, card: CARD });
  assert.equal(fixed.confirmed, false);
  assert.equal(fixed.proofIds.length, 1, "PayPal returned the same order for the retried request");
});

test("the shop's agent tools are shaped like WebMCP tools", () => {
  const tools = makeShop({}, makeFakePayPal()).agentTools();
  assert.deepEqual(tools.map((t) => t.name), ["search_products", "add_to_cart", "start_checkout", "fulfill_cart"]);
  for (const t of tools) {
    assert.ok(t.description.length > 10, `${t.name} describes itself`);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.execute, "function");
  }
});
