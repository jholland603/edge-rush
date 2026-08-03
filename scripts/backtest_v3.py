#!/usr/bin/env python3
"""
Phase 1 backtest v3: adds one feature on top of v2 -- a leak-free trailing
"passer rating edge", testing the claim (popularized by Cold Hard Football
Facts, coldhardfootballfacts.com) that defensive passer rating allowed is
one of the strongest predictors of winning in the NFL.

IMPORTANT DISTINCTION FROM THE ORIGINAL CLAIM: CHFF's "Correlation to
Victory" measures whether the team with the better passer rating IN A GIVEN
GAME also won that same game -- a same-game descriptive correlation, not a
pregame prediction. Some of that correlation is close to circular (a team
that's already winning forces low-percentage, high-interception throws out
of a trailing opponent late, which mechanically improves the leading team's
defensive passer rating in the same game they were already winning).

This script tests the actually-useful version of the claim: does a team's
TRAILING defensive passer rating allowed (computed only from games strictly
before the one being predicted, exactly like every other rating in this
project) help predict the outcome of its NEXT game, on top of what EPA/play
already captures? That's a fundamentally harder bar to clear than same-game
correlation, and it's the only version of the claim that could plausibly
inform a bet placed before kickoff.

Everything else is unchanged from v2 (see backtest_v2.py) -- same walk-
forward refitting, same off/def/pass/rush EPA ratings, same rest/weather/QB/
injury features. The new piece:

6. Passer rating edge
   Team-level NFL passer rating, computed the standard way from each team's
   own completions/attempts/passing_yards/passing_tds/passing_interceptions
   (already in stats_team_week -- no new data needed). Each team gets two
   EWMA ratings, seeded and carried over between seasons identically to the
   existing EPA ratings: r_off_rating (own passing efficiency) and
   r_def_rating_allowed (opponent passing efficiency allowed, via the same
   self-join trick used for def_pass_epa_play). qb_rating_edge nets one
   team's offense against the other's defense in passer-rating units, the
   same structure as pass_edge/rush_edge:

       qb_rating_edge = (h_off_rating - a_def_rating_allowed)
                       - (a_off_rating - h_def_rating_allowed)

   Passer rating and EPA/play are different scales (roughly 0-158 vs. -0.5
   to +0.5), so qb_rating_edge's regression coefficient will look tiny next
   to pass_edge's -- that's expected and not itself evidence of "no effect."
   What matters is whether adding it moves hit rate / RMSE at all versus v2.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

EWMA_ALPHA = 0.25
SEASON_CARRYOVER = 0.5
TRAIN_SEASONS = 3
EDGE_THRESHOLD = 2.0
QB_WINDOW = 8


# --------------------------------------------------------------------------
# 1. per-game team pass/rush EPA + passer rating, offense and defense
# --------------------------------------------------------------------------
def passer_rating(cmp, att, yds, td, ints):
    """Standard NFL passer rating. Vectorized (all inputs are pandas Series)."""
    att_safe = att.where(att > 0)
    a = ((cmp / att_safe) - 0.3) * 5
    b = ((yds / att_safe) - 3) * 0.25
    c = (td / att_safe) * 20
    d = 2.375 - (ints / att_safe) * 25
    a, b, c, d = (s.clip(lower=0, upper=2.375) for s in (a, b, c, d))
    return ((a + b + c + d) / 6) * 100


def load_team_games(raw_dir: Path) -> pd.DataFrame:
    files = sorted((raw_dir / "team").glob("stats_team_week_*.csv"))
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df["season_type"] == "REG"].copy()

    df["off_pass_epa_play"] = np.where(
        df["attempts"].fillna(0) > 0, df["passing_epa"] / df["attempts"], np.nan
    )
    df["off_rush_epa_play"] = np.where(
        df["carries"].fillna(0) > 0, df["rushing_epa"] / df["carries"], np.nan
    )
    df["off_passer_rating"] = passer_rating(
        df["completions"], df["attempts"], df["passing_yards"],
        df["passing_tds"], df["passing_interceptions"],
    )

    key = df[["game_id", "team", "off_pass_epa_play", "off_rush_epa_play", "off_passer_rating"]].rename(
        columns={"team": "opponent_team",
                 "off_pass_epa_play": "def_pass_epa_play",
                 "off_rush_epa_play": "def_rush_epa_play",
                 "off_passer_rating": "def_passer_rating_allowed"}
    )
    df = df.merge(key, on=["game_id", "opponent_team"], how="left")

    return df[["season", "week", "team", "opponent_team", "game_id",
               "off_pass_epa_play", "off_rush_epa_play",
               "def_pass_epa_play", "def_rush_epa_play",
               "off_passer_rating", "def_passer_rating_allowed"]]


def _seeded_ewma_column(tg: pd.DataFrame, col: str, out_col: str) -> pd.DataFrame:
    """Leak-free EWMA of `col`, seeded each season at 50% of the team's final
    prior-season rating for that same column. Returns tg with out_col added."""
    tg = tg.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def final_ewma(group):
        vals = group[col].to_numpy()
        running = np.nan
        for v in vals:
            if np.isnan(v):
                continue
            running = v if np.isnan(running) else EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
        return running

    season_final = (
        tg.groupby(["team", "season"]).apply(final_ewma).rename("final_rating").reset_index()
    )
    season_final["next_season"] = season_final["season"] + 1
    carryover = season_final[["team", "next_season", "final_rating"]].rename(
        columns={"next_season": "season", "final_rating": "prior_final"}
    )
    tg = tg.merge(carryover, on=["team", "season"], how="left")
    tg["prior_final"] = tg["prior_final"].fillna(0.0)

    def seeded_ewma(group):
        vals = group[col].to_numpy()
        running = group["prior_final"].iloc[0] * SEASON_CARRYOVER
        rating = np.empty(len(vals))
        for i, v in enumerate(vals):
            rating[i] = running
            if not np.isnan(v):
                running = EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
        return pd.Series(rating, index=group.index)

    tg[out_col] = tg.groupby(["team", "season"], group_keys=False).apply(seeded_ewma)
    return tg.drop(columns=["prior_final"])


def build_ratings(team_games: pd.DataFrame) -> pd.DataFrame:
    tg = team_games.copy()
    for col, out in [
        ("off_pass_epa_play", "r_off_pass"),
        ("off_rush_epa_play", "r_off_rush"),
        ("def_pass_epa_play", "r_def_pass"),
        ("def_rush_epa_play", "r_def_rush"),
        ("off_passer_rating", "r_off_rating"),
        ("def_passer_rating_allowed", "r_def_rating_allowed"),
    ]:
        tg = _seeded_ewma_column(tg, col, out)
    return tg[["season", "week", "team", "game_id",
               "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush",
               "r_off_rating", "r_def_rating_allowed"]]


# --------------------------------------------------------------------------
# 4. QB availability (leak-free "established starter" via trailing mode)
# --------------------------------------------------------------------------
def build_qb_change_flags(games: pd.DataFrame) -> pd.DataFrame:
    home = games[["season", "week", "game_id", "home_team", "home_qb_id"]].rename(
        columns={"home_team": "team", "home_qb_id": "qb_id"}
    )
    away = games[["season", "week", "game_id", "away_team", "away_qb_id"]].rename(
        columns={"away_team": "team", "away_qb_id": "qb_id"}
    )
    long = pd.concat([home, away], ignore_index=True).dropna(subset=["qb_id"])
    long = long.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def flag_group(group):
        qbs = group["qb_id"].to_list()
        flags = np.zeros(len(qbs), dtype=int)
        for i in range(len(qbs)):
            window = qbs[max(0, i - QB_WINDOW):i]  # strictly prior games only
            if not window:
                flags[i] = 0  # no history yet -> can't tell, assume no change
                continue
            established = pd.Series(window).mode().iloc[0]
            flags[i] = int(qbs[i] != established)
        return pd.Series(flags, index=group.index)

    long["qb_change"] = long.groupby("team", group_keys=False).apply(flag_group)
    return long[["season", "week", "game_id", "team", "qb_change"]]


# --------------------------------------------------------------------------
# 5. Injuries (2009-2025)
# --------------------------------------------------------------------------
def build_injury_counts(raw_dir: Path) -> pd.DataFrame:
    inj_dir = raw_dir / "injuries"
    files = sorted(inj_dir.glob("injuries_*.csv"))
    if not files:
        return pd.DataFrame(columns=["season", "week", "team", "out_count"])

    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df["game_type"] == "REG"]

    # keep only the FINAL report per player/week (latest date_modified)
    df["date_modified"] = pd.to_datetime(df["date_modified"], errors="coerce")
    df = df.sort_values("date_modified")
    df = df.drop_duplicates(subset=["season", "week", "team", "gsis_id"], keep="last")

    out = (
        df[df["report_status"] == "Out"]
        .groupby(["season", "week", "team"])
        .size()
        .rename("out_count")
        .reset_index()
    )
    return out


# --------------------------------------------------------------------------
# assemble matchup-level feature table
# --------------------------------------------------------------------------
def build_matchups(raw_dir: Path, ratings: pd.DataFrame) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    home_r = ratings.rename(columns={
        "team": "home_team", "r_off_pass": "h_off_pass", "r_off_rush": "h_off_rush",
        "r_def_pass": "h_def_pass", "r_def_rush": "h_def_rush",
        "r_off_rating": "h_off_rating", "r_def_rating_allowed": "h_def_rating_allowed",
    })
    away_r = ratings.rename(columns={
        "team": "away_team", "r_off_pass": "a_off_pass", "r_off_rush": "a_off_rush",
        "r_def_pass": "a_def_pass", "r_def_rush": "a_def_rush",
        "r_off_rating": "a_off_rating", "r_def_rating_allowed": "a_def_rating_allowed",
    })
    m = games.merge(home_r[["game_id", "home_team", "h_off_pass", "h_off_rush", "h_def_pass", "h_def_rush",
                             "h_off_rating", "h_def_rating_allowed"]],
                     on=["game_id", "home_team"], how="left")
    m = m.merge(away_r[["game_id", "away_team", "a_off_pass", "a_off_rush", "a_def_pass", "a_def_rush",
                         "a_off_rating", "a_def_rating_allowed"]],
                on=["game_id", "away_team"], how="left")
    m = m.dropna(subset=["h_off_pass", "h_off_rush", "a_off_pass", "a_off_rush",
                          "h_def_pass", "h_def_rush", "a_def_pass", "a_def_rush",
                          "h_off_rating", "h_def_rating_allowed", "a_off_rating", "a_def_rating_allowed"])

    m["pass_edge"] = (m["h_off_pass"] - m["a_def_pass"]) - (m["a_off_pass"] - m["h_def_pass"])
    m["rush_edge"] = (m["h_off_rush"] - m["a_def_rush"]) - (m["a_off_rush"] - m["h_def_rush"])
    m["qb_rating_edge"] = (m["h_off_rating"] - m["a_def_rating_allowed"]) - (m["a_off_rating"] - m["h_def_rating_allowed"])
    m["rest_diff"] = m["home_rest"] - m["away_rest"]
    m["wind"] = m["wind"].fillna(0.0)
    m["dome"] = m["roof"].isin(["dome", "closed"]).astype(int)

    qb = build_qb_change_flags(pd.read_csv(raw_dir / "games.csv", low_memory=False))
    qb_home = qb.rename(columns={"team": "home_team", "qb_change": "qb_change_home"})
    qb_away = qb.rename(columns={"team": "away_team", "qb_change": "qb_change_away"})
    m = m.merge(qb_home[["game_id", "home_team", "qb_change_home"]], on=["game_id", "home_team"], how="left")
    m = m.merge(qb_away[["game_id", "away_team", "qb_change_away"]], on=["game_id", "away_team"], how="left")
    m["qb_change_home"] = m["qb_change_home"].fillna(0).astype(int)
    m["qb_change_away"] = m["qb_change_away"].fillna(0).astype(int)

    inj = build_injury_counts(raw_dir)
    inj_home = inj.rename(columns={"team": "home_team", "out_count": "home_out_count"})
    inj_away = inj.rename(columns={"team": "away_team", "out_count": "away_out_count"})
    m = m.merge(inj_home, on=["season", "week", "home_team"], how="left")
    m = m.merge(inj_away, on=["season", "week", "away_team"], how="left")
    m["home_out_count"] = m["home_out_count"].fillna(0)
    m["away_out_count"] = m["away_out_count"].fillna(0)
    m["injury_edge"] = m["away_out_count"] - m["home_out_count"]

    return m


FEATURES = ["pass_edge", "rush_edge", "qb_rating_edge", "rest_diff", "wind", "dome",
            "qb_change_home", "qb_change_away", "injury_edge"]


def walk_forward_predict(m: pd.DataFrame) -> pd.DataFrame:
    seasons = sorted(m["season"].unique())
    train_cutoff_seasons = seasons[:TRAIN_SEASONS]
    results = []

    for season in seasons:
        if season in train_cutoff_seasons:
            continue
        train = m[m["season"] < season]
        if len(train) < 200:
            continue

        X = train[FEATURES].to_numpy(dtype=float)
        X = np.column_stack([np.ones(len(X)), X])
        y = train["result"].to_numpy(dtype=float)
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)

        test = m[m["season"] == season].copy()
        Xt = test[FEATURES].to_numpy(dtype=float)
        Xt = np.column_stack([np.ones(len(Xt)), Xt])
        test["predicted_margin"] = Xt @ coef
        test["train_games"] = len(train)
        for name, val in zip(["intercept"] + FEATURES, coef):
            test[f"coef_{name}"] = val
        results.append(test)

    return pd.concat(results, ignore_index=True)


def score(preds: pd.DataFrame):
    preds = preds.copy()
    preds["model_edge"] = preds["predicted_margin"] - preds["spread_line"]
    preds["home_cover_margin"] = preds["result"] - preds["spread_line"]

    flagged = preds[preds["model_edge"].abs() >= EDGE_THRESHOLD].copy()
    flagged["side"] = np.where(flagged["model_edge"] > 0, "home", "away")
    flagged = flagged[flagged["home_cover_margin"] != 0]
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
        flagged.groupby("season").agg(games=("model_win", "size"), hit_rate=("model_win", "mean")).reset_index()
    )
    by_season["hit_rate"] = by_season["hit_rate"].round(4)

    bins = [2, 3, 5, 7, 100]
    flagged["edge_bucket"] = pd.cut(flagged["model_edge"].abs(), bins, right=False)
    by_edge = (
        flagged.groupby("edge_bucket", observed=True)
        .agg(games=("model_win", "size"), hit_rate=("model_win", "mean")).reset_index()
    )
    by_edge["edge_bucket"] = by_edge["edge_bucket"].astype(str)
    by_edge["hit_rate"] = by_edge["hit_rate"].round(4)

    coef_cols = [c for c in preds.columns if c.startswith("coef_")]
    avg_coefs = {c.replace("coef_", ""): round(float(preds[c].mean()), 4) for c in coef_cols}

    return {
        "overall": overall,
        "by_season": by_season.to_dict(orient="records"),
        "by_edge_size": by_edge.to_dict(orient="records"),
        "avg_coefficients": avg_coefs,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--out-dir", default="backtest_v3_out", type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA + passer rating ...")
    team_games = load_team_games(args.raw_dir)

    print("Building 6-way ratings (off/def x pass/rush/passer-rating) ...")
    ratings = build_ratings(team_games)

    print("Building matchup feature table (rest, weather, QB, injuries, QB rating edge) ...")
    m = build_matchups(args.raw_dir, ratings)
    print(f"  {len(m)} games with full features")

    print("Walk-forward predicting ...")
    preds = walk_forward_predict(m)
    print(f"  {len(preds)} games scored")

    print("Scoring vs. closing line ...")
    preds, flagged = score(preds)
    summary = summarize(preds, flagged)
    print(json.dumps(summary["overall"], indent=2))
    print(json.dumps(summary["avg_coefficients"], indent=2))

    cols = ["season", "week", "game_id", "home_team", "away_team", "result", "spread_line",
            "predicted_margin", "model_edge"] + FEATURES
    preds[cols].to_csv(args.out_dir / "predictions_v3.csv", index=False)
    (args.out_dir / "summary_v3.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWrote {args.out_dir/'predictions_v3.csv'} and {args.out_dir/'summary_v3.json'}")


if __name__ == "__main__":
    main()
