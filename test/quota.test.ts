// The provider's usage box, read from the shape omnirush actually sends (captured from a
// live /device/me at login) — plus the cases where it says nothing useful.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderUsage } from "../src/quota.js";

test("the omnirush usage box is read whole", () => {
  const parsed = parseProviderUsage({
    id: "01a17552",
    email: "someone@example.com",
    usage: {
      grant_date: "2026-10-25",
      period: "day",
      resets_at: "2026-10-26T00:00:00Z",
      day: { allowance: 5_000_000, used: 1_234_567, resets_at: "2026-10-26T00:00:00Z" },
      week: { limit: 15_000_000, used: 4_321_000 },
      pot: { balance: 500_000, credited: 500_000 },
    },
  });
  assert.deepEqual(parsed, {
    used: 1_234_567,
    limit: 5_000_000,
    resetsAt: "2026-10-26T00:00:00Z",
    pot: 500_000,
    weekLimit: 15_000_000,
    weekUsed: 4_321_000,
  });
});

test("a day box without an allowance still reports what it spent", () => {
  const parsed = parseProviderUsage({ usage: { day: { used: 42 } } });
  assert.equal(parsed?.used, 42);
  assert.equal(parsed?.limit, null);
  assert.equal(parsed?.pot, null);
});

test("an answer with no usage says nothing rather than zero", () => {
  assert.equal(parseProviderUsage({ id: "x", email: "y" }), null);
  assert.equal(parseProviderUsage({ usage: {} }), null);
  assert.equal(parseProviderUsage({ usage: { day: {}, pot: {} } }), null);
  assert.equal(parseProviderUsage(null), null);
  assert.equal(parseProviderUsage("nope"), null);
});

test("numbers of the wrong type are ignored, not coerced", () => {
  const parsed = parseProviderUsage({ usage: { day: { used: "many", allowance: 5 }, pot: { balance: Number.NaN } } });
  assert.equal(parsed?.used, null);
  assert.equal(parsed?.limit, 5);
  assert.equal(parsed?.pot, null);
});
