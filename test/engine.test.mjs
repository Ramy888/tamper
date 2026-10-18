import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudit } from "../lib/engine.mjs";
import { CHECKS } from "../lib/checks.mjs";
import { makeFakePayPal } from "./helpers/fake-paypal.mjs";
import { fakeLLM } from "../lib/llm.mjs";

const CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

test("full audit: every flaw found on the weak shop, every patch holds on the fixed shop", async () => {
  const events = [];
  const out = await runAudit({
    pp: makeFakePayPal(),
    llm: fakeLLM((system) => (system.includes("Patcher") ? "Read the capture back with getCapture." : "The shop trusts the client at fulfillment.")),
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
    llm: fakeLLM(() => "a fix"),
    card: CARD,
    approve: async (f) => f.id !== "amount_mismatch", // human rejects one
  });
  assert.equal(out.scorecard.found, CHECKS.length);
  assert.equal(out.scorecard.patched, CHECKS.length - 1, "the rejected patch is not counted");
});
