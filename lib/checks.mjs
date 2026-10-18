// The AUDITORS: each check exercises the target shop the way a real attacker or a careless
// client would, then hands the result to the Judge, which confirms it against PayPal's records.
// A check only becomes a reported finding if the Judge confirms it. No finding is taken on trust.
import * as judge from "./judge.mjs";
import { SANDBOX_CARD } from "./paypal.mjs";

// A forged webhook event + headers that do NOT carry a genuine PayPal signature.
function forgedCaptureEvent(orderId, amount) {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
    "paypal-transmission-id": crypto.randomUUID(),
    "paypal-transmission-sig": Buffer.from("forged").toString("base64"),
    "paypal-transmission-time": new Date().toISOString(),
  };
  const event = {
    id: "WH-FORGED-" + crypto.randomUUID().slice(0, 8),
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "FAKE-" + crypto.randomUUID().slice(0, 8),
      amount: { value: amount, currency_code: "USD" },
      custom_id: orderId,
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  };
  return { headers, event };
}

export const CHECKS = [
  {
    id: "amount_mismatch",
    title: "Fulfillment trusts a client-reported amount, not PayPal's capture",
    severity: "critical",
    fixFlag: "verifyBeforeShip",
    flaw: "shop.fulfill() sets creditedAmount from reportedAmount instead of reading the capture from PayPal",
    async run({ shop, pp, card = SANDBOX_CARD }) {
      // Buyer really pays a small amount…
      const { orderId, captureId } = await shop.checkout({ clientTotal: "2.00", card });
      // …but tells the shop the cart was worth far more, and the shop ships on that word.
      shop.fulfill({ orderId, reportedAmount: "200.00" });
      const truth = await judge.captureAmount(pp, captureId); // PayPal: what really moved
      const belief = Number(shop.ledger.get(orderId).creditedAmount);
      const confirmed = shop.ledger.get(orderId).fulfilled && belief > Number(truth.paid);
      return {
        confirmed,
        shopBelief: `shipped a $${belief.toFixed(2)} order`,
        truth: `PayPal captured $${truth.paid}`,
        proofIds: [`order ${orderId}`, `capture ${captureId}`],
      };
    },
  },
  {
    id: "browser_trusted_paid",
    title: "Order marked paid on the browser's say-so, never verified with PayPal",
    severity: "critical",
    fixFlag: "verifyBeforeShip",
    flaw: "shop.fulfill() never calls getOrder/getCapture to confirm the order is COMPLETED",
    async run({ shop, pp }) {
      // No card: the buyer created an order but never actually paid.
      const { orderId } = await shop.checkout({ clientTotal: "49.00" });
      shop.fulfill({ orderId, reportedAmount: "49.00" }); // shop ships anyway
      const truth = await judge.orderTruth(pp, orderId); // PayPal: not completed
      const confirmed = shop.ledger.get(orderId).fulfilled && !truth.completed;
      return {
        confirmed,
        shopBelief: "shipped the order as paid",
        truth: `PayPal order status is ${truth.status} (never captured)`,
        proofIds: [`order ${orderId}`],
      };
    },
  },
  {
    id: "unverified_webhook",
    title: "Webhook events accepted without verify-webhook-signature",
    severity: "critical",
    fixFlag: "verifyWebhookSig",
    flaw: "shop.webhook() credits on any posted event; it never calls verify-webhook-signature",
    async run({ shop, pp }) {
      const { orderId } = await shop.checkout({ clientTotal: "75.00" });
      const { headers, event } = forgedCaptureEvent(orderId, "75.00");
      await shop.webhook({ event, headers }); // weak shop credits the fake; secure shop rejects it
      const verdict = await judge.webhookGenuine(pp, headers, event); // PayPal: not genuine
      const confirmed = shop.ledger.get(orderId).fulfilled && !verdict.genuine;
      return {
        confirmed,
        shopBelief: "credited a 'payment completed' webhook",
        truth: `PayPal signature check: ${verdict.status}`,
        proofIds: [`order ${orderId}`, "forged webhook rejected by PayPal"],
      };
    },
  },
  {
    id: "webhook_replay",
    title: "No idempotency: a replayed capture event credits the balance twice",
    severity: "high",
    fixFlag: "dedupeCaptures",
    flaw: "shop.webhook() adds to creditedAmount on every event; a Set of seen captures is kept but never checked",
    async run({ shop, pp, card = SANDBOX_CARD, genuineHeaders = { genuine: true }, inbox, waitMs = 40_000, note = () => {} }) {
      const { orderId, captureId } = await shop.checkout({ clientTotal: "30.00", card });
      // Hosted, PayPal posts its own signed PAYMENT.CAPTURE.COMPLETED for this capture to the
      // inbox; the Judge confirms it is genuine and that exact event is replayed. Otherwise a
      // synthetic stand-in is replayed, and the proof says so.
      let event, headers, rawBody, eventProof;
      let signedReplay = false;
      if (inbox) {
        note(`waiting up to ${Math.round(waitMs / 1000)}s for PayPal's own webhook delivery of capture ${captureId}…`);
        const delivery = await inbox.waitFor(captureId, waitMs);
        let verdict = { genuine: false, status: "no delivery in time" };
        if (delivery) {
          try {
            verdict = await judge.webhookGenuine(pp, delivery.paypalHeaders, delivery.event, delivery.rawBody);
          } catch (err) {
            verdict = { genuine: false, status: `PayPal's signature check failed: ${err.message || err}` };
          }
        }
        if (verdict.genuine) {
          ({ event, paypalHeaders: headers, rawBody } = delivery);
          signedReplay = true;
          eventProof = `webhook ${event.id} (PayPal-signed, verified)`;
          note(`PayPal delivered ${event.id} and confirms it is genuine; replaying it twice`);
        } else note(`no verified PayPal delivery (${verdict.status}); replaying a synthetic stand-in event`);
      }
      if (!event) {
        event = {
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: { id: captureId, amount: { value: "30.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: orderId } } },
        };
        headers = genuineHeaders;
        eventProof = "replayed event: synthetic stand-in, not PayPal-signed";
      }
      await shop.webhook({ event, headers, rawBody });
      await shop.webhook({ event, headers, rawBody }); // same event again
      const truth = await judge.captureAmount(pp, captureId); // PayPal: captured once
      const belief = Number(shop.ledger.get(orderId).creditedAmount);
      const confirmed = belief > Number(truth.paid);
      return {
        confirmed,
        // A shop that never credited the real payment shows nothing about replays: a fix that
        // just rejects every event must not read as "holds".
        inconclusive: belief < Number(truth.paid),
        signedReplay,
        shopBelief: `credited $${belief.toFixed(2)}`,
        truth: `PayPal captured $${truth.paid} once (capture ${captureId})`,
        proofIds: [`order ${orderId}`, `capture ${captureId}`, eventProof],
      };
    },
  },
];
