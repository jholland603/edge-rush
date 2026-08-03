#!/usr/bin/env python3
"""
Incremental D1 loader for ONE season's worth of new/updated rows -- run this
weekly during the season instead of re-doing the full historical bulk import
(that was a one-time job -- see build_d1_sql.py and HANDOFF.md for the story
of how fragile that was to get right, including bug #7's silent ID-shift
corruption).

Safe to run over and over, any time, even mid-week, without knowing what's
already loaded:
  - `game`: upserted (INSERT ... ON CONFLICT DO UPDATE) every time, so
    scores/lines/weather settle in as the week plays out.
  - `coach`/`referee`: new names are INSERT OR IGNORE'd (UNIQUE(name),
    AUTOINCREMENT id) -- the game row looks its coach_id/referee_id up by
    name via a correlated subquery, so this script never has to know or
    compute an id itself.
  - `player`: any player_id in this season's stats_player_week/injuries CSVs
    not already in D1 gets INSERT OR IGNORE'd, built from the CSV's own name
    columns -- no dependency on the old index.json (this project doesn't
    maintain that file anymore now that the site reads from D1).
  - `team_game`/`player_game` (hub tables): INSERT OR IGNORE, letting
    AUTOINCREMENT assign team_game_id/player_game_id -- this script never
    computes or reserves an id itself (that manual-counter approach is
    exactly what caused bug #7). The category tables (offense/defense/
    special_teams/misc) are loaded right after with
    `INSERT OR REPLACE INTO ... SELECT tg.team_game_id, ... FROM team_game tg
    WHERE tg.game_id = ? AND tg.team = ?` -- looking the id up by its natural
    key in the same statement instead of a separate round-trip to read back
    what id got assigned.
  - `injury_report`: no natural unique key (a player can have several daily
    practice-report snapshots in the same week), so each row is inserted
    only `WHERE NOT EXISTS` an identical (season, week, player_id, team,
    date_modified) row already -- safe to feed it the same day's file twice.

Two ways to run it, same pattern as weekly_update.py / reconcile_picks.py:
  1. Interactive (wrangler, needs `wrangler login` already done):
       python scripts/build_incremental_sql.py --season 2026
  2. Cowork scheduled task / anywhere without wrangler or a local login:
       python scripts/build_incremental_sql.py --season 2026 --sql-out out.sql
     then apply out.sql yourself (e.g. via the D1 MCP tool), in the order
     it's written -- later statements depend on earlier ones (player/coach/
     referee dimension rows before game/team_game/player_game/injury_report,
     hub tables before their category tables).

Robust to nflverse not having published a given file yet for this season --
games.csv / stats_team_week / stats_player_week / injuries are each
independently optional; a missing one is skipped with a printed note, not an
error, so this is safe to run in the off-season or early in a week before
that week's files are up.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import pandas as pd

TEAM_CODE_FIX = {"JAC": "JAX"}


def fix_team_code(v):
    return TEAM_CODE_FIX.get(v, v)


def esc(v):
    """Format a python value as a SQL literal (same rules as build_d1_sql.py's
    esc(), including the inf/-inf -> NULL fix from bug #6)."""
    if v is None:
        return "NULL"
    if isinstance(v, float):
        if pd.isna(v):
            return "NULL"
        if v in (float("inf"), float("-inf")):
            return "NULL"
        return repr(v)
    if isinstance(v, int):
        return str(v)
    s = str(v)
    return "'" + s.replace("'", "''") + "'"


def clean(v):
    """Normalize a pandas scalar: NaN/empty -> None; neutralize semicolons in
    strings (wrangler's bulk-file executor naively splits on ';')."""
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
        if ";" in v:
            return v.replace(";", ",")
    return v


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


# ---------------------------------------------------------------------------
# column lists -- identical to build_d1_sql.py, kept in sync with the D1 schema
# ---------------------------------------------------------------------------
TEAM_OFFENSE_COLS = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost", "passing_air_yards",
    "passing_yards_after_catch", "passing_first_downs", "passing_epa", "passing_cpoe",
    "passing_2pt_conversions", "pacr", "passing_10", "passing_16", "passing_20", "passing_40",
    "carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost",
    "rushing_first_downs", "rushing_epa", "rushing_2pt_conversions", "rushing_10", "rushing_12",
    "rushing_20", "rushing_40", "receptions", "targets", "receiving_yards", "receiving_tds",
    "receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards", "receiving_yards_after_catch",
    "receiving_first_downs", "receiving_epa", "receiving_2pt_conversions", "receiving_10",
    "receiving_16", "receiving_20", "receiving_40", "racr", "target_share", "air_yards_share", "wopr",
]
DEFENSE_COLS = [
    "def_tackles_solo", "def_tackles_with_assist", "def_tackle_assists", "def_tackles_for_loss",
    "def_tackles_for_loss_yards", "def_fumbles_forced", "def_sacks", "def_sack_yards", "def_qb_hits",
    "def_interceptions", "def_interception_yards", "def_pass_defended", "def_tds", "def_fumbles",
    "def_safeties",
]
ST_COLS = [
    "fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long", "fg_pct",
    "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_",
    "fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_",
    "fg_made_list", "fg_missed_list", "fg_blocked_list", "fg_made_distance", "fg_missed_distance", "fg_blocked_distance",
    "pat_made", "pat_att", "pat_missed", "pat_blocked", "pat_pct",
    "gwfg_made", "gwfg_att", "gwfg_missed", "gwfg_blocked", "gwfg_distance",
    "pt_att", "pt_blocked", "pt_long", "pt_yards", "pt_inside_20", "pt_out_of_bounds", "pt_downed",
    "pt_touchback", "pt_fair_caught", "pt_returned", "pt_return_yards", "pt_return_tds", "pt_net_yards",
    "punt_returns", "punt_return_yards", "kickoff_returns", "kickoff_return_yards",
]
TEAM_MISC_COLS = [
    "misc_yards", "fumble_recovery_own", "fumble_recovery_yards_own", "fumble_recovery_opp",
    "fumble_recovery_yards_opp", "fumble_recovery_tds", "penalties", "penalty_yards",
    "fumbles_forced_by_opp", "fumbles_not_forced", "fumbles_out_of_bounds", "fumbles_total",
    "fumbles_lost_total", "special_teams_tds", "timeouts",
]
PLAYER_OFFENSE_COLS = TEAM_OFFENSE_COLS + ["fantasy_points", "fantasy_points_ppr"]
PLAYER_MISC_COLS = [c for c in TEAM_MISC_COLS if c != "timeouts"]


def get_row(d, cols):
    return [clean(d.get(c)) for c in cols]


# ---------------------------------------------------------------------------
# 1. player dimension -- new player_ids only, derived straight from the CSVs
#    (stats_player_week has player_display_name; injuries has full_name/
#    first_name/last_name), not from the retired index.json.
# ---------------------------------------------------------------------------
def build_player_dim_statements(raw_dir: Path, season: int) -> list:
    rows = {}  # player_id -> (display_name, first, last)

    f = raw_dir / "player" / f"stats_player_week_{season}.csv"
    if f.exists():
        df = pd.read_csv(f, low_memory=False)
        for r in df.itertuples(index=False):
            d = r._asdict()
            pid = clean(d.get("player_id"))
            name = clean(d.get("player_display_name")) or clean(d.get("player_name"))
            if not pid or not name:
                continue
            if pid not in rows:
                parts = str(name).split(" ", 1)
                rows[pid] = (name, parts[0], parts[1] if len(parts) > 1 else "")

    f = raw_dir / "injuries" / f"injuries_{season}.csv"
    if f.exists():
        df = pd.read_csv(f, low_memory=False)
        for r in df.itertuples(index=False):
            d = r._asdict()
            pid = clean(d.get("gsis_id"))
            name = clean(d.get("full_name"))
            if not pid or not name or pid in rows:
                continue
            rows[pid] = (name, clean(d.get("first_name")) or "", clean(d.get("last_name")) or "")

    if not rows:
        return []

    stmts = []
    for pid, (name, first, last) in rows.items():
        stmts.append(
            "INSERT OR IGNORE INTO player (player_id, display_name, first_name, last_name) "
            f"VALUES ({esc(pid)}, {esc(name)}, {esc(first)}, {esc(last)});"
        )
    print(f"player: {len(stmts)} candidate new player_id(s) from season {season} CSVs")
    return stmts


# ---------------------------------------------------------------------------
# 2. game -- upsert every row for the season; coach/referee looked up by
#    name via subquery (after ensuring they exist) instead of a precomputed id.
# ---------------------------------------------------------------------------
def build_game_statements(raw_dir: Path, season: int) -> list:
    f = raw_dir / "games.csv"
    if not f.exists():
        print(f"game: {f} not found -- skipping")
        return []
    df = pd.read_csv(f, low_memory=False)
    df = df[df["season"] == season]
    if df.empty:
        print(f"game: no rows for season {season} in {f}")
        return []

    coaches = sorted(set(clean(c) for c in df["home_coach"].tolist() + df["away_coach"].tolist() if clean(c)))
    refs = sorted(set(clean(c) for c in df["referee"].tolist() if clean(c)))

    stmts = []
    for name in coaches:
        stmts.append(f"INSERT OR IGNORE INTO coach (name) VALUES ({esc(name)});")
    for name in refs:
        stmts.append(f"INSERT OR IGNORE INTO referee (name) VALUES ({esc(name)});")

    game_cols = [
        "game_id", "season", "week", "game_type_code", "gameday", "weekday", "gametime",
        "home_team", "away_team", "home_score", "away_score", "result", "total", "overtime",
        "home_rest", "away_rest", "div_game", "roof", "surface", "temp", "wind",
        "home_qb_id", "away_qb_id", "home_coach_id", "away_coach_id", "referee_id", "stadium_id",
        "spread_line", "home_spread_odds", "away_spread_odds", "total_line",
        "over_odds", "under_odds", "home_moneyline", "away_moneyline",
    ]
    update_cols = [c for c in game_cols if c != "game_id"]

    for r in df.itertuples(index=False):
        d = r._asdict()
        home_coach = clean(d.get("home_coach"))
        away_coach = clean(d.get("away_coach"))
        ref = clean(d.get("referee"))
        vals = {
            "game_id": clean(d.get("game_id")), "season": clean(d.get("season")), "week": clean(d.get("week")),
            "game_type_code": clean(d.get("game_type")), "gameday": clean(d.get("gameday")),
            "weekday": clean(d.get("weekday")), "gametime": clean(d.get("gametime")),
            "home_team": clean(d.get("home_team")), "away_team": clean(d.get("away_team")),
            "home_score": clean(d.get("home_score")), "away_score": clean(d.get("away_score")),
            "result": clean(d.get("result")), "total": clean(d.get("total")), "overtime": clean(d.get("overtime")),
            "home_rest": clean(d.get("home_rest")), "away_rest": clean(d.get("away_rest")),
            "div_game": clean(d.get("div_game")), "roof": clean(d.get("roof")), "surface": clean(d.get("surface")),
            "temp": clean(d.get("temp")), "wind": clean(d.get("wind")),
            "home_qb_id": clean(d.get("home_qb_id")), "away_qb_id": clean(d.get("away_qb_id")),
            "stadium_id": clean(d.get("stadium_id")),
            "spread_line": clean(d.get("spread_line")), "home_spread_odds": clean(d.get("home_spread_odds")),
            "away_spread_odds": clean(d.get("away_spread_odds")), "total_line": clean(d.get("total_line")),
            "over_odds": clean(d.get("over_odds")), "under_odds": clean(d.get("under_odds")),
            "home_moneyline": clean(d.get("home_moneyline")), "away_moneyline": clean(d.get("away_moneyline")),
        }
        value_exprs = []
        for c in game_cols:
            if c == "home_coach_id":
                value_exprs.append(f"(SELECT coach_id FROM coach WHERE name = {esc(home_coach)})" if home_coach else "NULL")
            elif c == "away_coach_id":
                value_exprs.append(f"(SELECT coach_id FROM coach WHERE name = {esc(away_coach)})" if away_coach else "NULL")
            elif c == "referee_id":
                value_exprs.append(f"(SELECT referee_id FROM referee WHERE name = {esc(ref)})" if ref else "NULL")
            else:
                value_exprs.append(esc(vals[c]))

        set_clause = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
        stmts.append(
            f"INSERT INTO game ({', '.join(game_cols)}) VALUES ({', '.join(value_exprs)}) "
            f"ON CONFLICT(game_id) DO UPDATE SET {set_clause};"
        )
    print(f"game: {len(df)} row(s) upserted for season {season} "
          f"({len(coaches)} coach name(s), {len(refs)} referee name(s) ensured)")
    return stmts


# ---------------------------------------------------------------------------
# 3. team_game + 4 category tables -- hub via INSERT OR IGNORE (AUTOINCREMENT
#    assigns team_game_id), category tables via INSERT OR REPLACE ... SELECT
#    looking the id up by (game_id, team) in the same statement.
# ---------------------------------------------------------------------------
def build_team_game_statements(raw_dir: Path, season: int) -> list:
    f = raw_dir / "team" / f"stats_team_week_{season}.csv"
    if not f.exists():
        print(f"team_game: {f} not found -- skipping (not published yet?)")
        return []
    df = pd.read_csv(f, low_memory=False)
    df = df[df["season_type"] == "REG"].copy()
    if df.empty:
        print(f"team_game: no REG rows for season {season} in {f}")
        return []

    stmts = []
    skipped = 0
    for r in df.itertuples(index=False):
        d = r._asdict()
        game_id = clean(d.get("game_id"))
        team = fix_team_code(clean(d.get("team")))
        opponent = fix_team_code(clean(d.get("opponent_team")))
        if not game_id or not team or not opponent:
            skipped += 1
            continue
        stmts.append(
            "INSERT OR IGNORE INTO team_game (game_id, team, opponent_team) VALUES "
            f"({esc(game_id)}, {esc(team)}, {esc(opponent)});"
        )
        for table, cols in [
            ("team_game_offense", TEAM_OFFENSE_COLS),
            ("team_game_defense", DEFENSE_COLS),
            ("team_game_special_teams", ST_COLS),
            ("team_game_misc", TEAM_MISC_COLS),
        ]:
            vals = get_row(d, cols)
            col_list = ", ".join(cols)
            select_list = ", ".join(esc(v) for v in vals)
            stmts.append(
                f"INSERT OR REPLACE INTO {table} (team_game_id, {col_list}) "
                f"SELECT tg.team_game_id, {select_list} FROM team_game tg "
                f"WHERE tg.game_id = {esc(game_id)} AND tg.team = {esc(team)};"
            )
    if skipped:
        print(f"  team_game {season}: skipped {skipped} row(s) with null game_id/team/opponent_team")
    print(f"team_game: {len(df) - skipped} row(s) processed for season {season}")
    return stmts


# ---------------------------------------------------------------------------
# 4. player_game + 4 category tables -- same pattern as team_game above.
# ---------------------------------------------------------------------------
def build_player_game_statements(raw_dir: Path, season: int) -> list:
    f = raw_dir / "player" / f"stats_player_week_{season}.csv"
    if not f.exists():
        print(f"player_game: {f} not found -- skipping (not published yet?)")
        return []
    df = pd.read_csv(f, low_memory=False)
    if "season_type" in df.columns:
        df = df[df["season_type"] == "REG"].copy()
    if df.empty:
        print(f"player_game: no REG rows for season {season} in {f}")
        return []

    stmts = []
    skipped = 0
    for r in df.itertuples(index=False):
        d = r._asdict()
        game_id = clean(d.get("game_id"))
        player_id = clean(d.get("player_id"))
        team = fix_team_code(clean(d.get("team")))
        opponent = fix_team_code(clean(d.get("opponent_team")))
        position = clean(d.get("position"))
        if not game_id or not player_id or not team or not opponent:
            skipped += 1
            continue
        stmts.append(
            "INSERT OR IGNORE INTO player_game (game_id, player_id, team, opponent_team, position_code) VALUES "
            f"({esc(game_id)}, {esc(player_id)}, {esc(team)}, {esc(opponent)}, {esc(position)});"
        )
        for table, cols in [
            ("player_game_offense", PLAYER_OFFENSE_COLS),
            ("player_game_defense", DEFENSE_COLS),
            ("player_game_special_teams", ST_COLS),
            ("player_game_misc", PLAYER_MISC_COLS),
        ]:
            vals = get_row(d, cols)
            col_list = ", ".join(cols)
            select_list = ", ".join(esc(v) for v in vals)
            stmts.append(
                f"INSERT OR REPLACE INTO {table} (player_game_id, {col_list}) "
                f"SELECT pg.player_game_id, {select_list} FROM player_game pg "
                f"WHERE pg.game_id = {esc(game_id)} AND pg.player_id = {esc(player_id)};"
            )
    if skipped:
        print(f"  player_game {season}: skipped {skipped} row(s) with null game_id/player_id/team/opponent_team")
    print(f"player_game: {len(df) - skipped} row(s) processed for season {season}")
    return stmts


# ---------------------------------------------------------------------------
# 5. injury_report -- no natural unique key; guard each insert with
#    WHERE NOT EXISTS an identical row already, so re-feeding the same day's
#    file is a no-op.
# ---------------------------------------------------------------------------
def build_injury_statements(raw_dir: Path, season: int) -> list:
    f = raw_dir / "injuries" / f"injuries_{season}.csv"
    if not f.exists():
        print(f"injury_report: {f} not found -- skipping")
        return []
    df = pd.read_csv(f, low_memory=False)

    cols = [
        "season", "week", "game_type_code", "player_id", "team",
        "report_primary_injury", "report_secondary_injury", "report_status",
        "practice_primary_injury", "practice_secondary_injury", "practice_status", "date_modified",
    ]
    stmts = []
    skipped = 0
    for r in df.itertuples(index=False):
        d = r._asdict()
        pid = clean(d.get("gsis_id"))
        if not pid:
            skipped += 1
            continue
        vals = {
            "season": clean(d.get("season")), "week": clean(d.get("week")),
            "game_type_code": clean(d.get("game_type")), "player_id": pid, "team": clean(d.get("team")),
            "report_primary_injury": clean(d.get("report_primary_injury")),
            "report_secondary_injury": clean(d.get("report_secondary_injury")),
            "report_status": clean(d.get("report_status")),
            "practice_primary_injury": clean(d.get("practice_primary_injury")),
            "practice_secondary_injury": clean(d.get("practice_secondary_injury")),
            "practice_status": clean(d.get("practice_status")), "date_modified": clean(d.get("date_modified")),
        }
        col_list = ", ".join(cols)
        select_list = ", ".join(esc(vals[c]) for c in cols)
        stmts.append(
            f"INSERT INTO injury_report ({col_list}) "
            f"SELECT {select_list} WHERE NOT EXISTS ("
            f"SELECT 1 FROM injury_report WHERE season = {esc(vals['season'])} AND week = {esc(vals['week'])} "
            f"AND player_id = {esc(vals['player_id'])} AND team = {esc(vals['team'])} "
            f"AND date_modified = {esc(vals['date_modified'])});"
        )
    if skipped:
        print(f"  injury_report {season}: skipped {skipped} row(s) with no gsis_id "
              f"(not in player dimension -- see bug #8 in HANDOFF.md; this script only "
              f"skips rows with a genuinely missing id, real-but-new player_ids are handled "
              f"by build_player_dim_statements() above, which runs first)")
    print(f"injury_report: {len(df) - skipped} row(s) processed for season {season}")
    return stmts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--db-name", default="edge-rush",
                         help="D1 database name (wrangler.toml database_name)")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute`. Use this when there's no wrangler/"
                              "local login available (e.g. a Cowork scheduled task) -- "
                              "apply the file yourself (e.g. via the D1 MCP tool), "
                              "statement by statement, in the order it's written.")
    args = parser.parse_args()

    statements = []
    # Order matters: player dimension and coach/referee/game before anything
    # that FKs to them; hub tables before their category tables.
    statements += build_player_dim_statements(args.raw_dir, args.season)
    statements += build_game_statements(args.raw_dir, args.season)
    statements += build_team_game_statements(args.raw_dir, args.season)
    statements += build_player_game_statements(args.raw_dir, args.season)
    statements += build_injury_statements(args.raw_dir, args.season)

    print(f"\n{len(statements)} statement(s) generated for season {args.season}")
    if not statements:
        print("Nothing to do.")
        return

    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("\n".join(statements) + "\n")
        print(f"Wrote {args.sql_out} -- apply it yourself (e.g. via the D1 MCP tool), "
              f"in order.")
    else:
        run_d1_statements(statements, args.db_name)


if __name__ == "__main__":
    main()
