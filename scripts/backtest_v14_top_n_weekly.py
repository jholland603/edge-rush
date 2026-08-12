#!/usr/bin/env python3
"""
Phase 1 backtest v14: does picking only the TOP 2-4 highest-conviction
games per week (by |model_edge|) beat betting everything that clears the
existing fixed 2.0-point threshold?

Jeff's framing (2026-08-11): the goal was never to flag every game that
crosses a bar -- pass_rush_only's fixed-threshold flag rate is ~70% of all
games (10-11 games/week), way more volume than "my best 2-4 spots." This
tests the more selective strategy directly instead of assuming a bigger
edge is automatically a better pick (the by_edge_size breakdown in earlier
backtests hints at this but never isolated it as its own selection rule).

Two selection rules tested, for N in {2, 3, 4}:
  uncapped   -- always take the top N games that week by |model_edge|,
                regardless of how small the largest edges are that week
                (forces a pick even in a flat week).
  threshold-gated -- take the top N games that week by |model_edge|, but
                ONLY from games that already clear the existing 2.0-point
                EDGE_THRESHOLD (bv2.EDGE_THRESHOLD) -- so a quiet week might
                yield 0-4 picks, never forces a bet when nothing clears the
                bar. This is the more conservative, arguably more honest
                version of "my best spots" -- doesn't manufacture confidence
                that isn't there.

All of this runs on pass_rush_only (2 features, no other model changes) --
the version v13 showed wins in every era cut tested. Same walk-forward
predictions as v13, just re-sliced by weekly rank instead of a flat
threshold. Any promising N gets the same by-season robustness check v13
just demonstrated is necessary before trusting an aggregate number.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v6_similarity_weighted as bv6  # noqa: E402

WINDOW = 10
TOP_N_VALUES = [2, 3, 4]


def hit_rate_with_se(wins: pd.Series) -> dict:
    n = len(wins)
    if n == 0:
        return {"n": 0, "hit_rate": None, "se": None}
    hr = float(wins.mean())
    se = float(np.sqrt(hr * (1 - hr) / n)) if n > 1 else None
    return {"n": int(n), "hit_rate": round(hr, 4), "se": round(se, 4) if se is not None else None}


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v14_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading EPA team-games + flat rolling-10 ratings ...")
    epa_tg = bv2.load_team_games(raw_dir)
    flat_epa = bv6.build_entering_ratings(epa_tg, WINDOW)[
        ["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]
    ]
    epa_m = bv2.build_matchups(raw_dir, flat_epa)

    bv2.FEATURES = ["pass_edge", "rush_edge"]
    preds = bv2.walk_forward_predict(epa_m)
    preds["model_edge"] = preds["predicted_margin"] - preds["spread_line"]
    preds["home_cover_margin"] = preds["result"] - preds["spread_line"]
    # drop pushes (can't win/lose a push) -- same convention as bv2.score()
    preds = preds[preds["home_cover_margin"] != 0].copy()
    preds["side"] = np.where(preds["model_edge"] > 0, "home", "away")
    preds["win"] = np.where(preds["side"] == "home", preds["home_cover_margin"] > 0, preds["home_cover_margin"] < 0)
    preds["abs_edge"] = preds["model_edge"].abs()
    print(f"  {len(preds)} scored games (pushes dropped)")

    # -----------------------------------------------------------------
    # Existing fixed-threshold baseline, for reference
    # -----------------------------------------------------------------
    baseline = preds[preds["abs_edge"] >= bv2.EDGE_THRESHOLD]
    baseline_stats = hit_rate_with_se(baseline["win"])
    print(f"\n=== BASELINE: fixed 2.0pt threshold (everything that clears it) ===")
    print(json.dumps(baseline_stats, indent=2))
    print(f"  avg games/week: {len(baseline) / preds[['season','week']].drop_duplicates().shape[0]:.2f}")

    results = {"baseline_fixed_threshold": baseline_stats}

    # -----------------------------------------------------------------
    # Top-N per week, both selection rules
    # -----------------------------------------------------------------
    preds["rank_in_week"] = preds.groupby(["season", "week"])["abs_edge"].rank(method="first", ascending=False)

    for n in TOP_N_VALUES:
        uncapped = preds[preds["rank_in_week"] <= n]
        uncapped_stats = hit_rate_with_se(uncapped["win"])
        avg_edge_uncapped = round(float(uncapped["abs_edge"].mean()), 3)
        print(f"\n=== TOP-{n} per week, UNCAPPED (always pick {n}, any week) ===")
        print(json.dumps(uncapped_stats, indent=2))
        print(f"  avg |edge| of picks: {avg_edge_uncapped}")
        results[f"top_{n}_uncapped"] = {**uncapped_stats, "avg_abs_edge": avg_edge_uncapped}

        gated = preds[(preds["rank_in_week"] <= n) & (preds["abs_edge"] >= bv2.EDGE_THRESHOLD)]
        gated_stats = hit_rate_with_se(gated["win"])
        avg_edge_gated = round(float(gated["abs_edge"].mean()), 3) if len(gated) else None
        weeks_total = preds[["season", "week"]].drop_duplicates().shape[0]
        weeks_with_pick = gated[["season", "week"]].drop_duplicates().shape[0]
        print(f"\n=== TOP-{n} per week, THRESHOLD-GATED (only if edge >= {bv2.EDGE_THRESHOLD}) ===")
        print(json.dumps(gated_stats, indent=2))
        print(f"  avg |edge| of picks: {avg_edge_gated}")
        print(f"  weeks with at least 1 pick: {weeks_with_pick}/{weeks_total} ({weeks_with_pick/weeks_total*100:.1f}%)")
        results[f"top_{n}_threshold_gated"] = {
            **gated_stats, "avg_abs_edge": avg_edge_gated,
            "weeks_with_pick": int(weeks_with_pick), "weeks_total": int(weeks_total),
        }

    # -----------------------------------------------------------------
    # By-season robustness check for the best-looking arm
    # -----------------------------------------------------------------
    best_key = max(
        (k for k in results if k != "baseline_fixed_threshold"),
        key=lambda k: results[k]["hit_rate"] or 0
    )
    print(f"\nBest-looking arm by hit rate: {best_key} ({results[best_key]['hit_rate']})")
    print("Running by-season breakdown before trusting that number (see v13) ...")

    n = int(best_key.split("_")[1])
    if "uncapped" in best_key:
        best_df = preds[preds["rank_in_week"] <= n]
    else:
        best_df = preds[(preds["rank_in_week"] <= n) & (preds["abs_edge"] >= bv2.EDGE_THRESHOLD)]

    by_season = best_df.groupby("season").agg(games=("win", "size"), hit_rate=("win", "mean")).reset_index()
    by_season["hit_rate"] = by_season["hit_rate"].round(4)
    print(f"\n=== {best_key}: hit rate by season ===")
    for r in by_season.itertuples():
        print(f"  {r.season}: n={r.games:3d}  hit={r.hit_rate:.4f}")
    results["best_arm_by_season"] = {"arm": best_key, "by_season": by_season.to_dict(orient="records")}

    # last-8-season cut of the best arm too, since that's the window Jeff
    # and I were just looking at
    recent = best_df[best_df["season"] >= 2018]
    results["best_arm_recent_era_2018_2025"] = hit_rate_with_se(recent["win"])
    print(f"\n{best_key}, 2018-2025 only: {json.dumps(results['best_arm_recent_era_2018_2025'], indent=2)}")

    (out_dir / "summary_v14.json").write_text(json.dumps(results, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v14.json'}")


if __name__ == "__main__":
    main()
