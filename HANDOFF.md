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

As of the last check this session: `game=7548` (done), `player=11366` (done),
`team_game=14530` (done, 1 short of 14531 as expected, see bug #4),
`player_game=475564` (done), `player_game_offense`/`defense`/`special_teams`/
`misc` all at `475564` (done and content-verified, both the 2010-2025 reload
after bug #7's cleanup and the pre-existing 1999-2009 data), `injury_report=0`
(not loaded yet — regenerated with bug #8's fix, ready to load, expect 90,346
once done). **Eight bugs found and fixed so far** (semicolons, file-ordering,
JAC/JAX, null-team orphan rows, placeholder player_ids in player_game,
unquoted inf, a serious silent id-shift corruption across 16 seasons of
category data, and the same placeholder-player_id issue in injury_report —
all detailed below, bug #7 especially worth reading before touching this data
again). `d1/import.ps1` has a persistent skip-log (`d1/imported.log`) so
re-runs don't re-upload already-loaded files. **Next action: tell the user to
run `.\import.ps1` again** — it'll resume at `30_injury_2009.sql` (everything
before that is already logged as done) and should run all the way through
this time. If it hits yet another error, ask the user to paste it and
diagnose with the method below — and given bug #7, don't assume a clean exit
code means the data is actually correct; spot-check content occasionally, not
just row counts.

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

**Next action — tell the user to deploy the Worker:**
```powershell
cd C:\Users\jeffr\Documents\edge-rush\worker
wrangler deploy
```
Then paste the printed `https://edge-rush-api.<subdomain>.workers.dev` URL
into the `API_BASE` constant near the top of `site/assets/js/data.js`
(currently `https://edge-rush-api.YOUR-SUBDOMAIN.workers.dev`), commit/push
for GitHub Pages, and spot-check `games.html`/`teams.html`/`players.html`/
`compare.html` load correctly. `worker/README.md` has a few sanity-check URLs
to hit directly first. If any page errors, check the browser console for a
CORS or 404 error first — likely just `API_BASE` not updated yet, or a route
typo.

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
- `worker/` — the new Cloudflare Worker serving games/teams/players/compare
  from D1 (`src/index.js`, `wrangler.toml`, deploy steps in `README.md`).
- `site/` — the live static site. `games.html`/`teams.html`/`players.html`/
  `compare.html` now read from the Worker (once `API_BASE` is set post-deploy);
  `index.html`/`picks.html` still read `data/*.json` directly (model/picks
  data, not in D1 — see above).
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
