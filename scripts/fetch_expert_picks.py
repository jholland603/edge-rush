#!/usr/bin/env python3
"""
Fetch this week's NFL expert straight-up picks from ESPN's public picks page
(espn.com/nfl/picks) and log a per-game consensus snapshot into D1's
expert_consensus table.

Why ESPN: it's the one free source found that's actually structured and not
paywalled. Pickwatch's real pick data (individual experts, even the
aggregate consensus %) is locked behind "Unlock Expert" / a paid account.
CBS Sports's old ATS expert panel has been discontinued (that URL now
redirects into player-prop picks). Sporting News's picks URL is dead. Yahoo
Sports's picks page now just redirects to Pickswise. NFL.com doesn't run a
weekly picks page. USA Today's Sportsbook Wire is free but single-author
prose, not a structured multi-expert panel. See the chat transcript from
2026-08-10 for the full survey.

Real limitation, disclosed up front: these are STRAIGHT-UP picks (who wins
outright), not against the spread. No free ATS *panel* (multiple named
experts) was found -- Pickwatch has one but it's paywalled, Pickswise is
free and ATS but is one outlet's picks, not a consensus, and wasn't
scriptable yet as of this writing (no picks posted for the 2026 season at
the time this was built). Straight-up consensus still isn't nothing: a
lopsided expert lean toward a value-priced underdog is a more interesting
signal than the (usual) lean toward the favorite, since the market already
prices the favorite as more likely to win outright.

Like odds_snapshot, this is forward-looking only -- there's no historical
dataset to backfill, so no backtest is possible yet. Built now anyway (per
Jeff's call, 2026-08-10) as pure collection infrastructure: every scheduled
run adds one row per game, so a real backtest becomes possible once enough
games have both a recorded consensus AND a final result. Until then this is
a fact, not a validated signal -- same framing as line_movement.

The picks data is embedded directly in the page's server-rendered HTML as
`window['__espnfitt__'] = {...};` -- confirmed by fetching the raw HTML and
finding the full JSON object right there, no JS execution required. Parsed
with json.JSONDecoder().raw_decode() (not a regex) since the object contains
deeply nested braces that a regex can't safely bound.

Team abbreviation mapping: ESPN uses "LAR" for the Rams and "WSH" for
Washington; this project's game_id scheme (nflverse) uses "LA" and "WAS".
Every other current-team abbreviation already matches between the two.

Usage:
    python3 scripts/fetch_expert_picks.py --sql-out /tmp/picks.sql
    python3 scripts/fetch_expert_picks.py --week 1 --season 2026  # explicit week
    python3 scripts/fetch_expert_picks.py   # auto-detects the nearest upcoming
                                             # REG week from games.csv, applies
                                             # via wrangler
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from fetch_odds_snapshot import build_game_lookup, match_game_id, run_d1_statements, sql_str  # noqa: E402

ESPN_PICKS_URL = "https://www.espn.com/nfl/picks"
ESPN_REGULAR_SEASON = 2  # ESPN's seasontype param: 1=preseason, 2=regular, 3=postseason

# ESPN team_abbr -> nflverse team_abbr. Only the two current-team abbreviations
# that actually differ between the sources; everything else already matches.
ESPN_ABBR_TO_NFLVERSE = {
    "LAR": "LA",
    "WSH": "WAS",
}


def normalize_abbr(abbr):
    return ESPN_ABBR_TO_NFLVERSE.get(abbr, abbr)


def fetch_picks_html(week, seasontype):
    url = f"{ESPN_PICKS_URL}?week={week}&seasontype={seasontype}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (edge-rush/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ESPN picks page request failed: {e.code} {e.reason}")


def extract_picks_data(html):
    marker = "window['__espnfitt__']="
    idx = html.find(marker)
    if idx == -1:
        raise SystemExit(
            "Could not find window['__espnfitt__'] in the ESPN page -- "
            "page structure may have changed since this script was written."
        )
    start = idx + len(marker)
    obj, _ = json.JSONDecoder().raw_decode(html, start)
    try:
        return obj["page"]["content"]["picksData"]
    except KeyError:
        raise SystemExit(
            "__espnfitt__ found but page.content.picksData is missing -- "
            "page structure may have changed since this script was written."
        )


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


def parse_teams(teams_str):
    """'AWAY at HOME' (normal) or 'AWAY VS HOME' (neutral-site game) ->
    (away_abbr, home_abbr). Orientation for neutral-site games isn't
    guaranteed by this label alone -- callers should also try the swapped
    orientation before giving up on a match."""
    parts = teams_str.replace(" VS ", " at ").split(" at ")
    if len(parts) != 2:
        return None, None
    return normalize_abbr(parts[0].strip()), normalize_abbr(parts[1].strip())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games-csv", default="raw/games.csv", type=Path)
    parser.add_argument("--week", type=int, default=None)
    parser.add_argument("--season", type=int, default=None, help="unused beyond logging -- "
                         "ESPN's URL only needs --week/seasontype, current season is implicit")
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

    print(f"Fetching ESPN expert picks (week={week}, seasontype={ESPN_REGULAR_SEASON})...")
    html = fetch_picks_html(week, ESPN_REGULAR_SEASON)
    picks_data = extract_picks_data(html)
    experts = picks_data.get("header", [])[1:]  # first header entry is a blank game-label column
    rows = picks_data.get("rows", [])
    print(f"  {len(experts)} expert(s), {len(rows)} game row(s) on the page")

    print(f"Loading upcoming games from {args.games_csv} for game_id matching...")
    lookup = build_game_lookup(args.games_csv)

    snapshot_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    upsert_stmts = []
    matched, unmatched, no_picks_yet = 0, [], []

    for row in rows:
        if not row or row[0] is None:
            continue
        game_info = row[0]
        teams_str = game_info.get("teams", "")
        away_abbr, home_abbr = parse_teams(teams_str)
        if not away_abbr or not home_abbr:
            unmatched.append(f"{teams_str} (couldn't parse team abbreviations)")
            continue

        commence_time = game_info.get("date", "")
        game_id = match_game_id(lookup, home_abbr, away_abbr, commence_time)
        if not game_id:
            # Neutral-site games (" VS ") don't guarantee away-then-home
            # ordering -- retry swapped before giving up.
            game_id = match_game_id(lookup, away_abbr, home_abbr, commence_time)
            if game_id:
                home_abbr, away_abbr = away_abbr, home_abbr
        if not game_id:
            unmatched.append(f"{away_abbr} @ {home_abbr} (no matching upcoming game_id)")
            continue

        picks = row[1:]
        expert_picks = []
        home_count = away_count = 0
        for expert, pick in zip(experts, picks):
            if not isinstance(pick, dict) or not pick.get("logo"):
                continue  # literal "No Pick" string -- this expert hasn't picked yet
            picked_abbr = normalize_abbr(pick["logo"].rsplit("/", 1)[-1].replace(".png", "").upper())
            expert_picks.append({"name": expert.get("name"), "pick": picked_abbr})
            if picked_abbr == home_abbr:
                home_count += 1
            elif picked_abbr == away_abbr:
                away_count += 1

        if not expert_picks:
            no_picks_yet.append(f"{away_abbr} @ {home_abbr} (no experts have picked yet)")
            continue

        upsert_stmts.append(
            "INSERT INTO expert_consensus "
            "(game_id, source, num_experts, home_picks, away_picks, experts_json, snapshot_time, updated) "
            f"VALUES ({sql_str(game_id)}, 'espn', {len(expert_picks)}, {home_count}, {away_count}, "
            f"{sql_str(json.dumps(expert_picks))}, {sql_str(snapshot_time)}, {sql_str(snapshot_time)}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "num_experts=excluded.num_experts, home_picks=excluded.home_picks, "
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
        print("Not picked yet (experts usually post a few days before kickoff):")
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
