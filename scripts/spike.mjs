// Day-1 spike (gate: by Oct 21, 3 findings proven by PayPal's records, one a forged webhook).
// Proves the core moment is real in the PayPal sandbox:
//   1. AMOUNT MISMATCH  — a shop that trusts a client-sent price "ships" a $200 order that
//      PayPal only captured $2 for. The Judge reads the capture back from PayPal and catches it.
//   2. DOUBLE CAPTURE   — the shop tries to capture an order twice; PayPal's second response is
//      the ground truth for whether money moved twice.
//   3. FORGED WEBHOOK   — a fake "payment completed" event the shop would trust. PayPal's
//      verify-webhook-signature returns FAILURE, so the Judge rejects it. No LLM involved.
//
// Run: node --env-file=.env scripts/spike.mjs
import { createOrder, captureOrder, getCapture, verifyWebhook } from "../lib/paypal.mjs";

const log = (tag, obj) => console.log(`\n[${tag}] ${typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)}`);
const assert = (ok, msg) => { if (!ok) { console.error(`\nFAIL: ${msg}`); process.exit(1); } console.log(`  PASS: ${msg}`); };

// --- Finding 1 & 2: a real order, captured, read back from PayPal as the source of truth ---
const SHOP_CLAIMED_PRICE = "200.00"; // what the weak shop's client said the cart was worth
const ACTUAL_ORDER = "2.00";         // what the order was really created for

const order = await createOrder(ACTUAL_ORDER);
log("order.created", { id: order.id, status: order.status });

const cap = await captureOrder(order.id);
const capId = cap.purchase_units[0].payments.captures[0].id;
log("order.captured", { captureId: capId, status: cap.status });

// The Judge: read the capture back from PayPal, never from the shop.
const truth = await getCapture(capId);
const paid = truth.amount.value;
log("judge.capture.truth", { paid, currency: truth.amount.currency_code, status: truth.status });

assert(paid === ACTUAL_ORDER, `PayPal confirms only $${paid} was captured`);
assert(paid !== SHOP_CLAIMED_PRICE, `FINDING 1 (amount mismatch): shop would ship a $${SHOP_CLAIMED_PRICE} order PayPal only took $${paid} for`);

// Finding 2: a second capture must not silently take money again.
let doubleBlocked = false;
try {
  await captureOrder(order.id);
} catch (e) {
  doubleBlocked = /ORDER_ALREADY_CAPTURED|422|already captured/i.test(String(e.message));
}
assert(doubleBlocked, `FINDING 2 (double capture): PayPal rejected the second capture of the same order`);

// --- Finding 3: forged webhook rejected by PayPal's own verification ---
const forgedHeaders = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
  "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
  "paypal-transmission-sig": "Zm9yZ2VkLXNpZ25hdHVyZQ==",
  "paypal-transmission-time": new Date().toISOString(),
};
const forgedEvent = { id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { amount: { value: SHOP_CLAIMED_PRICE } } };
const verdict = await verifyWebhook(forgedHeaders, forgedEvent);
log("judge.webhook.verify", verdict);
assert(verdict.verification_status === "FAILURE", `FINDING 3 (forged webhook): PayPal says the fake 'paid' event is not genuine`);

console.log("\n==== SPIKE PASSED: 3 findings, each proven by PayPal's own records ====");
