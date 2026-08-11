#!/usr/bin/env python3
"""
Phase 1 backtest v9: player-VALUE-weighted injuries, instead of a flat
headcount.

The one clearly-validated feature in this whole project is QB availability
-- and what makes it work is that it isolates ONE specific, high-value role
rather than treating every player as fungible. `injury_edge` (already in
the model) does the opposite: it's just a count of players with a final
"Out" status, so a long-snapper and a WR1 count the same. This tests the
natural extension: weight each "Out" player by how much they actually
produce, using trailing PPR fantasy points (already computed per player-
week in the source data) as a generic value proxy.

QBs are EXCLUDED from this feature -- that effect is already captured by
qb_change_home/away, and double-counting it through a back door would just
add collinearity, not new information.

Fantasy PPR is a strong proxy for offensive skill positions (QB/RB/WR/TE --
sniff-tested: 80-96% of player-weeks have nonzero PPR) and effectively zero
for defense/OL (0-1% nonzero) -- so this feature, as built, only really
captures skill-position offensive injuries. That's a real, disclosed scope
limit, not a bug: a cheap way to test the highest-value-looking piece of
this idea first, not a claim to have solved defensive injury value.

Two variants tested, both walk-forward against the full v2 feature set:
  1. ADD  -- value_injury_edge alongside the existing flat injury_edge.
  2. SWAP -- value_injury_edge REPLACES injury_edge (since they're likely
     highly redundant/collinear -- swapping tests whether the value-weighted
     version is simply a strictly-better version of the same information).
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402

VALUE_WINDOW = 8  # same window as the QB "established starter" precedent


def load_player_trailing_value(raw_dir: Path, window: int = VALUE_WINDOW) -> pd.DataFrame:
    """Leak-free trailing PPR average per (player_id, season, week) -- the
    value the player brings INTO that week, using only games strictly
    before it. REG season only, matching the rest of this project's
    convention."""
    files = sorted((raw_dir / "player").glob("stats_player_week_*.csv"))
    dfs = []
    for f in files:
        df = pd.read_csv(f, low_memory=False, usecols=[
            "player_id", "position", "season", "week", "season_type", "fantasy_points_ppr"
        ])
        dfs.append(df[df["season_type"] == "REG"])
    p = pd.concat(dfs, ignore_index=True)
    p = p.sort_values(["player_id", "season", "week"]).reset_index(drop=True)
    p["trailing_ppr"] = p.groupby("player_id")["fantasy_points_ppr"].transform(
        lambda s: s.shift(1).rolling(window, min_periods=1).mean()
    )
    return p[["player_id", "position", "season", "week", "trailing_ppr"]]


def build_value_injury_counts(raw_dir: Path, player_value: pd.DataFrame) -> pd.DataFrame:
    """Same season/week/team "final report" dedup logic as
    bv2.build_injury_counts, but summing each Out player's trailing PPR
    value instead of counting heads. QBs excluded (see module docstring)."""
    inj_dir = raw_dir / "injuries"
    files = sorted(inj_dir.glob("injuries_*.csv"))
    if not files:
        return pd.DataFrame(columns=["season", "week", "team", "value_out"])

    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[(df["game_type"] == "REG") & (df["position"] != "QB")]

    df["date_modified"] = pd.to_datetime(df["date_modified"], errors="coerce")
    df = df.sort_values("date_modified")
    df = df.drop_duplicates(subset=["season", "week", "team", "gsis_id"], keep="last")
    df = df[df["report_status"] == "Out"]

    # Exact (gsis_id, season, week) join fails almost entirely -- a player
    # who's "Out" that week naturally has NO stats_player_week row for that
    # week (they didn't play), so there's nothing at that exact key to join
    # to. Use an as-of merge instead: each Out player's MOST RECENT trailing
    # value at or before this report's season/week, per player -- still
    # leak-free (trailing_ppr itself already only looks at strictly-prior
    # games), and correctly carries a player's known value forward through
    # the very week they're injured.
    df["sort_key"] = df["season"] * 100 + df["week"]
    pv = player_value.rename(columns={"player_id": "gsis_id"}).copy()
    pv["sort_key"] = pv["season"] * 100 + pv["week"]
    df = df.sort_values("sort_key")
    pv = pv.sort_values("sort_key")
    df = pd.merge_asof(
        df, pv[["gsis_id", "sort_key", "trailing_ppr"]],
        on="sort_key", by="gsis_id", direction="backward"
    )
    df["trailing_ppr"] = df["trailing_ppr"].fillna(0.0)  # no trailing history -> treat as replacement-level

    out = df.groupby(["season", "week", "team"])["trailing_ppr"].sum().rename("value_out").reset_index()
    return out


def build_value_injury_edge(raw_dir: Path, m: pd.DataFrame, player_value: pd.DataFrame) -> pd.DataFrame:
    val = build_value_injury_counts(raw_dir, player_value)
    val_home = val.rename(columns={"team": "home_team", "value_out": "home_value_out"})
    val_away = val.rename(columns={"team": "away_team", "value_out": "away_value_out"})
    m = m.merge(val_home, on=["season", "week", "home_team"], how="left")
    m = m.merge(val_away, on=["season", "week", "away_team"], how="left")
    m["home_value_out"] = m["home_value_out"].fillna(0.0)
    m["away_value_out"] = m["away_value_out"].fillna(0.0)
    m["value_injury_edge"] = m["away_value_out"] - m["home_value_out"]
    return m


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v9_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game EPA + building EWMA ratings (same as v2) ...")
    team_games = bv2.load_team_games(raw_dir)
    ratings = bv2.build_ratings(team_games)
    m = bv2.build_matchups(raw_dir, ratings)
    print(f"  {len(m)} games with full v2 features")

    print(f"Building leak-free trailing player value (PPR, window={VALUE_WINDOW}, all seasons) ...")
    player_value = load_player_trailing_value(raw_dir, VALUE_WINDOW)
    print(f"  {len(player_value)} player-week rows")

    print("Building value-weighted injury edge (non-QB, 'Out' status) ...")
    m = build_value_injury_edge(raw_dir, m, player_value)
    print(f"  value_injury_edge stats: mean={m['value_injury_edge'].mean():.3f}, "
          f"std={m['value_injury_edge'].std():.3f}, "
          f"nonzero={((m['value_injury_edge'] != 0).mean() * 100):.1f}%")

    base_features = list(bv2.FEATURES)  # capture before any mutation

    def run(features, label):
        bv2.FEATURES = features
        preds = bv2.walk_forward_predict(m)
        preds, flagged = bv2.score(preds)
        summary = bv2.summarize(preds, flagged)
        print(f"\n=== {label} ===")
        print(json.dumps(summary["overall"], indent=2))
        print("avg coefficients:", json.dumps(summary["avg_coefficients"], indent=2))
        return summary

    results = {}
    results["baseline_v2"] = run(base_features, "BASELINE (current 8 features, flat injury_edge)")
    results["add_value_injury"] = run(
        base_features + ["value_injury_edge"],
        "ADD value_injury_edge alongside flat injury_edge"
    )
    swap_features = [f for f in base_features if f != "injury_edge"] + ["value_injury_edge"]
    results["swap_value_injury"] = run(
        swap_features,
        "SWAP value_injury_edge in place of flat injury_edge"
    )

    out = {k: {"overall": v["overall"], "avg_coefficients": v["avg_coefficients"]} for k, v in results.items()}
    (out_dir / "summary_v9.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v9.json'}")


if __name__ == "__main__":
    main()
