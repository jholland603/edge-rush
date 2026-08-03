#!/usr/bin/env python3
"""
Build .sql files for bulk-loading the edge-rush D1 database via `wrangler d1 execute --file`.
Reads the raw nflverse CSVs (games.csv, stats_team_week_*.csv, stats_player_week_*.csv,
injuries_*.csv) and the site's index.json (for the player dimension), and emits chunked
INSERT statements that respect D1's ~100KB per-statement limit.

Run from a plain python3 (pandas + pyarrow already installed in this environment).
"""
import json
import os
import sys
import pandas as pd

RAW = "raw"          # relative to project root; point at a local /tmp copy for speed if needed
INDEX_JSON = "index.json"
OUT = "d1/sql"
os.makedirs(OUT, exist_ok=True)

# The team dimension table (and games.csv, which it's built from) always uses
# the current abbreviation for a franchise. Some seasons of the team/player
# weekly-stats CSVs use an older/alternate code for the same team, which would
# otherwise violate the team_game/player_game FK against `team`. Known so far:
# stats_team_week_2001/2002.csv and stats_player_week_2001/2002.csv use 'JAC'
# for the Jaguars where games.csv (and every other season) uses 'JAX'.
TEAM_CODE_FIX = {"JAC": "JAX"}

def fix_team_code(v):
    if v in TEAM_CODE_FIX:
        return TEAM_CODE_FIX[v]
    return v

def esc(v):
    """Format a python value as a SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, float):
        if pd.isna(v):
            return "NULL"
        # inf/-inf show up in ratio columns (e.g. air_yards_share, wopr) when
        # the denominator is 0 but the numerator isn't -- pd.isna() doesn't
        # catch these (only NaN/None), and repr(inf) is the bare word "inf"
        # with no quotes, which SQLite parses as a column reference, not a
        # literal -- producing "no such column: inf". Treat the same as NaN:
        # there's no meaningful finite value to store, so store NULL.
        if v in (float("inf"), float("-inf")):
            return "NULL"
        return repr(v)
    if isinstance(v, int):
        return str(v)
    s = str(v)
    return "'" + s.replace("'", "''") + "'"

def clean(v):
    """Normalize a pandas scalar: NaN/empty -> None."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, str):
        if v.strip() == "":
            return None
        # wrangler's `d1 execute --file` naively splits on ';' before parsing SQL,
        # which corrupts statement boundaries when a quoted string literal (e.g.
        # fg_made_list "31;25;32") contains one. Neutralize semicolons in any
        # string value so a single bulk-file execution can't be split mid-literal.
        if ";" in v:
            return v.replace(";", ",")
    return v

def write_inserts(fh, table, columns, rows, chunk_size, conflict="OR IGNORE"):
    """rows: list of tuples aligned with columns. Writes chunked INSERT statements."""
    col_list = ", ".join(columns)
    n = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        if not chunk:
            continue
        values_sql = ",\n".join(
            "(" + ", ".join(esc(v) for v in row) + ")" for row in chunk
        )
        fh.write(f"INSERT {conflict} INTO {table} ({col_list}) VALUES\n{values_sql};\n")
        n += len(chunk)
    return n


# ---------------------------------------------------------------------------
# 1. player dimension (idempotent, safe to re-run even though 1200 rows are
#    already loaded via chat -- INSERT OR IGNORE skips existing PKs)
# ---------------------------------------------------------------------------
def build_player():
    d = json.load(open(INDEX_JSON))
    players = d["players"]
    rows = []
    for pid, info in players.items():
        name = (info.get("name") or "").strip()
        if not name:
            continue
        parts = name.split(" ", 1)
        first = parts[0]
        last = parts[1] if len(parts) > 1 else ""
        rows.append((pid, name, first, last))
    path = os.path.join(OUT, "00_player.sql")
    with open(path, "w") as fh:
        n = write_inserts(fh, "player", ["player_id", "display_name", "first_name", "last_name"], rows, 400)
    print(f"player: {n} rows -> {path} ({os.path.getsize(path)/1024:.0f} KB)")


_VALID_PLAYER_IDS = None
def valid_player_ids():
    """The exact set of player_ids that end up in the `player` dimension table
    (same filter as build_player() above: present in index.json with a
    non-empty name). player_game.player_id has a NOT NULL FK to this table, so
    any stats-CSV row whose player_id isn't in this set must be dropped or the
    load fails. Cached because it's read once per season."""
    global _VALID_PLAYER_IDS
    if _VALID_PLAYER_IDS is None:
        d = json.load(open(INDEX_JSON))
        _VALID_PLAYER_IDS = {
            pid for pid, info in d["players"].items() if (info.get("name") or "").strip()
        }
    return _VALID_PLAYER_IDS


# ---------------------------------------------------------------------------
# 2. game (needs coach_id / referee_id lookups -- deterministic: index+1 in
#    the exact sorted() list used when those tables were first loaded)
# ---------------------------------------------------------------------------
def build_game():
    df = pd.read_csv(f"{RAW}/games.csv", low_memory=False)

    coaches = sorted(set(df["home_coach"].dropna()) | set(df["away_coach"].dropna()))
    coach_id = {name: i + 1 for i, name in enumerate(coaches)}
    refs = sorted(set(df["referee"].dropna()))
    ref_id = {name: i + 1 for i, name in enumerate(refs)}

    cols = [
        "game_id", "season", "week", "game_type_code", "gameday", "weekday", "gametime",
        "home_team", "away_team", "home_score", "away_score", "result", "total", "overtime",
        "home_rest", "away_rest", "div_game", "roof", "surface", "temp", "wind",
        "home_qb_id", "away_qb_id", "home_coach_id", "away_coach_id", "referee_id", "stadium_id",
        "spread_line", "home_spread_odds", "away_spread_odds", "total_line",
        "over_odds", "under_odds", "home_moneyline", "away_moneyline",
    ]
    rows = []
    for r in df.itertuples(index=False):
        d = r._asdict()
        home_coach = clean(d.get("home_coach"))
        away_coach = clean(d.get("away_coach"))
        ref = clean(d.get("referee"))
        rows.append((
            clean(d.get("game_id")), clean(d.get("season")), clean(d.get("week")),
            clean(d.get("game_type")), clean(d.get("gameday")), clean(d.get("weekday")),
            clean(d.get("gametime")), clean(d.get("home_team")), clean(d.get("away_team")),
            clean(d.get("home_score")), clean(d.get("away_score")), clean(d.get("result")),
            clean(d.get("total")), clean(d.get("overtime")), clean(d.get("home_rest")),
            clean(d.get("away_rest")), clean(d.get("div_game")), clean(d.get("roof")),
            clean(d.get("surface")), clean(d.get("temp")), clean(d.get("wind")),
            clean(d.get("home_qb_id")), clean(d.get("away_qb_id")),
            coach_id.get(home_coach), coach_id.get(away_coach), ref_id.get(ref),
            clean(d.get("stadium_id")), clean(d.get("spread_line")),
            clean(d.get("home_spread_odds")), clean(d.get("away_spread_odds")),
            clean(d.get("total_line")), clean(d.get("over_odds")), clean(d.get("under_odds")),
            clean(d.get("home_moneyline")), clean(d.get("away_moneyline")),
        ))
    path = os.path.join(OUT, "01_game.sql")
    with open(path, "w") as fh:
        n = write_inserts(fh, "game", cols, rows, 200)
    print(f"game: {n} rows -> {path} ({os.path.getsize(path)/1024:.0f} KB)")


# ---------------------------------------------------------------------------
# 3. team_game + 4 category tables, one file per season
# ---------------------------------------------------------------------------
TEAM_OFFENSE_COLS = [
    "completions","attempts","passing_yards","passing_tds","passing_interceptions",
    "sacks_suffered","sack_yards_lost","sack_fumbles","sack_fumbles_lost","passing_air_yards",
    "passing_yards_after_catch","passing_first_downs","passing_epa","passing_cpoe",
    "passing_2pt_conversions","pacr","passing_10","passing_16","passing_20","passing_40",
    "carries","rushing_yards","rushing_tds","rushing_fumbles","rushing_fumbles_lost",
    "rushing_first_downs","rushing_epa","rushing_2pt_conversions","rushing_10","rushing_12",
    "rushing_20","rushing_40","receptions","targets","receiving_yards","receiving_tds",
    "receiving_fumbles","receiving_fumbles_lost","receiving_air_yards","receiving_yards_after_catch",
    "receiving_first_downs","receiving_epa","receiving_2pt_conversions","receiving_10",
    "receiving_16","receiving_20","receiving_40","racr","target_share","air_yards_share","wopr",
]
DEFENSE_COLS = [
    "def_tackles_solo","def_tackles_with_assist","def_tackle_assists","def_tackles_for_loss",
    "def_tackles_for_loss_yards","def_fumbles_forced","def_sacks","def_sack_yards","def_qb_hits",
    "def_interceptions","def_interception_yards","def_pass_defended","def_tds","def_fumbles",
    "def_safeties",
]
ST_COLS = [
    "fg_made","fg_att","fg_missed","fg_blocked","fg_long","fg_pct",
    "fg_made_0_19","fg_made_20_29","fg_made_30_39","fg_made_40_49","fg_made_50_59","fg_made_60_",
    "fg_missed_0_19","fg_missed_20_29","fg_missed_30_39","fg_missed_40_49","fg_missed_50_59","fg_missed_60_",
    "fg_made_list","fg_missed_list","fg_blocked_list","fg_made_distance","fg_missed_distance","fg_blocked_distance",
    "pat_made","pat_att","pat_missed","pat_blocked","pat_pct",
    "gwfg_made","gwfg_att","gwfg_missed","gwfg_blocked","gwfg_distance",
    "pt_att","pt_blocked","pt_long","pt_yards","pt_inside_20","pt_out_of_bounds","pt_downed",
    "pt_touchback","pt_fair_caught","pt_returned","pt_return_yards","pt_return_tds","pt_net_yards",
    "punt_returns","punt_return_yards","kickoff_returns","kickoff_return_yards",
]
TEAM_MISC_COLS = [
    "misc_yards","fumble_recovery_own","fumble_recovery_yards_own","fumble_recovery_opp",
    "fumble_recovery_yards_opp","fumble_recovery_tds","penalties","penalty_yards",
    "fumbles_forced_by_opp","fumbles_not_forced","fumbles_out_of_bounds","fumbles_total",
    "fumbles_lost_total","special_teams_tds","timeouts",
]
PLAYER_OFFENSE_COLS = TEAM_OFFENSE_COLS + ["fantasy_points", "fantasy_points_ppr"]
PLAYER_MISC_COLS = [c for c in TEAM_MISC_COLS if c != "timeouts"]


def get_row(d, cols):
    return [clean(d.get(c)) for c in cols]


def build_team_season(season, next_id):
    fn = f"{RAW}/team/stats_team_week_{season}.csv"
    if not os.path.exists(fn):
        return next_id, 0
    df = pd.read_csv(fn, engine="pyarrow")

    hub_rows, off_rows, def_rows, st_rows, misc_rows = [], [], [], [], []
    tid = next_id
    skipped = 0
    for r in df.itertuples(index=False):
        d = r._asdict()
        team = fix_team_code(clean(d.get("team")))
        opponent = fix_team_code(clean(d.get("opponent_team")))
        hub_rows.append((tid, clean(d.get("game_id")), team, opponent))
        # team_game.team/opponent_team are NOT NULL. A row missing either gets
        # silently dropped from the hub table by INSERT OR IGNORE -- but if we
        # still wrote its category-table rows (offense/defense/special_teams/
        # misc), those would reference a team_game_id that was never actually
        # inserted, causing a FOREIGN KEY constraint failure when the category
        # file loads. Skip category rows (but keep incrementing tid, so IDs
        # stay identical to what's already been generated/loaded for the hub
        # table) for any row with a null team or opponent_team.
        if team is not None and opponent is not None:
            off_vals = [clean(d.get(c)) if c in d else None for c in TEAM_OFFENSE_COLS]
            off_rows.append((tid, *off_vals))
            def_rows.append((tid, *get_row(d, DEFENSE_COLS)))
            st_rows.append((tid, *get_row(d, ST_COLS)))
            misc_rows.append((tid, *get_row(d, TEAM_MISC_COLS)))
        else:
            skipped += 1
        tid += 1
    if skipped:
        print(f"  team {season}: skipped category rows for {skipped} row(s) with null team/opponent_team (team_game_id still reserved)")

    # Hub and category tables are written to SEPARATE files (hub file name sorts
    # before the category file name) so wrangler fully finishes loading every
    # team_game row before any team_game_offense/defense/special_teams/misc row
    # is attempted. Bundling them in one file let wrangler's bulk-file executor
    # process rows out of top-to-bottom order, which surfaced as spurious
    # FOREIGN KEY constraint failures even though every statement is valid on
    # its own (verified by running each statement individually against D1).
    hub_path = os.path.join(OUT, f"10a_team_game_hub_{season}.sql")
    with open(hub_path, "w") as fh:
        write_inserts(fh, "team_game", ["team_game_id", "game_id", "team", "opponent_team"], hub_rows, 300)

    cat_path = os.path.join(OUT, f"10b_team_game_cat_{season}.sql")
    with open(cat_path, "w") as fh:
        write_inserts(fh, "team_game_offense", ["team_game_id"] + TEAM_OFFENSE_COLS, off_rows, 80)
        write_inserts(fh, "team_game_defense", ["team_game_id"] + DEFENSE_COLS, def_rows, 250)
        write_inserts(fh, "team_game_special_teams", ["team_game_id"] + ST_COLS, st_rows, 80)
        write_inserts(fh, "team_game_misc", ["team_game_id"] + TEAM_MISC_COLS, misc_rows, 250)
    print(f"team {season}: {len(hub_rows)} rows -> {hub_path} + {cat_path}")
    return tid, len(hub_rows)


def build_player_season(season, next_id):
    fn = f"{RAW}/player/stats_player_week_{season}.csv"
    if not os.path.exists(fn):
        return next_id, 0
    df = pd.read_csv(fn, engine="pyarrow")

    hub_rows, off_rows, def_rows, st_rows, misc_rows = [], [], [], [], []
    pid_ctr = next_id
    skipped = 0
    for r in df.itertuples(index=False):
        d = r._asdict()
        player_id = clean(d.get("player_id"))
        # Some stats_player_week CSVs (found so far: 1999 has 21 rows with
        # player_id '0', 2000 has 1 row with player_id 'XX-0000001') use a
        # placeholder player_id for an unattributed/unidentified stat line.
        # Neither is truthy-empty (so `not player_id` doesn't catch them) and
        # neither exists in the player dimension table (built from index.json
        # in build_player() above), so leaving them in violates player_game's
        # NOT NULL FK on player_id. Check membership against that same set
        # directly instead of hardcoding each bad id as it's discovered --
        # skip the row entirely (no hub row, no category rows, id not
        # reserved) whenever player_id isn't a real player.
        if not player_id or player_id not in valid_player_ids():
            continue
        team = fix_team_code(clean(d.get("team")))
        opponent = fix_team_code(clean(d.get("opponent_team")))
        hub_rows.append((
            pid_ctr, clean(d.get("game_id")), player_id, team, opponent, clean(d.get("position")),
        ))
        # Same null team/opponent_team issue as build_team_season -- see the
        # comment there. Keep incrementing pid_ctr either way so IDs match
        # what's already been generated/loaded for the hub table.
        if team is not None and opponent is not None:
            off_rows.append((pid_ctr, *get_row(d, PLAYER_OFFENSE_COLS)))
            def_rows.append((pid_ctr, *get_row(d, DEFENSE_COLS)))
            st_rows.append((pid_ctr, *get_row(d, ST_COLS)))
            misc_rows.append((pid_ctr, *get_row(d, PLAYER_MISC_COLS)))
        else:
            skipped += 1
        pid_ctr += 1
    if skipped:
        print(f"  player {season}: skipped category rows for {skipped} row(s) with null team/opponent_team (player_game_id still reserved)")

    # Same hub-file-before-category-file split as build_team_season -- see the
    # comment there for why.
    hub_path = os.path.join(OUT, f"20a_player_game_hub_{season}.sql")
    with open(hub_path, "w") as fh:
        write_inserts(fh, "player_game",
                       ["player_game_id", "game_id", "player_id", "team", "opponent_team", "position_code"],
                       hub_rows, 250)

    cat_path = os.path.join(OUT, f"20b_player_game_cat_{season}.sql")
    with open(cat_path, "w") as fh:
        write_inserts(fh, "player_game_offense", ["player_game_id"] + PLAYER_OFFENSE_COLS, off_rows, 60)
        write_inserts(fh, "player_game_defense", ["player_game_id"] + DEFENSE_COLS, def_rows, 200)
        write_inserts(fh, "player_game_special_teams", ["player_game_id"] + ST_COLS, st_rows, 60)
        write_inserts(fh, "player_game_misc", ["player_game_id"] + PLAYER_MISC_COLS, misc_rows, 200)
    print(f"player {season}: {len(hub_rows)} rows -> {hub_path} + {cat_path}")
    return pid_ctr, len(hub_rows)


# ---------------------------------------------------------------------------
# 4. injury_report, one file per season on disk (2009-2025)
# ---------------------------------------------------------------------------
def build_injury_season(season):
    fn = f"{RAW}/injuries/injuries_{season}.csv"
    if not os.path.exists(fn):
        return 0
    df = pd.read_csv(fn)
    cols = [
        "season", "week", "game_type_code", "player_id", "team",
        "report_primary_injury", "report_secondary_injury", "report_status",
        "practice_primary_injury", "practice_secondary_injury", "practice_status", "date_modified",
    ]
    rows = []
    for r in df.itertuples(index=False):
        d = r._asdict()
        pid = clean(d.get("gsis_id"))
        # Same issue as bug #5 in build_player_season(): every season's
        # injuries CSV (2009-2025, ~15-75 rows each) has some gsis_id values
        # that aren't in the player dimension (index.json) -- injury_report's
        # player_id has a NOT NULL FK to player, so leaving these in causes
        # "FOREIGN KEY constraint failed". Skip the same way, checking real
        # membership rather than just truthiness.
        if not pid or pid not in valid_player_ids():
            continue
        rows.append((
            clean(d.get("season")), clean(d.get("week")), clean(d.get("game_type")), pid,
            clean(d.get("team")), clean(d.get("report_primary_injury")), clean(d.get("report_secondary_injury")),
            clean(d.get("report_status")), clean(d.get("practice_primary_injury")),
            clean(d.get("practice_secondary_injury")), clean(d.get("practice_status")), clean(d.get("date_modified")),
        ))
    path = os.path.join(OUT, f"30_injury_{season}.sql")
    with open(path, "w") as fh:
        n = write_inserts(fh, "injury_report", cols, rows, 200)
    print(f"injury {season}: {n} rows -> {path} ({os.path.getsize(path)/1024:.0f} KB)")
    return n


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    if mode in ("all", "player"):
        build_player()
    if mode in ("all", "game"):
        build_game()

    if mode in ("all", "team", "test"):
        seasons = [1999] if mode == "test" else range(1999, 2027)
        next_id = 1
        total = 0
        for s in seasons:
            next_id, n = build_team_season(s, next_id)
            total += n
        print(f"TOTAL team_game rows: {total}")

    if mode in ("all", "playerstats", "test"):
        seasons = [1999] if mode == "test" else range(1999, 2027)
        next_id = 1
        total = 0
        for s in seasons:
            next_id, n = build_player_season(s, next_id)
            total += n
        print(f"TOTAL player_game rows: {total}")

    if mode in ("all", "injury"):
        total = 0
        for s in range(2009, 2026):
            total += build_injury_season(s)
        print(f"TOTAL injury_report rows: {total}")
