// An in-memory PayPal stand-in for unit tests: internally consistent so the auditors and the
// Judge behave exactly as they do against the real sandbox, with no network and no spend.
// The live spike (scripts/spike.mjs) is what proves the real PayPal behaviour.
let n = 1000;
const id = (p) => `${p}-${n++}`;

// `onCapture` fires for each card capture, so a test can play PayPal delivering the
// PAYMENT.CAPTURE.COMPLETED webhook a moment later (see captureEvent and sign below).
export function makeFakePayPal({ onCapture } = {}) {
  const orders = new Map();
  const captures = new Map();
  const signed = new Set();

  return {
    async createOrder(amount, { currency = "USD", card } = {}) {
      const orderId = id("ORD");
      if (card) {
        const capId = id("CAP");
        captures.set(capId, { amount: { value: String(amount), currency_code: currency }, status: "COMPLETED" });
        const order = {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: capId, amount: { value: String(amount), currency_code: currency } }] } }],
        };
        orders.set(orderId, order);
        onCapture?.({ captureId: capId, orderId, amount: String(amount), currency });
        return order;
      }
      const order = { id: orderId, status: "CREATED", purchase_units: [{ amount: { value: String(amount), currency_code: currency } }] };
      orders.set(orderId, order);
      return order;
    },
    async getOrder(orderId) {
      const o = orders.get(orderId);
      if (!o) throw new Error("order not found");
      return o;
    },
    async getCapture(capId) {
      const c = captures.get(capId);
      if (!c) throw new Error("capture not found");
      return c;
    },
    // Headers this fake PayPal will later verify as genuine, as it would a real delivery.
    sign() {
      const tid = id("TX");
      signed.add(tid);
      return {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
        "paypal-transmission-id": tid,
        "paypal-transmission-sig": "c2lnbmVk",
        "paypal-transmission-time": new Date().toISOString(),
      };
    },
    // Genuine only when the caller presents genuine headers; a forged event fails, as it does live.
    async verifyWebhook(headers) {
      const genuine = headers?.genuine === true || signed.has(headers?.["paypal-transmission-id"]);
      return { verification_status: genuine ? "SUCCESS" : "FAILURE" };
    },
  };
}

// The PAYMENT.CAPTURE.COMPLETED event PayPal posts after a capture (the fields the shop reads).
export const captureEvent = ({ captureId, orderId, amount, currency = "USD" }) => ({
  id: `WH-${captureId}`,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: captureId, amount: { value: amount, currency_code: currency }, supplementary_data: { related_ids: { order_id: orderId } } },
});
