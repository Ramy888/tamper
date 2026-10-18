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
