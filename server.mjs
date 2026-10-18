// Tamper dashboard server: serves the page, streams a live audit over SSE, gates each patch on a
// human click, and receives PayPal's webhook deliveries for the replay check. One run at a time
// (a demo studio), which keeps the wiring simple.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAudit } from "./lib/engine.mjs";
import { fakeLLM, makeLLM } from "./lib/llm.mjs";
import { makeInbox, MAX_BODY } from "./lib/inbox.mjs";
import * as paypal from "./lib/paypal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;
const WEBHOOK_PATH = "/api/paypal/webhook";

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

export function createTamperServer({ inbox = makeInbox(), pp = paypal, checkInbox = () => webhookPointsHere(pp) } = {}) {
  const state = { inboxLive: false };
  // The one active run (a demo studio): its pending human approvals, check id -> resolve fn.
  let active = null;

  // Asked again on each run until PayPal confirms the webhook points here, so a transient
  // failure at boot doesn't leave the replay check on the synthetic event for good.
  async function refreshInbox() {
    if (!state.inboxLive) state.inboxLive = (await checkInbox()) === true;
    return state.inboxLive;
  }

  async function runStream(res, { liveLLM, denied }) {
    if (active) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "an audit is already running" }));
    }
    const run = (active = { pending: new Map(), closed: false });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (e) => run.closed || res.write(`data: ${JSON.stringify(e)}\n\n`);
    // The reviewer closed the dashboard: nobody is left to approve, so every waiting and later
    // patch is rejected and the run finishes, freeing the slot.
    res.on("close", () => {
      run.closed = true;
      for (const resolve of run.pending.values()) resolve(false);
      run.pending.clear();
    });
    if (denied) send({ agent: "engine", phase: "notice", note: denied });
    try {
      const out = await runAudit({
        pp,
        llm: liveLLM ? makeLLM() : fakePatcherLLM(),
        inbox: (await refreshInbox()) ? inbox : undefined,
        emit: send,
        approve: (f) =>
          run.closed
            ? Promise.resolve(false)
            : new Promise((resolve) => {
                run.pending.set(f.id, resolve);
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
      const wantsLive = url.searchParams.get("llm") === "live";
      const passcode = process.env.TAMPER_PASSCODE;
      const supplied = url.searchParams.get("key") || req.headers["x-tamper-key"];
      const liveLLM = wantsLive && !!passcode && supplied === passcode;
      if (wantsLive && !liveLLM) return runStream(res, { liveLLM: false, denied: "live Claude needs the owner passcode; ran with no-spend auditor instead" });
      return runStream(res, { liveLLM });
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      const check = url.searchParams.get("check");
      const ok = url.searchParams.get("ok") === "1";
      const resolve = active?.pending.get(check);
      if (resolve) {
        resolve(ok);
        active.pending.delete(check);
      }
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
