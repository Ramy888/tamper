// Tamper dashboard server: serves the page, streams a live audit over SSE, and gates each
// patch on a human click. One run at a time (a demo studio), which keeps the wiring simple.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAudit } from "./lib/engine.mjs";
import { fakeLLM, makeLLM } from "./lib/llm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;

// Pending human approvals for the active run: check id -> resolve fn.
let pending = new Map();

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

async function runStream(res, { liveLLM, denied }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  pending = new Map();
  if (denied) send({ agent: "engine", phase: "notice", note: denied });
  try {
    const out = await runAudit({
      llm: liveLLM ? makeLLM() : fakePatcherLLM(),
      emit: send,
      approve: (f) =>
        new Promise((resolve) => {
          pending.set(f.id, resolve);
          send({ agent: "patcher", phase: "awaiting-approval", check: f.id, title: f.title, fix: f.fix });
        }),
    });
    send({ agent: "engine", phase: "complete", scorecard: out.scorecard });
  } catch (err) {
    send({ agent: "engine", phase: "error", error: String(err.message || err) });
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/") {
    const html = await readFile(join(here, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
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
    const resolve = pending.get(check);
    if (resolve) {
      resolve(ok);
      pending.delete(check);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`Tamper dashboard → http://localhost:${PORT}`));
