#!/usr/bin/env python3
"""
Fetch this week's NFL expert AGAINST-THE-SPREAD picks from CBS Sports'
public picks page (cbssports.com/nfl/picks/experts/against-the-spread/)
and log a per-game consensus snapshot into D1's expert_consensus table.

Replaces fetch_expert_picks.py (ESPN, straight-up-only) as of 2026-09.
ESPN only ever gave who-wins-outright picks -- CBS gives real
against-the-spread picks from 7 named writers (Pete Prisco, Jared Dubin,
Ryan Wilson, John Breech, Tyler Sullivan, Dave Richard, Jamey Eisenberg),
which is what this project actually wanted per the old ESPN script's own
docstring ("Real limitation, disclosed up front: these are STRAIGHT-UP
picks... No free ATS *panel*... was found"). Re-surveyed 2026-09-08 and
found CBS's ATS panel is live again (that old docstring called it
discontinued back in 2026-08 -- either it wasn't posted yet for the season,
or it came back).

Confirmed scriptable with a plain HTTP fetch, NOT a headless browser: the
whole picks table -- every game, every expert's pick, the spread number --
is present in the server-rendered HTML on a bare `urllib.request` GET, no
JS execution needed (verified against the live page 2026-09-08). Each pick
renders as a betting-widget button that happens to carry clean structured
data as a JSON blob in its `data-config` attribute:

    <button class="BetButton cbs-widget" data-config='{"meta":
      {"bets":[{"expertLabel":"Jared Dubin", ...}]}, "line":"-3.5", ...}'>

so the expert's name and the spread number are read directly out of that
JSON -- no fragile parsing of rendered button text needed. The picked team
is read off the sibling team-page link inside the same cell
(`<a href="/nfl/teams/SEA/...">`). The game itself (date + both team
abbreviations) comes straight from the row's own matchup link:
`<a href="/nfl/gametracker/preview/NFL_20260909_NE@SEA/">`.

Team abbreviation mapping: CBS's team-page URLs use standard current-team
abbreviations; the only ones known to differ from nflverse's scheme are the
same two ESPN needed remapped (kept here defensively even if CBS turns out
to already match -- see ABBR_TO_NFLVERSE below).

Like the ESPN script it replaces: forward-looking only, no historical
archive exists to backfill, so no backtest is possible yet -- this is pure
collection infrastructure, a fact logged each run, not (yet) a validated
signal. Same continue-on-error treatment in the workflow as before: one
picks-page markup change shouldn't be able to take down the rest of the
pipeline.

Usage:
    python3 scripts/fetch_cbs_picks.py --sql-out /tmp/picks.sql
    python3 scripts/fetch_cbs_picks.py --week 1 --season 2026  # explicit week
    python3 scripts/fetch_cbs_picks.py   # auto-detects the nearest upcoming
                                          # REG week from games.csv, applies
                                          # via wrangler
"""

import argparse
import html as html_module
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from fetch_odds_snapshot import build_game_lookup, match_game_id, run_d1_statements, sql_str  # noqa: E402

CBS_PICKS_URL = "https://www.cbssports.com/nfl/picks/experts/against-the-spread"

# CBS team-page abbr -> nflverse team abbr. Only remap what's actually been
# seen differing (none confirmed yet -- kept as a defensive placeholder,
# same pattern as ESPN_ABBR_TO_NFLVERSE in the script this replaces). If a
# future run's "unmatched" list shows LAR/WSH-shaped misses, that confirms
# CBS needs the same two remaps ESPN did; add them here.
CBS_ABBR_TO_NFLVERSE = {}


def normalize_abbr(abbr):
    return CBS_ABBR_TO_NFLVERSE.get(abbr, abbr)


def fetch_picks_html(week):
    url = f"{CBS_PICKS_URL}/{week}/"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (edge-rush/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"CBS picks page request failed: {e.code} {e.reason}")


ROW_RE = re.compile(r'<tr class="TableBase-bodyTr">.*?</tr>', re.S)
GAME_RE = re.compile(r'/nfl/gametracker/preview/NFL_(\d{8})_([A-Z]+)@([A-Z]+)/')
TD_RE = re.compile(r'<td class="TableBase-bodyTd.*?</td>', re.S)
CONFIG_RE = re.compile(r"data-config='(\{.*?\})'", re.S)
TEAM_HREF_RE = re.compile(r'/nfl/teams/([A-Z]+)/')


def extract_rows(html):
    """[{away, home, gameday, picks: [{name, pick}]}, ...] for every game
    row found on the page. `picks` only includes experts who've actually
    posted a pick yet (empty pick cells -- not every expert picks every
    game the moment the page goes up -- are skipped, same as the ESPN
    script's "No Pick" handling)."""
    games = []
    for row_html in ROW_RE.findall(html):
        m = GAME_RE.search(row_html)
        if not m:
            continue
        date_str, away_abbr, home_abbr = m.groups()
        away_abbr, home_abbr = normalize_abbr(away_abbr), normalize_abbr(home_abbr)
        gameday = f"{date_str[0:4]}-{date_str[4:6]}-{date_str[6:8]}"

        picks = []
        for td in TD_RE.findall(row_html):
            cfg_m = CONFIG_RE.search(td)
            if not cfg_m:
                continue  # game-info cell, or an expert who hasn't picked yet
            try:
                cfg = json.loads(html_module.unescape(cfg_m.group(1)))
            except json.JSONDecodeError:
                continue
            bets = (cfg.get("meta") or {}).get("bets") or []
            expert_name = bets[0].get("expertLabel") if bets else None
            line = cfg.get("line")
            team_m = TEAM_HREF_RE.search(td)
            picked_abbr = normalize_abbr(team_m.group(1)) if team_m else None
            if not expert_name or not picked_abbr:
                continue
            pick_text = f"{picked_abbr} {line}" if line else picked_abbr
            picks.append({"name": expert_name, "pick": pick_text, "team": picked_abbr})

        games.append({
            "away": away_abbr, "home": home_abbr, "gameday": gameday, "picks": picks,
        })
    return games


def determine_current_week(games_csv_path):
    """Earliest upcoming (unplayed) REG-season week, by gameday -- same
    'what should we be looking at right now' logic the rest of this project
    uses. Returns (None, None) if nothing REG-season is upcoming (true
    offseason, between the Super Bowl and the next games.csv refresh)."""
    games = pd.read_csv(games_csv_path, low_memory=False)
    upcoming = games[(games["result"].isna()) & (games["game_type"] == "REG")]
    if upcoming.empty:
        return None, None
    upcoming = upcoming.sort_values("gameday")
    row = upcoming.iloc[0]
    return int(row["season"]), int(row["week"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games-csv", default="raw/games.csv", type=Path)
    parser.add_argument("--week", type=int, default=None)
    parser.add_argument("--season", type=int, default=None, help="unused beyond logging -- "
                         "CBS's URL only needs --week, current season is implicit")
    parser.add_argument("--db-name", default="edge-rush")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute` (see fetch_odds_snapshot.py for why).")
    args = parser.parse_args()

    week = args.week
    season = args.season
    if week is None:
        season, week = determine_current_week(args.games_csv)
        if week is None:
            print("No upcoming REG-season games in games.csv -- nothing to fetch (offseason).")
            return
        print(f"Auto-detected nearest upcoming week: {season} week {week}")

    print(f"Fetching CBS Sports ATS picks (week={week})...")
    html = fetch_picks_html(week)
    rows = extract_rows(html)
    print(f"  {len(rows)} game row(s) on the page")

    print(f"Loading upcoming games from {args.games_csv} for game_id matching...")
    lookup = build_game_lookup(args.games_csv)

    snapshot_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    upsert_stmts = []
    matched, unmatched, no_picks_yet = 0, [], []

    for g in rows:
        away_abbr, home_abbr = g["away"], g["home"]
        commence_time = f"{g['gameday']}T00:00:00Z"
        game_id = match_game_id(lookup, home_abbr, away_abbr, commence_time)
        if not game_id:
            unmatched.append(f"{away_abbr} @ {home_abbr} (no matching upcoming game_id)")
            continue

        if not g["picks"]:
            no_picks_yet.append(f"{away_abbr} @ {home_abbr} (no experts have picked yet)")
            continue

        home_count = sum(1 for p in g["picks"] if p["team"] == home_abbr)
        away_count = sum(1 for p in g["picks"] if p["team"] == away_abbr)
        expert_picks = [{"name": p["name"], "pick": p["pick"]} for p in g["picks"]]

        upsert_stmts.append(
            "INSERT INTO expert_consensus "
            "(game_id, source, num_experts, home_picks, away_picks, experts_json, snapshot_time, updated) "
            f"VALUES ({sql_str(game_id)}, 'cbs', {len(expert_picks)}, {home_count}, {away_count}, "
            f"{sql_str(json.dumps(expert_picks))}, {sql_str(snapshot_time)}, {sql_str(snapshot_time)}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "source=excluded.source, num_experts=excluded.num_experts, home_picks=excluded.home_picks, "
            "away_picks=excluded.away_picks, experts_json=excluded.experts_json, "
            "snapshot_time=excluded.snapshot_time, updated=excluded.updated;"
        )
        matched += 1

    print(f"\n{matched} game(s) matched with picks, {len(unmatched)} unmatched, "
          f"{len(no_picks_yet)} not picked yet")
    if unmatched:
        print("Unmatched (not an error -- see fetch_odds_snapshot.py's convention):")
        for u in unmatched:
            print(f"  - {u}")
    if no_picks_yet:
        print("Not picked yet (CBS's writers usually post a few days before kickoff):")
        for n in no_picks_yet:
            print(f"  - {n}")

    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("\n".join(upsert_stmts) + ("\n" if upsert_stmts else ""))
        print(f"\nWrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        print("\nApplying to D1...")
        run_d1_statements(upsert_stmts, args.db_name)

    print("\nDone.")


if __name__ == "__main__":
    main()
