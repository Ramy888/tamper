// Runs the full audit against the LIVE PayPal sandbox. The LLM is faked by default (no spend);
// pass --live-llm to use the real Claude key for the Recon/Patcher prose.
// Run: node --env-file=.env scripts/audit.mjs
import { runAudit } from "../lib/engine.mjs";
import { fakeLLM, makeLLM } from "../lib/llm.mjs";

const liveLLM = process.argv.includes("--live-llm");
const llm = liveLLM
  ? makeLLM()
  : fakeLLM((system, user) => {
      if (!system.includes("Patcher")) return "The shop decides an order is paid at fulfill() and in its webhook, and both trust the client instead of PayPal's records.";
      const flag = /client-reported|browser's say-so/.test(user) ? "verifyBeforeShip" : /verify-webhook-signature/.test(user) ? "verifyWebhookSig" : "dedupeCaptures";
      return JSON.stringify({ flag, fix: "apply " + flag });
    });

const icon = { recon: "🔎", auditor: "🧪", judge: "⚖️", patcher: "🔧", verifier: "✅", engine: "📊" };
const out = await runAudit({
  llm,
  emit: (e) => {
    const tag = `${icon[e.agent] ?? "•"} ${e.agent}`;
    if (e.agent === "judge") console.log(`${tag}  [${e.confirmed ? "VULNERABLE" : "ok"}] ${e.check} — shop ${e.shopBelief}; ${e.truth}  {${e.proofIds?.join(", ")}}`);
    else if (e.agent === "verifier") console.log(`${tag}  ${e.check}: ${e.phase === "pending" ? "pending (" + e.reason + ")" : "fix holds = " + e.fixHolds}`);
    else if (e.agent === "patcher" && e.phase === "proposed") console.log(`${tag}  ${e.check}: ${e.fix}`);
    else if (e.agent === "recon" && e.phase === "done") console.log(`${tag}  ${e.note}`);
    else if (e.phase === "note") console.log(`${tag}  ${e.check}: ${e.note}`);
    else if (e.agent === "engine") console.log(`\n${tag}  found ${e.found}/${e.checks}, patched ${e.patched}, still vulnerable after patch: ${e.stillVulnerableAfterPatch}`);
  },
});
console.log(`\nLLM: ${liveLLM ? "live Claude" : "faked (no spend)"}.  Scorecard:`, out.scorecard);
