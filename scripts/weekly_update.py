#!/usr/bin/env python3
"""
Phase 2: weekly tool. Run this any time during the season after dropping
updated raw CSVs into raw/ (games.csv, team/stats_team_week_{season}.csv,
player/player_stats_{season}.csv, injuries/injuries_{season}.csv).

What it does:
  1. Computes each team's CURRENT power rating (off/def x pass/rush) as of
     right now -- i.e. their rating entering their next game -- using the
     same leak-free EWMA + season-carryover logic as the Phase 1 backtest.
  2. Finds upcoming games (no result yet, but a market spread_line posted).
  3. Builds the same feature set as backtest_v2 (pass_edge, rush_edge,
     rest_diff, wind, dome, qb_change_home/away, injury_edge) for each one.
     QB-change and injury features use the CURRENT week's injury report
     (if available) rather than games.csv's actual-starter field, since
     that field isn't known in advance for a game that hasn't happened.
  4. Fits the margin model and the edge-only calibration model on ALL
     completed historical seasons (not walk-forward -- there's no "future"
     left to hide), and scores every upcoming game.
  5. Writes data/model/{season}-week{N}.json (the site-facing snapshot)
     and appends flagged games (|edge| >= threshold) to an append-only
     picks log (backtest/picks_log.csv and a mirrored .json for the site).

IMPORTANT: per the Phase 1 calibration test, this model's confidence is
NOT reliably calibrated (Brier score at or above a naive 50/50 baseline).
Everything this script produces is for logging/paper-trading only -- see
--note in the output. Nothing here should be treated as a real pick until
Phase 1 shows a model that actually clears breakeven with calibrated
confidence.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

EWMA_ALPHA = 0.25
SEASON_CARRYOVER = 0.5
EDGE_THRESHOLD = 2.0
QB_WINDOW = 8
DISCLAIMER = (
    "PAPER TRADING ONLY. Phase 1 calibration testing found this model's "
    "confidence is not reliably calibrated (Brier score at/above a naive "
    "50/50 baseline). These numbers are logged for tracking, not acted on."
)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# team EPA/play, same as backtest_v2
# --------------------------------------------------------------------------
def load_team_games(raw_dir: Path) -> pd.DataFrame:
    files = sorted((raw_dir / "team").glob("stats_team_week_*.csv"))
    if not files:
        raise SystemExit("No raw/team/stats_team_week_*.csv files found.")
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df["season_type"] == "REG"].copy()

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


# --------------------------------------------------------------------------
# each team's rating RIGHT NOW (entering their next, not-yet-played game)
# --------------------------------------------------------------------------
def current_rating(team_games: pd.DataFrame, value_col: str) -> dict:
    out = {}
    for team, g in team_games.sort_values(["season", "week"]).groupby("team"):
        running = np.nan
        last_season = None
        for _, row in g.iterrows():
            if last_season is not None and row["season"] != last_season:
                running = running * SEASON_CARRYOVER if not np.isnan(running) else running
            v = row[value_col]
            if not np.isnan(v):
                running = v if np.isnan(running) else EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
            last_season = row["season"]
        out[team] = running
    return out


def current_ratings_all(team_games: pd.DataFrame, as_of_season: int) -> pd.DataFrame:
    rows = []
    ratings = {}
    for col, name in [("off_pass_epa_play", "off_pass"), ("off_rush_epa_play", "off_rush"),
                       ("def_pass_epa_play", "def_pass"), ("def_rush_epa_play", "def_rush")]:
        ratings[name] = current_rating(team_games, col)

    teams = sorted(set(team_games["team"].dropna().astype(str)))
    last_season_played = team_games.groupby("team")["season"].max()
    for team in teams:
        r = {"team": team}
        for name in ratings:
            val = ratings[name].get(team, np.nan)
            if np.isnan(val):
                val = 0.0
            r[name] = val
        # if the team hasn't played at all yet in as_of_season, apply one
        # more carryover step so this reflects "entering as_of_season"
        if team in last_season_played.index and last_season_played[team] < as_of_season:
            for name in ratings:
                r[name] = r[name] * SEASON_CARRYOVER
        rows.append(r)
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# QB availability + injuries for the CURRENT week (forward-looking,
# uses only information that would actually be known before kickoff)
# --------------------------------------------------------------------------
def established_starters(games_hist: pd.DataFrame) -> dict:
    """Each team's most-common starter over their last QB_WINDOW starts, as of now."""
    home = games_hist[["season", "week", "home_team", "home_qb_id"]].rename(
        columns={"home_team": "team", "home_qb_id": "qb_id"})
    away = games_hist[["season", "week", "away_team", "away_qb_id"]].rename(
        columns={"away_team": "team", "away_qb_id": "qb_id"})
    long = pd.concat([home, away], ignore_index=True).dropna(subset=["qb_id"])
    long = long.sort_values(["team", "season", "week"])

    out = {}
    for team, g in long.groupby("team"):
        window = g["qb_id"].to_list()[-QB_WINDOW:]
        if window:
            out[team] = pd.Series(window).mode().iloc[0]
    return out


def injury_out_players(raw_dir: Path, season: int, week: int) -> pd.DataFrame:
    f = raw_dir / "injuries" / f"injuries_{season}.csv"
    if not f.exists():
        return pd.DataFrame(columns=["team", "position", "full_name", "report_status"])
    df = pd.read_csv(f, low_memory=False)
    df = df[(df["game_type"] == "REG") & (df["week"] == week)]
    df["date_modified"] = pd.to_datetime(df["date_modified"], errors="coerce")
    df = df.sort_values("date_modified").drop_duplicates(subset=["team", "gsis_id"], keep="last")
    return df[["team", "position", "full_name", "report_status"]]


# --------------------------------------------------------------------------
# fit final models on ALL completed data (no walk-forward needed -- we're
# predicting the future, there's nothing left to "leak")
# --------------------------------------------------------------------------
FEATURES = ["pass_edge", "rush_edge", "rest_diff", "wind", "dome",
            "qb_change_home", "qb_change_away", "injury_edge"]


def load_historical_matchups(raw_dir: Path, ratings_by_week: pd.DataFrame) -> pd.DataFrame:
    """Rebuild the same v2 feature table for every COMPLETED game, to fit final models on.
    Fallback only -- prefer predictions_v2.csv when available (see main())."""
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    home_r = ratings_by_week.rename(columns={
        "team": "home_team", "r_off_pass": "h_off_pass", "r_off_rush": "h_off_rush",
        "r_def_pass": "h_def_pass", "r_def_rush": "h_def_rush"})
    away_r = ratings_by_week.rename(columns={
        "team": "away_team", "r_off_pass": "a_off_pass", "r_off_rush": "a_off_rush",
        "r_def_pass": "a_def_pass", "r_def_rush": "a_def_rush"})
    m = games.merge(home_r[["game_id", "home_team", "h_off_pass", "h_off_rush", "h_def_pass", "h_def_rush"]],
                     on=["game_id", "home_team"], how="left")
    m = m.merge(away_r[["game_id", "away_team", "a_off_pass", "a_off_rush", "a_def_pass", "a_def_rush"]],
                on=["game_id", "away_team"], how="left")
    m = m.dropna(subset=["h_off_pass", "h_off_rush", "a_off_pass", "a_off_rush",
                          "h_def_pass", "h_def_rush", "a_def_pass", "a_def_rush"])

    m["pass_edge"] = (m["h_off_pass"] - m["a_def_pass"]) - (m["a_off_pass"] - m["h_def_pass"])
    m["rush_edge"] = (m["h_off_rush"] - m["a_def_rush"]) - (m["a_off_rush"] - m["h_def_rush"])
    m["rest_diff"] = m["home_rest"] - m["away_rest"]
    m["wind"] = m["wind"].fillna(0.0)
    m["dome"] = m["roof"].isin(["dome", "closed"]).astype(int)
    m["qb_change_home"] = 0
    m["qb_change_away"] = 0
    m["injury_edge"] = 0.0
    return m


def build_ratings_by_week(team_games: pd.DataFrame) -> pd.DataFrame:
    """Leak-free rating ENTERING each played week -- same logic as backtest_v2,
    needed to rebuild historical matchups for fitting the final model (fallback path)."""
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def seeded_for_col(col, out_col):
        def final_ewma(group):
            vals = group[col].to_numpy()
            running = np.nan
            for v in vals:
                if np.isnan(v):
                    continue
                running = v if np.isnan(running) else EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
            return running

        season_final = tg.groupby(["team", "season"]).apply(final_ewma).rename("final_rating").reset_index()
        season_final["next_season"] = season_final["season"] + 1
        carryover = season_final[["team", "next_season", "final_rating"]].rename(
            columns={"next_season": "season", "final_rating": "prior_final"})
        local = tg.merge(carryover, on=["team", "season"], how="left")
        local["prior_final"] = local["prior_final"].fillna(0.0)

        def seeded(group):
            vals = group[col].to_numpy()
            running = group["prior_final"].iloc[0] * SEASON_CARRYOVER
            rating = np.empty(len(vals))
            for i, v in enumerate(vals):
                rating[i] = running
                if not np.isnan(v):
                    running = EWMA_ALPHA * v + (1 - EWMA_ALPHA) * running
            return pd.Series(rating, index=group.index)

        return local.groupby(["team", "season"], group_keys=False).apply(seeded)

    for col, out in [("off_pass_epa_play", "r_off_pass"), ("off_rush_epa_play", "r_off_rush"),
                      ("def_pass_epa_play", "r_def_pass"), ("def_rush_epa_play", "r_def_rush")]:
        tg[out] = seeded_for_col(col, out)
    return tg[["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]]


def fit_final_margin_model(hist: pd.DataFrame):
    X = hist[FEATURES].to_numpy(dtype=float)
    X = np.column_stack([np.ones(len(X)), X])
    y = hist["result"].to_numpy(dtype=float)
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    return coef


def fit_final_edge_calibration(preds_v2_path: Path):
    """Prefer the real, precisely-computed v2 predictions for calibration if available."""
    if not preds_v2_path.exists():
        return None
    from sklearn.linear_model import LogisticRegression
    df = pd.read_csv(preds_v2_path)
    df["home_cover_margin"] = df["result"] - df["spread_line"]
    df = df[df["home_cover_margin"] != 0].copy()
    df["home_covers"] = (df["home_cover_margin"] > 0).astype(int)
    clf = LogisticRegression(max_iter=1000)
    clf.fit(df[["model_edge"]].to_numpy(dtype=float), df["home_covers"].to_numpy(dtype=int))
    return clf


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--backtest-dir", default="backtest", type=Path)
    parser.add_argument("--predictions-v2", default="backtest/predictions_v2.csv", type=Path)
    parser.add_argument("--season", type=int, required=True)
    args = parser.parse_args()

    print(f"Loading team-game EPA history (all seasons through what's in raw/)...")
    team_games = load_team_games(args.raw_dir)

    print("Computing each team's CURRENT rating (entering their next game)...")
    cur = current_ratings_all(team_games, args.season)

    if args.predictions_v2.exists():
        # predictions_v2.csv already has precisely-computed qb_change/injury_edge
        # features (from backtest_v2's more careful historical reconstruction) --
        # prefer it over rebuilding a cruder version with those zeroed out.
        print(f"Using {args.predictions_v2} as the historical fit set (has real QB/injury features)...")
        hist = pd.read_csv(args.predictions_v2)
    else:
        print("No predictions_v2.csv found -- rebuilding historical matchups from raw/ "
              "(qb_change/injury_edge will be zeroed out for this fit -- run backtest_v2.py "
              "first for a model that actually uses those features).")
        ratings_by_week = build_ratings_by_week(team_games)
        hist = load_historical_matchups(args.raw_dir, ratings_by_week)
    print(f"  fitting on {len(hist)} completed historical games")
    coef = fit_final_margin_model(hist)
    coef_map = dict(zip(["intercept"] + FEATURES, coef))
    print(f"  final model coefficients: {json.dumps({k: round(v,4) for k,v in coef_map.items()})}")

    calib = fit_final_edge_calibration(args.predictions_v2)
    if calib is None:
        print("  (no predictions_v2.csv found -- skipping calibrated probability, edge only)")

    games = pd.read_csv(args.raw_dir / "games.csv", low_memory=False)
    games = games[(games["game_type"] == "REG") & (games["season"] == args.season)]
    upcoming = games[games["result"].isna() & games["spread_line"].notna()].copy()
    print(f"\nFound {len(upcoming)} upcoming {args.season} games with a posted line")

    if upcoming.empty:
        print("Nothing to predict -- no upcoming games with lines posted yet.")
        return

    est_starters = established_starters(pd.read_csv(args.raw_dir / "games.csv", low_memory=False))
    cur_idx = cur.set_index("team")

    rows = []
    for _, g in upcoming.iterrows():
        home, away = g["home_team"], g["away_team"]
        if home not in cur_idx.index or away not in cur_idx.index:
            continue
        h, a = cur_idx.loc[home], cur_idx.loc[away]

        pass_edge = (h["off_pass"] - a["def_pass"]) - (a["off_pass"] - h["def_pass"])
        rush_edge = (h["off_rush"] - a["def_rush"]) - (a["off_rush"] - h["def_rush"])
        rest_diff = (g["home_rest"] if pd.notna(g["home_rest"]) else 7) - \
                    (g["away_rest"] if pd.notna(g["away_rest"]) else 7)
        wind = 0.0
        dome = 1 if g["roof"] in ("dome", "closed") else 0

        inj = injury_out_players(args.raw_dir, args.season, int(g["week"]))
        home_out = int((inj["team"] == home).sum()) if not inj.empty else 0
        away_out = int((inj["team"] == away).sum()) if not inj.empty else 0
        injury_edge = away_out - home_out

        home_qb_out = (not inj.empty) and (
            (inj[(inj["team"] == home) & (inj["position"] == "QB")]["report_status"] == "Out").any()
        )
        away_qb_out = (not inj.empty) and (
            (inj[(inj["team"] == away) & (inj["position"] == "QB")]["report_status"] == "Out").any()
        )
        qb_change_home = int(home_qb_out)
        qb_change_away = int(away_qb_out)

        feat = {"pass_edge": pass_edge, "rush_edge": rush_edge, "rest_diff": rest_diff,
                "wind": wind, "dome": dome, "qb_change_home": qb_change_home,
                "qb_change_away": qb_change_away, "injury_edge": injury_edge}
        x = np.array([1.0] + [feat[f] for f in FEATURES])
        predicted_margin = float(x @ coef)
        model_edge = predicted_margin - float(g["spread_line"])

        p_home_covers = None
        if calib is not None:
            p_home_covers = float(calib.predict_proba([[model_edge]])[0, 1])

        rows.append({
            "season": int(g["season"]), "week": int(g["week"]), "game_id": g["game_id"],
            "gameday": g["gameday"], "home_team": home, "away_team": away,
            "market_spread": float(g["spread_line"]),
            "market_total": float(g["total_line"]) if pd.notna(g["total_line"]) else None,
            "model_spread": round(predicted_margin, 2),
            "edge": round(model_edge, 2),
            "p_home_covers": round(p_home_covers, 4) if p_home_covers is not None else None,
            "flagged": abs(model_edge) >= EDGE_THRESHOLD,
            "home_qb_established": est_starters.get(home),
            "away_qb_established": est_starters.get(away),
            "home_qb_out_flag": qb_change_home, "away_qb_out_flag": qb_change_away,
            "home_injuries_out": home_out, "away_injuries_out": away_out,
        })

    preds = pd.DataFrame(rows)
    print(f"\n{preds['flagged'].sum()} of {len(preds)} games flagged (|edge| >= {EDGE_THRESHOLD})")

    # ---- write per-week site snapshot, one file per (season, week) ----
    for week, wk in preds.groupby("week"):
        payload = {
            "week": int(week), "season": args.season, "updated": now_iso(),
            "note": DISCLAIMER,
            "games": [
                {"matchup": f"{r.away_team} @ {r.home_team}", "market_spread": r.market_spread,
                 "model_spread": r.model_spread, "edge": r.edge, "p_home_covers": r.p_home_covers,
                 "flagged": bool(r.flagged), "market_total": r.market_total}
                for r in wk.itertuples()
            ],
        }
        out_path = args.data_dir / "model" / f"{args.season}-week{int(week)}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2, default=str))
        print(f"  wrote {out_path}")

    # ---- manifest so the site knows what weeks are available (no directory listing on a static host) ----
    model_dir = args.data_dir / "model"
    weeks_available = []
    for f in sorted(model_dir.glob("*-week*.json")):
        s, w = f.stem.split("-week")
        weeks_available.append({"season": int(s), "week": int(w)})
    weeks_available.sort(key=lambda x: (x["season"], x["week"]))
    manifest = {"weeks": weeks_available, "latest": weeks_available[-1] if weeks_available else None}
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"  wrote {model_dir / 'manifest.json'}")

    # ---- append flagged games to the picks log (idempotent on game_id) ----
    log_csv = args.backtest_dir / "picks_log.csv"
    log_csv.parent.mkdir(parents=True, exist_ok=True)
    flagged = preds[preds["flagged"]].copy()
    flagged["logged_at"] = now_iso()
    flagged["bet_placed"] = "N"
    flagged["closing_line"] = np.nan
    flagged["actual_result"] = np.nan
    flagged["clv"] = np.nan

    log_cols = ["logged_at", "season", "week", "game_id", "gameday", "home_team", "away_team",
                "market_spread", "model_spread", "edge", "p_home_covers",
                "bet_placed", "closing_line", "actual_result", "clv"]

    if log_csv.exists():
        existing = pd.read_csv(log_csv)
        already_logged = set(existing["game_id"])
        new_rows = flagged[~flagged["game_id"].isin(already_logged)]
        combined = pd.concat([existing, new_rows[log_cols]], ignore_index=True)
    else:
        new_rows = flagged
        combined = flagged[log_cols]

    combined.to_csv(log_csv, index=False)
    (args.data_dir / "log").mkdir(parents=True, exist_ok=True)
    combined.to_json(args.data_dir / "log" / "picks_log.json", orient="records", indent=2)
    print(f"\n{len(new_rows)} new picks logged (log now has {len(combined)} total rows)")
    print(f"Wrote {log_csv} and data/log/picks_log.json")
    print(f"\n{DISCLAIMER}")


if __name__ == "__main__":
    main()
