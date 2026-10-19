// The target shop, as ONE implementation whose behaviour is set by five safety flags, all
// off by default (the weak shop). The Patcher's job is to name which flag fixes a finding;
// the Verifier flips exactly that one flag and re-runs the check. So the fix is causal — a
// wrong flag leaves the shop vulnerable and the Verifier reports the fix did not hold.
import { createOrder, getOrder, getCapture, verifyWebhook } from "../lib/paypal.mjs";

export const FLAGS = ["verifyBeforeShip", "verifyWebhookSig", "dedupeCaptures", "priceFromCatalog", "idempotentCheckout"];

// What the shop sells to AI shopping assistants through its agent tools.
export const CATALOG = {
  headphones: { name: "Studio headphones", price: "49.00" },
  "gift-card-5": { name: "$5 gift card", price: "5.00" },
};
const money = (n) => Number(n).toFixed(2);

export function makeShop(flags = {}, pp = { createOrder, getOrder, getCapture, verifyWebhook }) {
  const f = { verifyBeforeShip: false, verifyWebhookSig: false, dedupeCaptures: false, priceFromCatalog: false, idempotentCheckout: false, ...flags };
  const ledger = new Map();
  const carts = new Map();
  const cartTotal = (cart) => money(cart.lines.reduce((sum, l) => sum + Number(l.unit) * l.qty, 0));

  const shop = {
    flags: f,
    ledger,
    carts,

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

    // ---- the agent checkout: what an AI shopping assistant calls ----

    // priceFromCatalog ON: the catalog sets every price. OFF: a price the assistant sends is
    // charged as is (the flaw: a tool schema copied from a client-side cart API).
    async addToCart({ cartId, sku, qty = 1, price }) {
      const item = CATALOG[sku];
      if (!item) throw new Error(`unknown product ${sku}`);
      const id = cartId ?? `cart-${crypto.randomUUID().slice(0, 12)}`;
      const cart = carts.get(id) ?? { lines: [], orderIds: [], shipped: false };
      carts.set(id, cart);
      const unit = f.priceFromCatalog || price == null ? item.price : money(price);
      cart.lines.push({ sku, qty: Number(qty), unit });
      return { cartId: id, total: cartTotal(cart) };
    },

    // idempotentCheckout ON: one checkout per cart. Any further call, during or after the first,
    // gets the first's result, and the cart id goes to PayPal as the idempotency key, so a retry
    // from elsewhere still gets PayPal's same order back. (PayPal alone isn't enough: two calls with the same key at the
    // same moment created two orders in 3 of 5 sandbox tries.) OFF: every call is a new order.
    async startCheckout({ cartId }, { card } = {}) {
      const cart = carts.get(cartId);
      if (!cart) throw new Error("unknown cart");
      if (f.idempotentCheckout && cart.inFlight) return cart.inFlight;
      const run = (async () => {
        const order = await pp.createOrder(cartTotal(cart), { card, requestId: f.idempotentCheckout ? `tamper-${cartId}` : undefined });
        const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
        if (!cart.orderIds.includes(order.id)) cart.orderIds.push(order.id);
        return { orderId: order.id, captureId: capture?.id ?? null };
      })();
      if (f.idempotentCheckout) cart.inFlight = run;
      return run;
    },

    // Ships the cart. With verifyBeforeShip it first confirms with PayPal that the order is paid.
    async fulfillCart({ cartId }) {
      const cart = carts.get(cartId);
      if (!cart) throw new Error("unknown cart");
      if (f.verifyBeforeShip) {
        const order = await pp.getOrder(cart.orderIds.at(-1));
        if (order.status !== "COMPLETED") return { shipped: false, reason: "not captured per PayPal" };
      }
      cart.shipped = true;
      return { shipped: true, lines: cart.lines.map((l) => ({ ...l })) };
    },

    // The same four actions as agent tools, shaped like WebMCP tools (name, description, input
    // schema, execute), the way a storefront offers them to an AI assistant. `context.card` is
    // the buyer paying at PayPal (the sandbox card stands in for their approval).
    agentTools() {
      return [
        {
          name: "search_products",
          description: "Search the shop's catalog. Returns each product's sku, name and price.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute: async ({ query = "" } = {}) =>
            Object.entries(CATALOG)
              .filter(([sku, p]) => `${sku} ${p.name}`.toLowerCase().includes(query.toLowerCase()))
              .map(([sku, p]) => ({ sku, ...p })),
        },
        {
          name: "add_to_cart",
          description: "Add a product to a cart (a new cart if no cartId). Returns the cart id and total.",
          inputSchema: {
            type: "object",
            properties: { cartId: { type: "string" }, sku: { type: "string" }, qty: { type: "number" }, price: { type: "string" } },
            required: ["sku"],
          },
          execute: (args) => shop.addToCart(args),
        },
        {
          name: "start_checkout",
          description: "Start PayPal checkout for a cart. The buyer approves and pays at PayPal.",
          inputSchema: { type: "object", properties: { cartId: { type: "string" } }, required: ["cartId"] },
          execute: (args, context) => shop.startCheckout(args, context),
        },
        {
          name: "fulfill_cart",
          description: "Ship a paid cart.",
          inputSchema: { type: "object", properties: { cartId: { type: "string" } }, required: ["cartId"] },
          execute: (args) => shop.fulfillCart(args),
        },
      ];
    },
  };
  return shop;
}

export const makeWeakShop = (pp) => makeShop({}, pp);
export const makeSecureShop = (pp) => makeShop(Object.fromEntries(FLAGS.map((flag) => [flag, true])), pp);
