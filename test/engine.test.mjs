import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudit } from "../lib/engine.mjs";
import { CHECKS } from "../lib/checks.mjs";
import { makeFakePayPal } from "./helpers/fake-paypal.mjs";
import { fakeLLM } from "../lib/llm.mjs";

const CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

// A Patcher that names the correct flag for each flaw (mirrors each check's fixFlag).
const goodPatcher = fakeLLM((system, user) => {
  if (!system.includes("Patcher")) return "The shop trusts the client at fulfillment and in its webhook.";
  const flag = /client-reported|browser's say-so/.test(user) ? "verifyBeforeShip" : /verify-webhook-signature/.test(user) ? "verifyWebhookSig" : "dedupeCaptures";
  return JSON.stringify({ flag, fix: "apply " + flag });
});

test("full audit: every flaw found on the weak shop, every patch holds on the fixed shop", async () => {
  const events = [];
  const out = await runAudit({
    pp: makeFakePayPal(),
    llm: goodPatcher,
    shopSource: "weak shop source",
    card: CARD,
    emit: (e) => events.push(e),
  });

  assert.equal(out.scorecard.checks, CHECKS.length);
  assert.equal(out.scorecard.found, CHECKS.length, "all checks confirm on the weak shop");
  assert.equal(out.scorecard.patched, CHECKS.length, "all approved and patched");
  assert.equal(out.scorecard.stillVulnerableAfterPatch, 0, "no fix fails on the secure shop");

  // The Judge must have emitted a verdict for every check, each carrying PayPal proof ids.
  const verdicts = events.filter((e) => e.agent === "judge");
  assert.equal(verdicts.length, CHECKS.length);
  for (const v of verdicts.filter((v) => v.confirmed)) assert.ok(v.proofIds.length > 0);

  // The Verifier must have confirmed each fix holds.
  const verifs = events.filter((e) => e.agent === "verifier");
  assert.equal(verifs.length, CHECKS.length);
  for (const v of verifs) assert.equal(v.fixHolds, true);
});

test("a rejected patch is not applied and is reported as unpatched", async () => {
  const out = await runAudit({
    pp: makeFakePayPal(),
    llm: goodPatcher,
    shopSource: "weak shop source",
    card: CARD,
    approve: async (f) => f.id !== "amount_mismatch", // human rejects one
  });
  assert.equal(out.scorecard.found, CHECKS.length);
  assert.equal(out.scorecard.patched, CHECKS.length - 1, "the rejected patch is not counted");
  assert.equal(out.scorecard.rejected, 1);
});

// Prove-It: the Patcher's flag choice is causal. If it names the WRONG flag, the Verifier's
// re-run must still find the shop vulnerable — the scorecard cannot read a false "verified".
test("a wrong flag from the Patcher does not pass verification", async () => {
  const wrongPatcher = fakeLLM((system) =>
    system.includes("Patcher") ? JSON.stringify({ flag: "dedupeCaptures", fix: "wrong fix" }) : "recon",
  );
  const out = await runAudit({
    pp: makeFakePayPal(),
    llm: wrongPatcher,
    shopSource: "weak shop source",
    card: CARD,
  });
  // amount_mismatch and browser_trusted_paid are NOT fixed by dedupeCaptures, so they stay vulnerable.
  assert.ok(out.scorecard.stillVulnerableAfterPatch >= 2, "wrong flag leaves flaws vulnerable");
  assert.ok(out.scorecard.fixesVerified < out.scorecard.found, "a wrong fix is never counted as verified");
});
