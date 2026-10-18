// Tamper dashboard server: serves the page, streams a live audit over SSE, gates each patch on a
// human click, and receives PayPal's webhook deliveries for the replay check. One run at a time
// (a demo studio), which keeps the wiring simple.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAudit } from "./lib/engine.mjs";
import { fakeLLM, makeLLM } from "./lib/llm.mjs";
import { makeInbox, MAX_BODY } from "./lib/inbox.mjs";
import { makeRateLimit } from "./lib/ratelimit.mjs";
import * as paypal from "./lib/paypal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;
const WEBHOOK_PATH = "/api/paypal/webhook";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const duration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

// The visitor the demo budget is counted against. On Render, Cloudflare sits in front and sets
// CF-Connecting-IP itself; X-Forwarded-For is not used because its first entry is whatever the
// client sent (checked on the live service). Locally it is the socket's address.
function clientKey(req) {
  const cf = process.env.RENDER && req.headers["cf-connecting-ip"];
  return (cf ? String(cf).trim() : req.socket.remoteAddress) ?? "unknown";
}

// True only when `given` is this secret; an unset secret matches nothing.
function matches(given, secret) {
  if (!secret || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fakePatcherLLM() {
  return fakeLLM((system, user) => {
    if (!system.includes("Patcher")) return "The shop decides an order is paid at fulfill() and in its webhook; both trust the client, not PayPal's records.";
    const flag = /client-reported|browser's say-so/.test(user) ? "verifyBeforeShip" : /verify-webhook-signature/.test(user) ? "verifyWebhookSig" : "dedupeCaptures";
    const fix = {
      verifyBeforeShip: "Call getOrder/getCapture and ship only for the amount PayPal actually captured.",
      verifyWebhookSig: "Call verify-webhook-signature on every event and drop anything that isn't SUCCESS.",
      dedupeCaptures: "Dedupe on the capture id so a replayed event credits the balance only once.",
    }[flag];
    return JSON.stringify({ flag, fix });
  });
}

// Reads a request body of at most `cap` bytes; null as soon as it grows past that, without
// reading the rest.
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size <= cap) return chunks.push(c);
      req.off("data", onData);
      req.pause();
      resolve(null);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// True only when PayPal's webhook for this app posts to this host — otherwise every replay check
// would wait out its timeout for a delivery that can never arrive.
async function webhookPointsHere(pp = paypal) {
  const base = process.env.TAMPER_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!base || !id) return false;
  try {
    return (await pp.getWebhook(id)).url === new URL(WEBHOOK_PATH, base).href;
  } catch (err) {
    console.warn(`could not read PayPal's webhook config (will retry next run): ${err.message || err}`);
    return false;
  }
}

export function createTamperServer({
  inbox = makeInbox(),
  pp = paypal,
  checkInbox = () => webhookPointsHere(pp),
  limiter = makeRateLimit(),
  approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
} = {}) {
  const state = { inboxLive: false };
  // The one active run (a demo studio): its pending human approvals, check id -> settle fn.
  let active = null;

  // Asked again on each run until PayPal confirms the webhook points here, so a transient
  // failure at boot doesn't leave the replay check on the synthetic event for good.
  async function refreshInbox() {
    if (!state.inboxLive) state.inboxLive = (await checkInbox()) === true;
    return state.inboxLive;
  }

  async function runStream(res, { liveLLM, denied }) {
    // Only the dashboard that started this run can decide its fixes: it gets the token in the
    // first event and sends it back with each approval.
    const run = (active = { pending: new Map(), closed: false, abandoned: false, token: randomBytes(16).toString("hex") });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (e) => run.closed || res.write(`data: ${JSON.stringify(e)}\n\n`);
    // The reviewer closed the dashboard: nobody is left to approve, so every waiting and later
    // patch is rejected and the run finishes, freeing the slot.
    res.on("close", () => {
      run.closed = true;
      for (const settle of [...run.pending.values()]) settle(false);
    });
    send({ agent: "engine", phase: "token", token: run.token });
    if (denied) send({ agent: "engine", phase: "notice", note: denied });
    try {
      const out = await runAudit({
        pp,
        llm: liveLLM ? makeLLM() : fakePatcherLLM(),
        inbox: (await refreshInbox()) ? inbox : undefined,
        emit: send,
        // A reviewer who hasn't decided within the timeout is treated as gone, so an idle tab
        // can't hold the one run slot: this fix and every later one are rejected.
        approve: (f) =>
          run.closed || run.abandoned
            ? Promise.resolve(false)
            : new Promise((resolve) => {
                const timer = setTimeout(() => {
                  run.abandoned = true;
                  send({ agent: "patcher", phase: "note", check: f.id, note: `no decision in ${duration(approvalTimeoutMs)}; this and the remaining fixes are rejected` });
                  settle(false);
                }, approvalTimeoutMs);
                const settle = (ok) => {
                  clearTimeout(timer);
                  run.pending.delete(f.id);
                  resolve(ok);
                };
                run.pending.set(f.id, settle);
                send({ agent: "patcher", phase: "awaiting-approval", check: f.id, title: f.title, fix: f.fix });
              }),
      });
      send({ agent: "engine", phase: "complete", scorecard: out.scorecard });
    } catch (err) {
      send({ agent: "engine", phase: "error", error: String(err.message || err) });
    } finally {
      active = null;
      res.end();
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/") {
      const html = await readFile(join(here, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (url.pathname === WEBHOOK_PATH && req.method === "POST") {
      // Unauthenticated by nature (PayPal posts here), so intake only stores; the Judge asks
      // PayPal whether an event is genuine at audit time. Any other event is acknowledged with
      // 200 so PayPal stops retrying it.
      const raw = await readBody(req, MAX_BODY);
      if (raw === null) {
        res.writeHead(413, { Connection: "close" });
        return res.end(() => req.destroy());
      }
      inbox.accept(req.headers, raw);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === "/run") {
      // Live Claude spends the owner's key, so it is gated: only with the passcode (?key= or
      // X-Tamper-Key). Without it the audit still runs fully with the faked Patcher — no spend.
      // Each run creates sandbox orders, so visitors share an hourly budget; the owner doesn't.
      // Judges get their own demo code (?code=): it lifts the budget so a judging session can't
      // run out, and never turns on live Claude.
      const owner = matches(url.searchParams.get("key") || req.headers["x-tamper-key"], process.env.TAMPER_PASSCODE);
      const judge = matches(url.searchParams.get("code"), process.env.TAMPER_DEMO_CODE);
      const wantsLive = url.searchParams.get("llm") === "live";
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        return res.end(JSON.stringify(body));
      };
      if (active) return json(409, { error: "an audit is already running" });
      if (!owner && !judge) {
        const key = clientKey(req);
        // A short hash, never the address itself: enough to see the budget is per visitor.
        console.log(`run requested by visitor ${createHash("sha256").update(key).digest("hex").slice(0, 10)}`);
        const t = limiter.take(key);
        if (!t.ok) return json(429, { error: "hourly demo limit reached", retryAfterSec: t.retryAfterSec }, { "Retry-After": String(t.retryAfterSec) });
      }
      const liveLLM = wantsLive && owner;
      return runStream(res, { liveLLM, denied: wantsLive && !liveLLM ? "live Claude needs the owner passcode; ran with no-spend auditor instead" : undefined });
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      const check = url.searchParams.get("check");
      const ok = url.searchParams.get("ok") === "1";
      const given = Buffer.from(String(req.headers["x-run-token"] ?? ""));
      const expected = Buffer.from(active?.token ?? "");
      if (!active || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "not this run's reviewer" }));
      }
      active.pending.get(check)?.(ok);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404);
    res.end("not found");
  }

  // A failed request (e.g. a client dropping mid-upload) answers 500 rather than becoming an
  // unhandled rejection that takes the process down.
  const server = createServer((req, res) =>
    handle(req, res).catch((err) => {
      console.warn(`request failed: ${err.message || err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }),
  );

  return { server, inbox, state, refreshInbox };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createTamperServer();
  app.server.listen(PORT, () => console.log(`Tamper dashboard → http://localhost:${PORT}`));
  app.refreshInbox().then((live) =>
    console.log(live ? "PayPal webhook → this host: the replay check uses PayPal-signed deliveries" : "PayPal webhook not confirmed here yet: the replay check uses a labelled synthetic event"),
  );
}
