// The ENGINE: cooperating agents, each with one job, handing work to each other and
// checking each other's output. Recon maps the integration, the Auditors exploit it, the
// Judge (no LLM) confirms every finding against PayPal, the Patcher proposes a fix a human
// approves, and the Verifier re-runs the same check against the fixed shop to prove it holds.
import { CHECKS } from "./checks.mjs";
import * as paypal from "./paypal.mjs";
import { makeWeakShop, makeShop, FLAGS } from "../shop/shop.mjs";

const RECON_SYSTEM =
  "You are the Recon agent in a PayPal-integration security audit. In 2-3 sentences, describe " +
  "where this shop decides an order is paid, and the riskiest place it trusts something other " +
  "than PayPal's own records. Write for the developer fixing their own integration: describe the " +
  "mistake and what it costs them, not how someone would abuse it. Be concrete and brief.";

// The Patcher must pick the ONE safety flag that fixes the flaw. Its choice is causal: the
// Verifier flips exactly that flag and re-runs, so a wrong pick leaves the shop vulnerable.
const PATCHER_SYSTEM =
  "You are the Patcher agent fixing one PayPal-integration flaw. The shop has three safety flags:\n" +
  "- verifyBeforeShip: read the order/capture back from PayPal (getOrder/getCapture) before fulfilling\n" +
  "- verifyWebhookSig: call verify-webhook-signature before trusting a webhook event\n" +
  "- dedupeCaptures: credit each capture id only once (idempotency)\n" +
  'Reply with ONLY JSON: {"flag":"<one of the three>","fix":"<one sentence for the developer>"}';

function parsePatch(text) {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m[0]);
    if (FLAGS.includes(j.flag)) return { flag: j.flag, fix: String(j.fix || "").trim() };
  } catch {}
  return { flag: null, fix: text.trim() };
}

export async function runAudit({
  pp = paypal,
  llm, // required: a real makeLLM() or fakeLLM()
  card,
  emit = () => {},
  approve = async () => true, // human-in-the-loop gate before each patch is "applied"
  shopSource,
  inbox, // PayPal's real webhook deliveries, when PayPal's webhook points at this host
  waitMs,
} = {}) {
  const log = (e) => emit({ t: Date.now(), ...e });
  const noteAs = (agent, check) => (note) => log({ agent, phase: "note", check, note });

  // --- Recon --- reads the target shop's real source so its summary is grounded, not generic.
  if (shopSource === undefined) {
    const { readFile } = await import("node:fs/promises");
    shopSource = await readFile(new URL("../shop/shop.mjs", import.meta.url), "utf8").catch(() => "");
  }
  log({ agent: "recon", phase: "start" });
  const map = await llm.complete(RECON_SYSTEM, shopSource || "A PayPal checkout shop (source withheld).");
  log({ agent: "recon", phase: "done", note: map.trim() });

  // --- Auditors + Judge ---
  const weak = makeWeakShop(pp);
  const confirmed = [];
  for (const check of CHECKS) {
    log({ agent: "auditor", phase: "run", check: check.id, title: check.title });
    const res = await check.run({ shop: weak, pp, card, inbox, waitMs, note: noteAs("auditor", check.id) });
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
  const patched = [];
  for (const f of confirmed) {
    const { flag, fix } = parsePatch(await llm.complete(PATCHER_SYSTEM, `Flaw: ${f.title}\nCode issue: ${f.flaw}`));
    const ok = await approve({ ...f, fix, flag });
    if (!ok) {
      log({ agent: "patcher", phase: "rejected", check: f.id });
      patched.push({ id: f.id, fix, flag, fixHolds: false, rejected: true });
      continue;
    }
    // Verifier: build a shop with ONLY the Patcher's chosen flag flipped, then re-run the same
    // check. The fix holds only if the Patcher named the right flag — a wrong pick still fails.
    // If the re-run itself errors, the verdict is "pending", never a false pass.
    let held = null;
    try {
      const fixedShop = makeShop(flag ? { [flag]: true } : {}, pp);
      const recheck = await CHECKS.find((c) => c.id === f.id).run({ shop: fixedShop, pp, card, inbox, waitMs, note: noteAs("verifier", f.id) });
      if (recheck.inconclusive) {
        log({ agent: "verifier", phase: "pending", check: f.id, flag, reason: `inconclusive: ${recheck.shopBelief}, so the re-run shows nothing either way` });
      } else {
        held = !recheck.confirmed;
        log({ agent: "verifier", phase: "result", check: f.id, flag, fixHolds: held, truth: recheck.truth });
      }
    } catch (err) {
      log({ agent: "verifier", phase: "pending", check: f.id, reason: `re-run failed: ${err.message || err}` });
    }
    patched.push({ id: f.id, fix, flag, fixHolds: held });
  }

  const applied = patched.filter((p) => !p.rejected);
  const scorecard = {
    checks: CHECKS.length,
    found: confirmed.length,
    patched: applied.length,
    rejected: patched.filter((p) => p.rejected).length,
    fixesVerified: applied.filter((p) => p.fixHolds === true).length,
    pending: applied.filter((p) => p.fixHolds === null).length,
    stillVulnerableAfterPatch: applied.filter((p) => p.fixHolds === false).length,
  };
  log({ agent: "engine", phase: "scorecard", ...scorecard });
  return { map: map.trim(), findings: confirmed, patched, scorecard };
}
