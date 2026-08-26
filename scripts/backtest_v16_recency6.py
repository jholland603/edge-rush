#!/usr/bin/env python3
"""
Phase 1 backtest v16: recency-weighted rolling LAST-6-GAMES rating.

Jeff's idea: a power rating that only ever looks at a team's most recent 6
games (not full history, not a 10-game window like v5/v6/v7), with the 6
games inside that window weighted by recency instead of averaged flat:
  - most recent 3 games -> weight 2.0
  - next 2 games        -> weight 1.5
  - oldest (6th) game   -> weight 1.0

Same leak-free convention as every other backtest in this project: the
rating "entering" game i is built only from games strictly before i
(shift(1) then windowed), REG season only, same off/def x pass/rush split
as backtest_v2/v5/v6/v7. This is closest in spirit to backtest_v5's
"rolling_last_N" (a single per-team rating, not per-matchup like v6/v7's
opponent-similarity weighting) -- just with weights inside the window
instead of a flat mean.

Arms tested (mirrors v5/v7's structure so results are comparable):
  1. ewma_full_history        -- the live model's actual baseline (v2 EWMA)
  2. rolling_last_6_flat      -- same 6-game window, flat/unweighted average
                                  (isolates the window-size effect on its own)
  3. rolling_last_6_recency   -- the actual ask: 6-game window, weighted
                                  3 games @2.0 / 2 games @1.5 / 1 game @1.0

Two tests, same as v5/v6/v7:
  1. Standalone correlation vs. ATS outcome (no model fitting) for all
     three arms.
  2. Walk-forward model-feature test: add the recency-weighted-6 pass/rush
     edges as two EXTRA features on top of the model's existing EWMA
     features, see if the walk-forward regression finds them useful on top
     of what full-history EWMA already captures.

Also reports, regardless of outcome (per Jeff's standing ask in v6/v7):
  - how many games are actually available in the window early in a team's
    history (a 6-game window fills up fast -- by design this should have
    fewer "warm-up" games than v5/v6/v7's 10-game window)
  - how much the recency-weighted edge differs from the flat rolling-6 edge
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v5_rolling10 as bv5  # noqa: E402

WINDOW = 6  # Jeff's ask: only the previous 6 games, nothing more


# ---------------------------------------------------------------------------
# Recency tiers, rank-based (rank 1 = most recent game in the window):
#   rank 1-3 (most recent 3) -> 2.0
#   rank 4-5 (next 2)        -> 1.5
#   rank 6   (oldest of the 6) -> 1.0
# Rank-based (not position-based) so a team with fewer than 6 prior games
# still gets sane weights -- e.g. a team with only 4 games of history gets
# its most recent 3 at 2.0 and its oldest 1 at 1.5, no game ever falls
# through un-weighted. Matches the pattern backtest_v7 used for its 10-game
# window (4/3/3 tiers there), just with cutoffs at 3/5 instead of 4/7.
# ---------------------------------------------------------------------------
def recency_multiplier(rank_from_recent: int) -> float:
    if rank_from_recent <= 3:
        return 2.0
    if rank_from_recent <= 5:
        return 1.5
    return 1.0


def recency_weights_for_length(length: int) -> np.ndarray:
    # array ordered oldest -> newest (index 0 = oldest game in the window);
    # rank from most recent for index i is (length - i).
    return np.array([recency_multiplier(length - i) for i in range(length)])


# ---------------------------------------------------------------------------
# Leak-free rolling-6 rating per team/game, either flat or recency-weighted.
# Same output shape as bv5.build_rolling_ratings so it drops straight into
# bv2.build_matchups() unmodified.
# ---------------------------------------------------------------------------
STAT_COLS = {
    "off_pass_epa_play": "r_off_pass",
    "off_rush_epa_play": "r_off_rush",
    "def_pass_epa_play": "r_def_pass",
    "def_rush_epa_play": "r_def_rush",
}


def build_rolling6_ratings(team_games: pd.DataFrame, window: int, weighted: bool) -> pd.DataFrame:
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)
    frames = []
    for team, g in tg.groupby("team"):
        g = g.reset_index(drop=True)
        n = len(g)
        arrs = {c: g[c].to_numpy(dtype=float) for c in STAT_COLS}
        out = {oc: np.full(n, np.nan) for oc in STAT_COLS.values()}
        for i in range(n):
            lo = max(0, i - window)
            L = i - lo  # games available strictly before i, capped at window
            if L == 0:
                continue
            w = recency_weights_for_length(L) if weighted else np.ones(L)
            for c, oc in STAT_COLS.items():
                vals = arrs[c][lo:i]
                valid = ~np.isnan(vals)
                if not valid.any():
                    continue
                vv, ww = vals[valid], w[valid]
                out[oc][i] = float((vv * ww).sum() / ww.sum())
        gg = g[["season", "week", "team", "game_id"]].copy()
        gg["n_in_window"] = [min(i, window) for i in range(n)]
        for oc in STAT_COLS.values():
            gg[oc] = out[oc]
        frames.append(gg)
    return pd.concat(frames, ignore_index=True)


def window_diagnostics(ratings: pd.DataFrame, label: str) -> dict:
    d = ratings.dropna(subset=["r_off_pass"])
    return {
        "label": label,
        "n_team_games": int(len(d)),
        "avg_games_in_window": round(float(d["n_in_window"].mean()), 3),
        "pct_games_window_lt_6": round(float((d["n_in_window"] < WINDOW).mean()), 4),
        "pct_games_window_lt_3": round(float((d["n_in_window"] < 3).mean()), 4),
    }


def edge_shift_report(flat_m: pd.DataFrame, weighted_m: pd.DataFrame, label: str) -> dict:
    f = flat_m[["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].copy()
    f["flat_edge"] = f["pass_edge"] + f["rush_edge"]
    w = weighted_m[["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].copy()
    w["weighted_edge"] = w["pass_edge"] + w["rush_edge"]
    j = f[["game_id", "home_team", "away_team", "flat_edge"]].merge(
        w[["game_id", "home_team", "away_team", "weighted_edge"]],
        on=["game_id", "home_team", "away_team"], how="inner"
    ).dropna()
    diff = (j["weighted_edge"] - j["flat_edge"]).abs()
    corr = float(np.corrcoef(j["flat_edge"], j["weighted_edge"])[0, 1]) if len(j) > 1 else None
    return {
        "label": label,
        "n_games_compared": int(len(j)),
        "corr_flat_vs_weighted_edge": round(corr, 4) if corr is not None else None,
        "mean_abs_edge_shift": round(float(diff.mean()), 4),
        "median_abs_edge_shift": round(float(diff.median()), 4),
    }


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v16_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA (REG season only, same as v2/v5/v6/v7) ...")
    team_games = bv2.load_team_games(raw_dir)

    # -----------------------------------------------------------------
    # Part 1: standalone correlation vs ATS, 3 arms
    # -----------------------------------------------------------------
    print("\n=== Part 1: standalone correlation with ATS outcome ===")
    reports, matchup_tables, rating_tables = [], {}, {}

    print("  ewma_full_history (baseline, what the live model actually uses) ...")
    ewma_ratings = bv2.build_ratings(team_games)
    ewma_m = bv2.build_matchups(raw_dir, ewma_ratings)
    reports.append(bv5.correlation_report(ewma_m, "ewma_full_history (baseline)"))

    print("  rolling_last_6_flat ...")
    flat_ratings = build_rolling6_ratings(team_games, WINDOW, weighted=False)
    flat_m = bv2.build_matchups(raw_dir, flat_ratings)
    matchup_tables["rolling_last_6_flat"] = flat_m
    rating_tables["rolling_last_6_flat"] = flat_ratings
    reports.append(bv5.correlation_report(flat_m, "rolling_last_6_flat"))

    print("  rolling_last_6_recency (3@2.0 / 2@1.5 / 1@1.0) ...")
    rec_ratings = build_rolling6_ratings(team_games, WINDOW, weighted=True)
    rec_m = bv2.build_matchups(raw_dir, rec_ratings)
    matchup_tables["rolling_last_6_recency"] = rec_m
    rating_tables["rolling_last_6_recency"] = rec_ratings
    reports.append(bv5.correlation_report(rec_m, "rolling_last_6_recency"))

    for r in reports:
        print(f"\n  {r['label']} (n={r['total_games']}):")
        print(f"    combined edge: r={r['combined_edge']['pearson_r_vs_ats_margin']}, "
              f"home-favored cover={r['combined_edge']['home_cover_rate_when_home_rated_better']} "
              f"(n={r['combined_edge']['n_home_rated_better']}), "
              f"away-favored cover={r['combined_edge']['away_cover_rate_when_away_rated_better']} "
              f"(n={r['combined_edge']['n_away_rated_better']})")

    print("\n=== Diagnostics: window fill (regardless of ATS result) ===")
    diag_reports = [
        window_diagnostics(rating_tables["rolling_last_6_flat"], "rolling_last_6_flat"),
        window_diagnostics(rating_tables["rolling_last_6_recency"], "rolling_last_6_recency"),
    ]
    for d in diag_reports:
        print(f"  {d['label']}: avg games in window={d['avg_games_in_window']}/{WINDOW}, "
              f"% team-games with <6 avail={d['pct_games_window_lt_6']}, "
              f"% with <3 avail={d['pct_games_window_lt_3']}")

    shift = edge_shift_report(matchup_tables["rolling_last_6_flat"], matchup_tables["rolling_last_6_recency"],
                               "rolling_last_6_recency_vs_flat")
    print("\n=== Edge shift: recency-weighted vs flat, same 6-game window ===")
    print(f"  corr(flat,weighted)={shift['corr_flat_vs_weighted_edge']}, "
          f"mean|shift|={shift['mean_abs_edge_shift']}, median|shift|={shift['median_abs_edge_shift']}")

    # -----------------------------------------------------------------
    # Part 2: walk-forward model-feature test -- does the recency-weighted
    # rolling-6 edge add anything to the model's existing EWMA features?
    # -----------------------------------------------------------------
    print("\n=== Part 2: walk-forward model test (recency-weighted-6 added to existing EWMA features) ===")
    print("  Baseline v2 walk-forward (unmodified) ...")
    base_preds = bv2.walk_forward_predict(ewma_m)
    base_preds, base_flagged = bv2.score(base_preds)
    base_summary = bv2.summarize(base_preds, base_flagged)
    print("  baseline:", json.dumps(base_summary["overall"], indent=2))

    rec_edges = rec_m[["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].rename(
        columns={"pass_edge": "pass_edge_r6", "rush_edge": "rush_edge_r6"}
    )
    combined_m = ewma_m.merge(rec_edges, on=["game_id", "home_team", "away_team"], how="inner").dropna(
        subset=["pass_edge_r6", "rush_edge_r6"]
    )
    print(f"  {len(combined_m)} games with both EWMA and recency-weighted-6 features")

    bv2.FEATURES = bv2.FEATURES + ["pass_edge_r6", "rush_edge_r6"]
    ext_preds = bv2.walk_forward_predict(combined_m)
    ext_preds, ext_flagged = bv2.score(ext_preds)
    ext_summary = bv2.summarize(ext_preds, ext_flagged)
    print("  with recency-weighted-6 added:", json.dumps(ext_summary["overall"], indent=2))
    print("  avg coefficients:", json.dumps(ext_summary["avg_coefficients"], indent=2))

    # -----------------------------------------------------------------
    # Standalone version of the recency-6 model AS A PREDICTOR ON ITS OWN
    # (not just an add-on feature) -- fit predicted_margin = a + b*pass_edge_r6
    # + c*rush_edge_r6 + home-field intercept, same walk-forward discipline,
    # so Jeff can see how a model that ONLY uses the previous 6 games (his
    # actual question) performs standalone, not just as an EWMA add-on.
    # -----------------------------------------------------------------
    print("\n=== Part 3: recency-weighted-6 as a STANDALONE model (not just an EWMA add-on) ===")
    standalone_m = rec_m.dropna(subset=["pass_edge", "rush_edge"]).copy()
    saved_features = bv2.FEATURES
    bv2.FEATURES = ["pass_edge", "rush_edge"]
    standalone_preds = bv2.walk_forward_predict(standalone_m)
    standalone_preds, standalone_flagged = bv2.score(standalone_preds)
    standalone_summary = bv2.summarize(standalone_preds, standalone_flagged)
    bv2.FEATURES = saved_features
    print("  standalone recency-6 model:", json.dumps(standalone_summary["overall"], indent=2))

    out = {
        "window": WINDOW,
        "recency_tiers": "rank 1-3 (most recent 3): 2.0x, rank 4-5 (next 2): 1.5x, rank 6 (oldest): 1.0x",
        "correlation_reports": reports,
        "window_fill_diagnostics": diag_reports,
        "edge_shift_recency_vs_flat": shift,
        "model_feature_test": {
            "baseline_v2_ewma_overall": base_summary["overall"],
            "with_recency6_added_overall": ext_summary["overall"],
            "with_recency6_added_avg_coefficients": ext_summary["avg_coefficients"],
        },
        "standalone_recency6_model_test": {
            "overall": standalone_summary["overall"],
            "by_season": standalone_summary["by_season"],
            "by_edge_size": standalone_summary["by_edge_size"],
            "avg_coefficients": standalone_summary["avg_coefficients"],
        },
    }
    (out_dir / "summary_v16.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir / 'summary_v16.json'}")


if __name__ == "__main__":
    main()
