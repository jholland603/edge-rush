#!/usr/bin/env python3
"""
Fetch daily NFL team news headlines (beat writers, team sites, national
outlets) via Google News RSS, one query per team, and log them into D1's
`team_news` table.

Why Google News RSS, not Reddit: Jeff's original ask was "can you browse
team subreddits for upcoming-game news." Rejected after checking --
old.reddit.com's public .json endpoints have no official free tier for
scripted/automated access and are known to 429/block cloud-runner IPs
(exactly what GitHub Actions runners are) inconsistently over time. That's
a bad foundation for a daily unattended job -- it would silently degrade.
Google News RSS (news.google.com/rss/search) requires no API key, has no
documented rate limit for this volume (32 requests/day), and returns
already-structured XML (title/link/source/pubDate) pulled from exactly the
outlets subreddits mostly just link to anyway (ESPN, team beat writers,
local papers, SI, etc.) -- broader coverage than any single subreddit,
less noise than a discussion thread. Confirmed with Jeff (2026-08-12)
before building.

This is forward-looking only, same as odds_snapshot/expert_consensus --
no historical backfill exists or is attempted. Append-only: rows are
deduped on (team_abbr, link) via INSERT OR IGNORE, so re-running the same
day (or the same query across multiple cron slots) is harmless -- only
genuinely new headlines add rows. The `when:1d` search operator also keeps
each day's fetch scoped to roughly the last 24 hours, so the table doesn't
fill up with the same handful of stories re-surfacing every run.

Each headline is tagged with the team it's about (team_abbr) and, on a
best-effort basis, the team's own next upcoming game_id (their next
unplayed row in games.csv) -- NOT an attempt to figure out which specific
opponent a headline is about from free text, which isn't reliably
parseable. This just answers "what's being said about this team ahead of
their next game," which is what was actually asked for.

Usage:
    python3 scripts/fetch_team_news.py --sql-out /tmp/team_news.sql
    python3 scripts/fetch_team_news.py --limit-per-team 10
    python3 scripts/fetch_team_news.py   # applies via wrangler d1 execute
"""

import argparse
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from fetch_odds_snapshot import run_d1_statements, sql_str  # noqa: E402

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"

# nflverse team_abbr -> full team name used to build the search query.
# Current 32 teams only (same scope as fetch_odds_snapshot.py's reverse
# mapping) -- this project's game_id scheme never needs historical/relocated
# abbreviations for a forward-looking feed like this one.
TEAM_ABBR_TO_NAME = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LV": "Las Vegas Raiders", "LAC": "Los Angeles Chargers",
    "LA": "Los Angeles Rams", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SF": "San Francisco 49ers", "SEA": "Seattle Seahawks", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}


def fetch_team_rss(team_name, timeout=20):
    query = f'"{team_name}" NFL when:1d'
    url = f"{GOOGLE_NEWS_RSS}?{urllib.parse.urlencode({'q': query, 'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'})}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (edge-rush/1.0)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def normalize_pub_date(raw):
    """RSS pubDate is RFC 822 ('Wed, 12 Aug 2026 14:00:00 GMT') -- not
    safely sortable as plain text in SQL (starts with weekday, not year).
    Convert to ISO 8601 UTC ('2026-08-12T14:00:00Z') so `team_news.published`
    can be sorted with a plain ORDER BY. Falls back to the raw string on any
    parse failure -- added 2026-08-12 after Jeff asked how the game page's
    Team News card was sorted, and the honest answer was "insertion order,
    not actual article date, because the stored format wasn't sortable."
    Pre-existing rows inserted before this change keep their raw RFC 822
    string (INSERT OR IGNORE never updates existing rows) -- the Worker's
    ORDER BY published DESC falls back to `id DESC` as a tiebreaker/fallback
    for exactly that reason, see getTeamNewsFromD1() in worker/src/index.js.
    """
    if not raw:
        return raw
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return raw


def parse_rss_items(xml_bytes, limit):
    """Google News RSS item shape:
    <item>
      <title>Headline - Publisher</title>
      <link>https://news.google.com/rss/articles/... (redirect)</link>
      <pubDate>Wed, 12 Aug 2026 14:00:00 GMT</pubDate>
      <source url="https://espn.com">ESPN</source>
    </item>
    Title is "Headline - Publisher" by convention; source tag is the more
    reliable publisher name when present, title suffix is the fallback.
    """
    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.findall("./channel/item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = normalize_pub_date((item.findtext("pubDate") or "").strip())
        source_el = item.find("source")
        source = source_el.text.strip() if source_el is not None and source_el.text else None
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[-1].strip()
        if not title or not link:
            continue
        items.append({"title": title, "link": link, "source": source, "pub_date": pub_date})
    return items


def build_next_game_lookup(games_csv_path):
    """{team_abbr: game_id} for each team's single nearest upcoming
    (unplayed) game -- home or away, whichever comes first by gameday."""
    games = pd.read_csv(games_csv_path, low_memory=False)
    upcoming = games[games["result"].isna()].sort_values("gameday")
    lookup = {}
    for _, row in upcoming.iterrows():
        for abbr in (row["home_team"], row["away_team"]):
            if abbr not in lookup:
                lookup[abbr] = row["game_id"]
    return lookup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games-csv", default="raw/games.csv", type=Path)
    parser.add_argument("--limit-per-team", type=int, default=15,
                         help="Max headlines to keep per team per run (RSS feed is already "
                              "scoped to ~last 24h via when:1d; this just caps a noisy day).")
    parser.add_argument("--db-name", default="edge-rush")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute` (see fetch_odds_snapshot.py for why).")
    args = parser.parse_args()

    print(f"Loading next-game lookup from {args.games_csv}...")
    next_game = build_next_game_lookup(args.games_csv)

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    insert_stmts = []
    total_headlines = 0
    failed_teams = []

    for i, (abbr, name) in enumerate(TEAM_ABBR_TO_NAME.items()):
        try:
            xml_bytes = fetch_team_rss(name)
            items = parse_rss_items(xml_bytes, args.limit_per_team)
        except (urllib.error.URLError, urllib.error.HTTPError, ET.ParseError) as e:
            failed_teams.append(f"{abbr} ({e})")
            continue

        game_id = next_game.get(abbr)
        for item in items:
            insert_stmts.append(
                "INSERT OR IGNORE INTO team_news "
                "(team_abbr, game_id, headline, link, source, published, fetched) "
                f"VALUES ({sql_str(abbr)}, {sql_str(game_id)}, {sql_str(item['title'])}, "
                f"{sql_str(item['link'])}, {sql_str(item['source'])}, "
                f"{sql_str(item['pub_date'])}, {sql_str(fetched_at)});"
            )
        total_headlines += len(items)
        print(f"  {abbr}: {len(items)} headline(s)")

        # Light pacing -- 32 sequential requests to the same host, no need
        # to hammer it even though no rate limit is documented.
        if i < len(TEAM_ABBR_TO_NAME) - 1:
            time.sleep(0.5)

    print(f"\n{total_headlines} headline(s) across {len(TEAM_ABBR_TO_NAME) - len(failed_teams)} team(s) "
          f"-> {len(insert_stmts)} INSERT statement(s) (actual new rows will be fewer once "
          f"INSERT OR IGNORE dedupes against what's already stored)")
    if failed_teams:
        print(f"{len(failed_teams)} team(s) failed to fetch (not fatal -- retried next run):")
        for f in failed_teams:
            print(f"  - {f}")

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
