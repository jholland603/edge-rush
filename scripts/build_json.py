#!/usr/bin/env python3
"""
Build the /data JSON tree for the NFL handicapping site from raw nflverse CSVs.

Source layout expected (relative to --raw-dir, default ./raw):
    games.csv
    team/stats_team_week_{season}.csv
    player/player_stats_{season}.csv

Output layout (relative to --out-dir, default ./data):
    data/games/{season}.json
    data/teams/{season}.json
    data/players/season/{season}.json
    data/players/career/{player_id}.json
    data/model/                (placeholder only -- see README inside)
    index.json

Re-run any time the source CSVs are updated (e.g. weekly during the season).
This script always rebuilds season/game/team files it has source data for;
career player files are rebuilt from ALL season files found, so partial
re-runs (e.g. only 2026 CSVs present) will still produce complete career
totals as long as the earlier season CSVs are still in raw/.

Usage:
    python build_json.py --raw-dir ../raw --out-dir ../data
    python build_json.py --raw-dir ../raw --out-dir ../data --stage players-season
    python build_json.py --raw-dir ../raw --out-dir ../data --stage players-season --season-min 2020 --season-max 2024

The --stage flag lets you chunk a big build into pieces (useful if you're
running this somewhere with tight time limits per command, e.g. this was
originally built inside a sandboxed agent session where a single run of
the whole pipeline exceeded a 45s-per-command cap -- players-season and
players-career are the slow stages).
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_records(df: pd.DataFrame) -> list[dict]:
    """Convert a DataFrame to a list of JSON-safe dicts (NaN -> None)."""
    df = df.astype(object).where(pd.notnull(df), None)
    return df.to_dict(orient="records")


def write_json(path: Path, payload) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=None, separators=(",", ":"), default=str)
    path.write_text(text, encoding="utf-8")
    return len(text)


# --------------------------------------------------------------------------
# games.csv -> data/games/{season}.json
# --------------------------------------------------------------------------
def build_games(raw_dir: Path, out_dir: Path) -> list[int]:
    games_csv = raw_dir / "games.csv"
    if not games_csv.exists():
        print(f"  [skip] {games_csv} not found")
        return []

    df = pd.read_csv(games_csv, low_memory=False)
    seasons = sorted(df["season"].dropna().unique().tolist())
    updated = now_iso()

    for season in seasons:
        season_df = df[df["season"] == season].sort_values(["week", "gameday"])
        payload = {
            "season": int(season),
            "updated": updated,
            "game_count": len(season_df),
            "games": clean_records(season_df),
        }
        out_path = out_dir / "games" / f"{int(season)}.json"
        size = write_json(out_path, payload)
        print(f"  games/{int(season)}.json  ({len(season_df)} games, {size/1024:.0f} KB)")

    return [int(s) for s in seasons]


# --------------------------------------------------------------------------
# team/stats_team_week_{season}.csv -> data/teams/{season}.json
# --------------------------------------------------------------------------
def build_teams(raw_dir: Path, out_dir: Path) -> list[int]:
    team_dir = raw_dir / "team"
    files = sorted(team_dir.glob("stats_team_week_*.csv"))
    updated = now_iso()
    seasons = []

    for f in files:
        season = int(f.stem.split("_")[-1])
        seasons.append(season)
        df = pd.read_csv(f, low_memory=False)
        teams = {}
        for team, team_df in df.groupby("team"):
            team_df = team_df.sort_values("week").drop(columns=["team", "season"])
            teams[team] = clean_records(team_df)

        payload = {
            "season": season,
            "updated": updated,
            "team_count": len(teams),
            "teams": teams,
        }
        out_path = out_dir / "teams" / f"{season}.json"
        size = write_json(out_path, payload)
        print(f"  teams/{season}.json  ({len(teams)} teams, {size/1024:.0f} KB)")

    return sorted(seasons)


# --------------------------------------------------------------------------
# player/player_stats_{season}.csv -> data/players/season/{season}.json
#                                   -> data/players/career/{player_id}.json
# --------------------------------------------------------------------------
NON_NUMERIC_PLAYER_COLS = {
    "player_id", "player_name", "player_display_name", "position",
    "position_group", "headshot_url", "recent_team", "season", "week",
    "season_type", "opponent_team",
}


def build_players_season(raw_dir: Path, out_dir: Path, season_min=None, season_max=None) -> list[int]:
    """Build data/players/season/{season}.json for seasons in [season_min, season_max]."""
    player_dir = raw_dir / "player"
    files = sorted(player_dir.glob("player_stats_*.csv"))
    updated = now_iso()
    seasons = []

    week_drop_cols = {
        "player_id", "player_name", "player_display_name",
        "position", "position_group", "headshot_url", "season",
    }

    for f in files:
        season = int(f.stem.split("_")[-1])
        if season_min is not None and season < season_min:
            continue
        if season_max is not None and season > season_max:
            continue
        seasons.append(season)
        df = pd.read_csv(f, low_memory=False)

        # bulk NaN-clean + to_dict ONCE per season, then bucket in pure python
        # (looping pandas groupby.to_dict per player is 10x+ slower at this scale)
        df_sorted = df.sort_values(["player_id", "week"])
        df_clean = df_sorted.astype(object).where(pd.notnull(df_sorted), None)
        records = df_clean.to_dict(orient="records")

        players = {}
        for rec in records:
            pid = rec["player_id"]
            p = players.get(pid)
            if p is None:
                p = {
                    "player_name": rec["player_name"],
                    "player_display_name": rec["player_display_name"],
                    "position": rec["position"],
                    "position_group": rec["position_group"],
                    "team": rec["recent_team"],
                    "weeks": [],
                }
                players[pid] = p
            p["weeks"].append({k: v for k, v in rec.items() if k not in week_drop_cols})

        payload = {
            "season": season,
            "updated": updated,
            "player_count": len(players),
            "players": players,
        }
        out_path = out_dir / "players" / "season" / f"{season}.json"
        size = write_json(out_path, payload)
        print(f"  players/season/{season}.json  ({len(players)} players, {size/1024:.0f} KB)")

    return sorted(seasons)


def build_players_career(raw_dir: Path, out_dir: Path):
    """Build data/players/career/{player_id}.json from ALL player_stats CSVs found."""
    player_dir = raw_dir / "player"
    files = sorted(player_dir.glob("player_stats_*.csv"))
    updated = now_iso()
    seasons = [int(f.stem.split("_")[-1]) for f in files]
    all_season_dfs = [pd.read_csv(f, low_memory=False) for f in files]

    # ---- career totals, computed with vectorized groupby over ALL seasons at once ----
    big_df = pd.concat(all_season_dfs, ignore_index=True)
    numeric_cols = [c for c in big_df.columns if c not in NON_NUMERIC_PLAYER_COLS]
    for c in numeric_cols:
        big_df[c] = pd.to_numeric(big_df[c], errors="coerce")

    sums = big_df.groupby("player_id")[numeric_cols].sum(min_count=1)
    games_played = big_df.groupby("player_id").size()
    display_name = big_df.groupby("player_id")["player_display_name"].last()
    position = big_df.groupby("player_id")["position"].last()
    teams = big_df.groupby("player_id")["recent_team"].apply(
        lambda s: sorted(set(s.dropna()))
    )
    seasons_played = big_df.groupby("player_id")["season"].apply(
        lambda s: sorted(set(int(x) for x in s))
    )

    career_meta = {}
    career_dir = out_dir / "players" / "career"
    career_dir.mkdir(parents=True, exist_ok=True)
    for pid in sums.index:
        row = sums.loc[pid].dropna()
        totals = {k: round(float(v), 3) for k, v in row.items()}
        meta = {
            "player_display_name": display_name.loc[pid],
            "position": position.loc[pid],
            "seasons": seasons_played.loc[pid],
        }
        career_meta[pid] = meta
        payload = {
            "player_id": pid,
            "player_display_name": meta["player_display_name"],
            "position": meta["position"],
            "teams": teams.loc[pid],
            "seasons": meta["seasons"],
            "games_played": int(games_played.loc[pid]),
            "updated": updated,
            "career_totals": totals,
        }
        write_json(career_dir / f"{pid}.json", payload)
    print(f"  players/career/  ({len(career_meta)} player files)")

    return sorted(seasons), career_meta


# --------------------------------------------------------------------------
# index.json -- derived entirely from files already written under out_dir,
# so it can be (re)built any time as its own stage regardless of how the
# other stages were chunked across runs.
# --------------------------------------------------------------------------
def build_index(out_dir: Path):
    game_seasons = sorted(int(p.stem) for p in (out_dir / "games").glob("*.json"))
    team_seasons = sorted(int(p.stem) for p in (out_dir / "teams").glob("*.json"))
    player_seasons = sorted(int(p.stem) for p in (out_dir / "players" / "season").glob("*.json"))

    all_teams = set()
    for f in (out_dir / "teams").glob("*.json"):
        all_teams.update(json.loads(f.read_text())["teams"].keys())

    players_index = {}
    for f in (out_dir / "players" / "career").glob("*.json"):
        d = json.loads(f.read_text())
        players_index[d["player_id"]] = {
            "name": d["player_display_name"],
            "position": d["position"],
            "seasons": d["seasons"],
        }

    payload = {
        "updated": now_iso(),
        "seasons": {
            "games": game_seasons,
            "teams": team_seasons,
            "players": player_seasons,
        },
        "teams": sorted(all_teams),
        "player_count": len(players_index),
        "players": players_index,
    }
    size = write_json(out_dir.parent / "index.json", payload)
    print(f"  index.json  ({len(players_index)} players, {size/1024:.0f} KB)")


# --------------------------------------------------------------------------
# model/ placeholder
# --------------------------------------------------------------------------
def build_model_placeholder(out_dir: Path):
    model_dir = out_dir / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    template = {
        "week": 1,
        "season": 2026,
        "updated": now_iso(),
        "note": "PLACEHOLDER -- Phase 1 backtest has not been run yet. Do not treat these numbers as real predictions.",
        "games": [
            {
                "matchup": "NE @ SEA",
                "market_spread": 3.5,
                "model_spread": None,
                "edge": None,
                "market_total": 44.5,
                "model_total": None,
            }
        ],
    }
    write_json(model_dir / "_template.json", template)
    readme = (
        "# model/\n\n"
        "This folder is intentionally empty of real predictions.\n\n"
        "Per the project instructions, Phase 4 (publishing) comes only after Phase 1 "
        "(backtesting the power-rating model against closing lines) shows real signal. "
        "`_template.json` documents the intended file shape "
        "(`{season}-week{N}.json`) so the site/build code can be written against it "
        "ahead of time, but it should not be read as live data.\n"
    )
    (model_dir / "README.md").write_text(readme, encoding="utf-8")
    print("  model/_template.json + README.md (placeholder only)")


STAGES = ["games", "teams", "players-season", "players-career", "index", "model", "all"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--out-dir", default="data", type=Path)
    parser.add_argument(
        "--stage", choices=STAGES, default="all",
        help="Run just one stage. Useful for chunking a big build across "
             "several invocations (e.g. players-season is the slow one).",
    )
    parser.add_argument(
        "--season-min", type=int, default=None,
        help="Only for --stage players-season: lowest season to build this run.",
    )
    parser.add_argument(
        "--season-max", type=int, default=None,
        help="Only for --stage players-season: highest season to build this run.",
    )
    args = parser.parse_args()

    raw_dir: Path = args.raw_dir
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.stage in ("games", "all"):
        print("Building games/ ...")
        build_games(raw_dir, out_dir)

    if args.stage in ("teams", "all"):
        print("Building teams/ ...")
        build_teams(raw_dir, out_dir)

    if args.stage in ("players-season", "all"):
        print("Building players/season/ ...")
        build_players_season(raw_dir, out_dir, args.season_min, args.season_max)

    if args.stage in ("players-career", "all"):
        print("Building players/career/ ...")
        build_players_career(raw_dir, out_dir)

    if args.stage in ("index", "all"):
        print("Building index.json ...")
        build_index(out_dir)

    if args.stage in ("model", "all"):
        print("Building model/ placeholder ...")
        build_model_placeholder(out_dir)

    print("\nDone.")


if __name__ == "__main__":
    main()
