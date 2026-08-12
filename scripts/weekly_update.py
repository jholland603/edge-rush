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
# Top N picks per week, ranked by |edge| -- replaces the old "flag anything
# that clears the threshold" logic (2026-08-11, Jeff's call: "the goal isn't
# to try to pick every game... best 2-4 games to bet on per week"). A game
# still has to clear EDGE_THRESHOLD to be picked at all -- TOP_N_PER_WEEK
# just caps how many of the threshold-clearing games actually become picks,
# so a strong week gives up to 4, a flat week can give fewer (down to 0),
# and it never forces a pick that isn't really there. See backtest_v14.
TOP_N_PER_WEEK = 4
QB_WINDOW = 8
DISCLAIMER = (
    "PAPER TRADING ONLY. Model is pass_edge + rush_edge ONLY as of "
    "2026-08-11 (Jeff's call, dropping rest/wind/dome/QB-change/injury as "
    "model inputs -- backtest_v13 showed the 2-feature version beat the "
    "prior 8-feature model in every era cut tested: full history, last 10, "
    "last 8, and last 5 seasons; adding QB change back on top made it "
    "slightly worse in every one of those cuts too). Picks are now the top "
    f"{TOP_N_PER_WEEK} games per week by |edge| that also clear the "
    f"{EDGE_THRESHOLD}-point threshold (backtest_v14), not every game that "
    "clears the threshold. None of this is validated to beat the closing "
    "line -- see backtest_v11/v12/v13/v14 for the full history of what was "
    "tried and how thin the evidence is at every step. These numbers are "
    "logged for tracking, not acted on."
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
    return df[["season", "week", "team", "opponent_team", "game_id",
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
# Opponent-similarity-weighted ratings -- INFORMATIONAL ONLY, shown as a
# game.html card, never fed into FEATURES/predicted_margin above. Jeff's
# idea: instead of a flat average over a team's last 10 games, weight each
# of those games by how similar that game's opponent was, in the relevant
# unit, to the opponent this week (e.g. weight a team's pass-offense games
# toward the ones played against a similar-quality pass defense to this
# week's) -- AND (added in scripts/backtest_v7_recency_similarity.py) weight
# more recent games more heavily regardless of similarity: last 4 games get
# 2x, next 3 get 1.5x, oldest 3 get 1x, stacked multiplicatively with the
# similarity kernel. Backtested: pure similarity alone was a wash when added
# as a model feature (hit rate 51.26% -> 51.25%); the combined recency +
# similarity version (this one) was the first variant to move hit rate up at
# all, 51.26% -> 51.33% -- still nowhere near the 52.4% breakeven, and not
# something to treat as validated, but the least-bad result of everything
# tried so far. See HANDOFF.md / backtest_v7_recency_similarity.py. Kept
# visible per Jeff's explicit ask either way, as a secondary "does recent
# form look different against similar competition" card.
#
# SIMILARITY_BANDWIDTH_MULTIPLIER=0.5 is the tightest of the 4 bandwidths
# tested (0.5/1.0/2.0/4.0x the pooled rating std) -- it had the best
# standalone correlation both alone (v6) and combined with recency (v7), so
# production now matches what the backtest actually preferred rather than a
# deliberately-calmer compromise. Trade-off: more sample-thinning (effective
# ~5.3 of 10 games combined with recency, vs ~7.6 at 1.0x) -- the avg_ess
# shown on the card is exactly this, so a low number there is expected at
# this setting, not a bug.
SIMILARITY_BANDWIDTH_MULTIPLIER = 0.5


# Recency tiers -- rank 1 = most recent game in a team's window, counting
# backward. Rank-based (not position-based) so it still works correctly for
# teams with fewer than 10 games of history (early season): their most
# recent games still get the 2x/1.5x tiers, nothing falls through unweighted.
def recency_multiplier(rank_from_recent: int) -> float:
    if rank_from_recent <= 4:
        return 2.0
    if rank_from_recent <= 7:
        return 1.5
    return 1.0


def recency_weights_for_length(length: int) -> np.ndarray:
    # arr is ordered oldest -> newest (index 0 = oldest); rank from most
    # recent for index i is (length - i).
    return np.array([recency_multiplier(length - i) for i in range(length)])


def build_entering_ratings_with_opponent(team_games: pd.DataFrame, window: int = ROLLING_WINDOW) -> pd.DataFrame:
    """Leak-free entering rating per (team, game), plus the OPPONENT's own
    entering rating as of that same historical game -- i.e. how good was the
    team I played, at the time I played them. Same construction as
    backtest_v6_similarity_weighted.py's build_entering_ratings; duplicated
    here (not imported) since this script intentionally has no dependency on
    the backtest scripts -- kept in sync by hand if the method ever changes."""
    tg = team_games.sort_values(["team", "season", "week"]).reset_index(drop=True)

    def rolling_leak_free(col):
        return tg.groupby("team")[col].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).mean()
        )

    tg["r_off_pass"] = rolling_leak_free("off_pass_epa_play")
    tg["r_off_rush"] = rolling_leak_free("off_rush_epa_play")
    tg["r_def_pass"] = rolling_leak_free("def_pass_epa_play")
    tg["r_def_rush"] = rolling_leak_free("def_rush_epa_play")

    opp = tg[["game_id", "team", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]].rename(
        columns={
            "team": "opponent_team", "r_off_pass": "opp_r_off_pass", "r_off_rush": "opp_r_off_rush",
            "r_def_pass": "opp_r_def_pass", "r_def_rush": "opp_r_def_rush",
        }
    )
    return tg.merge(opp, on=["game_id", "opponent_team"], how="left")


def similarity_global_std(tg: pd.DataFrame) -> float:
    vals = pd.concat([tg["r_off_pass"], tg["r_off_rush"], tg["r_def_pass"], tg["r_def_rush"]])
    return float(vals.std(skipna=True))


_SIM_ARRAY_COLS = {
    "off_pass": "off_pass_epa_play", "off_rush": "off_rush_epa_play",
    "def_pass": "def_pass_epa_play", "def_rush": "def_rush_epa_play",
    "opp_r_off_pass": "opp_r_off_pass", "opp_r_off_rush": "opp_r_off_rush",
    "opp_r_def_pass": "opp_r_def_pass", "opp_r_def_rush": "opp_r_def_rush",
}


def build_similarity_team_arrays(tg: pd.DataFrame) -> dict:
    return {
        team: {k: g[col].to_numpy(dtype=float) for k, col in _SIM_ARRAY_COLS.items()}
        for team, g in tg.groupby("team")
    }


def combined_weighted(opp_vals: np.ndarray, stat_vals: np.ndarray, target: float, bandwidth: float,
                       recency_arr: np.ndarray):
    """Weighted average of `stat_vals`, combining a Gaussian similarity
    kernel (how close `opp_vals` is to `target`) with the recency tiers
    (`recency_arr`), multiplicatively. Returns (rating, effective_sample_size),
    NaN if nothing usable. Identical logic to
    backtest_v7_recency_similarity.py's combined_weighted (similarity always
    on here -- this script doesn't need the recency-only/similarity-only
    toggle the backtest used for comparison)."""
    if opp_vals.size == 0 or np.isnan(target):
        return np.nan, np.nan
    valid = ~np.isnan(opp_vals) & ~np.isnan(stat_vals)
    if not valid.any():
        return np.nan, np.nan
    diffs = opp_vals[valid] - target
    vals = stat_vals[valid]
    rec = recency_arr[valid]
    kern = np.exp(-0.5 * (diffs / bandwidth) ** 2)
    w = kern * rec
    wsum = w.sum()
    if wsum <= 1e-9:  # kernel collapsed to ~0 everywhere -- fall back to recency-only, then flat
        w = rec.copy()
        wsum = w.sum()
        if wsum <= 1e-9:
            w = np.ones(len(vals))
            wsum = float(len(vals))
    rating = float((vals * w).sum() / wsum)
    ess = float((w.sum() ** 2) / (w ** 2).sum())
    return rating, ess


def similarity_weighted_ratings(team_arrays: dict, team: str, opp_def_pass: float, opp_def_rush: float,
                                 opp_off_pass: float, opp_off_rush: float, bandwidth: float, window: int):
    """This team's last `window` games, reweighted toward opponents similar
    to the one it's ABOUT to play (opp_def_pass/opp_def_rush/opp_off_pass/
    opp_off_rush = that upcoming opponent's own CURRENT rating -- there's no
    "as of the time" restriction needed here since nothing has happened
    after "now" yet), AND toward more recent games regardless of similarity
    (recency tiers, see comment above). Returns (off_pass, off_rush, def_pass,
    def_rush, avg_effective_sample_size)."""
    arr = team_arrays.get(team)
    if arr is None:
        return 0.0, 0.0, 0.0, 0.0, None
    n = len(arr["off_pass"])
    lo = max(0, n - window)
    rec = recency_weights_for_length(n - lo)
    off_pass, ess1 = combined_weighted(arr["opp_r_def_pass"][lo:n], arr["off_pass"][lo:n], opp_def_pass, bandwidth, rec)
    off_rush, ess2 = combined_weighted(arr["opp_r_def_rush"][lo:n], arr["off_rush"][lo:n], opp_def_rush, bandwidth, rec)
    def_pass, ess3 = combined_weighted(arr["opp_r_off_pass"][lo:n], arr["def_pass"][lo:n], opp_off_pass, bandwidth, rec)
    def_rush, ess4 = combined_weighted(arr["opp_r_off_rush"][lo:n], arr["def_rush"][lo:n], opp_off_rush, bandwidth, rec)
    ess_vals = [e for e in (ess1, ess2, ess3, ess4) if not np.isnan(e)]
    avg_ess = float(np.mean(ess_vals)) if ess_vals else None
    clean = lambda v: 0.0 if np.isnan(v) else v
    return clean(off_pass), clean(off_rush), clean(def_pass), clean(def_rush), avg_ess


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


# Model inputs -- pass_edge/rush_edge ONLY as of 2026-08-11 (must match
# fit_model_coefficients.py's FEATURES, since that's what actually produced
# backtest/model_coefficients.json's coefficient keys). rest_diff/wind/dome/
# qb_change_home/away/injury_edge are still computed below (the `feat` dict
# has all of them) and still stored/shown on the site as informational
# signals -- they're just no longer part of the prediction itself. See the
# DISCLAIMER above and notes.md for why.
FEATURES = ["pass_edge", "rush_edge"]


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

    print("Building opponent-similarity-weighted ratings (informational only, see game.html card -- "
          "NOT used in the prediction below)...")
    sim_tg = build_entering_ratings_with_opponent(team_games, ROLLING_WINDOW)
    sim_bandwidth = SIMILARITY_BANDWIDTH_MULTIPLIER * similarity_global_std(sim_tg)
    sim_team_arrays = build_similarity_team_arrays(sim_tg)

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

        # Opponent-similarity-weighted comparison -- informational only (see
        # comment on similarity_weighted_ratings above). Reuses the SAME
        # opponent targets (a[...]/h[...], i.e. the actual upcoming
        # opponent's current flat rating) as the real pass_edge/rush_edge
        # above -- the only difference is HOW each team's own last-10
        # window gets averaged (flat vs. opponent-similarity-weighted).
        h_op, h_or, h_dp, h_dr, h_ess = similarity_weighted_ratings(
            sim_team_arrays, home, a["def_pass"], a["def_rush"], a["off_pass"], a["off_rush"],
            sim_bandwidth, ROLLING_WINDOW
        )
        a_op, a_or, a_dp, a_dr, a_ess = similarity_weighted_ratings(
            sim_team_arrays, away, h["def_pass"], h["def_rush"], h["off_pass"], h["off_rush"],
            sim_bandwidth, ROLLING_WINDOW
        )
        pass_edge_weighted = (h_op - a_dp) - (a_op - h_dp)
        rush_edge_weighted = (h_or - a_dr) - (a_or - h_dr)

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
            "clears_threshold": abs(model_edge) >= EDGE_THRESHOLD,
            "home_qb_established": est_starters.get(home),
            "away_qb_established": est_starters.get(away),
            "home_qb_out_flag": qb_change_home, "away_qb_out_flag": qb_change_away,
            "home_injuries_out": home_out, "away_injuries_out": away_out,
            "flat_pass_edge": pass_edge, "flat_rush_edge": rush_edge,
            "weighted_pass_edge": pass_edge_weighted, "weighted_rush_edge": rush_edge_weighted,
            "home_avg_ess": h_ess, "away_avg_ess": a_ess,
        })

    preds = pd.DataFrame(rows)

    # Top TOP_N_PER_WEEK picks per week by |edge|, among games that clear
    # EDGE_THRESHOLD -- see TOP_N_PER_WEEK's comment above. Ranked within
    # (season, week) since a single run of this script can cover more than
    # one upcoming week (e.g. next week's Sunday games already have lines
    # posted while this week's Monday game hasn't kicked off yet).
    preds["abs_edge"] = preds["edge"].abs()
    preds["rank_in_week"] = preds.groupby(["season", "week"])["abs_edge"].rank(method="first", ascending=False)
    preds["flagged"] = preds["clears_threshold"] & (preds["rank_in_week"] <= TOP_N_PER_WEEK)
    preds = preds.drop(columns=["abs_edge", "rank_in_week", "clears_threshold"])

    print(f"\n{preds['flagged'].sum()} of {len(preds)} games flagged "
          f"(top {TOP_N_PER_WEEK}/week by |edge|, and clears {EDGE_THRESHOLD}pt threshold)")

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
            "edge, p_home_covers, flagged, market_total, home_injuries_out, away_injuries_out, "
            "updated, note) VALUES ("
            f"{r.season}, {r.week}, {sql_str(r.game_id)}, {sql_str(matchup)}, "
            f"{sql_num(r.market_spread)}, {sql_num(r.model_spread)}, {sql_num(r.edge)}, "
            f"{sql_num(r.p_home_covers)}, {sql_bool(r.flagged)}, {sql_num(r.market_total)}, "
            f"{sql_num(r.home_injuries_out)}, {sql_num(r.away_injuries_out)}, "
            f"{sql_str(updated_at)}, {sql_str(DISCLAIMER)}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "matchup=excluded.matchup, market_spread=excluded.market_spread, "
            "model_spread=excluded.model_spread, edge=excluded.edge, "
            "p_home_covers=excluded.p_home_covers, flagged=excluded.flagged, "
            "market_total=excluded.market_total, home_injuries_out=excluded.home_injuries_out, "
            "away_injuries_out=excluded.away_injuries_out, "
            "updated=excluded.updated, note=excluded.note;"
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

    # ---- upsert the opponent-similarity comparison into D1
    # `model_similarity` -- INFORMATIONAL ONLY (see the big comment above
    # similarity_weighted_ratings()), a game.html display card, never read
    # by the pick logic above. Same upsert-on-game_id pattern as `model`. ----
    sim_stmts = []
    for r in preds.itertuples():
        sim_stmts.append(
            "INSERT INTO model_similarity (game_id, bandwidth_multiplier, flat_pass_edge, "
            "flat_rush_edge, weighted_pass_edge, weighted_rush_edge, home_avg_ess, away_avg_ess, "
            "updated) VALUES ("
            f"{sql_str(r.game_id)}, {sql_num(SIMILARITY_BANDWIDTH_MULTIPLIER)}, "
            f"{sql_num(r.flat_pass_edge)}, {sql_num(r.flat_rush_edge)}, "
            f"{sql_num(r.weighted_pass_edge)}, {sql_num(r.weighted_rush_edge)}, "
            f"{sql_num(r.home_avg_ess)}, {sql_num(r.away_avg_ess)}, {sql_str(updated_at)}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "bandwidth_multiplier=excluded.bandwidth_multiplier, "
            "flat_pass_edge=excluded.flat_pass_edge, flat_rush_edge=excluded.flat_rush_edge, "
            "weighted_pass_edge=excluded.weighted_pass_edge, weighted_rush_edge=excluded.weighted_rush_edge, "
            "home_avg_ess=excluded.home_avg_ess, away_avg_ess=excluded.away_avg_ess, "
            "updated=excluded.updated;"
        )
    print(f"Upserting {len(sim_stmts)} opponent-similarity comparison rows into D1 `model_similarity`...")
    if args.sql_out:
        with open(args.sql_out, "a", encoding="utf-8") as f:
            f.write("\n".join(sim_stmts) + "\n")
        print(f"  wrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        run_d1_statements(sim_stmts, args.db_name)

    print(f"\nDone. {len(model_stmts)} predictions upserted, "
          f"{len(picks_stmts)} flagged picks submitted (new ones inserted, repeats ignored), "
          f"{len(sim_stmts)} similarity-comparison rows upserted (informational only).")
    print(f"\n{DISCLAIMER}")


if __name__ == "__main__":
    main()
