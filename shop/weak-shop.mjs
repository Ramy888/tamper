// The TARGET: a deliberately weak demo store, the kind of PayPal integration a rushed
// team ships. Every flaw here is a real, common mistake. Tamper's job is to find them,
// prove each against PayPal's own records, and patch them. This file is the "before".
//
// It is a plain object of handlers so tests can call it directly and the server can also
// expose it over HTTP. It keeps its own notion of what it thinks it got paid — which is
// exactly what the Judge checks against PayPal's truth.
import { createOrder } from "../lib/paypal.mjs";

export function makeWeakShop(pp = { createOrder }) {
  // What the shop believes about each order: did it fulfill, and for how much.
  const ledger = new Map(); // orderId -> { fulfilled, creditedAmount, currency, seenCaptures:Set }

  return {
    ledger,

    // Checkout: the buyer pays inline (sandbox card). FLAW #1 — the shop creates the PayPal
    // order for a total the browser sent, trusting the client instead of a server-side cart.
    async checkout({ clientTotal, currency = "USD", card }) {
      const order = await pp.createOrder(clientTotal, { currency, card });
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      ledger.set(order.id, {
        fulfilled: false,
        creditedAmount: null,
        currency,
        captureId: capture?.id ?? null,
        paid: capture?.amount?.value ?? null,
        seenCaptures: new Set(),
      });
      return { orderId: order.id, captureId: capture?.id ?? null };
    },

    // Fulfillment: FLAW #2 — marks the order shipped on the browser's say-so, trusting a
    // client-reported amount and never asking PayPal what (or whether) it actually captured.
    fulfill({ orderId, reportedAmount }) {
      const row = ledger.get(orderId);
      if (!row) throw new Error("unknown order");
      row.fulfilled = true;
      row.creditedAmount = reportedAmount; // believes the client, not PayPal
      return { shipped: true };
    },

    // Webhook: FLAW #3 — accepts any posted event as genuine (no verify-webhook-signature),
    // and FLAW #4 — no idempotency, so a replayed capture event credits the balance twice.
    webhook({ event }) {
      if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return { ignored: true };
      const capture = event.resource;
      const orderId = capture?.supplementary_data?.related_ids?.order_id ?? capture?.custom_id;
      const row = orderId && ledger.get(orderId);
      if (!row) return { ignored: true };
      row.seenCaptures.add(capture.id); // a Set would dedupe, but the shop credits on every event:
      row.creditedAmount = (Number(row.creditedAmount) || 0) + Number(capture.amount.value);
      row.fulfilled = true;
      return { credited: capture.amount.value };
    },
  };
}
