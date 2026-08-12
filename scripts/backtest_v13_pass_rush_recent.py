#!/usr/bin/env python3
"""
Phase 1 backtest v13: digging into the v12 finding that pass_edge+rush_edge
ALONE (no other features) hit 52.27% in 2018-2025, closer to the 52.38%
breakeven than anything else tested in this project. Before treating that
as anything more than an interesting number, it needs three things v12
didn't check:

1. Is it one or two good seasons carrying the average, or a real pattern
   across the whole recent era? A by-season breakdown answers this
   directly -- an average built from 8 seasons where 6 are mediocre and 2
   are great is a much weaker claim than 8 seasons all clustered near 52%.

2. Does adding QB change back -- the one OTHER feature this project has
   independently validated as real, not just "the two clean ones" --
   help or hurt on top of pass/rush-only, specifically in the recent era?
   This is the actual "how clean should clean be" question.

3. How sensitive is the 52.27% number to exactly where the "recent era"
   line gets drawn? v12 used 2018-2025 somewhat arbitrarily (8 seasons,
   picked as a round number). If last-5 or last-10 tell a very different
   story, that's a sign the 2018-2025 number is fragile, not a real era
   effect.

All comparisons run on the same fair common-game-set discipline as v11/v12.
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
ERA_CUTS = {
    "last_5_2021_2025": list(range(2021, 2026)),
    "last_8_2018_2025": list(range(2018, 2026)),  # the v12 cut
    "last_10_2016_2025": list(range(2016, 2026)),
    "full_history_2002_2025": None,  # None = no filter
}


def run(m: pd.DataFrame, features: list, label: str) -> dict:
    base_features = bv2.FEATURES
    bv2.FEATURES = features
    try:
        preds = bv2.walk_forward_predict(m)
        preds, flagged = bv2.score(preds)
        summary = bv2.summarize(preds, flagged)
    finally:
        bv2.FEATURES = base_features
    print(f"\n=== {label} ===")
    print(json.dumps(summary["overall"], indent=2))
    return summary


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v13_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading EPA team-games + flat rolling-10 ratings ...")
    epa_tg = bv2.load_team_games(raw_dir)
    flat_epa = bv6.build_entering_ratings(epa_tg, WINDOW)[
        ["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]
    ]
    epa_m = bv2.build_matchups(raw_dir, flat_epa)
    print(f"  {len(epa_m)} games with full features")

    # -----------------------------------------------------------------
    # Part 1: pass_rush_only and pass_rush_plus_qb, walk-forward ONCE
    # (full history), then slice the SAME predictions by era -- this is
    # more honest than re-running walk-forward per era cut, since the
    # model itself only ever trains on strictly-prior seasons regardless
    # of which era we're slicing the SCORING window to -- slicing after
    # the fact just changes which already-computed predictions we're
    # averaging, not how they were made.
    # -----------------------------------------------------------------
    results = {}
    for label, features in [
        ("pass_rush_only", ["pass_edge", "rush_edge"]),
        ("pass_rush_plus_qb", ["pass_edge", "rush_edge", "qb_change_home", "qb_change_away"]),
        ("current_full_8", bv2.FEATURES),
    ]:
        base_features = bv2.FEATURES
        bv2.FEATURES = features
        try:
            preds = bv2.walk_forward_predict(epa_m)
            preds, flagged = bv2.score(preds)
        finally:
            bv2.FEATURES = base_features

        era_results = {}
        for era_label, seasons in ERA_CUTS.items():
            if seasons is None:
                p, f = preds, flagged
            else:
                p, f = preds[preds["season"].isin(seasons)], flagged[flagged["season"].isin(seasons)]
            if not len(p):
                continue
            s = bv2.summarize(p, f)
            era_results[era_label] = s["overall"]
        results[label] = era_results
        print(f"\n=== {label}: hit rate by era cut ===")
        for era_label, o in era_results.items():
            se = round(float(np.sqrt(0.5 * 0.5 / o["games_flagged"])), 4) if o["games_flagged"] else None
            print(f"  {era_label:24s} n={o['total_games_scored']:5d} flagged={o['games_flagged']:5d} "
                  f"hit={o['overall_hit_rate']:.4f}  (approx SE={se})")

    # -----------------------------------------------------------------
    # Part 2: by-season breakdown of pass_rush_only for 2016-2025 --
    # is 52.27% (2018-2025) one or two good seasons, or consistent?
    # -----------------------------------------------------------------
    base_features = bv2.FEATURES
    bv2.FEATURES = ["pass_edge", "rush_edge"]
    try:
        preds = bv2.walk_forward_predict(epa_m)
        preds, flagged = bv2.score(preds)
    finally:
        bv2.FEATURES = base_features

    recent = flagged[flagged["season"] >= 2016]
    by_season = (
        recent.groupby("season")
        .agg(games=("model_win", "size"), hit_rate=("model_win", "mean"))
        .reset_index()
    )
    by_season["hit_rate"] = by_season["hit_rate"].round(4)
    print("\n=== pass_rush_only: hit rate by individual season, 2016-2025 ===")
    for r in by_season.itertuples():
        print(f"  {r.season}: n={r.games:3d}  hit={r.hit_rate:.4f}")

    results["pass_rush_only_by_season_2016_2025"] = by_season.to_dict(orient="records")

    (out_dir / "summary_v13.json").write_text(json.dumps(results, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v13.json'}")


if __name__ == "__main__":
    main()
