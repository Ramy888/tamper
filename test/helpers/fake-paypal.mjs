// An in-memory PayPal stand-in for unit tests: internally consistent so the auditors and the
// Judge behave exactly as they do against the real sandbox, with no network and no spend.
// The live spike (scripts/spike.mjs) is what proves the real PayPal behaviour.
let n = 1000;
const id = (p) => `${p}-${n++}`;

export function makeFakePayPal() {
  const orders = new Map();
  const captures = new Map();

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
    // Genuine only when the caller presents genuine headers; a forged event fails, as it does live.
    async verifyWebhook(headers) {
      return { verification_status: headers?.genuine === true ? "SUCCESS" : "FAILURE" };
    },
  };
}
