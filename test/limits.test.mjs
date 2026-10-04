// The drawing limits of shared.mjs: who may start one more drawing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, limitsFrom, refusal, WINDOW_MS, DAY_MS } from "../shared.mjs";

const limits = limitsFrom({});
const now = 1_800_000_000_000;
const ask = (over = {}) => decide({ mine: [], everyone: { count: 0, oldest: undefined }, inProgress: 0, limits, now, ...over });
const ago = (ms, n = 1) => Array.from({ length: n }, (_, i) => now - ms + i);

test("defaults, and overrides from the environment", () => {
  assert.deepEqual(limits, { perVisitor: 5, perVisitorDaily: 25, daily: 500, concurrent: 4 });
  assert.equal(limitsFrom({ SKETCH_IP_LIMIT: "2", SKETCH_DAILY_CAP: "9" }).perVisitor, 2);
  assert.equal(limitsFrom({ SKETCH_IP_LIMIT: "2", SKETCH_DAILY_CAP: "9" }).daily, 9);
});

test("a new visitor may draw", () => {
  assert.equal(ask(), null);
});

test("five in ten minutes is the limit, until the oldest leaves the window", () => {
  assert.equal(ask({ mine: ago(60_000, 4) }), null);
  const refused = ask({ mine: ago(60_000, 5) });
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "rate_limited");
  assert.equal(refused.retryAfter, (WINDOW_MS - 60_000) / 1000);
  assert.equal(ask({ mine: ago(WINDOW_MS + 1, 5) }), null);
});

test("twenty-five in a day is the limit", () => {
  const refused = ask({ mine: ago(2 * 60 * 60_000, 25) });
  assert.equal(refused.code, "rate_limited");
  assert.equal(refused.retryAfter, (DAY_MS - 2 * 60 * 60_000) / 1000);
});

test("the day's total closes the site for everyone", () => {
  assert.equal(ask({ everyone: { count: 499, oldest: now - 1000 } }), null);
  const refused = ask({ everyone: { count: 500, oldest: now - 60 * 60_000 } });
  assert.deepEqual(refused, { status: 503, code: "closed", retryAfter: 23 * 60 * 60 });
});

test("too many in progress asks the visitor to wait a moment", () => {
  assert.deepEqual(ask({ inProgress: 4 }), { status: 503, code: "busy", retryAfter: 10 });
});

test("a visitor's own limit is reported before the site's", () => {
  assert.equal(ask({ mine: ago(60_000, 5), everyone: { count: 500, oldest: now - 1000 }, inProgress: 4 }).code, "rate_limited");
});

test("refusals say how long to wait", () => {
  assert.match(refusal("rate_limited", 540).error.message, /Try again in 9 minutes\.$/);
  assert.match(refusal("rate_limited", 30).error.message, /a minute/);
  assert.match(refusal("rate_limited", 23 * 3600).error.message, /23 hours/);
  assert.equal(refusal("closed").error.code, "closed");
});
