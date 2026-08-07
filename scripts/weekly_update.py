#!/usr/bin/env python3
"""
Phase 2: weekly (and now more-than-weekly -- see below) tool. Run this any
time after dropping updated raw CSVs into raw/ (games.csv,
team/stats_team_week_{season}.csv, injuries/injuries_{season}.csv).

What it does:
  1. Computes each team's CURRENT rating (off/def x pass/rush) as of right
     now -- i.e. their rating entering their next game -- as a simple
     trailing average of their last 10 completed games, ANY season, REG +
     POST both count. This replaced the original full-history EWMA rating
     in 2026-08 -- Jeff's call, made aware that backtest_v5_rolling10.py
     found no ATS signal from a rolling window (any size tested) and no
     improvement over the EWMA model it replaced. Recency over history was
     the deliberate tradeoff. See HANDOFF.md for the full writeup, and
     backtest/model_coefficients.json's "note" field for the short version.
  2. Finds upcoming games (no result yet, but a market spread_line posted).
  3. Builds the same feature set backtest_v2/v5 use (pass_edge, rush_edge,
     rest_diff, wind, dome, qb_change_home/away, injury_edge) for each one.
     QB-change and injury features use the CURRENT week's injury report
     (if available) rather than games.csv's actual-starter field, since
     that field isn't known in advance for a game that hasn't happened.
  4. Scores every upcoming game using PRE-FITTED coefficients loaded from
     backtest/model_coefficients.json -- this script does NOT fit anything
     itself anymore. Fitting needs the full historical raw/team/ archive
     (all seasons) to rebuild a rolling-10 feature table across thousands
     of historical games; that's a real "need decades of files" operation,
     and now that this script runs as often as the odds snapshots (up to
     16x/week, see .github/workflows/), it specifically should NOT need
     that archive on every run. Re-run scripts/fit_model_coefficients.py
     by hand (with the full raw/ archive present) whenever there's a good
     reason to refit -- a meaningful chunk of new data, or the feature set
     changing (Jeff's planned expert-picks addition, etc.) -- not on any
     automated schedule.
  5. Upserts every scored game into the D1 `model` table (one row per
     game_id -- re-running this script before kickoff, e.g. as injury
     news changes or a new odds snapshot lands, overwrites that game's
     prior prediction in place) and inserts newly-flagged games (|edge| >=
     threshold) into the D1 `picks_log` table. picks_log inserts are
     append-only: once a game_id is logged there, this script never
     touches it again (that's reconcile_picks.py's job, and even that only
     fills in the outcome columns).

IMPORTANT: per the Phase 1 calibration test (run against the prior EWMA
model; rolling-10 hasn't been independently calibration-tested), this
model's confidence should not be assumed reliable. Everything this script
produces is for logging/paper-trading only -- see --note in the output.

D1 access: this script shells out to `wrangler d1 execute --remote` by
default. You must have already run `wrangler login` once locally; GitHub
Actions runs use CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID env vars instead
(same wrangler CLI, non-interactive auth).
"""

import argparse
import json
import math
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROLLING_WINDOW = 10
EDGE_THRESHOLD = 2.0
QB_WINDOW = 8
DISCLAIMER = (
    "PAPER TRADING ONLY. Rolling-10 rating method (2026-08+): backtested "
    "standalone with no ATS signal found at any window size, and no "
    "improvement over the model's prior EWMA approach. Chosen for recency "
    "over history anyway -- see HANDOFF.md. These numbers are logged for "
    "tracking, not acted on."
)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x))


# --------------------------------------------------------------------------
# D1 helpers (shell out to wrangler)
# --------------------------------------------------------------------------
def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    if isinstance(v, float) and np.isnan(v):
        return "NULL"
    return str(v)


def sql_bool(v):
    return "1" if v else "0"


def run_d1_statements(statements, db_name):
    """Write `statements` to a temp .sql file and apply it with
    `wrangler d1 execute --remote --file=`. No-op if statements is empty."""
    if not statements:
        return
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".sql", delete=False, encoding="utf-8"
    ) as f:
        f.write("\n".join(statements))
        tmp_path = Path(f.name)
    try:
        cmd = ["wrangler", "d1", "execute", db_name, "--remote", f"--file={tmp_path}"]
        print(f"  running: {' '.join(cmd)}  ({len(statements)} statement(s))")
        subprocess.run(cmd, check=True)
    finally:
        tmp_path.unlink(missing_ok=True)


# --------------------------------------------------------------------------
# team EPA/play -- REG + POST both count (rolling-10 uses playoff games as
# recent-form signal, per Jeff's spec: "regardless of year, including
# playoffs"). Only needs whatever season files happen to be in raw/team/ --
# the live scoring path only ever needs the last ~10 games per team, so
# current + previous season is plenty; it does NOT need the full historical
# archive the way fit_model_coefficients.py does.
# --------------------------------------------------------------------------
def load_team_games(raw_dir: Path) -> pd.DataFrame:
    files = sorted((raw_dir / "team").glob("stats_team_week_*.csv"))
    if not files:
        raise SystemExit("No raw/team/stats_team_week_*.csv files found.")
    dfs = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    # no season_type filter -- REG + POST both count as "games played"

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
# each team's rating RIGHT NOW (entering their next, not-yet-played game) --
# a simple trailing average of their last ROLLING_WINDOW completed games,
# any season. Replaces the old EWMA + season-carryover approach.
# --------------------------------------------------------------------------
def current_ratings_all(team_games: pd.DataFrame, window: int = ROLLING_WINDOW) -> pd.DataFrame:
    tg = team_games.sort_values(["season", "week"])
    cols = [("off_pass_epa_play", "off_pass"), ("off_rush_epa_play", "off_rush"),
            ("def_pass_epa_play", "def_pass"), ("def_rush_epa_play", "def_rush")]
    rows = []
    for team, g in tg.groupby("team"):
        tail = g.tail(window)
        r = {"team": team}
        for col, name in cols:
            v = tail[col].mean()  # pandas .mean() skips NaN automatically
            r[name] = 0.0 if pd.isna(v) else float(v)
        rows.append(r)
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# QB availability + injuries for the CURRENT week (forward-looking, uses
# only information that would actually be known before kickoff)
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


FEATURES = ["pass_edge", "rush_edge", "rest_diff", "wind", "dome",
            "qb_change_home", "qb_change_away", "injury_edge"]


def load_coefficients(path: Path):
    if not path.exists():
        raise SystemExit(
            f"No coefficients file at {path}. Run "
            f"`python3 scripts/fit_model_coefficients.py --raw-dir raw --out {path}` "
            f"first (needs the full historical raw/team/ archive, all seasons)."
        )
    data = json.loads(path.read_text())
    coef_map = data["margin_model_coefficients"]
    coef = np.array([coef_map["intercept"]] + [coef_map[f] for f in FEATURES])
    calib = data.get("edge_calibration")
    return coef, calib, data


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--coefficients", default="backtest/model_coefficients.json", type=Path,
                         help="Pre-fitted coefficients from fit_model_coefficients.py. This "
                              "script never fits anything itself.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--db-name", default="edge-rush",
                         help="D1 database name (wrangler.toml database_name)")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute`. Use this when there's no wrangler/"
                              "local login available (e.g. a Cowork scheduled task) -- "
                              "apply the file yourself (e.g. via the D1 MCP tool).")
    args = parser.parse_args()

    print(f"Loading team-game EPA history (REG + POST, whatever seasons are in raw/team/)...")
    team_games = load_team_games(args.raw_dir)

    print(f"Computing each team's CURRENT rating (last {ROLLING_WINDOW} games, entering their next game)...")
    cur = current_ratings_all(team_games)

    print(f"Loading pre-fitted coefficients from {args.coefficients}...")
    coef, calib, coef_meta = load_coefficients(args.coefficients)
    print(f"  fitted {coef_meta.get('fitted_at')} on {coef_meta.get('n_historical_games')} "
          f"historical games ({coef_meta.get('rating_method')})")

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
            p_home_covers = sigmoid(calib["coef"] * model_edge + calib["intercept"])

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

    updated_at = now_iso()

    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("")  # start fresh -- statements below are appended

    # ---- upsert every scored game into D1 `model` (one row per game_id;
    # re-running before kickoff overwrites that game's prior prediction) ----
    model_stmts = []
    for r in preds.itertuples():
        matchup = f"{r.away_team} @ {r.home_team}"
        model_stmts.append(
            "INSERT INTO model (season, week, game_id, matchup, market_spread, model_spread, "
            "edge, p_home_covers, flagged, market_total, updated, note) VALUES ("
            f"{r.season}, {r.week}, {sql_str(r.game_id)}, {sql_str(matchup)}, "
            f"{sql_num(r.market_spread)}, {sql_num(r.model_spread)}, {sql_num(r.edge)}, "
            f"{sql_num(r.p_home_covers)}, {sql_bool(r.flagged)}, {sql_num(r.market_total)}, "
            f"{sql_str(updated_at)}, {sql_str(DISCLAIMER)}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "matchup=excluded.matchup, market_spread=excluded.market_spread, "
            "model_spread=excluded.model_spread, edge=excluded.edge, "
            "p_home_covers=excluded.p_home_covers, flagged=excluded.flagged, "
            "market_total=excluded.market_total, updated=excluded.updated, note=excluded.note;"
        )
    print(f"\nUpserting {len(model_stmts)} predictions into D1 `model`...")
    if args.sql_out:
        with open(args.sql_out, "a", encoding="utf-8") as f:
            f.write("\n".join(model_stmts) + "\n")
        print(f"  wrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        run_d1_statements(model_stmts, args.db_name)

    # ---- insert newly-flagged games into D1 `picks_log` (append-only:
    # INSERT OR IGNORE means a game_id already logged is never touched here) ----
    flagged = preds[preds["flagged"]].copy()
    picks_stmts = []
    for r in flagged.itertuples():
        picks_stmts.append(
            "INSERT OR IGNORE INTO picks_log (logged_at, season, week, game_id, gameday, "
            "home_team, away_team, market_spread, model_spread, edge, p_home_covers, "
            "bet_placed, closing_line, actual_result, clv) VALUES ("
            f"{sql_str(updated_at)}, {r.season}, {r.week}, {sql_str(r.game_id)}, "
            f"{sql_str(r.gameday)}, {sql_str(r.home_team)}, {sql_str(r.away_team)}, "
            f"{sql_num(r.market_spread)}, {sql_num(r.model_spread)}, {sql_num(r.edge)}, "
            f"{sql_num(r.p_home_covers)}, 'N', NULL, NULL, NULL);"
        )
    print(f"Inserting up to {len(picks_stmts)} newly-flagged picks into D1 `picks_log` "
          f"(existing game_ids are silently skipped)...")
    if args.sql_out:
        if picks_stmts:
            with open(args.sql_out, "a", encoding="utf-8") as f:
                f.write("\n".join(picks_stmts) + "\n")
        print(f"  wrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        run_d1_statements(picks_stmts, args.db_name)

    print(f"\nDone. {len(model_stmts)} predictions upserted, "
          f"{len(picks_stmts)} flagged picks submitted (new ones inserted, repeats ignored).")
    print(f"\n{DISCLAIMER}")


if __name__ == "__main__":
    main()
