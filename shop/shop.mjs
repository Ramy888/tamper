// The target shop, as ONE implementation whose behaviour is set by three safety flags, all
// off by default (the weak shop). The Patcher's job is to name which flag fixes a finding;
// the Verifier flips exactly that one flag and re-runs the check. So the fix is causal — a
// wrong flag leaves the shop vulnerable and the Verifier reports the fix did not hold.
import { createOrder, getOrder, getCapture, verifyWebhook } from "../lib/paypal.mjs";

export const FLAGS = ["verifyBeforeShip", "verifyWebhookSig", "dedupeCaptures"];

export function makeShop(flags = {}, pp = { createOrder, getOrder, getCapture, verifyWebhook }) {
  const f = { verifyBeforeShip: false, verifyWebhookSig: false, dedupeCaptures: false, ...flags };
  const ledger = new Map();

  return {
    flags: f,
    ledger,

    async checkout({ clientTotal, currency = "USD", card }) {
      const order = await pp.createOrder(clientTotal, { currency, card });
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      ledger.set(order.id, { fulfilled: false, creditedAmount: null, currency, captureId: capture?.id ?? null, seenCaptures: new Set() });
      return { orderId: order.id, captureId: capture?.id ?? null };
    },

    // verifyBeforeShip ON: read the order back from PayPal and ship only for what it actually
    // captured. OFF: trust the client's reported amount and browser "paid" signal (the flaws).
    async fulfill({ orderId, reportedAmount }) {
      const row = ledger.get(orderId);
      if (!row) throw new Error("unknown order");
      if (f.verifyBeforeShip) {
        const order = await pp.getOrder(orderId);
        const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
        if (order.status !== "COMPLETED" || !cap) return { shipped: false, reason: "not captured per PayPal" };
        row.fulfilled = true;
        row.creditedAmount = cap.amount.value;
        return { shipped: true, amount: cap.amount.value };
      }
      row.fulfilled = true;
      row.creditedAmount = reportedAmount;
      return { shipped: true };
    },

    // verifyWebhookSig ON: confirm the event with PayPal first. dedupeCaptures ON: credit each
    // capture id once. Both OFF: credit any posted event, every time (the webhook flaws).
    async webhook({ event, headers, rawBody }) {
      if (f.verifyWebhookSig) {
        const v = await pp.verifyWebhook(headers ?? {}, event, rawBody);
        if (v.verification_status !== "SUCCESS") return { rejected: "signature not genuine" };
      }
      if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return { ignored: true };
      const capture = event.resource;
      const orderId = capture?.supplementary_data?.related_ids?.order_id ?? capture?.custom_id;
      const row = orderId && ledger.get(orderId);
      if (!row) return { ignored: true };
      if (f.dedupeCaptures && row.seenCaptures.has(capture.id)) return { duplicate: true };
      row.seenCaptures.add(capture.id);
      row.creditedAmount = (Number(row.creditedAmount) || 0) + Number(capture.amount.value);
      row.fulfilled = true;
      return { credited: capture.amount.value };
    },
  };
}

export const makeWeakShop = (pp) => makeShop({}, pp);
export const makeSecureShop = (pp) => makeShop({ verifyBeforeShip: true, verifyWebhookSig: true, dedupeCaptures: true }, pp);
