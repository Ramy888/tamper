// The webhook INBOX: PayPal's real deliveries to /api/paypal/webhook, kept so the replay check
// can re-send a genuinely PayPal-signed event instead of a synthetic one. Intake makes no PayPal
// call (an unauthenticated POST must not trigger API traffic); the Judge verifies at audit time.
export const MAX_BODY = 64 * 1024;

const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
];

export function makeInbox({ keep = 50 } = {}) {
  const items = [];
  const waiters = new Set();
  const find = (captureId) => items.findLast((i) => i.event.resource.id === captureId) ?? null;

  return {
    find,
    get size() {
      return items.length;
    },

    // Keeps a PAYMENT.CAPTURE.COMPLETED delivery that carries PayPal's signature headers; the raw
    // body is kept byte-for-byte so a failed signature check can be diagnosed. True if stored.
    accept(headers, rawBody) {
      if (Buffer.byteLength(rawBody) > MAX_BODY) return false;
      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return false;
      }
      if (event?.event_type !== "PAYMENT.CAPTURE.COMPLETED" || typeof event.resource?.id !== "string") return false;
      if (SIGNATURE_HEADERS.some((h) => typeof headers[h] !== "string")) return false;
      const paypalHeaders = Object.fromEntries(SIGNATURE_HEADERS.map((h) => [h, headers[h]]));
      const item = { paypalHeaders, event, rawBody, receivedAt: Date.now() };
      items.push(item);
      if (items.length > keep) items.shift();
      for (const w of waiters) w(item);
      return true;
    },

    // Resolves with the delivery for this capture once PayPal posts it, or null after timeoutMs.
    waitFor(captureId, timeoutMs) {
      const hit = find(captureId);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const done = (v) => {
          clearTimeout(timer);
          waiters.delete(onItem);
          resolve(v);
        };
        const onItem = (item) => item.event.resource.id === captureId && done(item);
        const timer = setTimeout(() => done(null), timeoutMs);
        waiters.add(onItem);
      });
    },
  };
}
