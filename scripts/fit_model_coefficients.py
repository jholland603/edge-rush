#!/usr/bin/env python3
"""
Offline/occasional step: fit the margin-model and edge-calibration
coefficients weekly_update.py uses for live scoring, using a rolling-10-game
rating (Jeff's call, 2026-08 -- "games played in 2020 have less than zero
effect on what's happening now") instead of the old full-history EWMA.

Why this is a SEPARATE script from weekly_update.py rather than fit inline
on every run (like the old EWMA version did): fitting needs the full
historical raw/team/stats_team_week_*.csv archive (all seasons) to rebuild
a rolling-10 feature table across ~6,000+ historical games. That's a real
"need decades of files" operation -- but it only needs to happen when there's
a meaningful reason to (new season's worth of data accumulated, or the
feature set changes, e.g. Jeff's planned expert-picks addition). It should
NOT run on every scoring pass, especially now that scoring runs on the same
schedule as the odds snapshots (up to 16x/week) and specifically should NOT
need the full historical archive on every run.

So: run this by hand, occasionally, with the full raw/ archive present.
It writes backtest/model_coefficients.json. weekly_update.py just reads that
file -- it never re-fits anything itself, and only ever needs 1-2 seasons of
raw/team data (enough for a live rolling-10 window) to actually score
upcoming games.

Rolling-10 window definition (matches the live game.html feature, NOT
backtest_v5_rolling10.py's REG-only proxy): last 10 games per team, ANY
season, REG + POST both count -- a real, deliberate difference from what
backtest_v5 tested (which found no signal, REG-only). Jeff's decision,
made with that context.

Usage:
    python3 scripts/fit_model_coefficients.py --raw-dir raw --out backtest/model_coefficients.json
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402

WINDOW = 10
# Cut down to pass_edge/rush_edge only 2026-08-11 (Jeff's call): backtest_v13
# showed pass_edge+rush_edge ALONE beat the full 8-feature model in every
# era cut tested (full history, last 10/8/5 seasons), and adding QB change
# back on top of just pass/rush made it slightly worse in every cut too --
# not one good aggregate number, a consistent pattern across four different
# windows. rest_diff/wind/dome/qb_change_home/away/injury_edge are dropped
# as MODEL INPUTS here, but Jeff still wants them visible on the site as
# informational signals -- weekly_update.py still computes and stores all
# of them, they just no longer feed the prediction. See notes.md.
FEATURES = ["pass_edge", "rush_edge"]


def load_team_games_all_types(raw_dir: Path) -> pd.DataFrame:
    """Same as bv2.load_team_games, but keeps POST (playoff) games too --
    rolling-10 uses them as recent-form signal, per Jeff's explicit spec.
    (There's no PRE/preseason in stats_team_week_*.csv, only REG/POST.)"""
    files = sorted((raw_dir / "team").glob("stats_team_week_*.csv"))
    if not files:
        raise SystemExit("No raw/team/stats_team_week_*.csv files found.")
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    # no season_type filter here -- REG + POST both count as "games played"

    df["off_pass_epa_play"] = np.where(
        df["attempts"].fillna(0) > 0, df["passing_epa"] / df["attempts"], np.nan
    )
    df["off_rush_epa_play"] = np.where(
        df["carries"].fillna(0) > 0, df["rushing_epa"] / df["carries"], np.nan
    )
    key = df[["game_id", "team", "off_pass_epa_play", "off_rush_epa_play"]].rename(
        columns={"team": "opponent_team",
                 "off_pass_epa_play": "def_pass_epa_play",
                 "off_rush_epa_play": "def_rush_epa_play"}
    )
    df = df.merge(key, on=["game_id", "opponent_team"], how="left")
    return df[["season", "week", "team", "game_id",
               "off_pass_epa_play", "off_rush_epa_play",
               "def_pass_epa_play", "def_rush_epa_play"]]


def build_rolling10_ratings(team_games: pd.DataFrame, window: int = WINDOW) -> pd.DataFrame:
    """Leak-free rolling-N-game rating ENTERING each played game -- same
    shift(1).rolling(window, min_periods=1).mean() as
    backtest_v5_rolling10.py's build_rolling_ratings, just fed REG+POST
    team_games instead of REG-only, so it matches the live definition."""
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def rolling_leak_free(col):
        return tg.groupby("team")[col].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).mean()
        )

    out = tg[["season", "week", "team", "game_id"]].copy()
    out["r_off_pass"] = rolling_leak_free("off_pass_epa_play")
    out["r_off_rush"] = rolling_leak_free("off_rush_epa_play")
    out["r_def_pass"] = rolling_leak_free("def_pass_epa_play")
    out["r_def_rush"] = rolling_leak_free("def_rush_epa_play")
    return out


def fit_margin_model(hist: pd.DataFrame):
    X = hist[FEATURES].to_numpy(dtype=float)
    X = np.column_stack([np.ones(len(X)), X])
    y = hist["result"].to_numpy(dtype=float)
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    return coef


def fit_edge_calibration(hist: pd.DataFrame, coef: np.ndarray):
    from sklearn.linear_model import LogisticRegression
    X = hist[FEATURES].to_numpy(dtype=float)
    X1 = np.column_stack([np.ones(len(X)), X])
    predicted_margin = X1 @ coef
    model_edge = predicted_margin - hist["spread_line"].to_numpy(dtype=float)
    home_cover_margin = hist["result"].to_numpy(dtype=float) - hist["spread_line"].to_numpy(dtype=float)
    mask = home_cover_margin != 0  # exclude pushes
    home_covers = (home_cover_margin[mask] > 0).astype(int)
    clf = LogisticRegression(max_iter=1000)
    clf.fit(model_edge[mask].reshape(-1, 1), home_covers)
    return float(clf.coef_[0][0]), float(clf.intercept_[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--out", default="backtest/model_coefficients.json", type=Path)
    args = parser.parse_args()

    print("Loading team-game EPA history (REG + POST, all seasons in raw/)...")
    team_games = load_team_games_all_types(args.raw_dir)

    print(f"Building leak-free rolling-{WINDOW} ratings (entering each historical game)...")
    ratings = build_rolling10_ratings(team_games, WINDOW)

    print("Building full historical matchup/feature table (reuses backtest_v2's QB-change "
          "and injury-count logic unchanged, REG season games only as prediction targets)...")
    hist = bv2.build_matchups(args.raw_dir, ratings)
    print(f"  {len(hist)} completed historical REG-season games with a full feature set")

    print("Fitting margin model (OLS)...")
    coef = fit_margin_model(hist)
    coef_map = dict(zip(["intercept"] + FEATURES, [float(c) for c in coef]))
    print(f"  coefficients: {json.dumps({k: round(v, 4) for k, v in coef_map.items()})}")

    print("Fitting edge-calibration model (logistic regression, model_edge -> P(home covers))...")
    calib_coef, calib_intercept = fit_edge_calibration(hist, coef)
    print(f"  calibration: coef={round(calib_coef, 4)}, intercept={round(calib_intercept, 4)}")

    out = {
        "fitted_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rating_method": f"rolling_last_{WINDOW}_games_reg_and_post",
        "n_historical_games": int(len(hist)),
        "features": FEATURES,
        "margin_model_coefficients": coef_map,
        "edge_calibration": {"coef": calib_coef, "intercept": calib_intercept},
        "note": (
            "Rolling-10 (REG+POST) was tested standalone in backtest_v5_rolling10.py "
            "(REG-only proxy) and found to show no ATS signal and no improvement over "
            "the prior full-history EWMA model (51.26% -> 51.04% hit rate). Jeff chose "
            "rolling-10 anyway for recency over history, aware of that finding -- see "
            "HANDOFF.md. Treat this model the same as its predecessor: paper-trading "
            "only, not validated to beat the closing line."
        ),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
