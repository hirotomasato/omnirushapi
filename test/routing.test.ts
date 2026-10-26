import assert from "node:assert/strict";
import { test } from "node:test";
import { createRouteState, isCredentialStatus, isFailoverStatus, planAttempts, type Candidate } from "../src/routing.js";

function candidate(id: number, priority: number, weight: number, served = 0): Candidate {
  return { id, priority, weight, served };
}

function picksOver(candidates: Candidate[], strategy: "round-robin" | "least-used", runs: number): number[] {
  const state = createRouteState();
  const picked: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const plan = planAttempts(candidates, strategy, state, 1);
    assert.equal(plan.length, 1);
    picked.push(plan[0]?.id ?? -1);
  }
  return picked;
}

test("equal weights alternate", () => {
  const picks = picksOver([candidate(1, 100, 1), candidate(2, 100, 1)], "round-robin", 4);
  assert.deepEqual(picks, [1, 2, 1, 2]);
});

test("weights are honoured over a full cycle", () => {
  const picks = picksOver([candidate(1, 100, 1), candidate(2, 100, 2)], "round-robin", 6);
  assert.equal(picks.filter((id) => id === 2).length, 4);
  assert.equal(picks.filter((id) => id === 1).length, 2);
  // Weight 2 must not be served as one long block: the two accounts interleave.
  assert.deepEqual(picks, [2, 1, 2, 2, 1, 2]);
});

test("a lower priority tier is exhausted before the next one", () => {
  const plan = planAttempts([candidate(1, 10, 1), candidate(2, 20, 1), candidate(3, 20, 1)], "round-robin", createRouteState(), 3);
  assert.equal(plan[0]?.id, 1);
  assert.deepEqual(new Set(plan.slice(1).map((entry) => entry.id)), new Set([2, 3]));
});

test("the plan never repeats an account and never exceeds the candidates", () => {
  const plan = planAttempts([candidate(1, 100, 1), candidate(2, 100, 1)], "round-robin", createRouteState(), 5);
  assert.equal(plan.length, 2);
  assert.equal(new Set(plan.map((entry) => entry.id)).size, 2);
});

test("a zero-weight account is never picked", () => {
  const plan = planAttempts([candidate(1, 100, 0), candidate(2, 100, 1)], "round-robin", createRouteState(), 2);
  assert.deepEqual(plan.map((entry) => entry.id), [2]);
});

test("least-used divides by weight", () => {
  const plan = planAttempts(
    [candidate(1, 100, 1, 10), candidate(2, 100, 1, 2), candidate(3, 100, 2, 0)],
    "least-used",
    createRouteState(),
    2,
  );
  assert.deepEqual(plan.map((entry) => entry.id), [3, 2]);
});

test("failover covers a refusal or a transient upstream error, not a bad request", () => {
  for (const status of [401, 403, 408, 429, 500, 502, 503]) assert.equal(isFailoverStatus(status), true, `${status}`);
  for (const status of [400, 404, 422]) assert.equal(isFailoverStatus(status), false, `${status}`);
  assert.equal(isCredentialStatus(401), true);
  assert.equal(isCredentialStatus(403), true);
  assert.equal(isCredentialStatus(429), false);
});
