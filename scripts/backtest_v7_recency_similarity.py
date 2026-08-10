#!/usr/bin/env python3
"""
Phase 1 backtest v7: recency weighting, stacked on top of v6's
opponent-similarity weighting.

Jeff's idea: within the last-10-game window, weight more recent games more
heavily REGARDLESS of opponent similarity -- last 4 games get 2x weight, the
next 3 get 1.5x, the oldest 3 get 1x -- and combine that multiplicatively
with v6's opponent-similarity kernel (last-4/next-3/last-3 recency tiers x
Gaussian similarity kernel = one combined per-game weight). Still window=10,
still leak-free -- only the weighting inside the window changes.

Arms tested, all on the same games/method as v6 for a clean comparison:
  1. flat            -- no recency, no similarity (v6's baseline, recomputed here)
  2. recency_only     -- recency tiers only, no similarity
  3. similarity_only   -- v6's production bandwidth (1.0x std), no recency, for reference
  4-7. combined_{0.5,1.0,2.0,4.0}x_std -- recency tiers x similarity kernel, one
       per bandwidth (production uses 1.0x)

Same two tests as v5/v6: standalone correlation vs. ATS outcome, and a
walk-forward model-feature test using whichever combined arm has the best
standalone correlation. Plus the same diagnostics Jeff asked to always see
regardless of outcome: effective sample size and how much the combined edge
differs from the flat baseline.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v5_rolling10 as bv5  # noqa: E402
import backtest_v6_similarity_weighted as bv6  # noqa: E402

WINDOW = bv6.WINDOW  # 10, fixed per Jeff's ask
BANDWIDTH_MULTIPLIERS = [0.5, 1.0, 2.0, 4.0]


# ---------------------------------------------------------------------------
# Recency tiers: rank 1 = most recent game in the window, rank up to WINDOW
# = oldest. last 4 -> 2x, next 3 -> 1.5x, remaining -> 1x. Works correctly
# for windows shorter than 10 (early-history teams) since it's rank-based,
# not position-based -- e.g. a 6-game window still gives its most recent 4
# games 2x and its oldest 2 games 1.5x, no games ever fall through un-weighted.
# ---------------------------------------------------------------------------
def recency_multiplier(rank_from_recent: int) -> float:
    if rank_from_recent <= 4:
        return 2.0
    if rank_from_recent <= 7:
        return 1.5
    return 1.0


def recency_weights_for_length(length: int) -> np.ndarray:
    # slice is ordered oldest -> newest (index 0 = oldest); rank from most
    # recent for index i is (length - i).
    return np.array([recency_multiplier(length - i) for i in range(length)])


def combined_weighted(opp_vals: np.ndarray, stat_vals: np.ndarray, target: float,
                       bandwidth, recency_arr: np.ndarray, use_similarity: bool):
    """Weighted average combining (optionally) a Gaussian similarity kernel
    with (optionally) the recency tiers, multiplicatively. Returns
    (rating, effective_sample_size)."""
    if stat_vals.size == 0:
        return np.nan, np.nan
    if use_similarity and np.isnan(target):
        return np.nan, np.nan
    valid = ~np.isnan(stat_vals)
    if use_similarity:
        valid = valid & ~np.isnan(opp_vals)
    if not valid.any():
        return np.nan, np.nan
    vals = stat_vals[valid]
    rec = recency_arr[valid]
    if use_similarity:
        diffs = opp_vals[valid] - target
        kern = np.exp(-0.5 * (diffs / bandwidth) ** 2)
    else:
        kern = np.ones(len(vals))
    w = kern * rec
    wsum = w.sum()
    if wsum <= 1e-9:  # kernel collapsed everywhere -- fall back to recency-only, then flat
        w = rec.copy()
        wsum = w.sum()
        if wsum <= 1e-9:
            w = np.ones(len(vals))
            wsum = float(len(vals))
    rating = float((vals * w).sum() / wsum)
    ess = float((w.sum() ** 2) / (w ** 2).sum())
    return rating, ess


def build_combined_matchups(games: pd.DataFrame, team_arrays: dict, pos_lookup: dict,
                             bandwidth, use_similarity: bool, use_recency: bool,
                             window: int = WINDOW) -> pd.DataFrame:
    rows = []
    for g in games.itertuples():
        H, A, gid = g.home_team, g.away_team, g.game_id
        keyH, keyA = (H, gid), (A, gid)
        if keyH not in pos_lookup or keyA not in pos_lookup:
            continue
        pH, pA = pos_lookup[keyH], pos_lookup[keyA]
        arrH, arrA = team_arrays[H], team_arrays[A]
        loH, loA = max(0, pH - window), max(0, pA - window)
        LH, LA = pH - loH, pA - loA

        recH = recency_weights_for_length(LH) if use_recency else np.ones(LH)
        recA = recency_weights_for_length(LA) if use_recency else np.ones(LA)

        targetA_def_pass, targetA_def_rush = arrA["r_def_pass"][pA], arrA["r_def_rush"][pA]
        targetA_off_pass, targetA_off_rush = arrA["r_off_pass"][pA], arrA["r_off_rush"][pA]
        targetH_def_pass, targetH_def_rush = arrH["r_def_pass"][pH], arrH["r_def_rush"][pH]
        targetH_off_pass, targetH_off_rush = arrH["r_off_pass"][pH], arrH["r_off_rush"][pH]

        h_off_pass, ess_h1 = combined_weighted(arrH["opp_r_def_pass"][loH:pH], arrH["off_pass"][loH:pH], targetA_def_pass, bandwidth, recH, use_similarity)
        h_off_rush, ess_h2 = combined_weighted(arrH["opp_r_def_rush"][loH:pH], arrH["off_rush"][loH:pH], targetA_def_rush, bandwidth, recH, use_similarity)
        h_def_pass, ess_h3 = combined_weighted(arrH["opp_r_off_pass"][loH:pH], arrH["def_pass"][loH:pH], targetA_off_pass, bandwidth, recH, use_similarity)
        h_def_rush, ess_h4 = combined_weighted(arrH["opp_r_off_rush"][loH:pH], arrH["def_rush"][loH:pH], targetA_off_rush, bandwidth, recH, use_similarity)

        a_off_pass, ess_a1 = combined_weighted(arrA["opp_r_def_pass"][loA:pA], arrA["off_pass"][loA:pA], targetH_def_pass, bandwidth, recA, use_similarity)
        a_off_rush, ess_a2 = combined_weighted(arrA["opp_r_def_rush"][loA:pA], arrA["off_rush"][loA:pA], targetH_def_rush, bandwidth, recA, use_similarity)
        a_def_pass, ess_a3 = combined_weighted(arrA["opp_r_off_pass"][loA:pA], arrA["def_pass"][loA:pA], targetH_off_pass, bandwidth, recA, use_similarity)
        a_def_rush, ess_a4 = combined_weighted(arrA["opp_r_off_rush"][loA:pA], arrA["def_rush"][loA:pA], targetH_off_rush, bandwidth, recA, use_similarity)

        pass_edge = (h_off_pass - a_def_pass) - (a_off_pass - h_def_pass)
        rush_edge = (h_off_rush - a_def_rush) - (a_off_rush - h_def_rush)

        ess_vals = [e for e in [ess_h1, ess_h2, ess_h3, ess_h4, ess_a1, ess_a2, ess_a3, ess_a4] if not np.isnan(e)]
        n_vals = [LH, LH, LH, LH, LA, LA, LA, LA]

        rows.append({
            "season": g.season, "week": g.week, "game_id": gid,
            "home_team": H, "away_team": A,
            "result": g.result, "spread_line": g.spread_line,
            "pass_edge": pass_edge, "rush_edge": rush_edge,
            "avg_ess": float(np.mean(ess_vals)) if ess_vals else np.nan,
            "avg_n_window": float(np.mean(n_vals)),
        })

    return pd.DataFrame(rows)


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v7_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA (REG season only) ...")
    team_games = bv2.load_team_games(raw_dir)

    print("Building leak-free entering ratings + opponent-at-the-time profiles ...")
    tg = bv6.build_entering_ratings(team_games, WINDOW)
    std = bv6.global_rating_std(tg)
    print(f"  global rating std = {std:.4f}")

    print("Pre-extracting per-team numpy arrays ...")
    team_arrays, pos_lookup = bv6.build_team_arrays(tg)

    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])
    print(f"  {len(games)} REG games with a result + closing line")

    arms = [("flat", None, False, False)]
    arms.append(("recency_only", None, False, True))
    arms.append(("similarity_only_1.0x_std (v6 production)", 1.0 * std, True, False))
    for mult in BANDWIDTH_MULTIPLIERS:
        arms.append((f"combined_{mult}x_std", mult * std, True, True))

    print("\n=== Part 1: standalone correlation with ATS outcome ===")
    corr_reports = []
    diag_reports = []
    matchup_tables = {}
    for label, bandwidth, use_sim, use_rec in arms:
        print(f"  {label} ...")
        mt = build_combined_matchups(games, team_arrays, pos_lookup, bandwidth, use_sim, use_rec, WINDOW)
        matchup_tables[label] = mt
        corr_reports.append(bv5.correlation_report(mt, label))
        d = mt.dropna(subset=["pass_edge", "rush_edge"])
        diag_reports.append({
            "label": label,
            "n_games": int(len(d)),
            "avg_effective_sample_size": round(float(d["avg_ess"].mean()), 3),
            "median_effective_sample_size": round(float(d["avg_ess"].median()), 3),
            "avg_games_available_in_window": round(float(d["avg_n_window"].mean()), 3),
        })

    for r in corr_reports:
        print(f"\n  {r['label']} (n={r['total_games']}):")
        print(f"    combined edge: r={r['combined_edge']['pearson_r_vs_ats_margin']}, "
              f"home-favored cover={r['combined_edge']['home_cover_rate_when_home_rated_better']} "
              f"(n={r['combined_edge']['n_home_rated_better']}), "
              f"away-favored cover={r['combined_edge']['away_cover_rate_when_away_rated_better']} "
              f"(n={r['combined_edge']['n_away_rated_better']})")

    print("\n=== Diagnostics (regardless of ATS result) ===")
    for d in diag_reports:
        print(f"  {d['label']}: avg ESS={d['avg_effective_sample_size']}/10, "
              f"median ESS={d['median_effective_sample_size']}")

    flat_label = "flat"
    shift_reports = []
    for label, mt in matchup_tables.items():
        if label == flat_label:
            continue
        f = matchup_tables[flat_label][["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].copy()
        f["flat_edge"] = f["pass_edge"] + f["rush_edge"]
        w = mt[["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].copy()
        w["weighted_edge"] = w["pass_edge"] + w["rush_edge"]
        j = f[["game_id", "home_team", "away_team", "flat_edge"]].merge(
            w[["game_id", "home_team", "away_team", "weighted_edge"]],
            on=["game_id", "home_team", "away_team"], how="inner"
        ).dropna()
        diff = (j["weighted_edge"] - j["flat_edge"]).abs()
        corr = float(np.corrcoef(j["flat_edge"], j["weighted_edge"])[0, 1]) if len(j) > 1 else None
        shift_reports.append({
            "label": label, "n_games_compared": int(len(j)),
            "corr_flat_vs_weighted_edge": round(corr, 4) if corr is not None else None,
            "mean_abs_edge_shift": round(float(diff.mean()), 4),
            "median_abs_edge_shift": round(float(diff.median()), 4),
        })
    print("\n=== Edge shift vs flat baseline ===")
    for s in shift_reports:
        print(f"  {s['label']}: corr(flat,weighted)={s['corr_flat_vs_weighted_edge']}, "
              f"mean|shift|={s['mean_abs_edge_shift']}, median|shift|={s['median_abs_edge_shift']}")

    combined_arms = [r for r in corr_reports if r["label"].startswith("combined_")]
    best = max(combined_arms, key=lambda r: abs(r["combined_edge"]["pearson_r_vs_ats_margin"] or 0))
    best_label = best["label"]
    print(f"\nBest combined arm by |correlation|: {best_label}")

    print("\n=== Part 2: walk-forward model test (best combined arm added to existing EWMA features) ===")
    print("  Baseline v2 walk-forward (unmodified) ...")
    ewma_ratings = bv2.build_ratings(team_games)
    ewma_m = bv2.build_matchups(raw_dir, ewma_ratings)
    base_preds = bv2.walk_forward_predict(ewma_m)
    base_preds, base_flagged = bv2.score(base_preds)
    base_summary = bv2.summarize(base_preds, base_flagged)
    print("  baseline:", json.dumps(base_summary["overall"], indent=2))

    combo_edges = matchup_tables[best_label][["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].rename(
        columns={"pass_edge": "pass_edge_combo", "rush_edge": "rush_edge_combo"}
    )
    combined_m = ewma_m.merge(combo_edges, on=["game_id", "home_team", "away_team"], how="inner").dropna(
        subset=["pass_edge_combo", "rush_edge_combo"]
    )
    print(f"  {len(combined_m)} games with both EWMA and combined recency+similarity features")

    bv2.FEATURES = bv2.FEATURES + ["pass_edge_combo", "rush_edge_combo"]
    ext_preds = bv2.walk_forward_predict(combined_m)
    ext_preds, ext_flagged = bv2.score(ext_preds)
    ext_summary = bv2.summarize(ext_preds, ext_flagged)
    print("  with combined recency+similarity added:", json.dumps(ext_summary["overall"], indent=2))
    print("  avg coefficients:", json.dumps(ext_summary["avg_coefficients"], indent=2))

    out = {
        "window": WINDOW,
        "global_rating_std": round(std, 4),
        "recency_tiers": "rank 1-4 (most recent): 2x, rank 5-7: 1.5x, rank 8-10: 1x",
        "correlation_reports": corr_reports,
        "diagnostics_reports": diag_reports,
        "edge_shift_vs_flat_baseline": shift_reports,
        "best_combined_bandwidth_by_correlation": best_label,
        "model_feature_test": {
            "baseline_v2_overall": base_summary["overall"],
            "with_combined_added_overall": ext_summary["overall"],
            "with_combined_added_avg_coefficients": ext_summary["avg_coefficients"],
        },
    }
    (out_dir / "summary_v7.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v7.json'}")


if __name__ == "__main__":
    main()
