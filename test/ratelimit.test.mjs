import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRateLimit } from "../lib/ratelimit.mjs";

test("each visitor gets a few runs an hour, and all visitors share an hourly cap", () => {
  let now = 0;
  const limit = makeRateLimit({ perClient: 2, global: 3, windowMs: 60_000, clock: () => now });
  assert.equal(limit.take("a").ok, true);
  assert.equal(limit.take("a").ok, true);
  const a3 = limit.take("a");
  assert.equal(a3.ok, false, "a third run from the same visitor is refused");
  assert.ok(a3.retryAfterSec > 0 && a3.retryAfterSec <= 60);
  assert.equal(limit.take("b").ok, true);
  assert.equal(limit.take("c").ok, false, "the shared cap holds across visitors");
});

test("a refused attempt does not use up budget, and the window slides", () => {
  let now = 0;
  const limit = makeRateLimit({ perClient: 1, global: 10, windowMs: 60_000, clock: () => now });
  assert.equal(limit.take("a").ok, true);
  now = 30_000;
  assert.equal(limit.take("a").ok, false);
  now = 60_001;
  assert.equal(limit.take("a").ok, true, "the first run has left the window");
});
