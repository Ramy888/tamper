import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createTamperServer } from "../server.mjs";
import { MAX_BODY } from "../lib/inbox.mjs";
import { makeFakePayPal } from "./helpers/fake-paypal.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "c2ln",
  "paypal-transmission-time": "2026-10-18T12:00:00Z",
};

async function withServer(fn, opts) {
  const app = createTamperServer(opts);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await fn(base, app);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
}

// Sends raw bytes on a socket and resolves with whatever the server replies within `ms`.
function rawRequest(port, chunks, { ms = 1000, dropAfter } = {}) {
  return new Promise((resolve) => {
    let data = "";
    const s = net.connect(port, "127.0.0.1", () => {
      for (const c of chunks) s.write(c);
      if (dropAfter !== undefined) setTimeout(() => s.destroy(), dropAfter);
    });
    s.on("data", (c) => (data += c));
    s.on("error", () => {});
    s.on("close", () => resolve(data));
    setTimeout(() => (s.destroy(), resolve(data)), ms);
  });
}

// Reads the SSE stream until an event with this phase arrives.
async function readUntil(res, phase) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${phase}`);
    buf += dec.decode(value, { stream: true });
    for (const m of buf.matchAll(/^data: (.*)$/gm)) if (JSON.parse(m[1]).phase === phase) return reader;
  }
}

const post = (base, body) => fetch(`${base}/api/paypal/webhook`, { method: "POST", headers: H, body });

test("the webhook endpoint stores PayPal's capture deliveries and answers 200", async () => {
  await withServer(async (base, app) => {
    const res = await post(base, JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } }));
    assert.equal(res.status, 200);
    assert.ok(app.inbox.find("CAP-1"));
  });
});

test("other event types are acknowledged (so PayPal stops retrying) but not stored", async () => {
  await withServer(async (base, app) => {
    const res = await post(base, JSON.stringify({ id: "WH-2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "O-1" } }));
    assert.equal(res.status, 200);
    assert.equal(app.inbox.size, 0);
  });
});

test("an oversized POST is refused with 413 and stores nothing", async () => {
  await withServer(async (base, app) => {
    const big = JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" }, pad: "x".repeat(MAX_BODY + 1) });
    const res = await post(base, big);
    assert.equal(res.status, 413);
    assert.equal(app.inbox.size, 0);
  });
});

test("an oversized upload gets 413 as soon as it passes the cap, without reading the rest", async () => {
  await withServer(async (base, app) => {
    const head = `POST /api/paypal/webhook HTTP/1.1\r\nHost: x\r\nContent-Length: ${50 * MAX_BODY}\r\n\r\n`;
    const reply = await rawRequest(app.server.address().port, [head, "x".repeat(2 * MAX_BODY)]); // the rest never comes
    assert.match(reply, /^HTTP\/1\.1 413/);
    assert.equal(app.inbox.size, 0);
  });
});

test("a client dropping mid-upload does not take the server down", async () => {
  await withServer(async (base, app) => {
    const head = "POST /api/paypal/webhook HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n";
    await rawRequest(app.server.address().port, [head, '{"event_type":'], { dropAfter: 20 });
    await sleep(50);
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
});

test("one audit at a time; closing the dashboard mid-run frees the slot", async () => {
  await withServer(
    async (base) => {
      const ctl = new AbortController();
      await readUntil(await fetch(`${base}/run`, { signal: ctl.signal }), "awaiting-approval");
      assert.equal((await fetch(`${base}/run`)).status, 409, "a second run is refused while one waits");
      ctl.abort(); // the reviewer closes the tab: its waiting approvals are released, the run ends
      let status;
      for (let i = 0; i < 100 && status !== 200; i++) {
        await sleep(20);
        const r = await fetch(`${base}/run`);
        status = r.status;
        await r.body.cancel();
      }
      assert.equal(status, 200);
    },
    { pp: makeFakePayPal() },
  );
});

test("the PayPal webhook check is retried on each run until it confirms, then kept", async () => {
  let calls = 0;
  const answers = [false, true];
  const app = createTamperServer({ checkInbox: async () => answers[calls++] });
  await app.refreshInbox();
  assert.equal(app.state.inboxLive, false);
  await app.refreshInbox();
  await app.refreshInbox();
  assert.equal(app.state.inboxLive, true);
  assert.equal(calls, 2, "a confirmed answer is not asked again");
});
