// The "AFTER": the same shop with every flaw fixed the right way. The Verifier re-runs the
// exact same checks against this one to prove each patch holds — the checks must all come
// back unconfirmed. Same interface as the weak shop so the auditors drive it unchanged.
import { createOrder, getOrder, getCapture, verifyWebhook } from "../lib/paypal.mjs";

export function makeSecureShop(pp = { createOrder, getOrder, getCapture, verifyWebhook }) {
  const ledger = new Map();

  return {
    ledger,

    async checkout({ clientTotal, currency = "USD", card }) {
      const order = await pp.createOrder(clientTotal, { currency, card });
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      ledger.set(order.id, { fulfilled: false, creditedAmount: null, currency, captureId: capture?.id ?? null, seenCaptures: new Set() });
      return { orderId: order.id, captureId: capture?.id ?? null };
    },

    // FIX #1 & #2: never trust a client-reported amount or a browser "paid" signal. Read the
    // order back from PayPal and only fulfill for exactly what PayPal says it captured.
    async fulfill({ orderId }) {
      const order = await pp.getOrder(orderId);
      const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
      if (order.status !== "COMPLETED" || !cap) return { shipped: false, reason: "not captured per PayPal" };
      const row = ledger.get(orderId);
      row.fulfilled = true;
      row.creditedAmount = cap.amount.value; // PayPal's number, not the client's
      return { shipped: true, amount: cap.amount.value };
    },

    // FIX #3 & #4: verify the signature with PayPal, and dedupe on capture id for idempotency.
    async webhook({ event, headers }) {
      const v = await pp.verifyWebhook(headers ?? {}, event);
      if (v.verification_status !== "SUCCESS") return { rejected: "signature not genuine" };
      if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return { ignored: true };
      const capture = event.resource;
      const orderId = capture?.supplementary_data?.related_ids?.order_id ?? capture?.custom_id;
      const row = orderId && ledger.get(orderId);
      if (!row) return { ignored: true };
      if (row.seenCaptures.has(capture.id)) return { duplicate: true }; // idempotent
      row.seenCaptures.add(capture.id);
      row.creditedAmount = (Number(row.creditedAmount) || 0) + Number(capture.amount.value);
      row.fulfilled = true;
      return { credited: capture.amount.value };
    },
  };
}
