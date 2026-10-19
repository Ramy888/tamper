import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudit } from "../lib/engine.mjs";
import { CHECKS } from "../lib/checks.mjs";
import { makeFakePayPal, captureEvent } from "./helpers/fake-paypal.mjs";
import { makeInbox } from "../lib/inbox.mjs";
import { fakeLLM } from "../lib/llm.mjs";

const CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

// A Patcher that names the correct flag for each flaw (mirrors each check's fixFlag).
const goodPatcher = fakeLLM((system, user) => {
  if (!system.includes("Patcher")) return "The shop trusts the client at fulfillment and in its webhook.";
  const flag = /catalog price/.test(user) ? "priceFromCatalog" : /retried/.test(user) ? "idempotentCheckout"
    : /client-reported|browser's say-so/.test(user) ? "verifyBeforeShip" : /verify-webhook-signature/.test(user) ? "verifyWebhookSig" : "dedupeCaptures";
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
  // The dashboard titles each finding card from its verdict event alone.
  for (const v of verdicts) assert.equal(v.title, CHECKS.find((c) => c.id === v.check).title, `${v.check} verdict carries its title`);

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

test("hosted: the replay finding and its re-check both use PayPal-signed deliveries", async () => {
  const inbox = makeInbox();
  const pp = makeFakePayPal({ onCapture: (c) => setTimeout(() => inbox.accept(pp.sign(), JSON.stringify(captureEvent(c))), 5) });
  const events = [];
  const out = await runAudit({ pp, llm: goodPatcher, shopSource: "src", card: CARD, inbox, waitMs: 500, emit: (e) => events.push(e) });
  const verdict = events.find((e) => e.agent === "judge" && e.check === "webhook_replay");
  assert.match(verdict.proofIds.join(" "), /PayPal-signed/);
  assert.ok(events.some((e) => e.agent === "verifier" && e.phase === "note" && e.check === "webhook_replay"), "the Verifier's wait is logged too");
  assert.equal(out.scorecard.fixesVerified, CHECKS.length);
});

// Live, the replay stand-in event fails PayPal's signature check. A Patcher that answers
// "verify signatures" for the replay flaw then makes the shop credit nothing at all, which
// must read as pending, never as a verified fix.
test("replay: a fix that only makes the shop reject everything is pending, not verified", async () => {
  const pp = makeFakePayPal();
  pp.verifyWebhook = async () => ({ verification_status: "FAILURE" });
  const sigPatcher = fakeLLM((system) =>
    system.includes("Patcher") ? JSON.stringify({ flag: "verifyWebhookSig", fix: "verify" }) : "recon",
  );
  const events = [];
  await runAudit({ pp, llm: sigPatcher, shopSource: "src", card: CARD, emit: (e) => events.push(e) });
  const v = events.find((e) => e.agent === "verifier" && e.check === "webhook_replay");
  assert.equal(v.phase, "pending");
  assert.notEqual(v.fixHolds, true);
});
