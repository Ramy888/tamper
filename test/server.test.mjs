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

test("a visitor over the hourly demo limit gets 429; the owner's passcode is not limited", async () => {
  process.env.TAMPER_PASSCODE = "owner-pass";
  await withServer(
    async (base) => {
      const r = await fetch(`${base}/run`);
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) > 0);
      const owner = await fetch(`${base}/run`, { headers: { "X-Tamper-Key": "owner-pass" } });
      assert.equal(owner.status, 200);
      await owner.body.cancel();
    },
    { pp: makeFakePayPal(), limiter: { take: () => ({ ok: false, retryAfterSec: 42 }) } },
  );
});

test("a run announces its model: asking for live Claude without the passcode gets the no-spend one", async () => {
  delete process.env.TAMPER_PASSCODE;
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/run?llm=live`);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const first = JSON.parse(new TextDecoder().decode(value).match(/^data: (.*)$/m)[1]);
      assert.equal(first.phase, "token");
      assert.equal(first.model, "no-spend", "the dashboard learns live Claude is off before the audit starts");
      await reader.cancel();
    },
    { pp: makeFakePayPal() },
  );
});

test("a judge's demo code is not limited, but it never turns on live Claude", async () => {
  process.env.TAMPER_PASSCODE = "owner-pass";
  try {
    await withServer(
      async (base) => {
        assert.equal((await fetch(`${base}/run?code=`)).status, 429, "with no demo code set, an empty one is limited");
        process.env.TAMPER_DEMO_CODE = "judge-code";
        assert.equal((await fetch(`${base}/run?code=wrong-code`)).status, 429);
        const judge = await fetch(`${base}/run?code=judge-code&llm=live`);
        assert.equal(judge.status, 200);
        const reader = judge.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!/"phase":"notice"/.test(buf)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
        assert.match(buf, /live AI needs the owner passcode/);
        await reader.cancel();
      },
      { pp: makeFakePayPal(), limiter: { take: () => ({ ok: false, retryAfterSec: 42 }) } },
    );
  } finally {
    delete process.env.TAMPER_DEMO_CODE;
  }
});

test("an approval nobody answers times out: that fix and the rest are rejected, and the run ends", { timeout: 5000 }, async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/run`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      const events = [...buf.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const done = events.find((e) => e.phase === "complete");
      assert.ok(done, "the run completes without anyone approving");
      assert.equal(done.scorecard.rejected, done.scorecard.found);
      assert.ok(events.some((e) => e.phase === "note" && /no decision/i.test(e.note)));
      assert.equal(events.filter((e) => e.phase === "awaiting-approval").length, 1, "only the first fix waits; the rest are rejected at once");
    },
    { pp: makeFakePayPal(), approvalTimeoutMs: 50 },
  );
});

const TOKEN_PHASE = "token";

// Only the dashboard that started the run can decide its fixes: the run's token arrives in
// its first event and must come back with every approval.
test("an approval without the run's token is refused and changes nothing", { timeout: 5000 }, async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/run`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const seen = [];
      const next = async (pred) => {
        for (;;) {
          const hit = seen.find(pred);
          if (hit) return hit;
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (chunk.startsWith("data: ")) seen.push(JSON.parse(chunk.slice(6)));
          }
        }
      };
      const { token } = await next((e) => e.phase === TOKEN_PHASE);
      assert.ok(token && token.length >= 16, "the run announces its token");
      const ask = await next((e) => e.phase === "awaiting-approval");
      // The dashboard keeps the token from every event with this phase, so no other event may share it.
      assert.ok(seen.filter((e) => e.phase === TOKEN_PHASE).every((e) => e.token === token), "no other event reuses the token's phase");
      const stranger = await fetch(`${base}/approve?check=${ask.check}&ok=1`, { method: "POST" });
      assert.equal(stranger.status, 403);
      const forged = await fetch(`${base}/approve?check=${ask.check}&ok=1`, { method: "POST", headers: { "X-Run-Token": "guess" } });
      assert.equal(forged.status, 403);
      await sleep(50);
      assert.ok(!seen.some((e) => e.agent === "verifier"), "a refused approval does not move the run");
      const mine = await fetch(`${base}/approve?check=${ask.check}&ok=1`, { method: "POST", headers: { "X-Run-Token": token } });
      assert.equal(mine.status, 200);
      const v = await next((e) => e.agent === "verifier" && e.check === ask.check);
      assert.equal(v.fixHolds, true);
      await reader.cancel();
    },
    { pp: makeFakePayPal() },
  );
});
