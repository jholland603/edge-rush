#!/usr/bin/env python3
"""
Phase 1 backtest v12: true SRS (Simple Rating System) scoring model, the
follow-up to backtest_v11 after the flat rolling-10-average version of
opponent-adjusted scoring underperformed pass_edge/rush_edge across the
board (see the 2026-08-11 conversation / v11 results).

Why this is different from v11: v11's scoring_edge adjusted for opponent
quality in one hop -- a team's rating was its own average points scored/
allowed, and the "edge" compared that against the opponent's own one-hop
average. Real SRS is a JOINT solve: every team's rating is defined in terms
of every OTHER team's rating simultaneously (rating_i = avg margin_i +
avg opponent rating, solved iteratively until it converges), which is what
lets it properly account for strength of schedule instead of just a single
opponent-quality hop. This is standard methodology (pro-football-reference,
Sagarin, etc. all compute ratings this way) and should be meaningfully less
noisy than v11's version, if the underlying hypothesis (points are a more
direct signal than EPA) has any legs at all.

Leak-free design: rather than solving SRS per individual game (which would
require reconciling different "as of" cutoffs for the two teams in every
matchup -- genuinely ambiguous), this solves ONE joint SRS snapshot per
(season, week), using each team's trailing WINDOW=10 games strictly before
that week's EARLIEST kickoff (not just before each team's own game -- a
deliberately conservative cutoff, so even a team playing Monday night in a
week that started Thursday only sees data as fresh as the Thursday-game
teams do). Every game within that week then uses that single week's SRS
snapshot for both teams. This matches how real power-rating systems are
actually published (updated weekly, not continuously), and is still fully
leak-free -- if anything, slightly MORE conservative than the rest of this
project's per-team rolling cutoffs.

Solve method: standard Gauss-Seidel-style iteration --
    rating_i <- mean over i's window games of (margin_ij + rating_j)
repeated until the largest single-team change drops below 1e-6 (converges
in well under 200 iterations for a 32-team, densely-connected schedule this
size -- this is a textbook well-conditioned small system, no numerical
concerns here).

Also addresses Jeff's 2026-08-11 challenge on the whole backtesting
methodology: every result below is reported BOTH pooled across the full
2002-2025 history AND restricted to the last 8 seasons (2018-2025) alone,
since a method that only "works" on 20-year-old NFL isn't good evidence for
anything about betting 2026 games. Neither number is proof of a real edge --
backtests here are a screening tool to catch bad ideas before real money is
on the line, not validation. See notes.md / HANDOFF.md's PAPER TRADING ONLY
framing.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402
import backtest_v11_scoring_model as bv11  # noqa: E402

WINDOW = 10
RECENT_ERA_SEASONS = list(range(2018, 2026))  # 2018-2025, Jeff's "does this actually work now" cut
MAX_ITER = 200
TOL = 1e-6


# ---------------------------------------------------------------------------
# Long-format team-game table with gameday (v11's loader doesn't carry it --
# needed here for the per-week cutoff).
# ---------------------------------------------------------------------------
def load_scoring_games_with_date(raw_dir: Path) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["home_score", "away_score", "gameday"])
    games["gameday"] = pd.to_datetime(games["gameday"])

    home = games[["season", "week", "game_id", "gameday", "home_team", "away_team", "home_score", "away_score"]].rename(
        columns={"home_team": "team", "away_team": "opponent_team"}
    )
    home["margin"] = home["home_score"] - home["away_score"]
    away = games[["season", "week", "game_id", "gameday", "home_team", "away_team", "home_score", "away_score"]].rename(
        columns={"away_team": "team", "home_team": "opponent_team"}
    )
    away["margin"] = away["away_score"] - away["home_score"]

    tg = pd.concat([home, away], ignore_index=True)
    return tg[["season", "week", "game_id", "gameday", "team", "opponent_team", "margin"]].sort_values(
        ["team", "gameday"]
    ).reset_index(drop=True)


def solve_srs(team_games: dict) -> dict:
    """team_games: {team: [(opponent, margin), ...]} -- iterative joint
    solve. Teams with no games in the window get rating 0.0 (neutral)."""
    teams = list(team_games.keys())
    ratings = {t: 0.0 for t in teams}
    for _ in range(MAX_ITER):
        new_ratings = {}
        max_delta = 0.0
        for t in teams:
            gs = team_games[t]
            if not gs:
                new_ratings[t] = 0.0
                continue
            total = sum(margin + ratings.get(opp, 0.0) for opp, margin in gs)
            new_ratings[t] = total / len(gs)
        for t in teams:
            max_delta = max(max_delta, abs(new_ratings[t] - ratings[t]))
        ratings = new_ratings
        if max_delta < TOL:
            break
    return ratings


def build_srs_ratings_by_week(tg: pd.DataFrame, window: int = WINDOW) -> pd.DataFrame:
    week_keys = tg[["season", "week"]].drop_duplicates().sort_values(["season", "week"])
    week_start = tg.groupby(["season", "week"])["gameday"].min().rename("week_start")

    rows = []
    for _, wk in week_keys.iterrows():
        season, week = int(wk["season"]), int(wk["week"])
        cutoff = week_start.loc[(season, week)]

        prior = tg[tg["gameday"] < cutoff]
        if prior.empty:
            continue
        # leak-free trailing WINDOW games per team, strictly before this week
        prior = prior.sort_values("gameday").groupby("team").tail(window)

        team_games = {
            t: list(zip(g["opponent_team"], g["margin"]))
            for t, g in prior.groupby("team")
        }
        ratings = solve_srs(team_games)

        teams_this_week = tg[(tg["season"] == season) & (tg["week"] == week)]["team"].unique()
        for t in teams_this_week:
            rows.append({"season": season, "week": week, "team": t, "srs_rating": ratings.get(t, 0.0)})

    return pd.DataFrame(rows)


def build_srs_matchups(raw_dir: Path, srs_ratings: pd.DataFrame) -> pd.DataFrame:
    games = pd.read_csv(raw_dir / "games.csv", low_memory=False)
    games = games[games["game_type"] == "REG"].copy()
    games = games.dropna(subset=["spread_line", "result", "home_score", "away_score"])

    home_r = srs_ratings.rename(columns={"team": "home_team", "srs_rating": "h_srs"})
    away_r = srs_ratings.rename(columns={"team": "away_team", "srs_rating": "a_srs"})
    m = games.merge(home_r[["season", "week", "home_team", "h_srs"]], on=["season", "week", "home_team"], how="left")
    m = m.merge(away_r[["season", "week", "away_team", "a_srs"]], on=["season", "week", "away_team"], how="left")
    m = m.dropna(subset=["h_srs", "a_srs"])
    m["scoring_edge"] = m["h_srs"] - m["a_srs"]

    qb = bv2.build_qb_change_flags(pd.read_csv(raw_dir / "games.csv", low_memory=False))
    qb_home = qb.rename(columns={"team": "home_team", "qb_change": "qb_change_home"})
    qb_away = qb.rename(columns={"team": "away_team", "qb_change": "qb_change_away"})
    m = m.merge(qb_home[["game_id", "home_team", "qb_change_home"]], on=["game_id", "home_team"], how="left")
    m = m.merge(qb_away[["game_id", "away_team", "qb_change_away"]], on=["game_id", "away_team"], how="left")
    m["qb_change_home"] = m["qb_change_home"].fillna(0).astype(int)
    m["qb_change_away"] = m["qb_change_away"].fillna(0).astype(int)

    return m


def run_walk_forward_with_era_cut(m: pd.DataFrame, features: list, label: str) -> dict:
    base_features = bv2.FEATURES
    bv2.FEATURES = features
    try:
        preds = bv2.walk_forward_predict(m)
        preds, flagged = bv2.score(preds)
        full_summary = bv2.summarize(preds, flagged)

        recent_preds = preds[preds["season"].isin(RECENT_ERA_SEASONS)]
        recent_flagged = flagged[flagged["season"].isin(RECENT_ERA_SEASONS)]
        recent_summary = bv2.summarize(recent_preds, recent_flagged) if len(recent_preds) else None
    finally:
        bv2.FEATURES = base_features

    print(f"\n=== {label} ===")
    print("  full 2002-2025:", json.dumps(full_summary["overall"], indent=2))
    if recent_summary:
        print("  recent 2018-2025:", json.dumps(recent_summary["overall"], indent=2))
    return {"full_history": full_summary, "recent_era": recent_summary}


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v12_out")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {}

    print("Loading scoring team-games with gameday ...")
    tg = load_scoring_games_with_date(raw_dir)
    print(f"  {len(tg)} team-game rows")

    print("Solving joint SRS ratings, one snapshot per (season, week) ...")
    srs_ratings = build_srs_ratings_by_week(tg, WINDOW)
    print(f"  {len(srs_ratings)} team-week SRS ratings computed")

    print("Building matchup table (SRS diff + QB change) ...")
    srs_m = build_srs_matchups(raw_dir, srs_ratings)
    print(f"  {len(srs_m)} games with SRS scoring_edge")

    # standalone correlation, same diagnostic as v11 Part 1
    corr = bv11.corr_report(srs_m, "scoring_edge", "srs_scoring_edge")
    results["srs_correlation_full"] = corr
    print("\n=== Standalone correlation, SRS scoring_edge vs ATS margin (full history) ===")
    print(json.dumps(corr, indent=2))

    recent_srs_m = srs_m[srs_m["season"].isin(RECENT_ERA_SEASONS)]
    corr_recent = bv11.corr_report(recent_srs_m, "scoring_edge", "srs_scoring_edge_recent_era")
    results["srs_correlation_recent"] = corr_recent
    print("\n=== Standalone correlation, SRS scoring_edge vs ATS margin (2018-2025 only) ===")
    print(json.dumps(corr_recent, indent=2))

    # -----------------------------------------------------------------
    # Benchmarks, run fresh, same common-game-set discipline as v11 Part 3
    # -----------------------------------------------------------------
    print("\nLoading EPA benchmarks for a fair, common-game-set comparison ...")
    epa_tg = bv2.load_team_games(raw_dir)
    import backtest_v6_similarity_weighted as bv6  # noqa: E402
    flat_epa = bv6.build_entering_ratings(epa_tg, WINDOW)[
        ["season", "week", "team", "game_id", "r_off_pass", "r_off_rush", "r_def_pass", "r_def_rush"]
    ]
    epa_m = bv2.build_matchups(raw_dir, flat_epa)

    common_ids = set(epa_m["game_id"]) & set(srs_m["game_id"])
    print(f"  {len(common_ids)} games common to EPA benchmarks and SRS scoring")
    epa_common = epa_m[epa_m["game_id"].isin(common_ids)]
    srs_common = srs_m[srs_m["game_id"].isin(common_ids)]

    results["fair_full_8_feature"] = run_walk_forward_with_era_cut(epa_common, bv2.FEATURES, "FAIR: current full 8-feature model")
    results["fair_pass_rush_only"] = run_walk_forward_with_era_cut(epa_common, ["pass_edge", "rush_edge"], "FAIR: pass_edge + rush_edge only")
    results["fair_srs_scoring_only"] = run_walk_forward_with_era_cut(srs_common, ["scoring_edge"], "FAIR: SRS scoring_edge alone")
    results["fair_srs_scoring_plus_qb"] = run_walk_forward_with_era_cut(
        srs_common, ["scoring_edge", "qb_change_home", "qb_change_away"], "FAIR: SRS scoring_edge + QB change"
    )

    # also v11's flat scoring_edge on this exact common set, so all three
    # scoring methodologies (flat, similarity-weighted, SRS) are compared
    # on identical games in one place
    flat_scoring_tg = bv11.load_scoring_games(raw_dir)
    flat_scoring_ratings = bv11.build_flat_scoring_ratings(flat_scoring_tg, WINDOW)
    flat_scoring_m = bv11.build_flat_scoring_matchups(raw_dir, flat_scoring_ratings)
    flat_common = flat_scoring_m[flat_scoring_m["game_id"].isin(common_ids)]
    results["fair_flat_scoring_plus_qb"] = run_walk_forward_with_era_cut(
        flat_common, ["scoring_edge", "qb_change_home", "qb_change_away"], "FAIR: v11 flat scoring_edge + QB change (for reference)"
    )

    # -----------------------------------------------------------------
    def strip(v):
        return {
            "full_history": {"overall": v["full_history"]["overall"], "avg_coefficients": v["full_history"]["avg_coefficients"]},
            "recent_era": (
                {"overall": v["recent_era"]["overall"], "avg_coefficients": v["recent_era"]["avg_coefficients"]}
                if v["recent_era"] else None
            ),
        }

    out = {
        "srs_correlation_full": results["srs_correlation_full"],
        "srs_correlation_recent": results["srs_correlation_recent"],
        "fair_full_8_feature": strip(results["fair_full_8_feature"]),
        "fair_pass_rush_only": strip(results["fair_pass_rush_only"]),
        "fair_srs_scoring_only": strip(results["fair_srs_scoring_only"]),
        "fair_srs_scoring_plus_qb": strip(results["fair_srs_scoring_plus_qb"]),
        "fair_flat_scoring_plus_qb": strip(results["fair_flat_scoring_plus_qb"]),
    }
    (out_dir / "summary_v12.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_dir/'summary_v12.json'}")


if __name__ == "__main__":
    main()
