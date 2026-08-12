#!/usr/bin/env python3
"""
Phase 1 backtest v11: a genuinely NEW, minimal model with opponent-adjusted
SCORING as the main driver -- not a 9th feature bolted onto the existing
8-feature model, a replacement for it. Jeff's framing (2026-08-11): "too
much fluff" in the current model, wants something cleaner, scoring as the
main driver, bonus points for weighting scoring against similar opponents.

Why scoring instead of EPA: pass_edge/rush_edge (the current model's core
ratings) measure per-play EFFICIENCY, not points. There's real daylight
between "efficient offense" and "actual points on the board" -- red zone
conversion, special teams and defensive touchdowns, garbage-time discounting
-- that EPA doesn't fully capture. Since ATS outcomes are literally
determined by point margin, an opponent-adjusted scoring rating is a more
direct signal, not just a noisier proxy for the same thing. That's the case
for trying this, not just repeating the existing approach with new inputs.

Data note: unlike pass_edge/rush_edge, this needs nothing but games.csv --
points scored/allowed are directly in the schedule file, no
stats_team_week_*.csv join required. Much lighter dependency than the rest
of this project's features.

Rating construction deliberately mirrors build_entering_ratings() in
backtest_v6_similarity_weighted.py (leak-free trailing window=10, flat
average, matching what's actually live in weekly_update.py) rather than
backtest_v2's older EWMA approach -- this keeps v11 directly comparable to
the v8 rating-only benchmark (51.42% hit rate, pass_edge+rush_edge only,
same window convention) rather than mixing two different rating
methodologies in one comparison.

scoring_edge formula mirrors pass_edge/rush_edge exactly, just swapping in
points for EPA/play:
    scoring_edge = (h_off_points - a_def_points_allowed)
                 - (a_off_points - h_def_points_allowed)
Positive = favors home, same sign convention as every other edge in this
project.

Test plan, one variable at a time (per this project's own standard --
see phase1_results.md on multiple-comparisons risk):
  1. Standalone correlation of scoring_edge vs. ATS margin -- cheap sanity
     check before the expensive walk-forward test.
  2. Walk-forward, scoring_edge ALONE (1 feature) -- compared against a
     freshly-run pass_edge+rush_edge-only baseline (same window convention,
     run in this same script rather than trusting an earlier cached number)
     and the current full 8-feature model.
  3. Walk-forward, scoring_edge + qb_change_home + qb_change_away -- the
     actual "new clean model" candidate (the only other feature this
     project has independently validated as real).
  4. Bonus: opponent-similarity-weighted scoring_edge (same Gaussian kernel
     as backtest_v6, reused directly -- weight each team's last 10 games
     toward opponents whose PAST scoring defense/offense was similar to
     this week's actual opponent), standalone correlation + walk-forward,
     both alone and combined with QB change.
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
BANDWIDTH_MULTIPLIERS = [0.5, 1.0, 2.0, 4.0]  # same grid as v6, flat (uniform) is the non-similarity arm


# ---------------------------------------------------------------------------
# Scoring data -- games.csv only, no team-stats CSV needed
# ---------------------------------------------------------------------------
def load_scoring_games(raw_dir: Path) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["home_score", "away_score"])

    home = games[["season", "week", "game_id", "home_team", "away_team", "home_score", "away_score"]].rename(
        columns={"home_team": "team", "away_team": "opponent_team",
                 "home_score": "off_points", "away_score": "def_points_allowed"}
    )
    away = games[["season", "week", "game_id", "home_team", "away_team", "home_score", "away_score"]].rename(
        columns={"away_team": "team", "home_team": "opponent_team",
                 "away_score": "off_points", "home_score": "def_points_allowed"}
    )
    tg = pd.concat([home, away], ignore_index=True)
    return tg.sort_values(["team", "season", "week"]).reset_index(drop=True)


def build_flat_scoring_ratings(tg: pd.DataFrame, window: int = WINDOW) -> pd.DataFrame:
    tg = tg.sort_values(["team", "season", "week"]).reset_index(drop=True)
    tg["r_off_points"] = tg.groupby("team")["off_points"].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).mean()
    )
    tg["r_def_points_allowed"] = tg.groupby("team")["def_points_allowed"].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).mean()
    )
    return tg


def build_flat_scoring_matchups(raw_dir: Path, ratings: pd.DataFrame) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    home_r = ratings.rename(columns={"team": "home_team", "r_off_points": "h_off", "r_def_points_allowed": "h_def"})
    away_r = ratings.rename(columns={"team": "away_team", "r_off_points": "a_off", "r_def_points_allowed": "a_def"})
    m = games.merge(home_r[["game_id", "home_team", "h_off", "h_def"]], on=["game_id", "home_team"], how="left")
    m = m.merge(away_r[["game_id", "away_team", "a_off", "a_def"]], on=["game_id", "away_team"], how="left")
    m = m.dropna(subset=["h_off", "h_def", "a_off", "a_def"])
    m["scoring_edge"] = (m["h_off"] - m["a_def"]) - (m["a_off"] - m["h_def"])

    qb = bv2.build_qb_change_flags(pd.read_csv(raw_dir / "games.csv", low_memory=False))
    qb_home = qb.rename(columns={"team": "home_team", "qb_change": "qb_change_home"})
    qb_away = qb.rename(columns={"team": "away_team", "qb_change": "qb_change_away"})
    m = m.merge(qb_home[["game_id", "home_team", "qb_change_home"]], on=["game_id", "home_team"], how="left")
    m = m.merge(qb_away[["game_id", "away_team", "qb_change_away"]], on=["game_id", "away_team"], how="left")
    m["qb_change_home"] = m["qb_change_home"].fillna(0).astype(int)
    m["qb_change_away"] = m["qb_change_away"].fillna(0).astype(int)

    return m


# ---------------------------------------------------------------------------
# Bonus: opponent-similarity-weighted scoring rating -- reuses bv6's
# kernel_weighted() directly, just pointed at points instead of EPA.
# ---------------------------------------------------------------------------
def build_entering_scoring_with_opponent(tg: pd.DataFrame, window: int = WINDOW) -> pd.DataFrame:
    tg = build_flat_scoring_ratings(tg, window)
    opp = tg[["game_id", "team", "r_off_points", "r_def_points_allowed"]].rename(
        columns={"team": "opponent_team", "r_off_points": "opp_r_off_points",
                 "r_def_points_allowed": "opp_r_def_points_allowed"}
    )
    tg = tg.merge(opp, on=["game_id", "opponent_team"], how="left")
    return tg


def global_scoring_std(tg: pd.DataFrame) -> float:
    vals = pd.concat([tg["r_off_points"], tg["r_def_points_allowed"]])
    return float(vals.std(skipna=True))


SCORING_ARRAY_COLS = {
    "off_points": "off_points", "def_points_allowed": "def_points_allowed",
    "opp_r_off_points": "opp_r_off_points", "opp_r_def_points_allowed": "opp_r_def_points_allowed",
    "r_off_points": "r_off_points", "r_def_points_allowed": "r_def_points_allowed",
}


def build_scoring_team_arrays(tg: pd.DataFrame):
    team_arrays, pos_lookup = {}, {}
    for t, g in tg.groupby("team"):
        g = g.reset_index(drop=True)
        team_arrays[t] = {k: g[col].to_numpy(dtype=float) for k, col in SCORING_ARRAY_COLS.items()}
        for i, gid in enumerate(g["game_id"].to_numpy()):
            pos_lookup[(t, gid)] = i
    return team_arrays, pos_lookup


def build_similarity_scoring_matchups(games: pd.DataFrame, team_arrays: dict, pos_lookup: dict,
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

        targetA_def, targetA_off = arrA["r_def_points_allowed"][pA], arrA["r_off_points"][pA]
        targetH_def, targetH_off = arrH["r_def_points_allowed"][pH], arrH["r_off_points"][pH]

        # H's offense weighted toward past opponents whose D allowed similar
        # points to what A's D allows; H's D weighted toward past opponents
        # whose offense scored similar to what A's offense scores. Same
        # pattern as bv6's pass/rush kernel, just one axis each instead of
        # two (points scored is one number, not split by pass/rush).
        h_off, ess_h1, n_h1 = bv6.kernel_weighted(
            arrH["opp_r_def_points_allowed"][loH:pH], arrH["off_points"][loH:pH], targetA_def, bandwidth
        )
        h_def, ess_h2, n_h2 = bv6.kernel_weighted(
            arrH["opp_r_off_points"][loH:pH], arrH["def_points_allowed"][loH:pH], targetA_off, bandwidth
        )
        a_off, ess_a1, n_a1 = bv6.kernel_weighted(
            arrA["opp_r_def_points_allowed"][loA:pA], arrA["off_points"][loA:pA], targetH_def, bandwidth
        )
        a_def, ess_a2, n_a2 = bv6.kernel_weighted(
            arrA["opp_r_off_points"][loA:pA], arrA["def_points_allowed"][loA:pA], targetH_off, bandwidth
        )

        scoring_edge = (h_off - a_def) - (a_off - h_def)
        ess_vals = [e for e in [ess_h1, ess_h2, ess_a1, ess_a2] if not np.isnan(e)]
        n_vals = [n_h1, n_h2, n_a1, n_a2]

        rows.append({
            "season": g.season, "week": g.week, "game_id": gid,
            "home_team": H, "away_team": A,
            "result": g.result, "spread_line": g.spread_line,
            "scoring_edge": scoring_edge,
            "avg_ess": float(np.mean(ess_vals)) if ess_vals else np.nan,
            "avg_n_window": float(np.mean(n_vals)),
        })
    return pd.DataFrame(rows)


def corr_report(m: pd.DataFrame, edge_col: str, label: str) -> dict:
    d = m.dropna(subset=[edge_col, "result", "spread_line"])
    ats_margin = d["result"] - d["spread_line"]
    r = float(np.corrcoef(d[edge_col], ats_margin)[0, 1]) if len(d) > 1 else None
    home_better = d[d[edge_col] > 0]
    away_better = d[d[edge_col] < 0]
    home_cover = float((home_better["result"] - home_better["spread_line"] > 0).mean()) if len(home_better) else None
    away_cover = float((away_better["result"] - away_better["spread_line"] < 0).mean()) if len(away_better) else None
    return {
        "label": label, "n_games": int(len(d)),
        "pearson_r_vs_ats_margin": round(r, 4) if r is not None else None,
        "home_cover_rate_when_home_rated_better": round(home_cover, 4) if home_cover is not None else None,
        "n_home_rated_better": int(len(home_better)),
        "away_cover_rate_when_away_rated_better": round(away_cover, 4) if away_cover is not None else None,
        "n_away_rated_better": int(len(away_better)),
    }


def run_walk_forward(m: pd.DataFrame, features: list, label: str) -> dict:
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
    print("avg coefficients:", json.dumps(summary["avg_coefficients"], indent=2))
    return summary


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v11_out")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {}

    # -----------------------------------------------------------------
    # Part 0: benchmarks, run fresh in this script for a clean apples-
    # to-apples comparison (not trusting possibly-stale earlier numbers)
    # -----------------------------------------------------------------
    print("Loading EPA team-games + flat rolling-10 ratings (pass/rush, for benchmarks) ...")
    epa_tg = bv2.load_team_games(raw_dir)
    flat_epa = bv6.build_entering_ratings(epa_tg, WINDOW)[
        ["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]
    ]
    epa_m = bv2.build_matchups(raw_dir, flat_epa)  # reuses bv2's matchup assembly (rest/wind/dome/qb/injury) on flat ratings
    results["benchmark_full_8_feature"] = run_walk_forward(epa_m, bv2.FEATURES, "BENCHMARK: current full 8-feature model (flat rolling-10)")
    results["benchmark_pass_rush_only"] = run_walk_forward(epa_m, ["pass_edge", "rush_edge"], "BENCHMARK: pass_edge + rush_edge only (rating-only, flat rolling-10)")

    # -----------------------------------------------------------------
    # Part 1: flat scoring_edge -- standalone correlation + walk-forward
    # -----------------------------------------------------------------
    print("\nLoading scoring team-games (games.csv only) ...")
    scoring_tg = load_scoring_games(raw_dir)
    flat_scoring_ratings = build_flat_scoring_ratings(scoring_tg, WINDOW)
    flat_scoring_m = build_flat_scoring_matchups(raw_dir, flat_scoring_ratings)
    print(f"  {len(flat_scoring_m)} games with flat scoring_edge")

    results["flat_scoring_correlation"] = corr_report(flat_scoring_m, "scoring_edge", "flat_scoring_edge")
    print("\n=== Part 1: standalone correlation, flat scoring_edge vs ATS margin ===")
    print(json.dumps(results["flat_scoring_correlation"], indent=2))

    results["scoring_only"] = run_walk_forward(flat_scoring_m, ["scoring_edge"], "scoring_edge ALONE (new minimal model, no QB)")
    results["scoring_plus_qb"] = run_walk_forward(
        flat_scoring_m, ["scoring_edge", "qb_change_home", "qb_change_away"],
        "scoring_edge + QB change (the actual 'new clean model' candidate)"
    )

    # -----------------------------------------------------------------
    # Part 2 (bonus): opponent-similarity-weighted scoring_edge
    # -----------------------------------------------------------------
    print("\nBuilding opponent-similarity infrastructure for scoring ...")
    tg_sim = build_entering_scoring_with_opponent(scoring_tg, WINDOW)
    std = global_scoring_std(tg_sim)
    print(f"  global scoring rating std = {std:.4f}")
    team_arrays, pos_lookup = build_scoring_team_arrays(tg_sim)

    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    print("\n=== Part 2: standalone correlation, similarity-weighted scoring_edge, several bandwidths ===")
    sim_corr_reports = []
    sim_tables = {}
    for mult in BANDWIDTH_MULTIPLIERS:
        bw = mult * std
        label = f"similarity_scoring_{mult}x_std"
        mt = build_similarity_scoring_matchups(games, team_arrays, pos_lookup, bw, WINDOW)
        sim_tables[label] = mt
        rep = corr_report(mt, "scoring_edge", label)
        sim_corr_reports.append(rep)
        print(f"  {label}: r={rep['pearson_r_vs_ats_margin']}, n={rep['n_games']}")
    results["similarity_scoring_correlations"] = sim_corr_reports

    best = max(sim_corr_reports, key=lambda r: abs(r["pearson_r_vs_ats_margin"] or 0))
    best_label = best["label"]
    print(f"\nBest similarity bandwidth by |correlation|: {best_label} (r={best['pearson_r_vs_ats_margin']})")
    print(f"  vs. flat scoring_edge: r={results['flat_scoring_correlation']['pearson_r_vs_ats_margin']}")

    best_mt = sim_tables[best_label][["game_id", "home_team", "away_team", "scoring_edge", "avg_ess"]]
    print(f"  avg effective sample size at best bandwidth: {best_mt['avg_ess'].mean():.2f}/10")

    # walk-forward test needs QB change columns too -- pull from flat_scoring_m
    sim_m = best_mt.merge(
        flat_scoring_m[["game_id", "home_team", "away_team", "season", "week", "result", "spread_line",
                         "qb_change_home", "qb_change_away"]],
        on=["game_id", "home_team", "away_team"], how="inner"
    ).dropna(subset=["scoring_edge"])
    print(f"  {len(sim_m)} games with similarity-weighted scoring_edge for walk-forward")

    results["similarity_scoring_only"] = run_walk_forward(
        sim_m, ["scoring_edge"], f"similarity-weighted scoring_edge ALONE (best bandwidth: {best_label})"
    )
    results["similarity_scoring_plus_qb"] = run_walk_forward(
        sim_m, ["scoring_edge", "qb_change_home", "qb_change_away"],
        f"similarity-weighted scoring_edge + QB change (best bandwidth: {best_label})"
    )

    # -----------------------------------------------------------------
    # Part 3: fair, same-sample comparison. The benchmarks above (needs
    # stats_team_week join) and the scoring tests (games.csv only) don't
    # score the exact same set of games -- flat_scoring_m had 6219 games
    # scored vs. epa_m's 5492, ~700 more, likely rows the EPA join drops
    # to NaN somewhere across the years rather than an era/coverage gap
    # (both start scoring at the same season). Restricting every arm to
    # the common game_id intersection removes that as a confound before
    # trusting any of the hit-rate deltas above.
    # -----------------------------------------------------------------
    print("\n=== Part 3: fair comparison, common game_id set across all arms ===")
    common_ids = (
        set(epa_m["game_id"]) & set(flat_scoring_m["game_id"]) & set(sim_m["game_id"])
    )
    print(f"  {len(common_ids)} games common to EPA benchmarks, flat scoring, and similarity scoring")

    epa_common = epa_m[epa_m["game_id"].isin(common_ids)]
    flat_scoring_common = flat_scoring_m[flat_scoring_m["game_id"].isin(common_ids)]
    sim_common = sim_m[sim_m["game_id"].isin(common_ids)]

    results["fair_full_8_feature"] = run_walk_forward(epa_common, bv2.FEATURES, "FAIR (common games): full 8-feature model")
    results["fair_pass_rush_only"] = run_walk_forward(epa_common, ["pass_edge", "rush_edge"], "FAIR (common games): pass_edge + rush_edge only")
    results["fair_scoring_only"] = run_walk_forward(flat_scoring_common, ["scoring_edge"], "FAIR (common games): scoring_edge alone")
    results["fair_scoring_plus_qb"] = run_walk_forward(
        flat_scoring_common, ["scoring_edge", "qb_change_home", "qb_change_away"], "FAIR (common games): scoring_edge + QB change"
    )
    results["fair_similarity_scoring_plus_qb"] = run_walk_forward(
        sim_common, ["scoring_edge", "qb_change_home", "qb_change_away"],
        "FAIR (common games): similarity-weighted scoring_edge + QB change"
    )

    # -----------------------------------------------------------------
    out = {
        k: (v if k in ("flat_scoring_correlation", "similarity_scoring_correlations")
            else {"overall": v["overall"], "avg_coefficients": v["avg_coefficients"]})
        for k, v in results.items()
    }
    (out_dir / "summary_v11.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v11.json'}")


if __name__ == "__main__":
    main()
