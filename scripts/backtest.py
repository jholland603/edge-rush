#!/usr/bin/env python3
"""
Phase 1 backtest: EPA/play power-rating model vs. the closing line, 1999-2025.

Methodology (documented so it can be second-guessed and iterated on):

1. Per-team-per-game efficiency
   off_epa_play  = (passing_epa + rushing_epa) / (attempts + carries)
   def_epa_play  = opponent's off_epa_play in that same game (self-join on game_id)
   net_epa_play  = off_epa_play - def_epa_play   (higher = better team that game)

2. Power rating (leak-free within season)
   Exponentially-weighted moving average of net_epa_play, using only games
   STRICTLY BEFORE the week being predicted (shift(1) within team/season).
   alpha = EWMA_ALPHA (most recent game weighted alpha, decaying by (1-alpha)).
   At the start of a new season, a team's rating is seeded at
   0.5 * (final rating from its previous season) -- i.e. 50% regression to the
   mean (0) -- rather than restarting cold. Teams with no prior-season rating
   (first year in the dataset) seed at 0.

3. EPA -> points conversion (walk-forward, no lookahead)
   actual_margin (home_score - away_score) ~ intercept + slope * rating_diff
   is refit via OLS every season using ONLY seasons strictly before the one
   being predicted (expanding window). The intercept is therefore also a
   season-by-season estimate of home field advantage in points, which is
   allowed to drift over time (it really has, e.g. 2020's empty stadiums).
   The first TRAIN_SEASONS seasons are used purely to seed this regression
   and are excluded from scoring.

4. Scoring
   model_edge = predicted_margin - spread_line   (spread_line convention
   verified empirically: positive = home favored, same sign as `result`).
   For games where |model_edge| >= EDGE_THRESHOLD, the model "takes" the
   side (home if predicted_margin > spread_line, else away) and we check
   whether that side actually covered the closing spread (pushes excluded).
   Hit rate is reported overall and broken out by season, plus by edge-size
   bucket as a sanity check (a real signal should show hit rate rising with
   edge size, not flat).

Usage:
    python backtest.py --raw-dir ../raw --out-dir ../backtest
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

EWMA_ALPHA = 0.25
SEASON_CARRYOVER = 0.5   # fraction of prior-season final rating retained
TRAIN_SEASONS = 3        # first N seasons used only to seed the regression
EDGE_THRESHOLD = 2.0


def load_team_games(raw_dir: Path) -> pd.DataFrame:
    files = sorted((raw_dir / "team").glob("stats_team_week_*.csv"))
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df["season_type"] == "REG"].copy()  # closing lines / this phase: regular season only

    plays = df["attempts"].fillna(0) + df["carries"].fillna(0)
    off_epa = df["passing_epa"].fillna(0) + df["rushing_epa"].fillna(0)
    df["plays"] = plays
    df["off_epa_play"] = np.where(plays > 0, off_epa / plays, np.nan)

    # defensive EPA/play allowed = opponent's off_epa_play in the same game
    key = df[["game_id", "team", "off_epa_play", "plays"]].rename(
        columns={"team": "opponent_team", "off_epa_play": "def_epa_play", "plays": "opp_plays"}
    )
    df = df.merge(key, on=["game_id", "opponent_team"], how="left")

    df["net_epa_play"] = df["off_epa_play"] - df["def_epa_play"]
    return df[["season", "week", "team", "opponent_team", "game_id",
               "off_epa_play", "def_epa_play", "net_epa_play"]].dropna(subset=["net_epa_play"])


def build_ratings(team_games: pd.DataFrame) -> pd.DataFrame:
    """Return one row per team/season/week: rating ENTERING that week (leak-free)."""
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    # final rating achieved at the end of each season, used to seed next season's carryover
    def final_ewma(group):
        vals = group["net_epa_play"].to_numpy()
        running = np.nan
        for v in vals:
            running = v if np.isnan(running) else EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
        return running

    season_final = (
        tg.groupby(["team", "season"])
        .apply(final_ewma)
        .rename("final_rating")
        .reset_index()
    )
    season_final["next_season"] = season_final["season"] + 1
    carryover = season_final[["team", "next_season", "final_rating"]].rename(
        columns={"next_season": "season", "final_rating": "prior_final"}
    )

    tg = tg.merge(carryover, on=["team", "season"], how="left")
    tg["prior_final"] = tg["prior_final"].fillna(0.0)

    # fill each team/season's week-1 NaN rating with the seeded carryover,
    # then re-run the EWMA forward using that seed as the starting "running" value
    def seeded_ewma(group):
        vals = group["net_epa_play"].to_numpy()
        s = group["prior_final"].iloc[0] * SEASON_CARRYOVER
        rating = np.empty(len(vals))
        running = s
        for i, v in enumerate(vals):
            rating[i] = running
            running = EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
        return pd.Series(rating, index=group.index)

    tg["rating_entering_week"] = tg.groupby(["team", "season"], group_keys=False).apply(seeded_ewma)

    return tg[["season", "week", "team", "game_id", "rating_entering_week"]]


def build_matchups(raw_dir: Path, ratings: pd.DataFrame) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    home_r = ratings.rename(columns={"team": "home_team", "rating_entering_week": "home_rating"})
    away_r = ratings.rename(columns={"team": "away_team", "rating_entering_week": "away_rating"})

    m = games.merge(home_r[["game_id", "home_team", "home_rating"]], on=["game_id", "home_team"], how="left")
    m = m.merge(away_r[["game_id", "away_team", "away_rating"]], on=["game_id", "away_team"], how="left")
    m = m.dropna(subset=["home_rating", "away_rating"])
    m["rating_diff"] = m["home_rating"] - m["away_rating"]
    return m


def walk_forward_predict(m: pd.DataFrame) -> pd.DataFrame:
    seasons = sorted(m["season"].unique())
    train_cutoff_seasons = seasons[:TRAIN_SEASONS]
    results = []

    for i, season in enumerate(seasons):
        if season in train_cutoff_seasons:
            continue
        train = m[m["season"] < season]
        if len(train) < 50:
            continue
        # OLS: result = intercept + slope * rating_diff
        X = train["rating_diff"].to_numpy()
        y = train["result"].to_numpy()
        slope, intercept = np.polyfit(X, y, 1)

        test = m[m["season"] == season].copy()
        test["predicted_margin"] = intercept + slope * test["rating_diff"]
        test["hfa_estimate"] = intercept
        test["scale_estimate"] = slope
        test["train_games"] = len(train)
        results.append(test)

    return pd.concat(results, ignore_index=True)


def score(preds: pd.DataFrame) -> pd.DataFrame:
    preds = preds.copy()
    preds["model_edge"] = preds["predicted_margin"] - preds["spread_line"]
    preds["home_cover_margin"] = preds["result"] - preds["spread_line"]  # >0 home covered

    flagged = preds[preds["model_edge"].abs() >= EDGE_THRESHOLD].copy()
    flagged["side"] = np.where(flagged["model_edge"] > 0, "home", "away")
    flagged = flagged[flagged["home_cover_margin"] != 0]  # drop pushes
    flagged["model_win"] = np.where(
        flagged["side"] == "home",
        flagged["home_cover_margin"] > 0,
        flagged["home_cover_margin"] < 0,
    )
    return preds, flagged


def summarize(preds: pd.DataFrame, flagged: pd.DataFrame) -> dict:
    overall = {
        "seasons_scored": sorted(preds["season"].unique().tolist()),
        "total_games_scored": len(preds),
        "games_flagged": len(flagged),
        "flag_rate": round(len(flagged) / len(preds), 3) if len(preds) else None,
        "overall_hit_rate": round(flagged["model_win"].mean(), 4) if len(flagged) else None,
        "breakeven_hit_rate_at_-110": 0.5238,
        "rmse_model_vs_actual": round(float(np.sqrt(((preds["predicted_margin"] - preds["result"]) ** 2).mean())), 3),
        "rmse_market_vs_actual": round(float(np.sqrt(((preds["spread_line"] - preds["result"]) ** 2).mean())), 3),
    }

    by_season = (
        flagged.groupby("season")
        .agg(games=("model_win", "size"), hit_rate=("model_win", "mean"))
        .reset_index()
    )
    by_season["hit_rate"] = by_season["hit_rate"].round(4)

    bins = [2, 3, 5, 7, 100]
    flagged["edge_bucket"] = pd.cut(flagged["model_edge"].abs(), bins, right=False)
    by_edge = (
        flagged.groupby("edge_bucket", observed=True)
        .agg(games=("model_win", "size"), hit_rate=("model_win", "mean"))
        .reset_index()
    )
    by_edge["edge_bucket"] = by_edge["edge_bucket"].astype(str)
    by_edge["hit_rate"] = by_edge["hit_rate"].round(4)

    return {
        "overall": overall,
        "by_season": by_season.to_dict(orient="records"),
        "by_edge_size": by_edge.to_dict(orient="records"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--out-dir", default="backtest_out", type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game EPA/play ...")
    team_games = load_team_games(args.raw_dir)
    print(f"  {len(team_games)} team-game rows")

    print("Building power ratings ...")
    ratings = build_ratings(team_games)

    print("Building matchups with pre-game ratings ...")
    m = build_matchups(args.raw_dir, ratings)
    print(f"  {len(m)} games with both teams rated")

    print("Walk-forward predicting (expanding-window regression, no lookahead) ...")
    preds = walk_forward_predict(m)
    print(f"  {len(preds)} games scored (seasons: {sorted(preds['season'].unique().tolist())})")

    print("Scoring vs. closing line ...")
    preds, flagged = score(preds)
    summary = summarize(preds, flagged)

    print(json.dumps(summary["overall"], indent=2))

    cols = ["season", "week", "game_id", "home_team", "away_team", "home_score", "away_score",
            "result", "spread_line", "predicted_margin", "model_edge", "hfa_estimate", "scale_estimate"]
    preds[cols].to_csv(args.out_dir / "predictions.csv", index=False)
    (args.out_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWrote {args.out_dir/'predictions.csv'} and {args.out_dir/'summary.json'}")


if __name__ == "__main__":
    main()
