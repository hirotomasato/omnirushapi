// Routing policy: which account serves, and in what order the rest are tried.
//
// Pure and stateful only in `current` (the smooth round-robin carry), so the order
// is reproducible in tests and survives nothing but the process — by design: a restart
// starts the rotation over instead of persisting a half-finished pick.

export type Strategy = "round-robin" | "least-used";

export interface Candidate {
  id: number;
  /** Lower wins: a lower priority is a better tier, tried before every higher one. */
  priority: number;
  weight: number;
  served: number;
}

export interface RouteState {
  /** Smooth round-robin carry, per account id. */
  current: Map<number, number>;
}

export function createRouteState(): RouteState {
  return { current: new Map() };
}

/** One smooth (nginx-style) weighted pick: everyone accrues, the largest is served. */
function smoothPick(pool: Candidate[], state: RouteState): Candidate {
  let total = 0;
  for (const candidate of pool) {
    total += candidate.weight;
    state.current.set(candidate.id, (state.current.get(candidate.id) ?? 0) + candidate.weight);
  }
  let best = pool[0];
  if (!best) throw new Error("smoothPick needs a non-empty pool");
  for (const candidate of pool) {
    const weight = state.current.get(candidate.id) ?? 0;
    const bestWeight = state.current.get(best.id) ?? 0;
    if (weight > bestWeight || (weight === bestWeight && candidate.id < best.id)) best = candidate;
  }
  state.current.set(best.id, (state.current.get(best.id) ?? 0) - total);
  return best;
}

function leastUsedPick(pool: Candidate[]): Candidate {
  let best = pool[0];
  if (!best) throw new Error("leastUsedPick needs a non-empty pool");
  for (const candidate of pool) {
    const load = candidate.served / Math.max(1, candidate.weight);
    const bestLoad = best.served / Math.max(1, best.weight);
    if (load < bestLoad || (load === bestLoad && candidate.id < best.id)) best = candidate;
  }
  return best;
}

/**
 * The accounts to try, in order: the whole best-priority tier first, then the next,
 * up to `maxAttempts` distinct accounts. The first pick follows `strategy`; the
 * fallbacks are the best of what is left.
 */
export function planAttempts(candidates: Candidate[], strategy: Strategy, state: RouteState, maxAttempts: number): Candidate[] {
  const remaining = candidates.filter((candidate) => candidate.weight > 0);
  const plan: Candidate[] = [];
  while (plan.length < maxAttempts && remaining.length > 0) {
    let tier = remaining[0]?.priority ?? 0;
    for (const candidate of remaining) if (candidate.priority < tier) tier = candidate.priority;
    const pool = remaining.filter((candidate) => candidate.priority === tier);
    const picked = strategy === "least-used" ? leastUsedPick(pool) : smoothPick(pool, state);
    plan.push(picked);
    remaining.splice(remaining.indexOf(picked), 1);
  }
  return plan;
}

/** Whether an upstream failure can be fixed by another account. */
export function isFailoverStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 402 || status === 408 || status === 429 || status >= 500;
}

/** A refusal of the credential itself: the account stays out until an operator clears it. */
export function isCredentialStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// Wording upstreams use when the account, not the request, is the problem. Some answer
// 200 or 400 with one of these instead of a 429, so the status alone cannot tell us.
const LIMIT_SIGNALS = [
  "insufficient_quota",
  "quota_exceeded",
  "quota exceeded",
  "exceeded your current quota",
  "rate_limit",
  "rate limit",
  "too many requests",
  "billing hard limit",
  "credit balance is too low",
  "overloaded_error",
  "capacity",
];

/** Whether an answer's body reads like "this account is out of room", whatever its status. */
export function readsAsAccountLimit(status: number, body: string): boolean {
  if (status === 402 || status === 429) return true;
  if (status !== 400 && status !== 403 && status !== 404 && status !== 200) return false;
  const text = body.toLowerCase();
  return LIMIT_SIGNALS.some((signal) => text.includes(signal));
}
