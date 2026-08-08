#!/usr/bin/env python3
"""
Phase 1 backtest v6: opponent-similarity-weighted rolling-10 ratings.

Jeff's idea: instead of a FLAT average over a team's last 10 games (what
`weekly_update.py` / backtest_v5's "rolling_last_10" actually does), weight
each of those 10 games by how similar that game's opponent was, in the
relevant unit, to the opponent this week. E.g. when rating Team A's pass
OFFENSE for a game against Team B, weight A's last-10 games toward the ones
where A faced a pass DEFENSE similar in quality to B's -- not just take a
flat average of all 10.

This is inherently matchup-specific (unlike a normal power rating, a team
doesn't have one "current rating" -- its weighted rating depends on who it's
about to play), so this file does NOT reuse bv2.build_ratings/build_matchups
for the treatment arm. It builds per-matchup weighted ratings directly.
Still window=10, per Jeff's ask -- only the WEIGHTING within that window
changes, never the window size itself.

Four separate weighted ratings per team per matchup (each with its own
target-similarity axis):
  off_pass  weighted toward past opponents' def_pass  ~ this week's opp def_pass
  off_rush  weighted toward past opponents' def_rush  ~ this week's opp def_rush
  def_pass  weighted toward past opponents' off_pass  ~ this week's opp off_pass
  def_rush  weighted toward past opponents' off_rush  ~ this week's opp off_rush

Weight kernel: Gaussian, weight_i = exp(-(diff_i / bandwidth)^2 / 2), where
diff_i is the gap between a past opponent's rating (AS OF the time that game
was played -- leak-free) and this week's opponent's current rating. Bandwidth
is expressed as a multiple of the global std-dev of the rating scale so it's
comparable across pass/rush/off/def. bandwidth = None (flat/uniform) reproduces
a plain average exactly -- included as a built-in sanity check, should
reproduce backtest_v5's "rolling_last_10" correlation numbers.

Two tests, same structure as v5:
  1. Standalone correlation vs. ATS outcome, for several bandwidths.
  2. Walk-forward model-feature test: does adding the best-bandwidth
     similarity-weighted edges on top of the model's EXISTING EWMA features
     improve on the baseline.

Plus (per Jeff's explicit ask) diagnostic stats reported regardless of
whether the backtest finds an edge:
  - effective sample size (Kish's ESS) of the weighting, per game/bandwidth
    -- i.e. out of up to 10 games, how many "effectively distinct" games
    end up driving the weighted average. This is the honest answer to
    "does this actually do anything, or does it collapse back to ~10."
  - how much the weighted edge typically differs from the flat rolling-10
    edge (if these are nearly identical, the reweighting isn't changing
    predictions much regardless of backtest result).
  - a handful of concrete recent real matchups, flat vs. weighted side by
    side, so the mechanism is checkable by eye, not just by summary stat.

Perf note: the treatment arm is inherently per-matchup (weights depend on
who's actually being played), so it can't be vectorized the way a normal
team-level rating can. Team histories are pre-extracted to plain numpy
arrays once (build_team_arrays) and the game loop indexes into those
directly -- avoids pandas-per-row overhead, keeps a 5-bandwidth x ~7500-game
run to well under a minute.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v5_rolling10 as bv5  # noqa: E402

WINDOW = 10  # fixed per Jeff's ask -- only the weighting changes, not the window
BANDWIDTH_MULTIPLIERS = [0.5, 1.0, 2.0, 4.0, None]  # None = flat/uniform (sanity check)


# ---------------------------------------------------------------------------
# Step 1: leak-free entering rating per (team, game) -- same shape as v5's
# build_rolling_ratings, but also keeps opponent_team and the raw per-game
# stat (needed below) instead of dropping them.
# ---------------------------------------------------------------------------
def build_entering_ratings(team_games: pd.DataFrame, window: int = WINDOW) -> pd.DataFrame:
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def rolling_leak_free(col):
        return tg.groupby("team")[col].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).mean()
        )

    tg["r_off_pass"] = rolling_leak_free("off_pass_epa_play")
    tg["r_off_rush"] = rolling_leak_free("off_rush_epa_play")
    tg["r_def_pass"] = rolling_leak_free("def_pass_epa_play")
    tg["r_def_rush"] = rolling_leak_free("def_rush_epa_play")

    # attach the OPPONENT's entering rating as of that same historical game
    # -- this is "how good was the team I played, at the time I played them"
    opp = tg[["game_id", "team", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]].rename(
        columns={
            "team": "opponent_team",
            "r_off_pass": "opp_r_off_pass",
            "r_off_rush": "opp_r_off_rush",
            "r_def_pass": "opp_r_def_pass",
            "r_def_rush": "opp_r_def_rush",
        }
    )
    tg = tg.merge(opp, on=["game_id", "opponent_team"], how="left")
    return tg


def global_rating_std(tg: pd.DataFrame) -> float:
    vals = pd.concat([tg["r_off_pass"], tg["r_off_rush"], tg["r_def_pass"], tg["r_def_rush"]])
    return float(vals.std(skipna=True))


# ---------------------------------------------------------------------------
# Step 2: pre-extract per-team numpy arrays (fast lookups in the game loop)
# ---------------------------------------------------------------------------
ARRAY_COLS = {
    "off_pass": "off_pass_epa_play", "off_rush": "off_rush_epa_play",
    "def_pass": "def_pass_epa_play", "def_rush": "def_rush_epa_play",
    "opp_r_off_pass": "opp_r_off_pass", "opp_r_off_rush": "opp_r_off_rush",
    "opp_r_def_pass": "opp_r_def_pass", "opp_r_def_rush": "opp_r_def_rush",
    "r_off_pass": "r_off_pass", "r_off_rush": "r_off_rush",
    "r_def_pass": "r_def_pass", "r_def_rush": "r_def_rush",
}


def build_team_arrays(tg: pd.DataFrame):
    team_arrays, pos_lookup = {}, {}
    for t, g in tg.groupby("team"):
        g = g.reset_index(drop=True)
        team_arrays[t] = {k: g[col].to_numpy(dtype=float) for k, col in ARRAY_COLS.items()}
        for i, gid in enumerate(g["game_id"].to_numpy()):
            pos_lookup[(t, gid)] = i
    return team_arrays, pos_lookup


def kernel_weighted(opp_vals: np.ndarray, stat_vals: np.ndarray, target: float, bandwidth):
    """Returns (weighted_rating, effective_sample_size, n_used). NaN rating
    if nothing usable in the window."""
    if opp_vals.size == 0 or np.isnan(target):
        return np.nan, np.nan, 0
    valid = ~np.isnan(opp_vals) & ~np.isnan(stat_vals)
    if not valid.any():
        return np.nan, np.nan, 0
    diffs = opp_vals[valid] - target
    vals = stat_vals[valid]
    n = vals.size
    if bandwidth is None:  # flat/uniform -- the "sanity check" arm
        w = np.ones(n)
    else:
        w = np.exp(-0.5 * (diffs / bandwidth) ** 2)
    wsum = w.sum()
    if wsum <= 1e-9:  # kernel collapsed to ~0 everywhere -- fall back to flat
        w = np.ones(n)
        wsum = float(n)
    rating = float((vals * w).sum() / wsum)
    ess = float((w.sum() ** 2) / (w ** 2).sum())
    return rating, ess, n


def build_similarity_matchups(games: pd.DataFrame, team_arrays: dict, pos_lookup: dict,
                               bandwidth, window: int = WINDOW) -> pd.DataFrame:
    rows = []
    for g in games.itertuples():
        H, A, gid = g.home_team, g.away_team, g.game_id
        keyH, keyA = (H, gid), (A, gid)
        if keyH not in pos_lookup or keyA not in pos_lookup:
            continue
        pH, pA = pos_lookup[keyH], pos_lookup[keyA]
        arrH, arrA = team_arrays[H], team_arrays[A]
        loH, loA = max(0, pH - window), max(0, pA - window)

        targetA_def_pass, targetA_def_rush = arrA["r_def_pass"][pA], arrA["r_def_rush"][pA]
        targetA_off_pass, targetA_off_rush = arrA["r_off_pass"][pA], arrA["r_off_rush"][pA]
        targetH_def_pass, targetH_def_rush = arrH["r_def_pass"][pH], arrH["r_def_rush"][pH]
        targetH_off_pass, targetH_off_rush = arrH["r_off_pass"][pH], arrH["r_off_rush"][pH]

        h_off_pass, ess_h1, n_h1 = kernel_weighted(arrH["opp_r_def_pass"][loH:pH], arrH["off_pass"][loH:pH], targetA_def_pass, bandwidth)
        h_off_rush, ess_h2, n_h2 = kernel_weighted(arrH["opp_r_def_rush"][loH:pH], arrH["off_rush"][loH:pH], targetA_def_rush, bandwidth)
        h_def_pass, ess_h3, n_h3 = kernel_weighted(arrH["opp_r_off_pass"][loH:pH], arrH["def_pass"][loH:pH], targetA_off_pass, bandwidth)
        h_def_rush, ess_h4, n_h4 = kernel_weighted(arrH["opp_r_off_rush"][loH:pH], arrH["def_rush"][loH:pH], targetA_off_rush, bandwidth)

        a_off_pass, ess_a1, n_a1 = kernel_weighted(arrA["opp_r_def_pass"][loA:pA], arrA["off_pass"][loA:pA], targetH_def_pass, bandwidth)
        a_off_rush, ess_a2, n_a2 = kernel_weighted(arrA["opp_r_def_rush"][loA:pA], arrA["off_rush"][loA:pA], targetH_def_rush, bandwidth)
        a_def_pass, ess_a3, n_a3 = kernel_weighted(arrA["opp_r_off_pass"][loA:pA], arrA["def_pass"][loA:pA], targetH_off_pass, bandwidth)
        a_def_rush, ess_a4, n_a4 = kernel_weighted(arrA["opp_r_off_rush"][loA:pA], arrA["def_rush"][loA:pA], targetH_off_rush, bandwidth)

        pass_edge = (h_off_pass - a_def_pass) - (a_off_pass - h_def_pass)
        rush_edge = (h_off_rush - a_def_rush) - (a_off_rush - h_def_rush)

        ess_vals = [e for e in [ess_h1, ess_h2, ess_h3, ess_h4, ess_a1, ess_a2, ess_a3, ess_a4] if not np.isnan(e)]
        n_vals = [n_h1, n_h2, n_h3, n_h4, n_a1, n_a2, n_a3, n_a4]

        rows.append({
            "season": g.season, "week": g.week, "game_id": gid,
            "home_team": H, "away_team": A,
            "result": g.result, "spread_line": g.spread_line,
            "pass_edge": pass_edge, "rush_edge": rush_edge,
            "avg_ess": float(np.mean(ess_vals)) if ess_vals else np.nan,
            "avg_n_window": float(np.mean(n_vals)),
            "min_n_window": int(np.min(n_vals)),
        })

    return pd.DataFrame(rows)


def diagnostics_report(m: pd.DataFrame, label: str) -> dict:
    d = m.dropna(subset=["pass_edge", "rush_edge"])
    return {
        "label": label,
        "n_games": int(len(d)),
        "avg_effective_sample_size": round(float(d["avg_ess"].mean()), 3),
        "median_effective_sample_size": round(float(d["avg_ess"].median()), 3),
        "p10_effective_sample_size": round(float(d["avg_ess"].quantile(0.10)), 3),
        "avg_games_available_in_window": round(float(d["avg_n_window"].mean()), 3),
        "pct_games_window_lt_5": round(float((d["avg_n_window"] < 5).mean()), 4),
    }


def edge_shift_report(flat_m: pd.DataFrame, weighted_m: pd.DataFrame, label: str) -> dict:
    """How much does the weighted combined edge differ from the flat
    rolling-10 combined edge, on the same games?"""
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
        "p90_abs_edge_shift": round(float(diff.quantile(0.90)), 4),
    }


def example_games(flat_m: pd.DataFrame, weighted_m: pd.DataFrame, n: int = 8) -> list:
    """A handful of concrete recent games, flat vs. weighted, for eyeballing."""
    f = flat_m[["game_id", "season", "week", "home_team", "away_team", "pass_edge", "rush_edge"]].copy()
    f["flat_edge"] = f["pass_edge"] + f["rush_edge"]
    w = weighted_m[["game_id", "home_team", "away_team", "pass_edge", "rush_edge", "avg_ess"]].copy()
    w["weighted_edge"] = w["pass_edge"] + w["rush_edge"]
    j = f[["game_id", "season", "week", "home_team", "away_team", "flat_edge"]].merge(
        w[["game_id", "home_team", "away_team", "weighted_edge", "avg_ess"]],
        on=["game_id", "home_team", "away_team"], how="inner"
    ).dropna()
    j["shift"] = (j["weighted_edge"] - j["flat_edge"]).abs()
    recent = j[j["season"] == j["season"].max()].sort_values("shift", ascending=False).head(n)
    out = []
    for r in recent.itertuples():
        out.append({
            "game": f"{r.away_team} @ {r.home_team}", "season": int(r.season), "week": int(r.week),
            "flat_combined_edge": round(r.flat_edge, 3),
            "weighted_combined_edge": round(r.weighted_edge, 3),
            "shift": round(r.shift, 3),
            "avg_effective_sample_size": round(r.avg_ess, 2),
        })
    return out


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v6_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA (REG season only) ...")
    team_games = bv2.load_team_games(raw_dir)

    print("Building leak-free entering ratings + opponent-at-the-time profiles ...")
    tg = build_entering_ratings(team_games, WINDOW)
    std = global_rating_std(tg)
    print(f"  global rating std (pooled off/def x pass/rush) = {std:.4f}")

    print("Pre-extracting per-team numpy arrays ...")
    team_arrays, pos_lookup = build_team_arrays(tg)

    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])
    print(f"  {len(games)} REG games with a result + closing line")

    # -----------------------------------------------------------------
    # Part 1: standalone correlation vs ATS, several bandwidths
    # -----------------------------------------------------------------
    print("\n=== Part 1: standalone correlation with ATS outcome ===")
    corr_reports = []
    diag_reports = []
    matchup_tables = {}

    for mult in BANDWIDTH_MULTIPLIERS:
        bw = None if mult is None else mult * std
        label = "flat_uniform (=rolling_last_10 baseline)" if mult is None else f"bandwidth_{mult}x_std ({bw:.4f})"
        print(f"  {label} ...")
        mt = build_similarity_matchups(games, team_arrays, pos_lookup, bw, WINDOW)
        matchup_tables[label] = mt
        corr_reports.append(bv5.correlation_report(mt, label))
        diag_reports.append(diagnostics_report(mt, label))

    for r in corr_reports:
        print(f"\n  {r['label']} (n={r['total_games']}):")
        print(f"    combined edge: r={r['combined_edge']['pearson_r_vs_ats_margin']}, "
              f"home-favored cover={r['combined_edge']['home_cover_rate_when_home_rated_better']} "
              f"(n={r['combined_edge']['n_home_rated_better']}), "
              f"away-favored cover={r['combined_edge']['away_cover_rate_when_away_rated_better']} "
              f"(n={r['combined_edge']['n_away_rated_better']})")

    print("\n=== Diagnostics: what the weighting actually does (regardless of ATS result) ===")
    for d in diag_reports:
        print(f"  {d['label']}: avg ESS={d['avg_effective_sample_size']}/10, "
              f"median ESS={d['median_effective_sample_size']}, "
              f"avg games in window={d['avg_games_available_in_window']}")

    flat_label = "flat_uniform (=rolling_last_10 baseline)"
    shift_reports = []
    for label, mt in matchup_tables.items():
        if label == flat_label:
            continue
        shift_reports.append(edge_shift_report(matchup_tables[flat_label], mt, label))
    print("\n=== Edge shift vs flat rolling-10 baseline ===")
    for s in shift_reports:
        print(f"  {s['label']}: corr(flat,weighted)={s['corr_flat_vs_weighted_edge']}, "
              f"mean|shift|={s['mean_abs_edge_shift']}, median|shift|={s['median_abs_edge_shift']}, "
              f"p90|shift|={s['p90_abs_edge_shift']}")

    # pick the bandwidth with the best standalone |correlation| (excluding the
    # flat baseline) to carry into the walk-forward model-feature test
    real_corrs = [r for r in corr_reports if r["label"] != flat_label]
    best = max(real_corrs, key=lambda r: abs(r["combined_edge"]["pearson_r_vs_ats_margin"] or 0))
    best_label = best["label"]
    print(f"\nBest standalone bandwidth by |correlation|: {best_label}")

    # -----------------------------------------------------------------
    # Part 2: walk-forward model-feature test (best bandwidth vs baseline)
    # -----------------------------------------------------------------
    print("\n=== Part 2: walk-forward model test (best-bandwidth similarity edges added to existing EWMA features) ===")
    print("  Baseline v2 walk-forward (unmodified) ...")
    ewma_ratings = bv2.build_ratings(team_games)
    ewma_m = bv2.build_matchups(raw_dir, ewma_ratings)
    base_preds = bv2.walk_forward_predict(ewma_m)
    base_preds, base_flagged = bv2.score(base_preds)
    base_summary = bv2.summarize(base_preds, base_flagged)
    print("  baseline:", json.dumps(base_summary["overall"], indent=2))

    sim_edges = matchup_tables[best_label][["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].rename(
        columns={"pass_edge": "pass_edge_sim", "rush_edge": "rush_edge_sim"}
    )
    combined_m = ewma_m.merge(sim_edges, on=["game_id", "home_team", "away_team"], how="inner").dropna(
        subset=["pass_edge_sim", "rush_edge_sim"]
    )
    print(f"  {len(combined_m)} games with both EWMA and similarity-weighted features")

    bv2.FEATURES = bv2.FEATURES + ["pass_edge_sim", "rush_edge_sim"]
    ext_preds = bv2.walk_forward_predict(combined_m)
    ext_preds, ext_flagged = bv2.score(ext_preds)
    ext_summary = bv2.summarize(ext_preds, ext_flagged)
    print("  with similarity-weighted edges added:", json.dumps(ext_summary["overall"], indent=2))
    print("  avg coefficients:", json.dumps(ext_summary["avg_coefficients"], indent=2))

    # -----------------------------------------------------------------
    # example games (best bandwidth vs flat) for eyeballing
    # -----------------------------------------------------------------
    examples = example_games(matchup_tables[flat_label], matchup_tables[best_label])

    out = {
        "window": WINDOW,
        "global_rating_std": round(std, 4),
        "correlation_reports": corr_reports,
        "diagnostics_reports": diag_reports,
        "edge_shift_vs_flat_baseline": shift_reports,
        "best_bandwidth_by_correlation": best_label,
        "model_feature_test": {
            "baseline_v2_overall": base_summary["overall"],
            "with_similarity_weighted_added_overall": ext_summary["overall"],
            "with_similarity_weighted_added_avg_coefficients": ext_summary["avg_coefficients"],
        },
        "example_games_biggest_shift_most_recent_season": examples,
    }
    (out_dir / "summary_v6.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v6.json'}")


if __name__ == "__main__":
    main()
