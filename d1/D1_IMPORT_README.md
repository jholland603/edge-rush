# Loading data into the edge-rush D1 database

The schema (20 tables, 13 views) and the small reference tables (`team`, `season`,
`game_type`, `position`, `stadium`, `coach`, `referee`, plus the first 1,200 rows of
`player`) are already loaded. Everything else lives in `d1/sql/` as plain `.sql`
files, generated from the same raw CSVs the site's JSON data comes from.

## One-time setup

```powershell
npm install -g wrangler
wrangler login
```

This opens a browser to authorize wrangler against your Cloudflare account (the same
account the `edge-rush` D1 database lives in).

## Run the import

```powershell
cd C:\Users\jeffr\Documents\edge-rush\d1
.\import.ps1
```

This runs `wrangler d1 execute edge-rush --remote --file=...` against every file in
`sql/`, in the right order. It'll take a while — there are 181 files totaling ~290MB.
Every statement uses `INSERT OR IGNORE`, so the whole thing is safe to stop and
re-run from the top if a file fails partway (already-loaded rows are just skipped,
nothing gets duplicated).

**Known issue, fixed**: the first attempt at this failed with `FOREIGN KEY
constraint failed` on `team_game`. Root cause: `team_game`/`player_game` (the
"hub" tables) and their 4 category tables were originally bundled into one file
per season, and wrangler's bulk-file loader doesn't guarantee it executes a
single file's statements top-to-bottom — so a category-table row could get
attempted before its hub row existed. Fixed by splitting each season into a
`*_hub_*` file and a `*_cat_*` file, loaded in that order (confirmed: every
individual statement inserts cleanly on its own — this was purely an ordering
issue, not bad data).

## What's in each file

| File(s) | Table(s) | Rows |
|---|---|---|
| `00_player.sql` | `player` | 11,366 (1,200 already loaded) |
| `01_game.sql` | `game` | 7,548 |
| `10a_team_game_hub_1999.sql` ... `_2025.sql` | `team_game` | 14,531 |
| `10b_team_game_cat_1999.sql` ... `_2025.sql` | 4 team category tables | (same rows, wide) |
| `20a_player_game_hub_1999.sql` ... `_2025.sql` | `player_game` | 475,627 |
| `20b_player_game_cat_1999.sql` ... `_2025.sql` | 4 player category tables | (same rows, wide) |
| `30_injury_2009.sql` ... `_2025.sql` | `injury_report` | 90,752 |

## Verify when done

```powershell
wrangler d1 execute edge-rush --remote --command="SELECT (SELECT COUNT(*) FROM game) game, (SELECT COUNT(*) FROM team_game) team_game, (SELECT COUNT(*) FROM player_game) player_game, (SELECT COUNT(*) FROM injury_report) injury_report, (SELECT COUNT(*) FROM player) player;"
```

Expected: `game=7548, team_game=14531, player_game=475627, injury_report=90752, player=11366`.

## Regenerating the SQL files

If the underlying CSVs change, regenerate everything with:

```
python3 scripts/build_d1_sql.py all
```

(reads from `raw/`, writes fresh files into `d1/sql/`; point `RAW`/`OUT` at the top
of the script if your paths differ).
