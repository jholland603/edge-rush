#!/usr/bin/env python3
"""
Fetch live NFL odds from The Odds API (https://the-odds-api.com) and log a
snapshot of moneyline/spread/total per bookmaker into the D1 `odds_snapshot`
table.

This is deliberately NOT part of weekly_update.py / reconcile_picks.py --
odds_snapshot is a separate, append-only time series (many rows per game,
across every upcoming game, whether or not the model ever flagged it), not a
graded pick. See HANDOFF.md / notes.md for why this project keeps "raw
signal" data separate from the model's own frozen picks_log.

This only ever looks FORWARD -- there is no backfill. Each run captures
whatever odds The Odds API currently has for upcoming games; run it on a
schedule (see .github/workflows/odds-snapshot.yml) to build up a real
movement history over time. Rows are never updated or deleted, only
inserted (INSERT OR IGNORE on the game/bookmaker/snapshot_time unique key,
so re-running the same fetch twice in quick succession is harmless).

Requires an API key from https://the-odds-api.com (free tier: 500 credits/
month; this script's default single call -- 1 sport, up to 3 markets, 1
region -- costs 3 credits per run).

Usage:
    python3 scripts/fetch_odds_snapshot.py --api-key YOUR_KEY --sql-out /tmp/odds.sql
    python3 scripts/fetch_odds_snapshot.py   # reads ODDS_API_KEY env var, applies via wrangler

Team-name mapping: The Odds API returns full team names ("Seattle Seahawks");
edge-rush's game_id scheme uses nflverse abbreviations ("SEA"). This script
maps between them and looks up the matching game_id from raw/games.csv by
(home_abbr, away_abbr, nearest gameday to commence_time). Games that can't be
matched (e.g. a season/week not yet in raw/games.csv) are skipped and listed
in the summary -- not a hard failure, since games.csv is refreshed on its own
weekly schedule and may occasionally lag.
"""

import argparse
import json
import os
import subprocess
import tempfile
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/"

# Bookmaker keys (The Odds API's `bookmakers[].key`) we don't bother
# recording -- a book that just mirrors another book's price under a
# different name isn't an independent data point, so it'd just be dead
# weight in odds_snapshot. Doesn't touch rows already collected (this
# script only ever inserts, see the module docstring); it just stops new
# ones from landing. worker/src/index.js has a matching EXCLUDED_BOOKMAKERS
# that filters those pre-existing rows out of every query, so the two
# lists should be kept in sync.
#
# lowvig: sister site of betonlineag under the same parent group,
# explicitly marketed as "BetOnline's lines, less vig" -- confirmed not an
# independent price. Jeff's call, 2026-08-13.
EXCLUDED_BOOKMAKERS = {"lowvig"}

# The Odds API full team name -> nflverse team_abbr. Current 32 teams only
# (this project's game_id scheme uses nflverse's current abbreviations, e.g.
# LV not OAK, LA not STL -- historical relocations don't matter here since
# this script never looks backward).
TEAM_NAME_TO_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LA", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    try:
        if pd.isna(v):
            return "NULL"
    except TypeError:
        pass
    return str(v)


def run_d1_statements(statements, db_name):
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


def build_game_lookup(games_csv_path):
    """Return {(home_abbr, away_abbr): [(gameday, game_id), ...]} for games
    that haven't been played yet (result is NaN) -- the only ones odds
    snapshots are meaningful for."""
    games = pd.read_csv(games_csv_path, low_memory=False)
    upcoming = games[games["result"].isna()]
    lookup = {}
    for _, row in upcoming.iterrows():
        key = (row["home_team"], row["away_team"])
        lookup.setdefault(key, []).append((row["gameday"], row["game_id"]))
    return lookup


def match_game_id(lookup, home_abbr, away_abbr, commence_time):
    candidates = lookup.get((home_abbr, away_abbr))
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][1]
    # More than one upcoming meeting between these two teams (rare but
    # possible late in a season) -- pick whichever gameday is closest to
    # the odds API's commence_time.
    target_date = commence_time[:10]
    best = min(candidates, key=lambda c: abs(
        (datetime.fromisoformat(c[0]) - datetime.fromisoformat(target_date)).days
    ))
    return best[1]


def fetch_odds(api_key, regions, markets):
    params = f"?apiKey={api_key}&regions={regions}&markets={markets}&oddsFormat=american"
    req = urllib.request.Request(ODDS_API_URL + params)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            remaining = resp.headers.get("x-requests-remaining")
            used = resp.headers.get("x-requests-used")
            if remaining is not None:
                print(f"  Odds API credits: used {used}, remaining {remaining}")
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Odds API request failed: {e.code} {e.reason}\n{body}")


def extract_market_values(bookmaker):
    """Pull h2h/spreads/totals out of one bookmaker's markets list into the
    flat columns odds_snapshot stores. Assumes 2-outcome markets (standard
    for NFL h2h/spreads/totals)."""
    out = {
        "home_moneyline": None, "away_moneyline": None,
        "spread_line": None, "home_spread_odds": None, "away_spread_odds": None,
        "total_line": None, "over_odds": None, "under_odds": None,
    }
    for market in bookmaker.get("markets", []):
        key = market.get("key")
        outcomes = market.get("outcomes", [])
        if key == "h2h":
            for o in outcomes:
                # outcomes are named by team; matched by caller via home/away team names
                out[f"_ml_{o['name']}"] = o.get("price")
        elif key == "spreads":
            for o in outcomes:
                out[f"_spread_{o['name']}"] = o.get("point")
                out[f"_spread_odds_{o['name']}"] = o.get("price")
        elif key == "totals":
            for o in outcomes:
                if o["name"] == "Over":
                    out["total_line"] = o.get("point")
                    out["over_odds"] = o.get("price")
                elif o["name"] == "Under":
                    out["under_odds"] = o.get("price")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", default=os.environ.get("ODDS_API_KEY"),
                         help="The Odds API key (defaults to ODDS_API_KEY env var)")
    parser.add_argument("--games-csv", default="raw/games.csv", type=Path)
    parser.add_argument("--regions", default="us")
    parser.add_argument("--markets", default="h2h,spreads,totals")
    parser.add_argument("--db-name", default="edge-rush")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute`. Use this when there's no wrangler/"
                              "local login available (e.g. GitHub Actions without wrangler "
                              "auth configured, or a Cowork scheduled task).")
    args = parser.parse_args()

    if not args.api_key:
        raise SystemExit("No API key: pass --api-key or set ODDS_API_KEY")

    print("Fetching current NFL odds from The Odds API...")
    events = fetch_odds(args.api_key, args.regions, args.markets)
    print(f"  {len(events)} upcoming game(s) returned")

    print(f"Loading upcoming games from {args.games_csv} for game_id matching...")
    lookup = build_game_lookup(args.games_csv)

    snapshot_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    insert_stmts = []
    matched, unmatched = 0, []
    excluded_count = 0

    for event in events:
        home_name = event.get("home_team")
        away_name = event.get("away_team")
        home_abbr = TEAM_NAME_TO_ABBR.get(home_name)
        away_abbr = TEAM_NAME_TO_ABBR.get(away_name)
        if not home_abbr or not away_abbr:
            unmatched.append(f"{away_name} @ {home_name} (unrecognized team name)")
            continue
        game_id = match_game_id(lookup, home_abbr, away_abbr, event.get("commence_time", ""))
        if not game_id:
            unmatched.append(f"{away_name} @ {home_name} (no matching upcoming game_id)")
            continue

        for bm in event.get("bookmakers", []):
            if bm.get("key") in EXCLUDED_BOOKMAKERS:
                excluded_count += 1
                continue
            vals = extract_market_values(bm)
            home_ml = vals.get(f"_ml_{home_name}")
            away_ml = vals.get(f"_ml_{away_name}")
            # spreads market is keyed by team name too; home/away spread lines
            # are mirror images of each other, store the home side as
            # spread_line (matches games.spread_line's home-perspective convention)
            spread_line = vals.get(f"_spread_{home_name}")
            home_spread_odds = vals.get(f"_spread_odds_{home_name}")
            away_spread_odds = vals.get(f"_spread_odds_{away_name}")

            insert_stmts.append(
                "INSERT OR IGNORE INTO odds_snapshot "
                "(game_id, bookmaker, snapshot_time, home_moneyline, away_moneyline, "
                "spread_line, home_spread_odds, away_spread_odds, total_line, over_odds, under_odds) "
                f"VALUES ({sql_str(game_id)}, {sql_str(bm.get('key'))}, {sql_str(snapshot_time)}, "
                f"{sql_num(home_ml)}, {sql_num(away_ml)}, {sql_num(spread_line)}, "
                f"{sql_num(home_spread_odds)}, {sql_num(away_spread_odds)}, "
                f"{sql_num(vals.get('total_line'))}, {sql_num(vals.get('over_odds'))}, "
                f"{sql_num(vals.get('under_odds'))});"
            )
        matched += 1

    print(f"\n{matched} game(s) matched to a game_id, {len(insert_stmts)} bookmaker row(s) to insert"
          f" ({excluded_count} excluded-bookmaker row(s) skipped)")
    if unmatched:
        print(f"{len(unmatched)} game(s) skipped (not an error -- see below):")
        for u in unmatched:
            print(f"  - {u}")

    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("\n".join(insert_stmts) + ("\n" if insert_stmts else ""))
        print(f"\nWrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        print("\nApplying to D1...")
        run_d1_statements(insert_stmts, args.db_name)

    print("\nDone.")


if __name__ == "__main__":
    main()
