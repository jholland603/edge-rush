/**
 * DraftKings-style salary-cap lineup optimizer. Pure functions, no DOM --
 * kept separate from page-optimizer.js so the algorithm itself can be
 * exercised directly (e.g. from a Node test script) without a browser.
 *
 * Both formats reduce to a knapsack problem: pick players to maximize total
 * projected points, subject to a salary cap and per-slot count constraints.
 * Salaries are always whole $100s on DraftKings, so the cap is bucketed into
 * $100 units (500 buckets for a $50,000 cap) rather than tracked as a raw
 * dollar figure -- keeps the DP state space small enough to solve in a
 * browser in well under a second.
 *
 * Not backtested, same as the rest of the fantasy tooling -- this solves
 * the optimization problem exactly (given the pruning below, which is
 * provably lossless -- see dominance-pruning comment), but "exactly optimal
 * against these projections" is not the same claim as "will score the most
 * points," since the projections themselves are a directional convenience
 * ranking, not a validated model.
 */

const SALARY_CAP = 50000;
const SALARY_BUCKET = 100; // DK salaries are always multiples of 100

/**
 * Removes players from a group that can never be needed, given the group
 * will supply at most `maxSimultaneous` picks to the final lineup (e.g. RB
 * supplies at most 3: 2 natural RB slots + possibly 1 FLEX).
 *
 * A naive single-item dominance check (drop p if some other player is
 * cheaper-and-better) is WRONG here and was an earlier bug in this file:
 * Classic needs *multiple* picks from RB/WR/TE, so a player who's merely
 * "not the best" can still be exactly the right second- or third-best pick
 * -- pairwise dominance alone caught real players that were still needed
 * to fill 2 RB slots, occasionally making a perfectly legal roster look
 * infeasible.
 *
 * The correct generalization (K-dominance): player p can be safely removed
 * only if at least `maxSimultaneous` OTHER DISTINCT players each
 * individually dominate p (cheaper-or-equal salary AND greater-or-equal
 * projected points). Proof sketch: any hypothetical lineup uses at most
 * `maxSimultaneous` players from this group. If p is one of them, at most
 * `maxSimultaneous - 1` OTHER group-mates are also in that lineup. Since at
 * least `maxSimultaneous` distinct dominators of p exist, at least one of
 * them isn't already in the lineup, and swapping it in for p can only help
 * (cheaper-or-equal frees up cap room, and no worse in points) -- so p is
 * never needed. This is what keeps the DP tractable (a position with
 * 200+ candidates usually collapses to a few dozen), without the earlier
 * bug's risk of wrongly discarding a genuinely-needed second/third pick.
 */
function dominancePrune(players, maxSimultaneous) {
  const arr = [...players];
  const kept = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    let dominators = 0;
    for (let j = 0; j < arr.length; j++) {
      if (j === i) continue;
      const q = arr[j];
      if (q.salary <= p.salary && q.projected >= p.projected) {
        dominators++;
        if (dominators >= maxSimultaneous) break;
      }
    }
    if (dominators < maxSimultaneous) kept.push(p);
  }
  return kept;
}

function bucket(salary) {
  return Math.floor(salary / SALARY_BUCKET);
}

const CAP_BUCKETS = Math.floor(SALARY_CAP / SALARY_BUCKET);

/**
 * Classic: 1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX (RB/WR/TE), 1 DST. $50,000 cap.
 *
 * DP state is (qbCount, rbCount, wrCount, teCount, dstCount, flexFilled,
 * salaryBucket) -> best total projected points reachable. Encoded as a
 * single flat array index rather than nested objects, for speed. Players
 * are processed one at a time; for each, every reachable state is offered
 * the choice of skipping the player, or (if eligible and the relevant slot
 * isn't full) taking them into their natural slot or, for RB/WR/TE, into
 * FLEX instead. A parallel `trace` array records which choice produced
 * each state's best value, so the final lineup can be reconstructed by
 * walking backward from the optimal end state -- this needs one trace
 * layer per player, which is only affordable because dominancePrune()
 * already cut the candidate pool down first (a few hundred players * ~96k
 * states would be tens of millions of trace cells; a few dozen players
 * after pruning is a couple million, comfortably fine in a browser tab).
 */
function optimizeClassic(playersByPosition) {
  // maxSimultaneous per group = the most copies of that position the final
  // lineup could ever hold at once (natural slots + FLEX eligibility), since
  // K-dominance pruning is only safe up to that count -- see dominancePrune().
  const groups = {
    QB: dominancePrune(playersByPosition.QB || [], 1),
    RB: dominancePrune(playersByPosition.RB || [], 3), // 2 RB + 1 possible FLEX
    WR: dominancePrune(playersByPosition.WR || [], 4), // 3 WR + 1 possible FLEX
    TE: dominancePrune(playersByPosition.TE || [], 2), // 1 TE + 1 possible FLEX
    DST: dominancePrune(playersByPosition.DST || [], 1),
  };
  // Processing order matters not at all for correctness, only for how the
  // trace table lines up with the player list below.
  const pool = [...groups.QB, ...groups.RB, ...groups.WR, ...groups.TE, ...groups.DST];

  const QB_N = 2, RB_N = 3, WR_N = 4, TE_N = 2, DST_N = 2, FLEX_N = 2; // counts 0..N-1 (i.e. max is N-1)
  const stateSize = QB_N * RB_N * WR_N * TE_N * DST_N * FLEX_N * (CAP_BUCKETS + 1);

  function stateIndex(qb, rb, wr, te, dst, flex, sal) {
    return ((((qb * RB_N + rb) * WR_N + wr) * TE_N + te) * DST_N + dst) * FLEX_N * (CAP_BUCKETS + 1) + flex * (CAP_BUCKETS + 1) + sal;
  }

  let dp = new Float64Array(stateSize).fill(-Infinity);
  dp[stateIndex(0, 0, 0, 0, 0, 0, 0)] = 0;
  // trace[player_i][state] = 0 skip, 1 natural slot, 2 flex slot
  const trace = new Array(pool.length);

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    const sb = bucket(p.salary);
    const next = dp.slice(); // start from "skip everyone so far", improve below
    const choice = new Uint8Array(stateSize); // 0 = skip (default)

    const isFlexEligible = p.position === "RB" || p.position === "WR" || p.position === "TE";

    for (let qb = 0; qb < QB_N; qb++) {
      for (let rb = 0; rb < RB_N; rb++) {
        for (let wr = 0; wr < WR_N; wr++) {
          for (let te = 0; te < TE_N; te++) {
            for (let dst = 0; dst < DST_N; dst++) {
              for (let flex = 0; flex < FLEX_N; flex++) {
                const base = stateIndex(qb, rb, wr, te, dst, flex, 0);
                for (let sal = 0; sal <= CAP_BUCKETS; sal++) {
                  const cur = dp[base + sal];
                  if (cur === -Infinity) continue;
                  const newSal = sal + sb;
                  if (newSal > CAP_BUCKETS) continue;
                  const gained = cur + p.projected;

                  // Natural slot
                  if (p.position === "QB" && qb + 1 < QB_N) {
                    const idx = stateIndex(qb + 1, rb, wr, te, dst, flex, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
                  } else if (p.position === "RB" && rb + 1 < RB_N) {
                    const idx = stateIndex(qb, rb + 1, wr, te, dst, flex, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
                  } else if (p.position === "WR" && wr + 1 < WR_N) {
                    const idx = stateIndex(qb, rb, wr + 1, te, dst, flex, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
                  } else if (p.position === "TE" && te + 1 < TE_N) {
                    const idx = stateIndex(qb, rb, wr, te + 1, dst, flex, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
                  } else if (p.position === "DST" && dst + 1 < DST_N) {
                    const idx = stateIndex(qb, rb, wr, te, dst + 1, flex, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
                  }

                  // Flex slot
                  if (isFlexEligible && flex + 1 < FLEX_N) {
                    const idx = stateIndex(qb, rb, wr, te, dst, flex + 1, newSal);
                    if (gained > next[idx]) { next[idx] = gained; choice[idx] = 2; }
                  }
                }
              }
            }
          }
        }
      }
    }

    trace[i] = choice;
    dp = next;
  }

  // Full roster: exactly 1 QB, 2 RB, 3 WR, 1 TE, 1 DST, 1 FLEX (counts are
  // stored 0-indexed against their max, so "full" is count == N-1).
  let best = -Infinity;
  let bestSal = -1;
  for (let sal = 0; sal <= CAP_BUCKETS; sal++) {
    const v = dp[stateIndex(1, 2, 3, 1, 1, 1, sal)];
    if (v > best) { best = v; bestSal = sal; }
  }
  if (best === -Infinity) return null; // not enough eligible players to fill a legal roster under the cap

  // Walk backward through players to reconstruct which ones were picked.
  let state = [1, 2, 3, 1, 1, 1, bestSal];
  const picks = [];
  for (let i = pool.length - 1; i >= 0; i--) {
    const idx = stateIndex(...state);
    const c = trace[i][idx];
    if (c === 0) continue;
    const p = pool[i];
    const sb = bucket(p.salary);
    if (c === 1) {
      picks.push({ ...p, slot: p.position });
      if (p.position === "QB") state[0]--;
      else if (p.position === "RB") state[1]--;
      else if (p.position === "WR") state[2]--;
      else if (p.position === "TE") state[3]--;
      else if (p.position === "DST") state[4]--;
    } else {
      picks.push({ ...p, slot: "FLEX" });
      state[5]--;
    }
    state[6] -= sb;
  }

  return {
    lineup: picks,
    totalSalary: picks.reduce((s, p) => s + p.salary, 0),
    totalProjected: picks.reduce((s, p) => s + p.projected, 0),
  };
}

/**
 * Showdown/Captain Mode: 1 Captain (any position, salary and points both
 * *1.5) + 5 FLEX (any position, no slot restrictions -- single-game
 * slates). $50,000 cap. Every player can be considered as either role but
 * only used once. Dominance pruning still applies (same reasoning as
 * Classic), just against the combined pool since there's no position
 * split here.
 */
function optimizeShowdown(allPlayers) {
  // 1 Captain + 5 FLEX = 6 total roster spots any player could occupy.
  const pool = dominancePrune(allPlayers, 6);

  const FLEX_N = 6; // counts 0..5
  const stateSize = 2 * FLEX_N * (CAP_BUCKETS + 1); // captainFilled(0/1) * flexCount * salary

  function stateIndex(cap, flex, sal) {
    return (cap * FLEX_N + flex) * (CAP_BUCKETS + 1) + sal;
  }

  let dp = new Float64Array(stateSize).fill(-Infinity);
  dp[stateIndex(0, 0, 0)] = 0;
  const trace = new Array(pool.length);

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    const captainSalBucket = bucket(Math.round(p.salary * 1.5 / SALARY_BUCKET) * SALARY_BUCKET);
    const captainPts = p.projected * 1.5;
    const flexSalBucket = bucket(p.salary);

    const next = dp.slice();
    const choice = new Uint8Array(stateSize); // 0 skip, 1 captain, 2 flex

    for (let cap = 0; cap < 2; cap++) {
      for (let flex = 0; flex < FLEX_N; flex++) {
        for (let sal = 0; sal <= CAP_BUCKETS; sal++) {
          const cur = dp[stateIndex(cap, flex, sal)];
          if (cur === -Infinity) continue;

          if (cap === 0) {
            const newSal = sal + captainSalBucket;
            if (newSal <= CAP_BUCKETS) {
              const idx = stateIndex(1, flex, newSal);
              const gained = cur + captainPts;
              if (gained > next[idx]) { next[idx] = gained; choice[idx] = 1; }
            }
          }
          if (flex + 1 < FLEX_N) {
            const newSal = sal + flexSalBucket;
            if (newSal <= CAP_BUCKETS) {
              const idx = stateIndex(cap, flex + 1, newSal);
              const gained = cur + p.projected;
              if (gained > next[idx]) { next[idx] = gained; choice[idx] = 2; }
            }
          }
        }
      }
    }

    trace[i] = choice;
    dp = next;
  }

  let best = -Infinity;
  let bestSal = -1;
  for (let sal = 0; sal <= CAP_BUCKETS; sal++) {
    const v = dp[stateIndex(1, 5, sal)];
    if (v > best) { best = v; bestSal = sal; }
  }
  if (best === -Infinity) return null;

  let state = [1, 5, bestSal];
  const picks = [];
  for (let i = pool.length - 1; i >= 0; i--) {
    const idx = stateIndex(...state);
    const c = trace[i][idx];
    if (c === 0) continue;
    const p = pool[i];
    if (c === 1) {
      picks.push({ ...p, slot: "CPT", salary: Math.round(p.salary * 1.5 / SALARY_BUCKET) * SALARY_BUCKET, projected: p.projected * 1.5 });
      state[0]--;
      state[2] -= bucket(Math.round(p.salary * 1.5 / SALARY_BUCKET) * SALARY_BUCKET);
    } else {
      picks.push({ ...p, slot: "FLEX" });
      state[1]--;
      state[2] -= bucket(p.salary);
    }
  }

  return {
    lineup: picks,
    totalSalary: picks.reduce((s, p) => s + p.salary, 0),
    totalProjected: picks.reduce((s, p) => s + p.projected, 0),
  };
}

const OptimizerCore = { SALARY_CAP, SALARY_BUCKET, dominancePrune, optimizeClassic, optimizeShowdown };

if (typeof module !== "undefined" && module.exports) {
  module.exports = OptimizerCore;
} else {
  window.OptimizerCore = OptimizerCore;
}
