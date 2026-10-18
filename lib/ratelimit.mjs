// The public demo's budget: each audit creates real sandbox orders, so a visitor gets a few runs
// an hour and all visitors share an hourly cap. Sliding window; refused attempts cost nothing.
export function makeRateLimit({ perClient = 5, global = 30, windowMs = 60 * 60_000, clock = Date.now } = {}) {
  let runs = []; // { key, at }

  return {
    take(key) {
      const now = clock();
      runs = runs.filter((r) => now - r.at < windowMs);
      const mine = runs.filter((r) => r.key === key);
      const blocking = mine.length >= perClient ? mine : runs.length >= global ? runs : null;
      if (blocking) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((blocking[0].at + windowMs - now) / 1000)) };
      runs.push({ key, at: now });
      return { ok: true };
    },
  };
}
