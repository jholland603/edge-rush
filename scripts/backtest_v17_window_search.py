#!/usr/bin/env python3
"""
Phase 1 backtest v17: does ANY (window size x recency-decay) combination on
a rolling last-N-games rating show a real edge, or does searching over many
combinations just find noise?

Follow-up to v16 (Jeff's specific 6-game / 3-2-1 weighting -- no signal).
Jeff's question: can we find a window + weighting that DOES move the needle?

Honest way to answer that without just p-hacking a hyperparameter grid:

1. SEARCH: build a grid of window sizes x recency-decay strengths. For each
   cell, compute the leak-free rolling rating (same off/def x pass/rush
   split as v2/v5/v6/v7/v16) and its standalone correlation with ATS margin,
   using only "search" seasons (1999-2015 REG, ~half the dataset).
   Recency weighting here is a decay curve weight(rank) = decay^(rank-1)
   (rank 1 = most recent game in the window), which nests v16's simple
   3-tier scheme as one special case and covers everything from flat
   (decay=1.0) to very aggressive recency-only (decay=0.1) in between.

2. NULL BASELINE (multiple-comparisons check): shuffle the ATS-margin
   outcome (breaks any real relationship, keeps the edge values' own
   structure) and rerun the ENTIRE grid search on the shuffled data, many
   times. This answers "if there were truly no signal anywhere in this
   grid, how big a correlation would searching 200+ combinations turn up
   just by chance?" -- the honest yardstick for whether the real best
   combo found in step 1 means anything.

3. HOLDOUT: take the single best combo from the search seasons only, and
   check it OUT OF SAMPLE on seasons the search never saw (2016-2025) --
   both standalone correlation and an actual walk-forward betting-style
   hit rate against the closing line, same discipline as every other
   backtest in this project (refit each season on strictly prior data).

If the search-seasons "winner" doesn't survive both the null-baseline
comparison and the holdout, that's the answer: no, nothing in this family
moves the needle, and picking the best result from a big grid without this
check would have been the mistake.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v5_rolling10 as bv5  # noqa: E402

SEARCH_END_SEASON = 2015   # inclusive -- "search" set used to pick the best combo
HOLDOUT_START_SEASON = 2016  # "holdout" set the search never sees

WINDOWS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 32]
DECAYS = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
N_PERMUTATIONS = 40
RNG_SEED = 20260813  # today's date, for reproducibility

STAT_COLS = {
    "off_pass_epa_play": "r_off_pass",
    "off_rush_epa_play": "r_off_rush",
    "def_pass_epa_play": "r_def_pass",
    "def_rush_epa_play": "r_def_rush",
}


def weights_for_length(length: int, decay: float) -> np.ndarray:
    # oldest -> newest ordering; rank_from_recent for index i (0=oldest) is (length - i)
    ranks = np.array([length - i for i in range(length)])
    return decay ** (ranks - 1)


def build_rolling_ratings(team_games: pd.DataFrame, window: int, decay: float) -> pd.DataFrame:
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)
    frames = []
    for team, g in tg.groupby("team"):
        g = g.reset_index(drop=True)
        n = len(g)
        arrs = {c: g[c].to_numpy(dtype=float) for c in STAT_COLS}
        out = {oc: np.full(n, np.nan) for oc in STAT_COLS.values()}
        for i in range(n):
            lo = max(0, i - window)
            L = i - lo
            if L == 0:
                continue
            w = weights_for_length(L, decay)
            for c, oc in STAT_COLS.items():
                vals = arrs[c][lo:i]
                valid = ~np.isnan(vals)
                if not valid.any():
                    continue
                vv, ww = vals[valid], w[valid]
                out[oc][i] = float((vv * ww).sum() / ww.sum())
        gg = g[["season", "week", "team", "game_id"]].copy()
        for oc in STAT_COLS.values():
            gg[oc] = out[oc]
        frames.append(gg)
    return pd.concat(frames, ignore_index=True)


def build_matchups_lite(games: pd.DataFrame, ratings: pd.DataFrame) -> pd.DataFrame:
    """Just the columns bv5.correlation_report needs -- skips rest/weather/
    QB/injury merges (expensive, irrelevant to standalone correlation) so
    the grid search stays fast."""
    home_r = ratings.rename(columns={
        "team": "home_team", "r_off_pass": "h_off_pass", "r_off_rush": "h_off_rush",
        "r_def_pass": "h_def_pass", "r_def_rush": "h_def_rush",
    })
    away_r = ratings.rename(columns={
        "team": "away_team", "r_off_pass": "a_off_pass", "r_off_rush": "a_off_rush",
        "r_def_pass": "a_def_pass", "r_def_rush": "a_def_rush",
    })
    m = games.merge(home_r[["game_id", "home_team", "h_off_pass", "h_off_rush", "h_def_pass", "h_def_rush"]],
                     on=["game_id", "home_team"], how="left")
    m = m.merge(away_r[["game_id", "away_team", "a_off_pass", "a_off_rush", "a_def_pass", "a_def_rush"]],
                on=["game_id", "away_team"], how="left")
    m = m.dropna(subset=["h_off_pass", "h_off_rush", "a_off_pass", "a_off_rush",
                          "h_def_pass", "h_def_rush", "a_def_pass", "a_def_rush"])
    m["pass_edge"] = (m["h_off_pass"] - m["a_def_pass"]) - (m["a_off_pass"] - m["h_def_pass"])
    m["rush_edge"] = (m["h_off_rush"] - m["a_def_rush"]) - (m["a_off_rush"] - m["h_def_rush"])
    return m


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v17_out")
    out_dir.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    print("Loading team-game pass/rush EPA (REG season only) ...")
    team_games = bv2.load_team_games(raw_dir)

    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])
    games["ats_margin"] = games["result"] - games["spread_line"]
    games = games[games["ats_margin"] != 0]  # exclude pushes
    print(f"  {len(games)} REG games with a result + closing line (pushes excluded)")

    search_games = games[games["season"] <= SEARCH_END_SEASON].copy()
    holdout_games = games[games["season"] >= HOLDOUT_START_SEASON].copy()
    print(f"  search set: {len(search_games)} games (<= {SEARCH_END_SEASON}), "
          f"holdout set: {len(holdout_games)} games (>= {HOLDOUT_START_SEASON})")

    # -----------------------------------------------------------------
    # Step 1: build every (window, decay) rating + its lite matchup table
    # once, keyed for reuse across search/holdout/permutation.
    # -----------------------------------------------------------------
    print(f"\n=== Building {len(WINDOWS)}x{len(DECAYS)}={len(WINDOWS) * len(DECAYS)} rating grid ===")
    combo_edge_search = {}    # (window, decay) -> combined edge array aligned to search_base
    combo_edge_holdout = {}   # (window, decay) -> combined edge array aligned to holdout_base
    search_base = None
    holdout_base = None
    grid_reports = []

    t0 = time.time()
    for window in WINDOWS:
        for decay in DECAYS:
            ratings = build_rolling_ratings(team_games, window, decay)
            m_search = build_matchups_lite(search_games, ratings)
            m_holdout = build_matchups_lite(holdout_games, ratings)

            m_search = m_search.dropna(subset=["pass_edge", "rush_edge"])
            m_holdout = m_holdout.dropna(subset=["pass_edge", "rush_edge"])
            m_search["combined_edge"] = m_search["pass_edge"] + m_search["rush_edge"]
            m_holdout["combined_edge"] = m_holdout["pass_edge"] + m_holdout["rush_edge"]

            if search_base is None:
                search_base = m_search[["game_id", "home_team", "away_team", "ats_margin"]].reset_index(drop=True)
                holdout_base = m_holdout[["game_id", "home_team", "away_team", "ats_margin"]].reset_index(drop=True)

            # align to the common base by game_id/home_team/away_team (grid is
            # ~identical in game coverage across cells -- only the very first
            # game of each team's history ever drops, so this is a formality)
            aligned_s = search_base.merge(
                m_search[["game_id", "home_team", "away_team", "combined_edge"]],
                on=["game_id", "home_team", "away_team"], how="left"
            )
            aligned_h = holdout_base.merge(
                m_holdout[["game_id", "home_team", "away_team", "combined_edge"]],
                on=["game_id", "home_team", "away_team"], how="left"
            )
            combo_edge_search[(window, decay)] = aligned_s["combined_edge"].to_numpy(dtype=float)
            combo_edge_holdout[(window, decay)] = aligned_h["combined_edge"].to_numpy(dtype=float)

    print(f"  grid built in {time.time() - t0:.1f}s")

    # -----------------------------------------------------------------
    # Step 2: real correlations on the search set, vectorized across the
    # whole grid at once.
    # -----------------------------------------------------------------
    combos = list(combo_edge_search.keys())
    E_search = np.column_stack([combo_edge_search[c] for c in combos])  # (n_games, n_combos)
    y_search = search_base["ats_margin"].to_numpy(dtype=float)
    valid_s = ~np.isnan(E_search).any(axis=1)
    E_search_v, y_search_v = E_search[valid_s], y_search[valid_s]
    print(f"  {valid_s.sum()} search games usable across the full grid (all combos have data)")

    def corr_matrix(E, y):
        Ec = E - E.mean(axis=0, keepdims=True)
        yc = y - y.mean()
        num = (Ec * yc[:, None]).sum(axis=0)
        den = np.sqrt((Ec ** 2).sum(axis=0)) * np.sqrt((yc ** 2).sum())
        return num / den

    real_corrs = corr_matrix(E_search_v, y_search_v)
    for c, r in zip(combos, real_corrs):
        grid_reports.append({"window": c[0], "decay": c[1], "search_pearson_r": round(float(r), 4)})
    grid_reports.sort(key=lambda d: abs(d["search_pearson_r"]), reverse=True)

    best = grid_reports[0]
    best_combo = (best["window"], best["decay"])
    print(f"\nBest combo on SEARCH seasons (<= {SEARCH_END_SEASON}): "
          f"window={best_combo[0]}, decay={best_combo[1]} -> r={best['search_pearson_r']}")
    print("Top 10 by |r| on search seasons:")
    for g in grid_reports[:10]:
        print(f"  window={g['window']:>2}, decay={g['decay']:.2f}: r={g['search_pearson_r']}")

    # -----------------------------------------------------------------
    # Step 3: null baseline -- shuffle the search-set ATS outcome, rerun the
    # WHOLE grid, record the best |r| the grid finds on pure noise. Repeat
    # N_PERMUTATIONS times to build a distribution.
    # -----------------------------------------------------------------
    print(f"\n=== Permutation null baseline ({N_PERMUTATIONS} shuffles of the search-set outcome) ===")
    rng = np.random.default_rng(RNG_SEED)
    null_best_abs_r = []
    for p in range(N_PERMUTATIONS):
        y_shuf = rng.permutation(y_search_v)
        corrs = corr_matrix(E_search_v, y_shuf)
        null_best_abs_r.append(float(np.max(np.abs(corrs))))
    null_best_abs_r = np.array(null_best_abs_r)
    real_best_abs_r = abs(best["search_pearson_r"])
    pct_null_exceeding_real = float((null_best_abs_r >= real_best_abs_r).mean())
    print(f"  null 'best of grid' |r|: mean={null_best_abs_r.mean():.4f}, "
          f"median={np.median(null_best_abs_r):.4f}, "
          f"p10={np.quantile(null_best_abs_r, .10):.4f}, p90={np.quantile(null_best_abs_r, .90):.4f}")
    print(f"  real best |r|={real_best_abs_r:.4f} -- "
          f"{pct_null_exceeding_real * 100:.1f}% of {N_PERMUTATIONS} pure-noise searches beat or matched it")

    # -----------------------------------------------------------------
    # Step 4: holdout check -- does the search-set winner hold up on seasons
    # the search never saw?
    # -----------------------------------------------------------------
    print(f"\n=== Holdout check: best combo on seasons >= {HOLDOUT_START_SEASON} (search never saw these) ===")
    edge_h = combo_edge_holdout[best_combo]
    y_h = holdout_base["ats_margin"].to_numpy(dtype=float)
    valid_h = ~np.isnan(edge_h)
    holdout_r = float(np.corrcoef(edge_h[valid_h], y_h[valid_h])[0, 1])
    print(f"  window={best_combo[0]}, decay={best_combo[1]}: "
          f"search r={best['search_pearson_r']}, holdout r={round(holdout_r, 4)} (n={int(valid_h.sum())})")

    # also report the flat (decay=1.0), same-window baseline on holdout, for
    # a same-window sanity comparison (does recency weighting even help vs
    # flat at the winning window, out of sample)
    flat_key = (best_combo[0], 1.0)
    edge_h_flat = combo_edge_holdout[flat_key]
    valid_hf = ~np.isnan(edge_h_flat)
    holdout_r_flat = float(np.corrcoef(edge_h_flat[valid_hf], y_h[valid_hf])[0, 1])
    print(f"  same window, flat (decay=1.0) on holdout: r={round(holdout_r_flat, 4)}")

    # -----------------------------------------------------------------
    # Step 5: walk-forward standalone betting-style test of the winning
    # combo across ALL seasons (refit each season on strictly prior data,
    # same discipline as v2/v5/v6/v7/v16), so Jeff sees an actual hit rate
    # against the closing line, not just a correlation number.
    # -----------------------------------------------------------------
    print(f"\n=== Walk-forward standalone hit-rate test of the search winner (window={best_combo[0]}, decay={best_combo[1]}) ===")
    winner_ratings = build_rolling_ratings(team_games, best_combo[0], best_combo[1])
    winner_m = bv2.build_matchups(raw_dir, winner_ratings)
    saved_features = bv2.FEATURES
    bv2.FEATURES = ["pass_edge", "rush_edge"]
    wf_preds = bv2.walk_forward_predict(winner_m.dropna(subset=["pass_edge", "rush_edge"]))
    wf_preds, wf_flagged = bv2.score(wf_preds)
    wf_summary = bv2.summarize(wf_preds, wf_flagged)
    bv2.FEATURES = saved_features
    print("  overall:", json.dumps(wf_summary["overall"], indent=2))
    print("  by season:")
    for r in wf_summary["by_season"]:
        flag = "  <-- holdout" if r["season"] >= HOLDOUT_START_SEASON else ""
        print(f"    {r}{flag}")

    holdout_rows = [r for r in wf_summary["by_season"] if r["season"] >= HOLDOUT_START_SEASON]
    holdout_games_n = sum(r["games"] for r in holdout_rows)
    holdout_hits = sum(r["games"] * r["hit_rate"] for r in holdout_rows)
    holdout_hit_rate = round(holdout_hits / holdout_games_n, 4) if holdout_games_n else None
    print(f"\n  Holdout-only ({HOLDOUT_START_SEASON}+) walk-forward hit rate: "
          f"{holdout_hit_rate} over {holdout_games_n} flagged games (breakeven 0.5238)")

    out = {
        "search_seasons": f"<= {SEARCH_END_SEASON}",
        "holdout_seasons": f">= {HOLDOUT_START_SEASON}",
        "grid_shape": {"windows": WINDOWS, "decays": DECAYS, "n_combos": len(combos)},
        "top_10_by_search_correlation": grid_reports[:10],
        "bottom_5_by_search_correlation": grid_reports[-5:],
        "permutation_null_baseline": {
            "n_permutations": N_PERMUTATIONS,
            "null_best_of_grid_abs_r_mean": round(float(null_best_abs_r.mean()), 4),
            "null_best_of_grid_abs_r_median": round(float(np.median(null_best_abs_r)), 4),
            "null_best_of_grid_abs_r_p10": round(float(np.quantile(null_best_abs_r, .10)), 4),
            "null_best_of_grid_abs_r_p90": round(float(np.quantile(null_best_abs_r, .90)), 4),
            "real_best_search_abs_r": round(real_best_abs_r, 4),
            "pct_of_null_searches_matching_or_beating_real": round(pct_null_exceeding_real, 4),
        },
        "holdout_check": {
            "winning_combo": {"window": best_combo[0], "decay": best_combo[1]},
            "search_r": best["search_pearson_r"],
            "holdout_r": round(holdout_r, 4),
            "same_window_flat_holdout_r": round(holdout_r_flat, 4),
        },
        "walk_forward_standalone_test": {
            "overall": wf_summary["overall"],
            "by_season": wf_summary["by_season"],
            "holdout_only_hit_rate": holdout_hit_rate,
            "holdout_only_n_games": holdout_games_n,
        },
    }
    (out_dir / "summary_v17.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir / 'summary_v17.json'}")
    print(f"Total runtime: {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
