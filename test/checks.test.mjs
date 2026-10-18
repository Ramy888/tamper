import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS } from "../lib/checks.mjs";
import { makeWeakShop } from "../shop/shop.mjs";
import { makeSecureShop } from "../shop/shop.mjs";
import { makeFakePayPal } from "./helpers/fake-paypal.mjs";

const CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

for (const check of CHECKS) {
  test(`${check.id}: the weak shop is vulnerable`, async () => {
    const pp = makeFakePayPal();
    const res = await check.run({ shop: makeWeakShop(pp), pp, card: CARD });
    assert.equal(res.confirmed, true, `${check.id} should confirm on the weak shop`);
    assert.ok(res.proofIds.length > 0, "a finding carries PayPal proof ids");
  });

  test(`${check.id}: the secure shop is not`, async () => {
    const pp = makeFakePayPal();
    const res = await check.run({ shop: makeSecureShop(pp), pp, card: CARD });
    assert.equal(res.confirmed, false, `${check.id} must not confirm after the fix`);
  });
}

test("every check names a concrete code-level flaw for the Patcher", () => {
  for (const c of CHECKS) assert.ok(c.flaw && c.flaw.length > 10, `${c.id} needs a flaw description`);
});
