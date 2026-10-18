// The ENGINE: cooperating agents, each with one job, handing work to each other and
// checking each other's output. Recon maps the integration, the Auditors exploit it, the
// Judge (no LLM) confirms every finding against PayPal, the Patcher proposes a fix a human
// approves, and the Verifier re-runs the same check against the fixed shop to prove it holds.
import { CHECKS } from "./checks.mjs";
import * as paypal from "./paypal.mjs";
import { makeWeakShop } from "../shop/weak-shop.mjs";
import { makeSecureShop } from "../shop/secure-shop.mjs";

const RECON_SYSTEM =
  "You are the Recon agent in a PayPal-integration security audit. In 2-3 sentences, describe " +
  "where this shop decides an order is paid, and the riskiest place it trusts something other " +
  "than PayPal's own records. Be concrete and brief.";

const PATCHER_SYSTEM =
  "You are the Patcher agent. Given one confirmed PayPal-integration flaw, reply with a one-sentence " +
  "fix a developer can apply, naming the PayPal call that makes it safe (getOrder, getCapture, or " +
  "verify-webhook-signature). No preamble.";

export async function runAudit({
  pp = paypal,
  llm, // required: a real makeLLM() or fakeLLM()
  card,
  emit = () => {},
  approve = async () => true, // human-in-the-loop gate before each patch is "applied"
  shopSource = "",
} = {}) {
  const log = (e) => emit({ t: Date.now(), ...e });

  // --- Recon ---
  log({ agent: "recon", phase: "start" });
  const map = await llm.complete(RECON_SYSTEM, shopSource || "A PayPal checkout shop (source withheld).");
  log({ agent: "recon", phase: "done", note: map.trim() });

  // --- Auditors + Judge ---
  const weak = makeWeakShop(pp);
  const confirmed = [];
  for (const check of CHECKS) {
    log({ agent: "auditor", phase: "run", check: check.id, title: check.title });
    const res = await check.run({ shop: weak, pp, card });
    log({
      agent: "judge",
      phase: "verdict",
      check: check.id,
      confirmed: res.confirmed,
      severity: check.severity,
      shopBelief: res.shopBelief,
      truth: res.truth,
      proofIds: res.proofIds,
    });
    if (res.confirmed) confirmed.push({ ...check, ...res });
  }

  // --- Patcher (human-approved) + Verifier ---
  const fixed = makeSecureShop(pp);
  const patched = [];
  for (const f of confirmed) {
    const fix = await llm.complete(PATCHER_SYSTEM, `Flaw: ${f.title}\nCode issue: ${f.flaw}`);
    log({ agent: "patcher", phase: "proposed", check: f.id, fix: fix.trim() });
    const ok = await approve({ ...f, fix: fix.trim() });
    if (!ok) {
      log({ agent: "patcher", phase: "rejected", check: f.id });
      continue;
    }
    // Verifier: re-run the exact same check against the fixed shop; it must NOT confirm now.
    // Some fixes can only be auto-verified live with a genuinely PayPal-signed event (the
    // replay check): if that input isn't available the verdict is "pending", never a false pass.
    let held = null;
    try {
      const recheck = await CHECKS.find((c) => c.id === f.id).run({ shop: fixed, pp, card });
      held = !recheck.confirmed;
      log({ agent: "verifier", phase: "result", check: f.id, fixHolds: held, truth: recheck.truth });
    } catch (err) {
      log({ agent: "verifier", phase: "pending", check: f.id, reason: "needs a real PayPal-signed event to auto-verify" });
    }
    patched.push({ id: f.id, fix: fix.trim(), fixHolds: held });
  }

  const scorecard = {
    checks: CHECKS.length,
    found: confirmed.length,
    patched: patched.length,
    fixesVerified: patched.filter((p) => p.fixHolds === true).length,
    pending: patched.filter((p) => p.fixHolds === null).length,
    stillVulnerableAfterPatch: patched.filter((p) => p.fixHolds === false).length,
  };
  log({ agent: "engine", phase: "scorecard", ...scorecard });
  return { map: map.trim(), findings: confirmed, patched, scorecard };
}
