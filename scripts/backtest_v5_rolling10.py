#!/usr/bin/env python3
"""
Phase 1 backtest v5: does the "last N games" rolling-window rating (the idea
now shown live on game.html's Team Comparison / situational cards) actually
correlate with ATS outcomes, and does it add anything the model's existing
full-history EWMA ratings don't already capture?

Two separate questions, tested two different ways:

1. STANDALONE CORRELATION (no model fitting): for several window sizes N,
   build a leak-free rolling-N-game per-play EPA rating per team (same
   pass/rush, offense/defense split as backtest_v2's EWMA), compute each
   game's edge = home_rating - away_rating, and directly correlate that edge
   against the actual ATS margin (result - spread_line) league-wide. This is
   the same style of test as the Big Home Dog sniff test (raw cover rate /
   correlation, no regression) -- "does the team with the better rolling
   window number cover more often."

2. MODEL-FEATURE TEST (walk-forward, following backtest_v4_homedog's exact
   pattern): add the rolling-10 pass/rush edges as two EXTRA features
   alongside the model's existing EWMA-based pass_edge/rush_edge and rerun
   the same walk-forward regression, to see whether the rolling window
   contains information the full-history EWMA doesn't already have.

Reuses backtest_v2's data loading, EWMA ratings, matchup assembly, and
walk-forward/scoring machinery unchanged -- only new code is the rolling
(non-EWMA) rating builder and the two comparison reports.

Scope note: like backtest_v2's own ratings, this uses REGULAR SEASON games
only (raw/team/stats_team_week_*.csv filtered to season_type == "REG" by
load_team_games(), same as every existing backtest in this project). The
live site's rolling-10 window on game.html includes playoffs -- that's a
real, deliberate difference from what's tested here. Keeping this backtest
REG-only keeps it an apples-to-apples comparison against the model's
existing EWMA features (which are also REG-only), and matches the data this
project's other backtests already use. If the playoff-inclusive version
turns out to matter, that would need pulling playoff EPA out of D1 to
extend raw/team/stats_team_week_*.csv, which this does not do.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402

WINDOWS = [5, 8, 10, 15]


# ---------------------------------------------------------------------------
# Rolling (non-EWMA) rating, same shape as bv2.build_ratings()'s output so it
# can be dropped straight into bv2.build_matchups() unmodified.
# ---------------------------------------------------------------------------
def build_rolling_ratings(team_games: pd.DataFrame, window: int) -> pd.DataFrame:
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def rolling_leak_free(group_col):
        # shift(1) excludes the current game -- the rating entering game i
        # only ever averages games strictly before it, min_periods=1 so
        # early-history teams (or the first `window` games of the dataset)
        # get whatever's available rather than NaN, same spirit as the
        # live SQL's "LIMIT N" just returning fewer rows if that's all
        # there is.
        return tg.groupby("team")[group_col].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).mean()
        )

    out = tg[["season", "week", "team", "game_id"]].copy()
    out["r_off_pass"] = rolling_leak_free("off_pass_epa_play")
    out["r_off_rush"] = rolling_leak_free("off_rush_epa_play")
    out["r_def_pass"] = rolling_leak_free("def_pass_epa_play")
    out["r_def_rush"] = rolling_leak_free("def_rush_epa_play")
    return out


def correlation_report(m: pd.DataFrame, label: str) -> dict:
    d = m.dropna(subset=["pass_edge", "rush_edge", "result", "spread_line"]).copy()
    d["combined_edge"] = d["pass_edge"] + d["rush_edge"]
    d["ats_margin"] = d["result"] - d["spread_line"]
    d = d[d["ats_margin"] != 0]  # exclude pushes, same convention as bv2.score()

    def cover_stats(edge_col):
        sub = d[d[edge_col] != 0]
        favored_home = sub[sub[edge_col] > 0]
        favored_away = sub[sub[edge_col] < 0]
        home_cover_when_favored = (favored_home["ats_margin"] > 0).mean() if len(favored_home) else None
        away_cover_when_favored = (favored_away["ats_margin"] < 0).mean() if len(favored_away) else None
        corr = float(np.corrcoef(sub[edge_col], sub["ats_margin"])[0, 1]) if len(sub) > 1 else None
        return {
            "n": int(len(sub)),
            "pearson_r_vs_ats_margin": round(corr, 4) if corr is not None else None,
            "home_cover_rate_when_home_rated_better": round(float(home_cover_when_favored), 4) if home_cover_when_favored is not None else None,
            "away_cover_rate_when_away_rated_better": round(float(away_cover_when_favored), 4) if away_cover_when_favored is not None else None,
            "n_home_rated_better": int(len(favored_home)),
            "n_away_rated_better": int(len(favored_away)),
        }

    return {
        "label": label,
        "total_games": int(len(d)),
        "combined_edge": cover_stats("combined_edge"),
        "pass_edge": cover_stats("pass_edge"),
        "rush_edge": cover_stats("rush_edge"),
    }


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v5_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA (REG season only, same as v2) ...")
    team_games = bv2.load_team_games(raw_dir)

    # -----------------------------------------------------------------
    # Part 1: standalone correlation, several window sizes + EWMA baseline
    # -----------------------------------------------------------------
    print("\n=== Part 1: standalone correlation with ATS outcome ===")
    reports = []

    print("  EWMA baseline (full-history, what the live model actually uses) ...")
    ewma_ratings = bv2.build_ratings(team_games)
    ewma_m = bv2.build_matchups(raw_dir, ewma_ratings)
    reports.append(correlation_report(ewma_m, "ewma_full_history (baseline)"))

    roll10_m = None  # keep the N=10 matchup table around for Part 2
    for n in WINDOWS:
        print(f"  Rolling last-{n}-games ...")
        roll_ratings = build_rolling_ratings(team_games, n)
        roll_m = bv2.build_matchups(raw_dir, roll_ratings)
        reports.append(correlation_report(roll_m, f"rolling_last_{n}"))
        if n == 10:
            roll10_m = roll_m

    for r in reports:
        print(f"\n  {r['label']} (n={r['total_games']}):")
        print(f"    combined edge: r={r['combined_edge']['pearson_r_vs_ats_margin']}, "
              f"home-favored cover={r['combined_edge']['home_cover_rate_when_home_rated_better']} "
              f"(n={r['combined_edge']['n_home_rated_better']}), "
              f"away-favored cover={r['combined_edge']['away_cover_rate_when_away_rated_better']} "
              f"(n={r['combined_edge']['n_away_rated_better']})")

    # -----------------------------------------------------------------
    # Part 2: does rolling-10 add anything to the actual walk-forward model
    # on top of the existing EWMA features?
    # -----------------------------------------------------------------
    print("\n=== Part 2: walk-forward model test (rolling-10 added to existing features) ===")

    print("  Baseline v2 walk-forward (unmodified) ...")
    base_preds = bv2.walk_forward_predict(ewma_m)
    base_preds, base_flagged = bv2.score(base_preds)
    base_summary = bv2.summarize(base_preds, base_flagged)
    print("  baseline:", json.dumps(base_summary["overall"], indent=2))

    roll10_edges = roll10_m[["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].rename(
        columns={"pass_edge": "pass_edge_roll10", "rush_edge": "rush_edge_roll10"}
    )
    combined_m = ewma_m.merge(roll10_edges, on=["game_id", "home_team", "away_team"], how="inner")
    print(f"  {len(combined_m)} games with both EWMA and rolling-10 features")

    bv2.FEATURES = bv2.FEATURES + ["pass_edge_roll10", "rush_edge_roll10"]
    ext_preds = bv2.walk_forward_predict(combined_m)
    ext_preds, ext_flagged = bv2.score(ext_preds)
    ext_summary = bv2.summarize(ext_preds, ext_flagged)
    print("  with rolling-10 added:", json.dumps(ext_summary["overall"], indent=2))
    print("  avg coefficients:", json.dumps(ext_summary["avg_coefficients"], indent=2))

    # -----------------------------------------------------------------
    # write everything out
    # -----------------------------------------------------------------
    out = {
        "correlation_reports": reports,
        "model_feature_test": {
            "baseline_v2_overall": base_summary["overall"],
            "with_rolling10_added_overall": ext_summary["overall"],
            "with_rolling10_added_avg_coefficients": ext_summary["avg_coefficients"],
        },
    }
    (out_dir / "summary_v5.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v5.json'}")


if __name__ == "__main__":
    main()
