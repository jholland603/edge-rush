#!/usr/bin/env python3
"""
Phase 1 backtest v15: multi-position "stud player" injury value.

Jeff's framing (2026-08-11): a value-weighted injury feature shouldn't stop
at the QB -- a bell-cow RB, a true WR1, a double-digit-sack pass rusher, or
even an elite kicker missing should register as a bigger deal than a
backup long-snapper. backtest_v9 already applied this logic to skill
positions via trailing PPR fantasy points, but it explicitly EXCLUDED QBs
(qb_change_home/away already existed as a separate binary flag) and had no
answer at all for pass-rushers or kickers (fantasy_points_ppr doesn't score
either). This tests a genuinely broader version, one bucket per position
group, each with its own value metric since PPR doesn't apply to defense:

  qb      -- trailing sum of passing_epa
  rb      -- trailing sum of rushing_epa (RB + FB)
  wr_te   -- trailing sum of receiving_epa (WR + TE)
  front7  -- trailing sum of a pressure composite:
             def_sacks + 0.75*def_qb_hits + 0.5*def_tackles_for_loss
             (DE/DT/DL/NT/LB/ILB/OLB/MLB -- "pass rusher" per Jeff's framing,
             widened to the whole front seven since a run-stuffing off-ball
             backer racking up TFLs is the same kind of front-seven
             difference-maker, not a separate category worth its own bucket)
  kicker  -- trailing sum of fantasy_points (the only per-player metric
             nflverse computes that scores a kicker's FG/PAT production)

To make positions comparable on one scale (an elite WR's receiving_epa and
an elite pass rusher's sack count are totally different units), each
player's trailing value is z-scored against the full-sample mean/std of
players in their OWN bucket -- "value" becomes "how many standard
deviations above their position's average player is this guy," not raw
EPA/sack counts. That z-score is a fixed normalization constant computed
once over the whole sample (like VALUE_WINDOW or EDGE_THRESHOLD elsewhere
in this project) -- it doesn't use game outcomes, but it IS computed over
the full 2009-2025 sample rather than an expanding window, a disclosed
(minor) simplification worth knowing about.

Injury report data only goes back to 2009 (nflverse), so this whole test
runs on 2009-2025 REG season games only -- a smaller, more recent sample
than the 2002-2025 (or full-history) windows most other backtests in this
project use. The baseline (pass_edge+rush_edge alone, today's live model)
is recomputed on this SAME 2009-2025 window for a fair comparison, not
borrowed from the fuller-history numbers reported elsewhere in this
project.

Variants tested, all layered on top of pass_edge+rush_edge:
  1. Each position bucket's edge alone (5 separate single-feature tests) --
     lets us see whether any ONE position actually carries signal, rather
     than only ever looking at a blended number.
  2. All 5 position edges together.
  3. One combined z-score sum ("stud_value_edge") -- the single-number
     version, in case a clean unified feature matters more than being able
     to attribute the effect to a specific position.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v6_similarity_weighted as bv6  # noqa: E402

WINDOW = 10        # rolling EPA window, matches the live model
VALUE_WINDOW = 8   # trailing player-value window, matches v9 / QB precedent

POSITION_BUCKETS = {
    "qb": {"QB"},
    "rb": {"RB", "FB"},
    "wr_te": {"WR", "TE"},
    "front7": {"DE", "DT", "DL", "NT", "LB", "ILB", "OLB", "MLB"},
    "kicker": {"K"},
}

VALUE_METRIC = {
    "qb": "passing_epa",
    "rb": "rushing_epa",
    "wr_te": "receiving_epa",
    "front7": "_pressure_composite",
    "kicker": "fantasy_points",
}


def load_player_weeks(raw_dir: Path) -> pd.DataFrame:
    files = sorted((raw_dir / "player").glob("stats_player_week_*.csv"))
    needed = {"player_id", "position", "season", "week", "season_type",
              "passing_epa", "rushing_epa", "receiving_epa", "fantasy_points",
              "def_sacks", "def_qb_hits", "def_tackles_for_loss"}
    dfs = []
    for f in files:
        df = pd.read_csv(f, low_memory=False, usecols=lambda c: c in needed)
        dfs.append(df[df["season_type"] == "REG"])
    p = pd.concat(dfs, ignore_index=True)
    p["_pressure_composite"] = (
        p["def_sacks"].fillna(0) + 0.75 * p["def_qb_hits"].fillna(0)
        + 0.5 * p["def_tackles_for_loss"].fillna(0)
    )
    return p


def build_bucket_trailing_zscore(p: pd.DataFrame, positions: set, metric: str,
                                  window: int = VALUE_WINDOW) -> pd.DataFrame:
    sub = p[p["position"].isin(positions)].copy()
    sub = sub.sort_values(["player_id", "season", "week"]).reset_index(drop=True)
    sub["trailing_value"] = sub.groupby("player_id")[metric].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).mean()
    )
    mu = sub["trailing_value"].mean()
    sd = sub["trailing_value"].std()
    sub["value_z"] = (sub["trailing_value"] - mu) / sd if sd and sd > 1e-9 else 0.0
    return sub[["player_id", "season", "week", "value_z"]]


def build_bucket_out_edge(raw_dir: Path, bucket_value: pd.DataFrame, positions: set) -> pd.DataFrame:
    """Same 'final report, Out status, as-of merge' pattern as v9's
    build_value_injury_counts, restricted to this bucket's positions."""
    inj_dir = raw_dir / "injuries"
    files = sorted(inj_dir.glob("injuries_*.csv"))
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[(df["game_type"] == "REG") & (df["position"].isin(positions))]

    df["date_modified"] = pd.to_datetime(df["date_modified"], errors="coerce")
    df = df.sort_values("date_modified")
    df = df.drop_duplicates(subset=["season", "week", "team", "gsis_id"], keep="last")
    df = df[df["report_status"] == "Out"]

    df["sort_key"] = df["season"] * 100 + df["week"]
    bv = bucket_value.rename(columns={"player_id": "gsis_id"}).copy()
    bv["sort_key"] = bv["season"] * 100 + bv["week"]
    df = df.sort_values("sort_key")
    bv = bv.sort_values("sort_key")
    df = pd.merge_asof(
        df, bv[["gsis_id", "sort_key", "value_z"]],
        on="sort_key", by="gsis_id", direction="backward"
    )
    df["value_z"] = df["value_z"].fillna(0.0)  # no trailing history -> replacement-level (avg)

    out = df.groupby(["season", "week", "team"])["value_z"].sum().rename("value_out").reset_index()
    return out


def attach_edge(m: pd.DataFrame, out: pd.DataFrame, col_name: str) -> pd.DataFrame:
    home = out.rename(columns={"team": "home_team", "value_out": "home_v"})
    away = out.rename(columns={"team": "away_team", "value_out": "away_v"})
    m = m.merge(home, on=["season", "week", "home_team"], how="left")
    m = m.merge(away, on=["season", "week", "away_team"], how="left")
    m["home_v"] = m["home_v"].fillna(0.0)
    m["away_v"] = m["away_v"].fillna(0.0)
    m[col_name] = m["away_v"] - m["home_v"]
    return m.drop(columns=["home_v", "away_v"])


def hit_rate_with_se(flagged: pd.DataFrame) -> dict:
    n = len(flagged)
    if n == 0:
        return {"n": 0, "hit_rate": None, "se": None}
    hr = float(flagged["model_win"].mean())
    se = float(np.sqrt(hr * (1 - hr) / n))
    return {"n": n, "hit_rate": round(hr, 4), "se": round(se, 4)}


def run(m: pd.DataFrame, features: list, label: str):
    base = list(bv2.FEATURES)
    bv2.FEATURES = features
    try:
        preds = bv2.walk_forward_predict(m)
        preds, flagged = bv2.score(preds)
    finally:
        bv2.FEATURES = base
    stats = hit_rate_with_se(flagged)
    print(f"\n=== {label} ===")
    print(json.dumps(stats, indent=2))
    return stats, preds, flagged


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v15_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game EPA + flat rolling-10 ratings (matches the live model) ...")
    epa_tg = bv2.load_team_games(raw_dir)
    flat_epa = bv6.build_entering_ratings(epa_tg, WINDOW)[
        ["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]
    ]
    m = bv2.build_matchups(raw_dir, flat_epa)
    # Injury data starts 2009 -- restrict the WHOLE comparison (baseline
    # included) to this window, so it's a fair test rather than comparing
    # against a baseline number borrowed from a longer history this
    # feature can't actually use.
    m = m[m["season"] >= 2009].copy()
    print(f"  {len(m)} games, 2009-2025, with pass_edge/rush_edge")

    print("Loading player-week production (1999-2025, all positions needed for trailing value) ...")
    p = load_player_weeks(raw_dir)
    print(f"  {len(p)} player-week rows")

    edge_cols = []
    for bucket, positions in POSITION_BUCKETS.items():
        print(f"Building {bucket} trailing z-score + Out-edge ...")
        bv = build_bucket_trailing_zscore(p, positions, VALUE_METRIC[bucket])
        out = build_bucket_out_edge(raw_dir, bv, positions)
        col = f"{bucket}_value_edge"
        m = attach_edge(m, out, col)
        edge_cols.append(col)
        nonzero = (m[col] != 0).mean() * 100
        print(f"  {col}: mean={m[col].mean():.3f} std={m[col].std():.3f} nonzero={nonzero:.1f}%")

    m["stud_value_edge"] = m[edge_cols].sum(axis=1)

    base_features = ["pass_edge", "rush_edge"]
    results = {}
    flagged_by_key = {}

    stats, _, flagged = run(m, base_features, "BASELINE pass_edge+rush_edge (2009-2025 only)")
    results["baseline_2009_2025"] = stats
    flagged_by_key["baseline_2009_2025"] = flagged

    for col in edge_cols:
        stats, _, flagged = run(m, base_features + [col], f"+ {col}")
        results[col] = stats
        flagged_by_key[col] = flagged

    stats, _, flagged = run(m, base_features + edge_cols, "+ all 5 position edges together")
    results["all_five_edges"] = stats
    flagged_by_key["all_five_edges"] = flagged

    stats, _, flagged = run(m, base_features + ["stud_value_edge"], "+ stud_value_edge (combined)")
    results["stud_value_edge_combined"] = stats
    flagged_by_key["stud_value_edge_combined"] = flagged

    # By-season breakdown + a last-8-season (2018-2025) cut of the
    # best-looking arm -- same discipline v13/v14 applied before trusting
    # any single aggregate number, even though 2009-2025 is already a
    # "recent" window by this project's usual standards.
    best_key = max(
        (k for k in results if k != "baseline_2009_2025"),
        key=lambda k: (results[k]["hit_rate"] or 0)
    )
    best_flagged = flagged_by_key[best_key]
    print(f"\nBest-looking arm: {best_key} ({results[best_key]['hit_rate']})")

    by_season = (
        best_flagged.groupby("season").agg(games=("model_win", "size"), hit_rate=("model_win", "mean")).reset_index()
    )
    by_season["hit_rate"] = by_season["hit_rate"].round(4)
    print(f"\n=== {best_key}: hit rate by season ===")
    for r in by_season.itertuples():
        print(f"  {r.season}: n={r.games:3d}  hit={r.hit_rate:.4f}")
    results["best_arm_by_season"] = {"arm": best_key, "by_season": by_season.to_dict(orient="records")}

    recent = best_flagged[best_flagged["season"] >= 2018]
    results["best_arm_2018_2025"] = hit_rate_with_se(recent)
    print(f"\n{best_key}, 2018-2025 only: {json.dumps(results['best_arm_2018_2025'], indent=2)}")

    (out_dir / "summary_v15.json").write_text(json.dumps(results, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v15.json'}")


if __name__ == "__main__":
    main()
