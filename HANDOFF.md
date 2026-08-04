# edge-rush — session handoff

Paste this whole file into a new chat, or just point the new Claude at this file
(`C:\Users\jeffr\Documents\edge-rush\HANDOFF.md`) and say "read this and continue."

## What this project is

A personal NFL handicapping / power-rating model, built in 4 phases:
1. **Backtest** — leak-free walk-forward model (EPA-based ratings) vs. closing lines.
2. **Weekly automation** — pull new data, generate this week's picks.
3. **Live tracking** — reconcile picks against actual results.
4. **Publish** — a static website to browse all of it.

Project root: `C:\Users\jeffr\Documents\edge-rush` (bash-mounted at
`/sessions/.../mnt/edge-rush/` — the exact session path changes each session, ask
if you need it). Was originally named `nfl`, renamed mid-project; if the folder
connection ever looks stale/empty, reconnect via `mcp__cowork__request_cowork_directory`
pointed at the current path.

Phases 1-3 are done and documented in `backtest/phase1_results.md` (includes an
honest negative finding: QB passer-rating-edge, tested to check a claim from Cold
Hard Football Facts, added no signal beyond the existing EPA model). Phase 4 (the
site) is built and working, reading a static JSON data tree under `data/`.

## Where we are right now: migrating part of the data layer to Cloudflare D1

**Why:** the site wanted a "compare 2+ players, filter by year range" feature.
Doing that from static per-player JSON files meant embedding a `by_season`
breakdown in every player's career JSON — tested, and too slow/large. That
reopened an earlier "static files vs. database" decision in favor of a real
database: Cloudflare D1 (SQLite-based, serverless, reachable from a Cloudflare
Worker).

**Access model:** Claude has an authenticated Cloudflare MCP connector (tools
prefixed `mcp__443c8321-6997-48b6-9458-d457ec8a2a60__*`, e.g. `d1_database_query`)
— not raw API credentials. It can run SQL against D1 directly and instantly, but
cannot run `wrangler` (that needs the user's own login, so bulk file loads are
the user's job, guided by Claude).

### D1 database

- Name: `edge-rush`, id `b3234230-248f-49fa-bf7e-965ab93cea3a`.
- Full schema already created and verified live: 20 tables + 13 views. Layout:
  8 dimension tables (`team`, `position`, `season`, `game_type`, `stadium`,
  `coach`, `referee`, `player`) → central `game` table → two hub tables
  (`team_game`, `player_game`), each with 4 category tables (`_offense`,
  `_defense`, `_special_teams`, `_misc` — split up because D1 caps tables at 100
  columns and the source data is 133-145 columns wide) → plus `injury_report`.
  No stored season/career totals anywhere — the 13 views compute those live via
  `SUM()` over the per-game rows, joined through the hub tables to `game` for
  season filtering. Ask Claude to show the ERD again (mermaid.js) if you want
  the full DDL restated.
- **Do not touch** two unrelated pre-existing resources in the same Cloudflare
  account: D1 database `disttrkr_db` and Worker `overpass-proxy`. Not part of
  this project.

### Data load status — check this first, in a new session

Run this via the D1 MCP tool (`mcp__443c8321-6997-48b6-9458-d457ec8a2a60__d1_database_query`,
database id `b3234230-248f-49fa-bf7e-965ab93cea3a`) to see exactly where the
load stands:

```sql
SELECT (SELECT COUNT(*) FROM game) game,
       (SELECT COUNT(*) FROM team_game) team_game,
       (SELECT COUNT(*) FROM team_game_offense) team_game_offense,
       (SELECT COUNT(*) FROM player_game) player_game,
       (SELECT COUNT(*) FROM injury_report) injury_report,
       (SELECT COUNT(*) FROM player) player;
```

Expected once fully loaded: `game=7548, team_game=14531,
team_game_offense=14531, player_game=475565, injury_report=90346,
player=11366`. (These are lower than originally estimated —
`player_game`/`injury_report` totals dropped after bugs #5 and #8 removed
rows with placeholder/invalid player_ids that don't exist in the player
dimension; see those bugs below for exact counts. `team_game`/`player_game`
will each land 1 below their listed totals — one null-team row each, see bug
#4.)

**Update: the full historical import finished and was verified in a later
session** — `game=7548`, `player=11366`, `team_game=14530`, `player_game=475564`
(all four `player_game_*` category tables content-verified, not just row
counts), `injury_report=90346`. All 8 bugs below are fixed and the fixes are
confirmed live. `d1/sql/` (the generated files) and the old static
`data/*.json` tree have since been deleted — both are safe to regenerate/were
superseded (see the D1-migration sections further down for what replaced
them). The rest of this "Data load status" section and the 8 bugs below are
kept as project history / diagnostic reference, not a live to-do list.

### How the load works, and two bugs already found and fixed

Hand-typing rows through the chat tool call works but doesn't scale — retyping
~600 rows at a time burned a huge amount of context for just the `player`
dimension table (11,366 rows), and the fact tables are far bigger
(`player_game` alone is ~475,627 rows). So instead: `scripts/build_d1_sql.py`
generates complete `.sql` files directly from the raw CSVs (fast, no
chat-context cost), and the user runs `wrangler` locally to actually write them
(needs the user's own Cloudflare login — Claude can't run wrangler itself).

**Bug #1 (fixed): embedded semicolons.** Some columns (`fg_made_list`,
`fg_missed_list`, `fg_blocked_list`) store multiple values in one string
separated by literal `;`, e.g. `'31;25;32'`. Suspected this broke wrangler's
file parsing. Fixed in `build_d1_sql.py`'s `clean()` function by replacing `;`
with `,` in every string value. This turned out NOT to be the actual cause of
the FK error (see bug #2), but it's a real fix and stays in.

**Bug #2 (fixed): wrangler doesn't guarantee statement order within one file.**
The real cause of `FOREIGN KEY constraint failed` on `team_game`. Diagnosed by
extracting individual `INSERT` statements from the failing file and running
each one directly against D1 via the MCP query tool — every single one
succeeded standalone. Since the SQL was provably valid, the only explanation
left was execution order: `team_game_offense` (which FKs to `team_game`) was
apparently being attempted before its `team_game` hub row existed, within the
same bundled file. Fixed by splitting each season's hub table and category
tables into **separate files**, loaded in a strict order:
`10a_team_game_hub_{season}.sql` → `10b_team_game_cat_{season}.sql`, and
`20a_player_game_hub_{season}.sql` → `20b_player_game_cat_{season}.sql`.
`import.ps1` was updated to run all `10a_*` before any `10b_*`, etc. All 181
files (was 73 before the split) were regenerated and byte-verified on the
mount.

**Bug #3 (fixed): 'JAC' vs 'JAX' team code.** Hit next, on
`10a_team_game_hub_2001.sql` — a pure hub file this time, so not an ordering
issue. Diagnosed by diffing the distinct team codes used in
`stats_team_week_2001.csv` against the `team` dimension table: `stats_team_week_
2001/2002.csv` and `stats_player_week_2001/2002.csv` use `'JAC'` for the
Jaguars where `games.csv` (and every other season, and the `team` table itself)
uses `'JAX'`. Fixed with a `TEAM_CODE_FIX = {"JAC": "JAX"}` map applied to every
`team`/`opponent_team` value in `build_d1_sql.py`. Only the 2001/2002 hub files
needed regenerating (`10a_team_game_hub_{2001,2002}.sql`,
`20a_player_game_hub_{2001,2002}.sql`) — the category files don't store team
codes, only the numeric hub id, so they were untouched. All four regenerated
files were verified row-count-identical to the originals and byte-verified on
the mount. If another team-code mismatch turns up in a different season, the
same `TEAM_CODE_FIX` dict is the place to add it.

**Bug #4 (fixed): orphaned category rows for null-team/opponent rows.** Hit
next, on `10b_team_game_cat_1999.sql` — a pure category file this time, whose
only FK target (`team_game`) was confirmed 100% loaded for all 27 seasons, so
it wasn't an ordering issue. Diagnosed by extracting individual statements and
running them directly against D1 — every one succeeded standalone, which
pointed away from bad data at first. The actual bug: `stats_team_week_1999.csv`
has one row (`1999_09_PHI_CAR`) with `team`/`opponent_team` both null.
`team_game.team`/`opponent_team` are `NOT NULL`, so that row's hub insert gets
silently swallowed by `INSERT OR IGNORE` — but `build_d1_sql.py` was still
generating offense/defense/special_teams/misc rows for that same
`team_game_id`, so the category file referenced an id that was never actually
inserted into `team_game`. Confirmed by finding a gap at `team_game_id=255` in
the live table (`WITH RECURSIVE` scan of ids 1–517 for 1999). The same issue
existed in `stats_player_week_1999.csv` (one row, same game, `player_game_id`
7443) — the other seasons that looked suspicious on a first grep
(2001/2004/2016/2018) turned out to already be excluded correctly by the
existing `if not player_id: continue` check, so only 1999 needed a real fix.
Fixed in `build_d1_sql.py`: `build_team_season()` and `build_player_season()`
now still reserve the `team_game_id`/`player_game_id` for a null-team row
(keeping the hub table's existing numbering byte-for-byte identical to what's
already loaded) but skip writing that id into any of the 4 category tables.
Only `10b_team_game_cat_1999.sql` and `20b_player_game_cat_1999.sql` needed
regenerating; both hub files (`10a`/`20a`) are untouched and confirmed
byte-identical to what was already on disk. If a similar FK error shows up on
a different season's category file, check for null `team`/`opponent_team`
rows in that season's CSV the same way (`df['team'].isna() |
df['opponent_team'].isna()`).

**Bug #5 (fixed): placeholder player_ids not in the player dimension.**
Hit next, on `20a_player_game_hub_1999.sql` — a player hub file, FK target is
`player`. `stats_player_week_1999.csv` has 21 rows with the literal string
`'0'` as `player_id` (no name/position — one per team per week, looks like an
unattributed team-level stat line); `stats_player_week_2000.csv` has 1 row
with `player_id` `'XX-0000001'` (has a name, "S.Fernando", but still not in
`index.json`/the `player` table). Both are truthy non-empty strings, so the
existing `if not player_id: continue` guard in `build_player_season()` didn't
catch them, and since neither exists in the `player` dimension table,
inserting them violates `player_game`'s `NOT NULL REFERENCES player(player_id)`
FK. Rather than hardcode each bad id as found, fixed generically: added
`valid_player_ids()` (loads the same `index.json` name-filtered set
`build_player()` uses, cached) and changed the guard to
`if not player_id or player_id not in valid_player_ids(): continue`. This
also future-proofs against any other placeholder ids in later seasons.
Because `player_game` was still at 0 rows when this was found, **all 27
seasons of `20a_player_game_hub_*.sql` and `20b_player_game_cat_*.sql` (54
files) were regenerated**, not just 1999/2000 — removing 22 rows near the
start of the sequence shifts every `player_game_id` after it by 22, so partial
regeneration would have produced inconsistent numbering between hub and
category files for every season from 2000 onward. All 475,565 resulting
`player_id` values were checked against the dimension set with zero
violations, and all 54 regenerated files were byte-size-verified against the
mount after copying. `team_game`/`10a`/`10b` files are untouched (unaffected —
this bug is specific to `stats_player_week_*.csv`, not the team-level CSVs).

**Bug #6 (fixed): unquoted `inf`/`-inf` float literals.** Hit next, on
`20b_player_game_cat_1999.sql` — error was `no such column: inf`, not a FK
error. Cause: `esc()` in `build_d1_sql.py` formats Python floats with
`repr(v)`, and only special-cased `pd.isna(v)` (NaN/None) as NULL. It didn't
check for `inf`/`-inf`, which show up in ratio columns (`air_yards_share`,
`wopr`) when the numerator is nonzero but the denominator is 0.
`repr(float('inf'))` is the bare word `inf` with no quotes, which SQLite
parses as a column reference instead of a literal, hence "no such column".
Fixed by treating `inf`/`-inf` as NULL in `esc()`, same as NaN. Scope: only
`stats_player_week_1999.csv` and `2001.csv` actually contain inf values (checked
every generated `20b_player_game_cat_*.sql`/`10b_team_game_cat_*.sql` file for
the literal token) — team-level category tables never hit this since the 5
share/ratio columns are always NULL at the team level (see file map notes).
This fix only changes how a value is *formatted*, not which rows are kept, so
unlike bugs #4/#5 there's no id-numbering cascade — only
`20b_player_game_cat_1999.sql` and `20b_player_game_cat_2001.sql` needed
regenerating and copying, both byte-verified on the mount. (Stale pre-split
leftover files `20_player_game_1999.sql`/`20_player_game_2001.sql` in `d1/sql/`
also contain `inf` but aren't read by `import.ps1` — harmless, safe to ignore
or delete.)

**Bug #7 (fixed, and this one was serious): stale copies of 2010-2025
category files silently corrupted already-loaded data.** Hit next, on
`20b_player_game_cat_2025.sql` — `FOREIGN KEY constraint failed`, no useful
offset given. Root cause: when bug #5 was fixed, *all* 27 seasons of
`20a_player_game_hub_*`/`20b_player_game_cat_*` were regenerated (removing 42
invalid-player_id rows shifted every `player_game_id` from 2002 onward down
by a constant 61). Every file was copied to the mount and verified against
the freshly-generated copy -- but that verification only compared **file
size**, and shifting every id in a file by a constant doesn't change its size
at all (same digit count almost everywhere). So the copy silently failed for
`20b_player_game_cat_2010.sql` through `2025.sql` (16 files) -- the mount kept
serving the *old*, pre-fix versions with ids 61 too high, while the hub files
(`20a_*`, which did get copied correctly, and are unaffected by this class of
bug since they don't reference other tables) were already correct.

The result when the user's import actually ran those stale category files:
since old_id = correct_id + 61, and 61 rows is tiny compared to a season's
~17-19k rows, almost every stale insert still landed on an id that existed in
the (correctly-numbered) hub table -- just the **wrong** row. Concretely: for
seasons 2010-2024, each season's first 61 `player_game_id` slots were left
completely empty, the rest of the season's stats were shifted 61 slots
forward (slot X held the stats that actually belong to slot X-61), and each
season's own last 61 rows' stats spilled into the first 61 slots of the
*next* season's id range. Confirmed directly: `player_game_id 188733` (Cleveland's
QB, 2010 week 1) had zero rows in `player_game_offense`, while `188733`'s real
stat line (20/37, 227 yards) was sitting under `player_game_id 188794`, which
correctly belongs to a *different* player in a different game
(`2010_01_CIN_NE`). This is silent -- an FK-orphan check
(`LEFT JOIN ... WHERE parent.id IS NULL`) finds **zero** orphans here, because
every stale id pointed at a row that genuinely exists, just the wrong one. It
only threw a hard error at the very end (season 2025), the one season with no
"next season" to absorb the overflow, once the shift pushed ids
(475566-475626) past the real max (475565).

2025 itself never actually wrote any rows -- wrangler's whole-file execution
rolled back cleanly on the FK error, confirmed by `MAX(player_game_id)` in
`player_game_offense` being 456227, not anything in the 475xxx range. But
season 2024 (stale, and the last season to fully succeed before 2025) DID
commit, including its own last-61-rows spillover into ids 456167-456227 (which
sit in 2025's numeered range). Net corrupted range across all 4
`player_game_*` category tables: ids 188723 (2010's start) through 456227
(2024's spillover past its own 456166 end) -- 267,444 rows total, fixed by:

1. Regenerating (no numbering change, just re-copying already-correct
   `/tmp` files) and this time **byte-hash-verifying**
   (`md5sum`, not `stat -c%s`) all 54 `20a`/`20b` player files against the
   mount -- confirmed clean.
2. `DELETE FROM player_game_{offense,defense,special_teams,misc} WHERE
   player_game_id BETWEEN 188723 AND 456227` (both the main corrupted range
   and the 2024-into-2025 spillover) -- verified after: all four tables now
   `MIN=1, MAX=188722, COUNT=188721`, i.e. exactly seasons 1999-2009, fully
   correct, nothing beyond.
3. `d1/import.ps1` now keeps a persistent `d1/imported.log` (leaf filenames,
   one per line) -- `Run-File` skips anything already logged instead of
   re-uploading it, and only appends to the log on real success. This is also
   what makes re-runs after a failure fast (the user's other ask this round)
   -- previously every re-run re-uploaded all 181 files from the top.
   **Bootstrapped today** with exactly: `00_player.sql`, `01_game.sql`, all
   27 `10a_team_game_hub_*`/`10b_team_game_cat_*`/`20a_player_game_hub_*`, and
   `20b_player_game_cat_{1999-2009}.sql` (94 lines) -- deliberately excluding
   `20b_player_game_cat_{2010-2025}.sql` (needs a real reload after the
   delete above) and all `30_injury_*` (never reached yet).
   **If you ever manually delete/fix loaded data again, remove the
   corresponding line(s) from `imported.log` too**, or `import.ps1` will
   silently skip re-loading it.

**Lesson for future file-copy verification: always hash-compare
(`md5sum`), never just size-compare** -- this bug would have been caught
immediately with a hash check instead of the size check used during the
bug #5 cleanup.

**Bug #8 (fixed): same placeholder-player_id issue as bug #5, in
`injury_report`.** Hit next, on `30_injury_2009.sql` — `FOREIGN KEY constraint
failed`. `build_injury_season()` had the same shallow `if not pid: continue`
guard as `build_player_season()` did before bug #5, checking truthiness
instead of real membership in the player dimension. Every single season's
`injuries_{year}.csv` (2009-2025) has some `gsis_id` values not present in
`index.json` -- counts ranged 5-76 per season, 406 total. Fixed the same way:
`if not pid or pid not in valid_player_ids(): continue`. `injury_report_id` is
`AUTOINCREMENT` (not manually assigned like `player_game_id`), so there's no
id-numbering cascade to worry about here -- each season's file was just
regenerated independently and dropped straight in, no copy-verification
subtlety like bug #7 (these are fresh files, not stale-copy risks). All
90,346 resulting rows checked against the player dimension: zero invalid.
Total dropped from the previously-expected 90,752: 406, exactly matching the
per-season invalid-row counts.

**If a new error shows up**, use the same diagnostic method: pull the specific
failing statement out of the SQL file, run it directly via the D1 MCP query
tool. If it succeeds standalone, it's an execution-order/wrangler quirk (check
whether the failing file has a cross-table dependency that isn't split into
its own ordered file yet). If it fails standalone too, it's a real data issue —
diff the distinct game_id/team/player_id/etc. values in that season's CSV
against the corresponding dimension table (bugs #2, #3, #5, #8), check for
non-finite float values (`inf`/`-inf`/`NaN`) in ratio columns (bug #6), or --
if row counts look plausible but something feels off -- directly spot-check a
few known rows' actual content against the source CSV rather than trusting a
file-size or orphan-count check alone (bug #7).

**How to run it:**

```powershell
npm install -g wrangler      # one-time, if not already installed
wrangler login                # one-time, opens a browser to authorize
cd C:\Users\jeffr\Documents\edge-rush\d1
.\import.ps1
```

Common gotchas already hit this session, in case they recur:
- Double-clicking `import.ps1` in File Explorer opens it in an editor instead
  of running it — must run it from inside a PowerShell window.
- Typing the script's path directly into `cmd.exe` (not PowerShell) also just
  opens it in the default editor. If stuck in cmd, run
  `powershell -ExecutionPolicy Bypass -File "C:\Users\jeffr\Documents\edge-rush\d1\import.ps1"`
  instead.
- `--remote` is required in every wrangler command — without it, wrangler
  writes to a local throwaway copy, not the real database.
- The whole run is safe to stop and re-run from the top any time; every insert
  uses `INSERT OR IGNORE`, so already-loaded rows are just skipped.

Full details in `edge-rush\d1\D1_IMPORT_README.md`.

## Data layer + Worker: done. What's left is deploy + wire-up.

The D1 import is fully finished (all 8 bugs above fixed and verified — see
row counts up top). The two open design decisions got answered this session:

- **Worker scope: everything.** `games.html`, `teams.html`, `players.html`,
  `compare.html` now all go through the Worker/D1 (no schema changes needed —
  all their data was already in D1). `index.html` (home) and `picks.html`
  stay on static JSON: they read `model/*.json` and `log/picks_log.json`,
  which are Phase 2/3 data (weekly predictions, picks tracking) that was
  never migrated into D1 and has no tables for it yet. If that's ever wanted,
  it means designing a `model` table and a `picks_log` table and changing how
  picks get *written* (not just read) — a separate, bigger task, not done.
- **Hosting: site stays on GitHub Pages.** Worker deploys separately
  (`edge-rush-api`, its own `workers.dev` URL) with CORS wide open (`*` —
  this only ever serves public read-only NFL stats, nothing sensitive to
  restrict).

**Built this session:**
- `worker/` — a new Cloudflare Worker (`wrangler.toml` + `src/index.js`)
  implementing `/index`, `/games/:season`, `/teams/:season`,
  `/players/season/:season`, `/players/career/:playerId[?from=&to=]`,
  reading D1 directly (binding `DB`, database id
  `b3234230-248f-49fa-bf7e-965ab93cea3a`). The `?from=&to=` range on the
  career endpoint is the year-range filter that started this whole D1
  detour — implemented by summing the `v_player_season_offense`/`defense`/
  `special_teams` views (which expose a `season` column to filter on) plus a
  direct join for misc stats (no view covers `player_game_misc`/
  `team_game_misc`). Full `README.md` with deploy steps is in `worker/`.
- Two new indexes on D1 (`idx_player_game_player` on `player_game(player_id)`,
  `idx_team_game_team` on `team_game(team)`, `idx_game_season` on
  `game(season)`) — none of the existing `UNIQUE`/PK constraints help a
  lookup by player_id/team/season alone, and the career/compare pages do
  exactly that constantly. Added directly via the D1 MCP tool, no
  regeneration needed.
- `site/assets/js/data.js` — `getIndex`/`getGamesSeason`/`getTeamsSeason`/
  `getPlayersSeason`/`getPlayerCareer` now call the Worker
  (`API_BASE` constant, currently a placeholder —
  **needs the real URL after deploy, see next section**).
  `getModelManifest`/`getModelWeek`/`getPicksLog` untouched, still static
  JSON.
- `site/compare.html` + `page-compare.js` — added the From/To season
  selects, wired to the Worker's range param, cache keyed by
  `` `${id}:${from}-${to}` `` (not just `id`) so switching the range doesn't
  serve back a stale full-career response. Players with zero games in the
  selected range come back `null` from the API and are dropped from that
  render with a small warning badge rather than crashing.

**Update: the Worker is deployed** at `https://edge-rush-api.disttrkr.workers.dev`
(already the real URL in `site/assets/js/data.js`'s `API_BASE`, not a
placeholder). One bug hit and fixed post-deploy: `/teams/:season` and
`/players/season/:season` initially 500'd with `"too many columns in result
set"` — the original single wildcard 4-way join (`o.*, d.*, s.*, m.*`, 133+
columns) blew past a D1 result-set column limit. Fixed by splitting into 5
narrower `Promise.all`'d queries merged in JS by id (see the code comments in
`getTeamsSeason`/`getPlayersSeason` in `worker/src/index.js`) — redeploy with
`wrangler deploy` after pulling this fix if you haven't already. Whenever the
Worker's code changes (including the Phase-2/3 routes added later, see
below), redeploy the same way — the URL doesn't change between deploys.

**Field-fidelity note:** the Worker's JSON shapes closely match the old
static files but aren't a byte-perfect reproduction of every field
`scripts/build_json.py` produced — only mapped/verified against what
`page-games.js`/`page-teams.js`/`page-players.js`/`page-compare.js`/
`player-stats.js` actually *read* (confirmed by grepping every `Data.*` /
`w.<field>` / `career_totals.<field>` usage before writing the Worker). One
specific judgment call: "current position" for a player is derived as
`position_code` from their most recent game (`ORDER BY season DESC, week
DESC LIMIT 1`) — the original script used `.last()` on a per-season
CSV-row-order groupby, which is nearly always the same result but isn't
guaranteed identical in rare tie-break edge cases. If a stat card ever looks
wrong on a real player, compare the Worker's SQL for that field against the
raw CSV before assuming it's a bug in the data itself.

**Old static JSON tree (`data/games`, `data/teams`, `data/players`, top-level
`index.json`) has been deleted** — everything now comes from D1/the Worker.
`raw/` (source CSVs) was deliberately kept: 7 scripts still read it directly
(`build_d1_sql.py`, `build_incremental_sql.py`, `weekly_update.py`,
`reconcile_picks.py`, `backtest_v2.py`, and others). `d1/sql/*.sql` (the
one-time historical bulk-load files) is safe to delete too if disk space
matters — fully regenerable from `raw/*.csv` via `build_d1_sql.py`.

## Phase 2/3 (model + picks log) also migrated into D1 — the site is now 100% D1-backed

Everything above (games/teams/players/compare) was the first D1 migration.
This session finished the rest: `model` predictions and the `picks_log` are
now D1 tables too, and — the part the user actually asked for — there's a
weekly scheduled task that keeps all of this current automatically, so
nobody has to manually re-run the historical import or hand-feed CSVs again.

### New D1 tables

```sql
CREATE TABLE model (
  model_id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL REFERENCES season(season_year), week INTEGER NOT NULL,
  game_id TEXT NOT NULL UNIQUE REFERENCES game(game_id), matchup TEXT NOT NULL,
  market_spread REAL, model_spread REAL, edge REAL, p_home_covers REAL,
  flagged INTEGER NOT NULL DEFAULT 0, market_total REAL, updated TEXT NOT NULL, note TEXT
);
CREATE TABLE picks_log (
  picks_log_id INTEGER PRIMARY KEY AUTOINCREMENT, logged_at TEXT NOT NULL,
  season INTEGER NOT NULL REFERENCES season(season_year), week INTEGER NOT NULL,
  game_id TEXT NOT NULL UNIQUE REFERENCES game(game_id), gameday TEXT,
  home_team TEXT NOT NULL REFERENCES team(team_abbr), away_team TEXT NOT NULL REFERENCES team(team_abbr),
  market_spread REAL, model_spread REAL, edge REAL, p_home_covers REAL,
  bet_placed TEXT NOT NULL DEFAULT 'N', closing_line REAL, actual_result REAL, clv REAL,
  side TEXT, covered INTEGER
);
```

Design notes:
- `model.game_id` is `UNIQUE` and rows are **upserted** (`ON CONFLICT DO
  UPDATE`) — unlike picks_log, a prediction isn't "frozen," so re-running
  `weekly_update.py` before kickoff (e.g. as injury news changes through the
  week) intentionally overwrites that game's prior prediction in place.
- `picks_log.game_id` is also `UNIQUE`, but inserts are `INSERT OR IGNORE` —
  once a game is flagged and logged, `weekly_update.py` never touches that
  row again. `reconcile_picks.py` is the only thing allowed to update a
  logged row, and it only ever fills `closing_line`/`actual_result`/`clv`/
  `side`/`covered` — `logged_at`/`market_spread`/`model_spread`/`edge` stay
  frozen forever. This is the whole point of a pick log (see
  `nfl-handicapping-project-instructions.md` Phase 3).
- Existing `data/model/*.json` + `data/log/picks_log.json` (4 weeks of 2026
  predictions, 32 logged picks) were migrated in directly via the D1 MCP
  tool and verified row-count-identical (51 model rows across weeks 1-4, 32
  picks_log rows) before the static files were removed.

### Worker + site changes

`worker/src/index.js` gained three routes: `/model/manifest` (replaces
`data/model/manifest.json`), `/model/:season/:week` (replaces
`data/model/{season}-week{week}.json`), `/picks` (replaces
`data/log/picks_log.json`). `site/assets/js/data.js`'s `getModelManifest`/
`getModelWeek`/`getPicksLog` now call the Worker instead of static files —
`index.html`/`picks.html` (`page-home.js`/`page-picks.js`) needed no changes,
since the Worker's JSON shapes match the old static files field-for-field.
**The whole site is now D1-backed; there is no static `data/` tree left.**
Remember to `wrangler deploy` from `worker/` after pulling these changes if
you haven't already (same as the first migration).

### weekly_update.py / reconcile_picks.py: now write to D1, not JSON files

Both scripts still do the exact same modeling/reconciliation logic as
before (EWMA power ratings, `np.linalg.lstsq` margin fit, CLV math) — only
the *persistence* layer changed:
- `weekly_update.py` now upserts every scored game into `model` and
  `INSERT OR IGNORE`s newly-flagged games into `picks_log`, instead of
  writing `data/model/*.json` + `backtest/picks_log.csv`.
- `reconcile_picks.py` now reads pending `picks_log` rows from D1 and writes
  `UPDATE`s back, instead of reading/writing `backtest/picks_log.csv`.
- **`backtest/picks_log.csv` is no longer written or read by either script.**
  D1 is now the single source of truth for picks. (`backtest/predictions_v2.csv`
  from Phase 1's backtest is unrelated and still used as-is, for calibration.)

Both scripts talk to D1 via `wrangler d1 execute --remote` by default (same
as the original bulk import — needs `wrangler login` already done), e.g.:
```powershell
cd C:\Users\jeffr\Documents\edge-rush
python scripts/weekly_update.py --season 2026
python scripts/reconcile_picks.py
```
Both also accept a `--sql-out PATH` flag that writes the generated SQL to a
file *instead of* running wrangler — this exists because the Cowork
scheduled task below runs in an environment with no wrangler/local login,
only the D1 MCP connector, so it needs to generate SQL and apply it itself
via that tool. `reconcile_picks.py` additionally accepts `--pending-json
PATH` (read the list of un-reconciled picks from a file instead of querying
D1 via wrangler) for the same reason. Don't need either flag for a normal
manual run.

### New script: `scripts/build_incremental_sql.py` (loads one season's new/changed raw rows)

`build_d1_sql.py` was a **one-time** historical bulk-load tool — it assigns
`team_game_id`/`player_game_id` by replaying the *entire* row sequence from
scratch (see bug #7 above for how fragile that turned out to be). It is
**not** safe to use for ongoing weekly loads.

`build_incremental_sql.py` is the ongoing-load equivalent, safe to run
repeatedly, any time, for a single season, without knowing what's already
loaded:
- `game` rows are upserted every time (scores/lines/weather settle in as
  the week plays out).
- `coach`/`referee` are looked up by name via a SQL subquery
  (`(SELECT coach_id FROM coach WHERE name = ...)`) rather than a
  precomputed id — new coaches/refs just get `INSERT OR IGNORE`'d first.
- `team_game`/`player_game` hub rows are `INSERT OR IGNORE`'d letting
  `INTEGER PRIMARY KEY AUTOINCREMENT` assign the id (confirmed these columns
  really are `AUTOINCREMENT` in the live schema, unlike what the manual
  bulk-load counters assumed they'd need). The category tables are loaded
  right after with `INSERT OR REPLACE INTO ... SELECT tg.team_game_id, ...
  FROM team_game tg WHERE tg.game_id = ? AND tg.team = ?` — looking the
  freshly-assigned id up by its natural key in the same statement, so there's
  no separate round-trip needed to read back what id got assigned.
- `player` dimension rows for anyone new (rookies, etc.) are derived
  directly from the current season's `stats_player_week`/`injuries` CSVs
  (their own name columns), **not** from the old `index.json` (deleted, see
  above) — this was a real gap that had to be solved for this to work going
  forward.
- `injury_report` has no natural unique key (a player can have several daily
  practice-report snapshots in one week), so each insert is guarded with
  `WHERE NOT EXISTS` an identical row already, instead of relying on a
  constraint.

Same `--sql-out` pattern as the other two scripts.

### The actual automation: Cowork scheduled task `edge-rush-weekly-refresh`

Set up via `mcp__scheduled-tasks__create_scheduled_task`, runs every Tuesday
9am, fully self-contained prompt (no memory of this conversation). Each run:
1. Downloads fresh `raw/games.csv` (all seasons) + current-season
   `stats_team_week`/`stats_player_week`/`injuries` CSVs from nflverse.
   Treats a 404/not-yet-published file as expected, not an error (important
   off-season and early in a week before nflverse publishes that week's
   files) — logs it and moves on.
2. Runs `build_incremental_sql.py --season {N} --sql-out ...`, applies the
   SQL via the D1 MCP query tool (not wrangler — a background/scheduled run
   has no local wrangler login).
3. Runs `weekly_update.py --season {N} --sql-out ...`, applies via MCP.
4. Queries pending `picks_log` rows via MCP, runs
   `reconcile_picks.py --pending-json ... --sql-out ...`, applies via MCP.
5. Reports a short summary (rows loaded, predictions upserted, picks
   flagged/reconciled, or "nothing new published yet" if that's what
   happened).

**Caveat worth knowing:** the `stats_player`/`injuries` nflverse release-tag
URLs used in the task's prompt (`.../releases/download/stats_player/
stats_player_week_{season}.csv`, `.../releases/download/injuries/
injuries_{season}.csv`) follow the same pattern as the `schedules`/
`stats_team` URLs already confirmed working, but weren't independently
re-verified this session (the 2026 season hadn't started yet as of this
writing — no `raw/team/stats_team_week_2026.csv` or
`raw/player/stats_player_week_2026.csv` exist locally, so there was nothing
live to test the download against). If a run reports a 404 on either, that's
the first thing to check — the task's prompt already tells it to fall back
to browsing `https://github.com/nflverse/nflverse-data/releases` and note
the mismatch rather than silently failing.

Check/manage this task from the "Scheduled" section of the Cowork sidebar,
or ask Claude to look it up via `mcp__scheduled-tasks__list_scheduled_tasks`.

## Schedule view + per-game detail page

`games.html` was already effectively a schedule view (every game for a
season/week, score, closing lines, ATS/O-U result); this added a model-edge
overlay and a click-through to a new single-game detail page.

- **`GET /model/season/:season`** (new Worker route) -- every `model` row
  for a season, keyed by `game_id`. `page-games.js` fetches this alongside
  the game list and adds a "Model Edge" column (badge highlighted if
  flagged); missing model data for a season/game is normal (not every
  season has been scored) and just shows `-`. Each matchup cell now links to
  `game.html?id={game_id}`.
- **`GET /game/:gameId`** (new Worker route + `game.html`/`page-game.js`) --
  single-game detail: the game row, its `model` prediction if one exists,
  each team's stat totals both "to date" (regular-season games earlier in
  that same season, `game.week < W`) and "full season" (whole season,
  including postseason if applicable), and up to the last 10 head-to-head
  meetings between the two franchises (any season, excludes the game itself).
  Team stat aggregation is a new shared helper, `getTeamAggregate(DB, team,
  season, beforeWeek)` -- same SUM-over-category-tables pattern as
  `getPlayerCareer`, just grouped by `team` instead of `player_id`, with an
  optional `week` cutoff instead of a season range. Verified directly
  against D1 (not through the deployed Worker -- this sandbox can't reach
  `workers.dev` URLs, see the network-restriction note further up) using a
  real game (`2025_05_SF_LA`): to-date/full-season splits and the 10 most
  recent LA/SF meetings all came back correct.
- The stat set shown on the game page is a curated subset (passing/rushing
  yards+TDs+EPA-per-play, turnovers, sacks/INT/TFL on defense, FG/punt
  special-teams, penalties) -- not the full 47/15/49/15-column category
  tables. If more detail is wanted later, `getTeamAggregate` is the one
  place to extend (add columns to whichever category's SUM list) and
  `STAT_ROWS` in `page-game.js` is the one place to add the matching display
  row.
- **Redeploy the Worker** (`wrangler deploy` from `worker/`) to pick up
  these two new routes -- same as any other `worker/src/index.js` change.

**Follow-up UI polish:** `/index` now also returns `team_names` (`{ABBR:
"Full Name"}`, from `team.team_name`). `Util.favoredTeamLine(value, homeAbbr,
awayAbbr)` (new, in `util.js`) labels which team a "positive = home
favored" value (spread_line, model_spread, market_spread, edge, or
closing_line -- all the same convention) actually favors, bookmaker-style
(favorite always shown negative, e.g. `"NE -3.5"` instead of a bare `+3.5`).
This landed everywhere that convention shows up: `games.html`'s Line/Model
Edge columns, `game.html`'s spread/model-prediction display and
head-to-head Line column, and `picks.html`'s Market/Model/Edge/Closing
columns on both the weekly table and the full picks log (CLV was
deliberately left alone -- it's already framed from "the side we picked,"
not a home/away spread). Matchup-style columns (`games.html`, `game.html`'s
title/head-to-head, `picks.html`'s both tables) show full team names via
`team_names`; tight tabular columns (Line, Model Edge, Market/Model/Edge/
Closing, the game page's team-comparison table headers) stay abbreviated on
purpose -- explicit user preference, not a general "always spell out teams"
rule.

**Bug fix: "every game looked like an away game."** `teams.html` (team
weekly log) and `players.html` (player weekly log) both hardcoded `@{opponent}`
on every row, regardless of whether the team/player was actually home or
away that week -- there was no home/away signal in the data being returned
at all. Fixed by adding `CASE WHEN team = g.home_team THEN 1 ELSE 0 END AS
is_home` to the hub queries in `getTeamsSeason`/`getPlayersSeason`
(`worker/src/index.js`), and both pages now render `vs {full name}` for
home games, `@ {full name}` for away games. Verified directly against D1
with KC's actual 2025 schedule (alternates correctly: LAC@KC away, PHI home,
NYG away, BAL home, ...). `teams.html`'s team-select dropdown also now
shows full names instead of abbreviations, same reasoning.

## Useful file map

- `scripts/build_d1_sql.py` — regenerates all the `d1/sql/*.sql` files from
  `raw/*.csv` + `index.json`. Idempotent, re-run any time the source CSVs
  change or the SQL needs regenerating. Column mappings for every table are
  hardcoded at the top (`TEAM_OFFENSE_COLS`, `DEFENSE_COLS`, etc.) — note
  `team_game_offense` has 5 columns (`pacr`, `racr`, `target_share`,
  `air_yards_share`, `wopr`) that don't exist in the team-level source CSV and
  are always NULL there; those 5 only have real values in
  `player_game_offense`. Not a bug, just an unused-column quirk from copying
  the player column list when designing the schema. RAW/OUT/INDEX_JSON paths
  at the top default to relative (`raw`, `d1/sql`, `index.json`); point them at
  a `/tmp` staging copy for speed if regenerating (this mount is slow — see
  below).
- `d1/sql/` — generated `.sql` files: `00_player`, `01_game`,
  `10a_team_game_hub_*` / `10b_team_game_cat_*`,
  `20a_player_game_hub_*` / `20b_player_game_cat_*`, `30_injury_*`.
- `d1/import.ps1` — the load script; keeps `d1/imported.log` (leaf filenames
  already successfully loaded) so re-runs skip everything already done
  instead of re-uploading all 181+ files every time. **If you ever manually
  delete/fix already-loaded D1 data, remove the matching line(s) from
  `imported.log` too**, or a re-run will silently skip reloading it.
  `d1/D1_IMPORT_README.md` has more detail, reflects the hub/category split.
- `worker/` — the Cloudflare Worker serving the entire site from D1
  (`src/index.js`, `wrangler.toml`, deploy steps in `README.md`) — games,
  teams, players, compare, model, and picks routes all live here now.
- `site/` — the live static site. Every page (`games.html`/`teams.html`/
  `players.html`/`compare.html`/`index.html`/`picks.html`/`game.html`) now
  reads through the Worker (once `API_BASE` is set post-deploy) — there's no
  static `data/*.json` tree anymore. `game.html`/`page-game.js` is the
  single-game detail view linked from `games.html`'s schedule table.
- `scripts/build_d1_sql.py` — the one-time historical bulk-load tool (see
  above). Don't use this for ongoing weekly loads — see
  `build_incremental_sql.py` instead.
- `scripts/build_incremental_sql.py` — ongoing loader: safely adds a single
  season's new/changed `game`/`team_game`/`player_game`/`injury_report` rows
  (and any new `player`/`coach`/`referee` dimension rows) without touching
  historical seasons. What the scheduled task runs weekly.
- `scripts/weekly_update.py` / `scripts/reconcile_picks.py` — Phase 2/3
  scripts, now read/write D1's `model`/`picks_log` tables instead of JSON/CSV
  files. Both support `--sql-out` (and `reconcile_picks.py` also
  `--pending-json`) so they can run without wrangler, from the scheduled task.
- `backtest/phase1_results.md` — full model history/results, including the v3
  passer-rating negative finding.

## Other things worth knowing

- The `raw/player/stats_player_week_*.csv` files (145 cols, all positions) are
  the current nflverse source; the old offense-only `player_stats` release is
  deprecated. `raw/team/stats_team_week_*.csv` (133 cols) is the team-level
  equivalent. `raw/games.csv` and `raw/injuries/injuries_{2009-2025}.csv` round
  out the raw data.
- This mount (`edge-rush` folder) is slow for many-small-file writes and can
  silently truncate large files if copied in parallel, AND the `/tmp` sandbox
  scratch space can occasionally get wiped between bash calls (happened once
  this session, lost a staged raw/ copy + generated SQL mid-task) — always
  stage heavy work in `/tmp` first, copy to the mount sequentially, and verify
  byte size after each copy (`stat -c%s` both sides) before trusting it. If
  `/tmp` files vanish unexpectedly, just re-stage from the mount and resume.
- `pd.read_csv(f, engine="pyarrow")` is dramatically faster than the default
  engine on these wide CSVs — use it for anything touching the player/team stat
  files.
- Direct D1 queries via the MCP tool are instant and a great debugging tool —
  don't hesitate to test a suspect INSERT statement directly there before
  assuming a bug is in the generation script.

## Stadium name fix, roof/dome indicator, and weather forecast scaffolding

- Fixed 18 stale rows in the `stadium` dimension table (e.g. `PSINet Stadium`
  → `M&T Bank Stadium`, `Heinz Field` → `Acrisure Stadium`) so `stadium_name`
  reflects nflverse's own current naming per its 2025-season `raw/games.csv`
  rows. Deliberately did NOT try to reconstruct era-correct historical names
  per game (e.g. showing "PSINet Stadium" for 1999 Ravens games) — that data
  exists in `raw/games.csv`'s trailing `stadium` column but reconstructing
  ~7,500 rows' worth of rename-transition dates needs bulk CSV processing
  (pandas), which the bash sandbox couldn't do this session. Jeff said he
  didn't think it mattered much anyway, so this was dropped in favor of a
  roof/dome indicator instead (see below).
  - One caveat worth remembering: nflverse's own schedule data can lag real
    -world sponsor renames — its 2025 rows still say "New Era Field" for
    Buffalo, not "Highmark Stadium." We load whatever nflverse's data says
    (project's stated source of truth), not our own outside knowledge of the
    "actual" current name.
- Added `stadium.latitude` / `stadium.longitude` (REAL columns), populated
  for all 30 stadium_ids used by the 2026 schedule. Values are well-known,
  stable geographic facts (not sourced per-row from nflverse), good enough
  precision for a weather API call.
- Added `Util.roofLabel(roof, stadiumId)` in `util.js`: turns `game.roof`
  ("dome"/"outdoors"/"closed"/"open"/null) into a friendly label. The 5
  retractable-roof stadiums (`ATL97`, `DAL00`, `HOU00`, `IND00`, `PHO00`)
  legitimately have `roof = NULL` for future games until the game-day
  decision is made — `roofLabel` shows "Retractable (TBD)" for those instead
  of treating it as missing data. Wired into a new "Roof" column on
  `games.html` and into the "Conditions" card on `game.html`.
- **Weather forecast pipeline (Task #26 infra done, no data yet — see
  below):**
  - New table `weather_forecast (game_id PK, forecast_temp, forecast_wind,
    forecast_precip_prob, fetched_at, source)`. One row per game, overwritten
    in place as forecasts get refreshed (unlike `picks_log`, there's no
    "frozen prediction to grade" concept here — once `game.temp`/`game.wind`
    exist post-game, the forecast is just superseded, not compared against).
  - Worker: `getGamesSeason` and `getGameDetail` now `LEFT JOIN
    weather_forecast` and return `forecast_temp` / `forecast_wind` /
    `forecast_precip_prob` / `forecast_fetched_at` alongside the game row. No
    new routes needed. **Worker needs redeploying** for this to take effect.
  - Site: `Util.forecastLabel(g)` renders e.g. "72°F, 8mph, 20% rain"; shown
    in a new "Forecast" column on `games.html` and folded into game.html's
    Conditions card (only shown once `game.temp` is null, i.e. pre-game).
  - Data source: Open-Meteo (`api.open-meteo.com/v1/forecast`), free, no API
    key. **Note:** plain `mcp__workspace__web_fetch` returns empty output for
    this JSON API in this environment (also failed on the nflverse
    draft_picks CSV download — seems to be a non-HTML-content issue with
    that tool here) — use the Claude-in-Chrome browser tools
    (`navigate` + `get_page_text`) instead, confirmed working.
  - A daily scheduled task, `nfl-weather-forecast-refresh` (8:06am local,
    self-contained prompt in `C:\Users\jeffr\Claude\Scheduled\
    nfl-weather-forecast-refresh\SKILL.md`), checks for REG games in the
    next 14 days at non-dome stadiums lacking a fresh forecast and
    upserts one via Open-Meteo. Most days it'll no-op — forecasts are only
    meaningful ~10-16 days out, and as of 2026-08-03 the earliest 2026 game
    is 2026-09-09 (no PRE-season games loaded in D1 for 2026), so this task
    won't actually populate anything until roughly the last week of August.
    That's expected, not a bug.

## Coaching tenure — preliminary sniff test, NOT yet a model feature (Task #27)

- Added a D1 view `coach_tenure(game_id, team, coach_id,
  tenure_games_before)` — for every team-game, how many prior games that
  exact coach has coached that exact team (0 = first game with the team).
  Computed with a SQL window function (`ROW_NUMBER() OVER (PARTITION BY
  team, coach_id ORDER BY season, week)`), works for future 2026 games too
  since `home_coach_id`/`away_coach_id` are already populated.
- Ran a quick, honest sniff test bucketing REG-season games by
  (home coach tenure − away coach tenure) and comparing average RAW home
  scoring margin vs. average margin AGAINST THE CLOSING SPREAD (ATS):
  raw margin trends cleanly with tenure gap (-0.88 → +5.21 pts across the 5
  buckets from "away much more tenured" to "home much more tenured"), but
  the ATS margin does NOT show a clean trend (-0.50, +0.54, -0.41, +0.14,
  +0.47) — i.e. the market already seems to price in what tenure is a proxy
  for, so a coach's own tenure may not add much edge-finding power on top of
  the market line, at least not as a lone univariate signal.
- This is NOT a substitute for the real Phase 1 backtest methodology
  (walk-forward regression refit with the feature added, checking
  calibration/hit-rate) — that requires running `scripts/backtest_v3.py` or
  similar, which needs the bash sandbox (down all session) for numpy/pandas.
  Do not wire `tenure_games_before` into `weekly_update.py`'s live
  predictions without running that backtest first; the sniff test above is
  a reason for lowered enthusiasm, not a final verdict (a multivariate
  regression could still find something the naive bucket split misses).

## Leaders page (players + teams, any season range)

- New Worker routes: `/leaders/catalog` (available categories), `/leaders/players?stat=&from=&to=&position=&limit=`,
  `/leaders/teams?stat=&from=&to=&limit=`. Two whitelists (`PLAYER_STAT_CATALOG`,
  `TEAM_STAT_CATALOG` in `worker/src/index.js`) map a stat id to a table +
  column -- table/column names only ever come from these server-side
  constants, never interpolated from the request, even though the SQL is
  built dynamically per catalog entry (no injection surface). "Points
  Scored" (team scope) is special-cased since it comes from `game.home_score`
  /`away_score`, not a `team_game_*` column.
- Tried a "player's most recent career position" lookup for the position
  column first (correlated subquery per player) -- added ~1.5s per query.
  Switched to `MAX(pg.position_code)` over just the games in the selected
  range instead: same display value in the overwhelming common case (players
  essentially never change position mid-range) and no perf hit. Unfiltered,
  full-history leaderboard queries (e.g. rushing yards, no position filter,
  1999-2025) still take ~1.4-1.6s regardless -- that's just the actual data
  volume (~1.8M rows read across the joins for a 26-season scan), not a
  fixable inefficiency. Same ballpark as `/index`'s known-slow response;
  the 5-minute Cache-Control on Worker responses absorbs repeat hits.
- New page `leaders.html` + `page-leaders.js`: scope toggle (players/teams),
  category dropdown (sourced from `/leaders/catalog`, not hardcoded, so
  adding a catalog entry server-side is enough), from/to season selects, and
  for player categories with a natural position hint (e.g. QB for passing
  yards, K for FG made) a "Only QBs" checkbox that's on by default but can
  be unchecked to see the stat across all positions.
- **Deliberately not in the main nav or footer** -- linked instead from
  `players.html` ("See stat leaders &rarr;", `?scope=players`) and
  `teams.html` ("See team leaders &rarr;", `?scope=teams`), same
  discoverable-but-not-top-level treatment as the Compare page. This was an
  explicit choice from a multiple-choice question, not a default.

## Player breakdown under each team-stats weekly-log row

- teams.html's weekly log shows team-level totals per game (Pass Yds, Rush
  Yds, etc.) but not who actually produced them. Added a "Players ▸" toggle
  as the last column of each row -- clicking it expands a nested row showing
  every player on that team who had an offensive touch in that specific game
  (passing/rushing/receiving lines), so the team total is traceable back to
  the players behind it. Click again to collapse.
- New Worker route: `GET /game/:gameId/players/:team` (`getGameTeamPlayers`)
  -- single-game, single-team query joining `player_game` + `player` +
  `player_game_offense`, filtered to `attempts > 0 OR carries > 0 OR
  targets > 0` so defense/special-teams-only players (who still have a
  `player_game` row for the game) don't clutter the list. ~20-55ms against
  D1 -- this is a single-game lookup, nothing like the multi-season leaderboard
  scans.
  Doesn't need `scope` filtering -- a single `game_id` is inherently either
  regular season or playoffs already, there's nothing to toggle.
- `data.js`: `getGamePlayers(gameId, team)`.
- `page-teams.js`: each weekly-log row renders a paired hidden `<tr
  class="expand-row">` under it; the toggle button fetches lazily (only on
  first expand) and caches by `${gameId}:${team}` so re-toggling doesn't
  re-fetch. Player names link to players.html.
- New CSS: `.expand-toggle` (link-styled button), `tr.expand-row td`
  (slightly elevated background so the nested table reads as "inside" the
  row it belongs to), `.subtable` (tighter padding, static header -- so it
  doesn't inherit the outer table's sticky-header behavior).

## Responsive hamburger nav + leaders.html fixes

- **Hamburger nav for narrow screens.** The header nav (`components.js`
  `SiteHeader`) was just `flex-wrap`, so on a phone the six links wrapped
  into two or three cluttered rows under the logo. Kept the horizontal bar
  exactly as-is on desktop (that pattern's fine, it wasn't the problem) and
  only below 768px it now collapses behind a hamburger button that toggles
  `.site-header__nav`'s `.is-open` class (plain CSS `display: none` /
  `flex`, no JS framework). The three bars morph into an X via
  `aria-expanded` + CSS transforms rather than swapping icons. Pure
  front-end, no Worker involvement.
- **Team-leaders "Players" toggle looked missing.** Root cause: switching
  the Leaders scope to "Teams" defaults the stat dropdown to whatever's
  first in `TEAM_STAT_CATALOG`, which is Points Scored -- the one stat with
  no player breakdown (see the earlier section on this feature). The toggle
  cell was rendering as a bare empty `<td>` for that case, which reads as
  "the feature's broken" rather than "not applicable here." Now renders a
  faint "–" with a `title` tooltip explaining why.
- **Leaders defaults to the current season, not full history.** Landing on
  26 years of combined totals wasn't a useful first view. From/To now both
  default to the most recent season in `index.seasons.games` (same "current
  season" concept as the games.html season default) unless the URL says
  otherwise. Full history is still one click away via the existing "Career"
  checkbox.
- **Investigated but could not reproduce:** a report that the teams.html
  player breakdown shows the opponent's roster instead of the selected
  team's. Tested live (KC week 1 vs LAC, PHI week 2 @ KC, and the page's
  bare default load) via browser automation -- all three showed the
  correct team's players with stats matching the row's totals exactly. No
  swap found in `getGameTeamPlayers`'s SQL, the route's param order, or
  `page-teams.js`'s `toggleExpand`. Left as-is pending a reproducible
  example (specific team/season/week) since nothing here should be changed
  blind.

## games.html week dropdown defaults to the current week

- New `Util.currentWeek(games)`: first week whose games haven't all been
  played yet (by `gameday`, "YYYY-MM-DD" string compare against today in
  UTC), else the season's last week if every game's already happened.
  Handles the pre-season case correctly -- once next year's schedule rows
  exist (`gameday`s all in the future), week 1 is the first "not fully
  played" week, so it's picked automatically without a special case.
- `page-games.js` only applies this on the page's bare first load (no
  `season`/`week` in the URL at all) -- see `defaultToCurrentWeek` param on
  `loadSeasonGames`. Manually switching seasons afterward still resets to
  "All weeks," since pinning a past season you're intentionally browsing to
  whatever week happens to be "current" today isn't useful.
- Pure front-end change, no Worker involvement -- just push `site/`.

## Rebrand: "NFL Model" -> "Edge Rush"

- Renamed everywhere it was user-visible: the header brand (`components.js`
  `SiteHeader`, now `Edge<span>Rush</span>`) and every page's `<title>`
  (`Edge Rush &mdash; {page}`).
- Added `site/assets/favicon.svg` -- a simple double-chevron mark in the
  site's existing accent green (`#4fd1a5`) on the dark background color
  (`#0f1720`), reusing the design tokens already in `style.css` rather than
  inventing new colors. Linked via `<link rel="icon" type="image/svg+xml"
  href="assets/favicon.svg">` in every page's `<head>`, and reused as the
  small mark next to the brand text in the header itself so the tab icon
  and the in-page logo match.
- Pure front-end change (new static asset + HTML/CSS/JS edits only, no
  Worker routes touched) -- just push `site/`, no `wrangler deploy` needed.

## Player breakdown under each team-leaders row

- Same idea as the teams.html player breakdown above, applied to team
  leaderboard rows: click "Players ▸" on a team row in leaders.html
  (teams scope) to see which players on that team contributed to the
  summed stat total over the currently selected year range and season
  type. Same fairness scope (reg/post/all) as the row it's expanding.
- Reuses the insight that every `team_game_*` category table has an
  identically-columned `player_game_*` counterpart -- `TEAM_TO_PLAYER_TABLE`
  maps `team_game_offense/defense/misc` to their player equivalents, so
  `getTeamStatPlayers(DB, team, statId, from, to, scope, limit)` just
  reuses the `TEAM_STAT_CATALOG` entry's `(table, column)` with the table
  name swapped, filtered to one team. New route: `GET
  /leaders/teams/:team/players?stat=&from=&to=&scope=&limit=`.
  Single-team scope keeps it fast even over the full 1999-2025 range
  (~150ms directly against D1, vs. ~1.4-1.6s for the unscoped
  league-wide leaderboard queries).
- `points_scored` is excluded -- it's a special-cased UNION query on
  `game.home_score`/`away_score` with no single player-table column
  behind it (scoring mixes TDs across positions plus kicking), so there's
  no honest per-player decomposition. The Worker returns 404 for it and
  `page-leaders.js` just doesn't render the toggle for that stat.
- `data.js`: `getTeamStatPlayers({ team, stat, from, to, scope, limit })`.
- `page-leaders.js`: mirrors the teams.html pattern -- paired hidden
  `<tr class="expand-row">` under each team row, lazy-fetched and cached
  by `${team}:${stat}:${from}-${to}:${scope}` on first expand.

## Regular season vs. playoffs: fairness fix across Leaders, Career, and Compare

- The fairness problem: player/team season and career totals were silently
  mixing in playoff games. That's not an apples-to-apples comparison -- a
  player whose team goes on a deep playoff run gets more games (and more
  counting stats) than an equally good player whose team misses the
  playoffs entirely. Confirmed via a multiple-choice question that this
  should be fixed everywhere totals get summed and compared: Leaders,
  the player Career-totals card, and Compare -- not just the newest feature.
- New shared Worker concept: `scope` = `"reg"` (default, regular season
  only), `"post"` (playoffs only, `game_type_code != 'REG'`), or `"all"`
  (both combined). Two helpers, `normalizeScope(raw)` and
  `scopeClause(scope, alias)`, generate the right `AND {alias}.game_type_code
  ...` SQL fragment (or none, for "all") -- used by `getPlayerLeaders`,
  `getTeamLeaders` (including the `points_scored` special case), and
  `getPlayerCareer`.
- **`getPlayerCareer` was rewritten** to stop using the `v_player_season_*`
  views for its offense/defense/special_teams subqueries -- those views
  pre-aggregate REG+playoffs together with no way to split them back apart,
  so they couldn't support `scope` at all. Now does the same direct
  join+SUM against the category tables that `misc` (and `getTeamAggregate`)
  already did. Verified correctness directly against D1 before shipping:
  Tom Brady's REG passing yards (89,216) + playoff passing yards (13,400)
  = 102,616, exactly matching the "all" total. Performance is fine --
  these are single-player queries (indexed on `player_id`), nothing like
  the ~1.5s full-history leaderboard scans.
- All three routes default to `scope=reg` when the param is omitted, so
  any old cached URL or stale bookmark just gets the fair (regular-season
  -only) behavior for free.
- UI: a "Season type" dropdown (Regular season only / Playoffs only /
  Regular season + playoffs) on `leaders.html`, `compare.html`, and a new
  one on `players.html` scoped to just the Career-totals card (the weekly
  log table is unaffected either way -- it already shows individual games
  with their own round label per row, nothing to "total" unfairly there).
  `getPlayerCareer` returns `null` when a scope has zero qualifying games
  (e.g. "Playoffs only" for a player who never made the playoffs) -- all
  three pages show an empty-state message for that case instead of crashing.

## "Career" option on the Leaders page, and the pre-1999 data wall

- Confirmed via search (not just memory): nflverse's own player-stats
  pipeline -- what this entire project is built on -- does not go back
  before 1999, period. No pre-1999 weekly/seasonal player stats exist
  anywhere in the nflverse ecosystem.
- `raw/draft_picks.csv` (already downloaded, see the draft-capital section
  above) does carry PFR-sourced **career totals** (not per-game) for every
  player drafted since 1980 -- games, completions/attempts, pass yards/TD
  /INT, rush yards/TD, receptions/rec yards/TD, tackles, INTs, sacks. This
  was raised as a possible way to approximate pre-1999 career stats (career
  total minus our known 1999+ total = the missing pre-1999 portion) but
  explicitly NOT pursued: only covers drafted players since 1980 (misses
  undrafted players and 1970s-and-earlier careers entirely), no advanced
  metrics, and loading/reconciling the full ~13k-row file by hand (bash
  still down) for an approximate result wasn't worth it. Revisit if the
  sandbox comes back and it seems worth it later -- the file is already in
  `raw/`.
- What shipped instead: a "Career (1999&ndash;present)" checkbox on
  `leaders.html` next to the season selects. Checking it just sets
  from/to to the full available range and disables the two selects (no new
  data, no reconciliation) -- clearly labeled "1999-present" so it's never
  implied to be more complete than it is. `page-leaders.js`:
  `applyCareerRange()` + a `career=1` URL param to persist/restore it.

## Player stat picks were curated, not exhaustive -- added QB efficiency stats

- `site/assets/js/player-stats.js` (`CAREER_STAT_GROUPS`, `WEEK_COLUMNS`)
  was a deliberate, hand-picked subset per position group (headline
  counting stats + EPA + one efficiency metric) to keep the stat-card grid
  and weekly-log table scannable, not a dump of every column nflverse
  provides. Completions/attempts were only ever shown combined ("Cmp/Att")
  in the weekly log table, not on the career card, and Yds/Att wasn't shown
  anywhere -- a real gap, not intentional.
- Added to `CAREER_STAT_GROUPS.QB`: separate `Attempts`/`Completions` cards,
  computed `Cmp %`, computed `Yds/Att`. Added `Y/A` column to
  `QB_WEEK_COLUMNS`. All derived from `completions`/`attempts`/
  `passing_yards`, already present in the API response (same fields
  `passerRating()` already consumed) -- no Worker or data changes needed,
  pure front-end. No redeploy required, just push the site.

## Situational trends page + big-home-dog signal

- New Worker route `/trends` (`getTrends` in `worker/src/index.js`): three
  SQL blocks over the full 1999-present `game` table, no new tables needed --
  home underdogs bucketed by size (spread_line < -3, -3..-7, -7+), rest
  advantage (home_rest - away_rest, 5 buckets), and divisional vs.
  non-divisional (ATS + total O/U). **Needs a Worker redeploy** to go live.
- New site page `trends.html` + `page-trends.js`, linked from nav/footer
  (`components.js`). Straight tables, no charting.
- Findings (full history, informs the "worth building" question below):
  - Home dogs overall are a coin flip (50.5% cover, 2,514 games). But split
    by size: dogs getting <3 or 3-7 points cover ~49%, dogs getting 7+
    points cover **55.8%** (n=521) — a real, sizable-sample edge above the
    ~52.4% breakeven line at standard -110 odds. This is the well-known
    "big home dog" betting angle and it holds up in this data.
  - Rest advantage showed no clean trend either direction (46.8%-49.8%
    home cover % across all 5 buckets, not monotonic) — weaker than
    expected, worth remembering before assuming "extra rest = edge."
  - Divisional games: home teams cover less (47.6% vs 49.9% non-divisional)
    and total tends slightly under (avg O/U margin +0.17 vs +1.02) —
    consistent with the "familiar divisional opponents play tighter, lower
    -scoring games" narrative.
- Added Task "Evaluate big-home-dog flag as a model feature" — this sniff
  test is actually stronger evidence than either the coaching-tenure or
  draft-capital ones from earlier in the project (bigger, cleaner, more
  games). Still needs the same walk-forward backtest before going into
  `weekly_update.py` — same bash blocker as those two.

## Playoff-round week labels (games.html)

- `game_type_code` already encodes the round for weeks 19-22 (`WC`, `DIV`,
  `CON`, `SB` -- confirmed via `SELECT game_type_code, min(week), max(week)
  FROM game WHERE season=2024 GROUP BY game_type_code`, one round per week
  number, no new data needed). `page-games.js`'s week dropdown now shows
  "Wild Card" / "Divisional" / "Conference Championship" / "Super Bowl"
  instead of "Week 19"-"Week 22" (`weekLabel()` looks up any game in that
  week and maps its `game_type` through `PLAYOFF_ROUND_LABELS`). Regular
  season weeks are unaffected ("Week 1".."Week 18").

## Draft capital feature — still blocked (Task #28)

- Confirmed the correct source URL:
  `https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv`
  (also available as `.rds`/`.parquet`, same path pattern). This is a real,
  working release asset — the earlier failed guesses were wrong paths, this
  one is right per `nflreadr`'s own source (`R/load_draft_picks.R`).
- Still can't ingest it in this environment: `mcp__workspace__web_fetch`
  returns empty on the direct download link, and navigating to it in Chrome
  triggers a browser file *download* rather than rendering the CSV as text
  (unlike a plain JSON API, which Chrome renders fine) — so there's no way
  to read the bytes without the bash sandbox (which was down the entire
  session) to `curl`/`pandas.read_csv` it directly. Next session: check bash
  first: if it's up, `curl -L <url> -o draft_picks.csv` should just work.
- Update: Jeff manually downloaded it to `raw/draft_picks.csv` (readable as
  plain text — 12,927 picks, 1980-2025, 35 columns). Bash was still down, so
  a full pick-value-weighted, multi-year aggregation (proper job for
  pandas) wasn't feasible by hand. Built a coarse stopgap instead: table
  `draft_capital_recent(team, picks_rounds123_2022_2025)` — count of each
  team's round 1-3 picks over the last 4 drafts, gathered via 32 targeted
  `Grep -c` calls directly against the CSV (reliable exact counts, not
  hand-transcribed — verified the 32 counts sum to 409, matching the
  expected ~102 picks/round1-3 x 4 years). Sniff-tested against 2025 REG
  season ATS margin, bucketed by (home capital − away capital): showed NO
  usable trend (0.27, -0.21, 0.55, 2.03, -1.23 across the 5 buckets, not
  monotonic) — but this is inconclusive, not a negative result: one season
  (~272 games) is too small a sample and pick-count is a much cruder proxy
  than a real pick-value curve. Contrast with the coaching-tenure sniff test
  above, which had ~27 seasons of data and showed a real pattern either way.
  **Don't read anything into this result** — it just means the coarse
  version isn't informative, not that draft capital doesn't matter. Redo
  properly once bash is back: load the full `raw/draft_picks.csv` into a
  `draft_pick(season, round, pick, team)` table (team abbreviation mapping
  needed: GNB→GB, KAN→KC, NOR→NO, SFO→SF, TAM→TB, SDG→SD, NWE→NE, LAR→LA,
  LVR→LV, OAK stays OAK), apply a real pick-value curve (e.g. `3000/pick` or
  a proper draft trade chart), sum a trailing-N-year window per team per
  season, and backtest across many seasons the way the coaching-tenure
  bucket test did.
