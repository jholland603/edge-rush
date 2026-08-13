# Open threads / decisions log

Running notes so nothing gets lost between sessions. Not a deliverable, just a scratchpad.

## Team News card on game.html -- live, not from D1 (built 2026-08-12)
- After getting the team_news D1 table/daily job working (see below), Jeff paused before
  building the actual display card and asked to talk through skipping D1 for the display
  entirely -- fetch live at request time instead. Reasoning: D1 ties the card's freshness to
  a once-a-day cron job that already proved fragile earlier this same session (curl/ESPN
  failures upstream of it killed the whole run more than once), and he's the only user right
  now so per-pageview live requests aren't a real traffic/rate-limit concern.
- Decided: live fetch, cached at the Cloudflare edge (Cache API via `caches.default`, no new
  KV/D1 binding needed) for 30 minutes. The `team_news` D1 table and its daily job are left
  running exactly as before -- not read by this page anymore, kept as a fallback Jeff can
  switch back to if the live approach turns out too slow, and as a running archive either way.
- **Worker (`worker/src/index.js`)**: new `getTeamNewsLive(teamAbbr)` -- builds a
  `"<Team Name>" NFL when:1d` Google News RSS query (same query shape as
  `fetch_team_news.py`), fetches it directly (this Worker has no bundler/npm deps, so XML is
  parsed with a small regex-based `parseGoogleNewsRss()` instead of a real parser -- handles
  CDATA-wrapped titles and HTML entities, unit-tested against mocked RSS with both). Wired
  into `getGameDetail`'s existing `Promise.all` as `team_news: { away, home }`. Never throws --
  a failed fetch just yields an empty list for that team, same "log and skip" pattern as the
  rest of this Worker.
- **Site (`site/assets/js/page-game.js`)**: new "Team News" signal card, headlines as links
  (source name shown alongside, opens in a new tab), placed right after the Injury Report
  card. Status tag `"none"` -- purely informational, not a signal claim.
- Verified: `node --check` on both changed files (syntax), and the RSS parsing logic
  specifically unit-tested in isolation against mocked Google News XML (CDATA titles, an
  HTML-entity-escaped title, and a missing `<source>` tag falling back to parsing it out of
  the title suffix) -- all passed. Could not test the live Worker fetch/cache path itself from
  this sandbox (no way to run a Workers runtime here) -- needs a real `wrangler deploy` +
  page load from Jeff to confirm end-to-end.
- **Deployed and confirmed working** (2026-08-12, same day): checked the raw `/game/:gameId`
  response directly and got 8 real, current headlines for LAC with today's date -- the
  live fetch/cache/parse pipeline is genuinely working end to end. ARI came back empty on
  that same check, which is expected/normal (Google's `when:1d` window is narrow and news
  volume varies team to team day to day), not a bug.
- **Follow-up, same session:** Jeff didn't like it buried as one more small card inside the
  Situational Signals grid (15+ other cards) -- moved it out into its own top-level
  `<details class="page-section">` ("Team news"), placed right after the model summary and
  above Team Comparison so it's one of the first things on the page, not buried. Two side-by-
  side `.card`s (away/home), reusing the same `.card`/`.card-grid` pattern `renderSummary`'s
  stat cards already use, rather than the small `.signal-card` layout. `getTeamNewsLive()` /
  the Worker response shape didn't change, just where and how the site renders it.
- Re-push the site's static files (`site/game.html`, `site/assets/js/page-game.js`) --
  confirmed working, new standalone section renders correctly.
- **Bug found right after, same session:** Jeff checked two different SEA/ARI game pages and
  both showed "No recent headlines" for BOTH teams. Direct API checks on both game_ids
  confirmed it -- `team_news: {away: [], home: []}` on both. Root cause: the Cache API key is
  per-TEAM, not per-game (deliberate -- every game page for a team should share one fetch), but
  that also means a single bad fetch (Google intermittently blocking/rate-limiting Cloudflare's
  Worker IPs seems likely, though not confirmed -- the very first test earlier this session got
  8 real headlines for LAC, so it's not a hard block, just inconsistent) got cached as "no news"
  for the full 30 minutes and showed up empty on every game page for that team during that
  window. Two different teams (SEA and ARI) both empty at once, on two different game pages, is
  the tell -- too coincidental for both to genuinely have zero news at that exact moment.
- **Fix:** split the cache TTL -- a real (non-empty) result still caches for the full
  `TEAM_NEWS_CACHE_SECONDS` (30 min), but an empty result now only caches for
  `TEAM_NEWS_EMPTY_CACHE_SECONDS` (3 min), since an empty result can't be trusted the same way
  (genuinely no news vs. this one fetch got blocked -- no way to tell from here). A transient
  failure now clears itself in a few minutes instead of looking stuck for half an hour.
- **Widened the same session, Jeff's call:** confirmed the empty state was partly just
  `when:1d` (Google News's own ~24h window) legitimately having nothing for quieter teams --
  not only the caching bug above. Widened to `when:3d` in `getTeamNewsLive()` -- trades a
  little strict freshness for "usually has something to show," still excludes genuinely stale
  stories. Site's note text under the card updated to match ("roughly last 3 days").
- **Root cause found, same session:** added a temporary `/debug/team-news/:team` route
  (bypassed cache, returned raw HTTP status + response snippet). Hit it for ARI: HTTP 503,
  body was Google's actual bot-block page ("Sorry... but your computer or network may be
  sending automated queries"). Confirmed: Google is blocking Cloudflare Workers' shared IP
  range as automated traffic. Not transient, not fixable with retries/wider windows/better
  caching -- structural. The one early LAC success was luck before/between blocks, not the norm.
- **Reverted to D1, same session (Jeff's call once the real cause was clear):** the daily
  GitHub-Actions-based fetch (`scripts/fetch_team_news.py`) doesn't hit this wall -- different
  IP pool, far fewer requests (32/day vs. once per page load). Switched `getGameDetail` back
  to reading `team_news` from D1 (`getTeamNewsFromD1()`), same shape as before
  (`{away: [...], home: [...]}`, mapped `headline`->`title` so the site JS didn't need to
  change beyond copy). Deleted all the now-dead live-fetch machinery: `getTeamNewsLive()`,
  `parseGoogleNewsRss()` + its XML helpers, `TEAM_ABBR_TO_NAME`, the Cache-API TTL constants,
  and the temporary debug route -- confirmed via grep nothing still references them.
  Net result: this ended up exactly where the very first version (before Jeff asked to try
  live-without-D1) already was, just now with hard evidence for why D1 is the right call
  instead of an assumption either way.
- **Site note text updated** to say "Refreshed daily via Google News RSS -- as of the last
  scheduled run, not real-time" instead of the live/edge-cached framing.
- **Not yet done (needs Jeff):** `wrangler deploy` from `worker/` (changed again -- this is
  the real, final version) + push the site JS. Then confirm headlines actually show up now --
  they're reading straight from the `team_news` table that's already been populated daily
  since earlier this session, so this should just work without depending on Google tolerating
  the request at page-load time anymore.

## Team news pre-kickoff refresh added (2026-08-12, same session)
- Jeff's ask: refresh team news right before each kickoff window too, not just once a day --
  roughly 8pm Thu, 12/3/8pm Sun, 8pm Mon.
- Rather than add a second, slightly-offset set of cron entries just for this, reused the
  pre-kickoff triggers `odds-snapshot.yml` already fires for odds/model (~1hr before kickoff:
  7pm ET Thu/Mon, 12/3/7pm ET Sun -- 1 hour off from Jeff's stated times, close enough to the
  same intent that a second near-duplicate schedule wasn't worth the complexity). Broadened
  the team-news step's `if` condition to also match those three existing cron strings (`0 23
  * * 4`, `0 16,19,23 * * 0`, `0 23 * * 1`) alongside the daily morning slot. Verified the YAML
  still parses and the multi-line `if:` folds into one valid boolean expression (`python3 -c
  "import yaml; yaml.safe_load(...)"`, then printed the step's parsed `if` to confirm).
  Team news now runs 12x/week (was 7x/week): the 7 daily mornings plus Thu/Mon (1 each) and
  Sunday's 3-kickoff-window entry (fires 3x from one cron line).
- **Not yet done (needs Jeff):** same `wrangler deploy` + push as above (this was a workflow-
  only change, `worker/src/index.js` untouched by this addition specifically, but still
  bundled with the not-yet-deployed team-news-source-switch above) -- next Thu/Sun/Mon game
  day will be the first real test of the pre-kickoff timing.

## Team news: real date sort + collapse to 5 (2026-08-12, same session)
- Jeff asked how the card was sorted. Honest answer at the time: `ORDER BY id DESC` --
  insertion order, not the article's own published date -- because `team_news.published` was
  stored as Google's raw RFC 822 pubDate string ("Wed, 12 Aug 2026 14:00:00 GMT"), which isn't
  safely sortable as text in SQL (starts with weekday, not year).
- **Fixed:** `scripts/fetch_team_news.py` now has `normalize_pub_date()` -- parses the RFC 822
  string with `email.utils.parsedate_to_datetime` and stores ISO 8601 UTC instead
  ("2026-08-12T14:00:00Z", sorts correctly with a plain string comparison). Falls back to the
  raw string on any parse failure rather than dropping the value. Verified against real
  examples ("Wed, 12 Aug 2026 14:00:00 GMT" -> "2026-08-12T14:00:00Z") and a garbage-input
  fallback case, both by hand in this session.
- Worker's `getTeamNewsFromD1()` now sorts `ORDER BY published DESC, id DESC` (was `id DESC`
  alone) -- `id DESC` stays as a tiebreaker/fallback since rows inserted before this fix still
  hold the old RFC 822 string (INSERT OR IGNORE never rewrites existing rows) and would sort
  unpredictably mixed in with the new ISO-format ones.
- **Recommended to Jeff (not yet confirmed done):** run `DELETE FROM team_news;` once via
  wrangler after deploying, so every remaining row is consistently ISO-formatted -- the
  existing rows are all from today's testing/preseason period anyway, zero value to keep, and
  clearing them avoids the mixed-format sort edge case entirely rather than just tolerating it.
- **Also added:** site now shows only the top 5 headlines per team by default, with a
  "Show N more" toggle revealing the rest (still capped at TEAM_NEWS_LIMIT=8 from the Worker).
  Implemented as a delegated click listener on `teamNewsWrap` (survives `renderTeamNews()`
  re-running on every page load, since it's set up once rather than re-attached per render).
- **Not yet done (needs Jeff):** `wrangler deploy` (worker changed -- new ORDER BY),
  `git push` (site + script both changed), then clear the table as above, then either wait for
  the next scheduled run or trigger `workflow_dispatch` once to repopulate with clean,
  properly-sortable data.
- **Confirmed working, same session:** Jeff ran the delete + a manual `workflow_dispatch`
  (was momentarily queued -- normal GitHub Actions scheduling behavior, not a bug, resolved
  itself in a minute or two). Checked `/game/2026_01_ARI_LAC` directly afterward: real
  headlines for both teams, `pub_date` in the new sortable ISO format, newest first. Full
  loop verified end to end.

## Article date/time shown + home page "Latest News" feed (2026-08-12, same session)
- Two more asks after confirming the above worked: (1) show each headline's actual date/time
  on the card, (2) a general "all teams" news section on the home page, last 24h, top 10 with
  a "show more" toggle.
- **Date/time**: `page-game.js`'s `newsLine()` now shows `Util.formatDateTime(item.pub_date)`
  under each headline -- reused the existing helper (same one the odds-history table already
  uses for `snapshot_time`), no new formatting code needed. Only works cleanly for the new
  ISO-format `pub_date` values (post the sort-order fix above); falls back to showing
  whatever's there as-is for anything unparseable.
- **Home page feed**: new Worker route `/news/recent` (`getRecentTeamNews()`) -- flat query
  across every team's `team_news` rows, `WHERE published >= <24h-ago cutoff>`,
  `ORDER BY published DESC, id DESC`, capped at 40. Cutoff is truncated to
  `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds) to exactly match `normalize_pub_date()`'s stored
  format -- a millisecond-bearing cutoff could otherwise string-sort as "before" a same-second
  row that has no fractional part, a subtle edge case avoided by matching formats exactly.
  Not deduped or capped per team -- a genuinely flat "most recent across everyone" feed, per
  Jeff's literal ask; a busy news day for one team could dominate the top 10, not yet solved
  since it wasn't asked for.
- **Site**: new `Data.getRecentTeamNews()` in `data.js`; new "Latest news" section on
  `index.html` (`#latest-news-wrap`, between the status banner and the Explore nav cards);
  `page-home.js` renders the first 10 with a "Show N more" toggle for the rest (same
  collapse/delegated-click pattern as game.html's per-team card, copied rather than shared --
  matches this project's one-file-per-page convention, no shared news-rendering module).
  Each headline shows the team abbreviation (linked to that game's page when `game_id` is
  known), the headline itself (linked out to the article), source, and date/time.
- Verified: `node --check` on every changed file (`worker/src/index.js`, `data.js`,
  `page-home.js`, `page-game.js`) -- all pass. Could not exercise the live fetch/render in a
  browser from this sandbox.
- **Not yet done (needs Jeff):** `wrangler deploy` (new route) + `git push`
  (`site/index.html`, `site/assets/js/data.js`, `site/assets/js/page-home.js`,
  `site/assets/js/page-game.js`) -- then load the home page and confirm the Latest News
  section renders with real headlines from multiple teams.

## ESPN expert-picks step now non-blocking (fixed 2026-08-12)
- Found immediately after the games.csv fix above, same verification pass: with games.csv
  fixed, the job got one step further and died on "Fetch ESPN expert picks and apply to D1" --
  `fetch_expert_picks.py` couldn't find `window['__espnfitt__']` in the page (its own docstring
  already anticipated this exact failure mode -- "page structure may have changed"). Couldn't
  confirm the actual cause (ESPN markup change vs. no picks posted yet a month before Week 1)
  -- Chrome browser access wasn't granted this session to inspect the live page, and a plain
  fetch of espn.com/nfl/picks came back empty (JS-heavy page, no raw source to inspect that way).
- Rather than guess-fix a scraper I couldn't actually observe failing, added
  `continue-on-error: true` to that step instead -- one third-party page's markup shouldn't be
  able to kill odds/team-news/model-scoring downstream in the same job, same "log and skip,
  don't crash" philosophy already used for unmatched games/bookmakers elsewhere in this
  workflow. The underlying scraper issue is still open and worth a real look once someone can
  actually see what ESPN's page is doing now (or once real 2026 picks are posted closer to
  Week 1 and this may resolve itself if it's a too-far-out-week issue, not a markup change).

## Both workflows failing on games.csv download (fixed 2026-08-12)
- Found while verifying the team_news job (below): `market-refresh.yml`'s "Refresh games.csv"
  step had been failing for a couple of days, including on manual `workflow_dispatch` runs --
  `curl: (56) Connection died, tried 5 times before giving up` against nflverse-data's GitHub
  release CDN. Unrelated to team_news -- that step runs later in the job and never got to
  execute since the job fails fast. Pre-existing, not introduced by this session's changes.
- Fix: added `--retry 5 --retry-delay 5 --retry-all-errors` to every bare `curl -fsSL` pulling
  an nflverse-data release asset in both `market-refresh.yml` (odds-snapshot.yml) and
  `weekly-refresh.yml` -- the season-specific pulls already tolerated failure via `|| echo`,
  but without retries a transient connection drop looked identical to "not published yet" and
  silently skipped real data. Not yet re-verified against a real run (needs another
  `workflow_dispatch` from Jeff) -- can't trigger GitHub Actions from this sandbox.

## Team news headlines (new `team_news` table, built 2026-08-12)
- Jeff's ask: browse team subreddits/blogs daily for upcoming-game news, all 32 teams, into D1.
- Reddit rejected as the actual source: old.reddit.com's public `.json` endpoints have no
  free tier for scripted/automated access and are known to inconsistently 429/block
  cloud-runner IPs over time (exactly what GitHub Actions runners are) -- a bad foundation
  for an unattended daily job that would silently degrade. Confirmed with Jeff before building.
- Built on **Google News RSS** instead (`news.google.com/rss/search`) -- no API key, no
  documented rate limit at this volume (32 requests/day), structured XML
  (title/link/source/pubDate), and it surfaces the same outlets subreddits mostly just
  link to anyway (ESPN, beat writers, local papers, SI) with broader coverage than any
  single subreddit.
- **New script** `scripts/fetch_team_news.py` -- one `"<Team Name>" NFL when:1d` query per
  team, tags each headline with `team_abbr` and (best-effort) the team's own next upcoming
  `game_id` from `raw/games.csv`. Not attempting to parse which specific opponent a
  headline is about from free text -- not reliably parseable, and wasn't what was asked for.
  Verified locally against real `games.csv` with a mocked RSS response (this sandbox has no
  general internet access and couldn't hit news.google.com directly to test for real --
  same category of limitation as odds_snapshot/expert_picks, confirmed end-to-end only
  works once run for real in GitHub Actions).
- **New D1 table `team_news`** -- needs to be created live via wrangler (this sandbox has
  no `wrangler`/Cloudflare credentials, same limitation as every other new-table addition
  so far). Exact schema to run:
  ```sql
  CREATE TABLE team_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_abbr TEXT NOT NULL REFERENCES team(team_abbr),
    game_id TEXT REFERENCES game(game_id),
    headline TEXT NOT NULL,
    link TEXT NOT NULL,
    source TEXT,
    published TEXT,
    fetched TEXT NOT NULL,
    UNIQUE(team_abbr, link)
  );
  ```
  Append-only (`INSERT OR IGNORE` on the `UNIQUE(team_abbr, link)` key), same convention as
  `odds_snapshot`/`expert_consensus` -- never updated or deleted, dedup happens at insert time.
- **Wired into `.github/workflows/odds-snapshot.yml`** as a fourth job on the existing
  schedule, gated to only the once-a-day morning slot (`0 12 * * *`) or a manual
  `workflow_dispatch` -- doesn't need to run on all 16 weekly triggers like odds/picks do.
- **Not yet done (needs Jeff, can't be done from this sandbox):**
  1. Run the `CREATE TABLE team_news` statement above against the live `edge-rush` D1 database.
  2. Commit + push `.github/workflows/odds-snapshot.yml` and `scripts/fetch_team_news.py`.
  3. Trigger `workflow_dispatch` once to confirm the Google News RSS fetch actually works
     end-to-end from a GitHub Actions runner (only verified locally against mocked RSS here).
- No display feature built yet (no game.html/games.html card reading `team_news`) --
  scope was just "get it into the DB," per Jeff's answer. Natural next step once there's
  real data to look at.

## Model refinement (not yet done)
- Isolate the QB-availability feature on its own (strip out weather/general injury count, which came back near-zero in v2) and see if it clears breakeven by itself. This is the most promising thread from the Phase 1 backtest — see `backtest/phase1_results.md`.

## Weekly data refresh (once 2026 season starts)
- This sandbox can't directly download from nflverse's release-asset host (network allowlist restriction) — refresh has to go through the browser (Chrome extension), same as the historical backfill.
- Each week during the season: pull the current `games.csv` (for that week's lines + prior week's results), `stats_team_week_2026.csv`, `player_stats_2026.csv` (once published — lagged behind team stats historically), and `injuries_2026.csv`.
- Once files land in `raw/`, the rebuild (`scripts/build_json.py`) and backtest scoring (`scripts/backtest_v2.py`) are already fast and automated.
- Open question: whether to set up a weekly reminder for this, or just do it on request.

## Expert picks / public consensus (forward-looking only, built 2026-08-10)
- No free historical dataset exists for this — can't backtest it, only use it live going forward. Same limitation as line movement (odds_snapshot).
- Source survey (2026-08-10) — most candidates from the original list turned out to be dead ends:
  - **NFL Pickwatch** — real pick data (individual experts, even the aggregate consensus %) is paywalled behind "Unlock Expert" / a paid account. Not usable for free.
  - **CBS Sports** experts ATS page — discontinued; that URL now redirects into player-prop picks, not the old panel.
  - **Sporting News** picks URL — dead link.
  - **Yahoo Sports** picks page — now just redirects to Pickswise, no independent source.
  - **NFL.com** — doesn't run a weekly picks page.
  - **USA Today Sportsbook Wire** — free, but single-author prose articles (one pick per game), not structured, not a panel.
  - **Pickswise** — free, ATS-focused (the format actually wanted here), but it's one outlet's picks, not a multi-expert consensus, and wasn't scriptable yet as of this check (no 2026 picks posted, page structure unconfirmed). Worth revisiting once Week 1 picks are live.
  - **ESPN** (espn.com/nfl/picks) — free, no paywall, ~10-12 named analysts (Bell, Bowen, Clay, Fowler, Graziano, etc.). Straight-up picks only (who wins outright), not ATS. The picks data is server-rendered directly into the page HTML as `window['__espnfitt__']`, so it's scrapable with a plain HTTP GET, no browser automation needed for the weekly job. **This is the one that got built.**
- Built: `scripts/fetch_expert_picks.py` (mirrors `fetch_odds_snapshot.py`'s game_id-matching pattern) → D1 `expert_consensus` table → `expert_consensus` block on `getGameSituationalSignals` in the Worker → "Expert Pick Consensus" card on game.html. Runs on the same schedule as odds-snapshot.yml.
- Real, disclosed limitation: straight-up, not against the spread. A lopsided lean toward the underdog is the more interesting read than a lean toward the favorite, since the market already prices favorites as more likely to win outright.
- The market closing line already reflects aggregate expert/sharp opinion by construction — this is a supplementary signal, not a replacement for the market comparison already in the backtest.
- If Pickswise's ATS panel becomes scriptable once the season starts, that's the natural second source to add — genuinely spread-focused, which ESPN's data isn't.

## Stud-player injury value (backtest_v15, built 2026-08-11)
- Jeff's ask: weight injured players by how much they actually produce (a 100-catch WR out is a big deal, a 5-catch WR isn't), extended beyond just QBs to RB/WR-TE/front-seven/kicker.
- Tested as a MODEL INPUT first: `scripts/backtest_v15_stud_player_injury.py`, five position buckets (QB: passing EPA, RB: rushing EPA, WR/TE: receiving EPA, front seven: sacks/hits/TFL composite, K: fantasy points), each z-scored against its own position's population, added on top of pass_edge+rush_edge. 2009-2025 only (injury reports don't exist before 2009); baseline recomputed on the same window for a fair comparison.
- Result: nothing cleared breakeven. Best arm (all five edges together) hit 52.07% overall / 52.59% in 2018-2025, but the by-season breakdown for that exact arm swings from 59% to 47% year to year -- noise, not a real pattern like pass_edge+rush_edge's. QB value specifically showed zero effect (51.82% vs. 51.82% baseline). Not adopted as a model input -- same conclusion backtest_v9 reached for skill positions, now confirmed for pass rush/kicker too.
- Built as a DISPLAY feature instead: `getNotableInjuredPlayers` in the Worker lists every player with a final Out/Doubtful status on the current injury report, either team, with trailing per-game production attached (passing/rushing yards, receptions, sacks, FG makes depending on position) -- reuses the same position buckets as v15 but purely for "who's out and does it matter," not as a model input. Renders on the Injury Report card in game.html. OL/DB/etc. (no clean single counting stat) still show up by name/status, just without a stat line.

## Team News card on teams.html (built 2026-08-13)
- Jeff's ask: "Let's also add a news card to the Teams page. Same rule as games page. Last 5 plus 'more' link."
- teams.html has no `game_id` -- it's driven by `<select>` dropdowns (season, team), not a
  per-URL param -- so it can't just read `team_news` off a `/game/:gameId` response like
  game.html does. Added a standalone Worker route instead: `/team-news/:teamAbbr` calls the
  existing `getTeamNewsFromD1(DB, teamAbbr)` directly (same function `getGameDetail` already
  calls for each side of a matchup, just not bundled this time).
- **Site**: new `#team-news-wrap` section on teams.html, between the summary cards and the
  Weekly log table. `page-teams.js` gets its own self-contained copy of the newsLine/
  teamNewsList/5-visible-then-"Show N more" pattern (same convention as page-game.js and
  page-home.js's own copies -- one file per page, no shared helper module). `loadTeamNews()`
  fires whenever the effective team selection could have changed: initial load, team-select
  change, and season-select change (season change can silently reset which team's selected --
  see `loadTeamsForSeason()`). Not season-scoped itself (team_news has no season column), but
  a stale-response guard checks `teamSelect.value` still matches before rendering, in case a
  slow request for team A resolves after team B is already selected.
- Same daily-refresh-not-real-time caveat as the game.html card -- see `/team-news/:teamAbbr`'s
  comment in the Worker and `getTeamNewsFromD1()`'s longer history above it.
- Verified: `node --check` on `worker/src/index.js`, `site/assets/js/data.js`, and
  `site/assets/js/page-teams.js` -- all passed. Needs `wrangler deploy` (worker changed again)
  and a `git push` for the site files to go live.

## Team filter on home page news card (built 2026-08-13)
- Jeff's ask: filter the home page's "Latest news" feed down to one team.
- Client-side only, no new Worker route -- `/news/recent` already returns up to 40 items for
  the full 48h window in one call (see `getRecentTeamNews()`); filtering that same
  already-fetched array by `item.team` is simpler than a second round-trip and produces an
  identical result, since this is narrowing what's already on screen rather than asking for a
  longer lookback on one team (that's what the teams.html news card is for -- no time limit
  there).
- **Site**: new `#news-team-filter` `<select>` above the news card on `index.html` (same
  `.controls`/`.control` markup teams.html already uses). `page-home.js` now also calls
  `Data.getIndex()` (parallel with `Data.getRecentTeamNews()`) to populate it with all 32
  teams, sorted by full name -- deliberately not limited to teams that currently have
  headlines, same convention as every other team dropdown on the site (picking a quiet team
  shows "No headlines for this team," doesn't just vanish from the list). Rendering was
  refactored into `renderNewsWrap()`/`renderNewsList()` so the filter's `change` handler can
  re-render from the one already-fetched `allNewsItems` array without re-fetching. "Last
  refreshed" line stays unfiltered (whole-pipeline signal, not per-team).
- Verified: `node --check` on `page-home.js` -- passed.

## Bug: team filter showing no Cowboys news despite real, recent headlines (found/fixed 2026-08-13)
- Jeff noticed the new home page team filter showed nothing for Dallas, even though game.html
  and teams.html both showed real Cowboys headlines from today.
- Root cause confirmed by hitting the live API directly: `/team-news/DAL` had 8 real headlines,
  all from today (00:57-12:28 UTC), well inside the 48h window. But `/news/recent` (the feed the
  home page's filter draws from) had zero DAL items -- because a burst of near-simultaneous "how
  to watch X vs Y" preview articles across ~30+ OTHER teams, all published in the single hour
  right before kickoff (13:03-13:57 UTC), completely filled the old `RECENT_NEWS_LIMIT` (40)
  cap on its own. Dallas's genuinely-recent headlines just lost the ORDER BY published DESC ...
  LIMIT 40 race and got truncated out at the query level, before the client-side team filter
  ever saw them. Not a bug in the filter itself, or in Dallas's data.
  - This didn't matter before today (2026-08-13) because nothing had ever asked
    `/news/recent` to represent every team's coverage -- the unfiltered home page view only
    ever displayed the newest 10 anyway, so a truncated-but-still-plenty-large pool of 40 was
    invisible. It became a real bug the moment the per-team filter shipped, since filtering
    can only narrow what's already in the fetched list -- a team truncated out at the query
    level can never come back.
- Fix: raised `RECENT_NEWS_LIMIT` from 40 to 300 in the Worker (`getRecentTeamNews()`) --
  comfortably covers the realistic ceiling (32 teams x several headlines each within 2 days,
  even during a heavy pre-kickoff week) without being unbounded. The home page's default
  "All teams" view is unaffected (still 10 visible + "show more", client-side), this only
  changes how much the team filter has to work with.
- Verified: `node --check` on `worker/src/index.js` and `page-home.js` -- passed. Needs
  `wrangler deploy` to take effect.

## Filtering out "how to watch" / live-stream listicles (built 2026-08-13)
- Jeff's ask right after the DAL truncation bug above -- the flood of near-identical
  "X vs Y Live Stream: How to Watch" articles (one per outlet, posted under BOTH teams in the
  game) was exactly what caused that bug, and they're not real news anyway (no injury/roster/
  game info, just a watch-it-here listicle).
- Filtered at fetch time, not just hidden client-side: `scripts/fetch_team_news.py` now has
  `is_low_value_headline(title)`, matching `"how to watch"`, `"live stream"`, `"how to stream"`
  case-insensitively against the title. Applied inside `parse_rss_items()` before the
  per-team `--limit-per-team` cap, so junk headlines can no longer crowd out real ones within
  a single team's per-run allotment either -- previously the cap was applied to the raw item
  list first via slicing, so a bad day could genuinely fill a team's 15-headline cap with nothing
  but watch-it-here listicles.
- Deliberately narrow patterns -- didn't touch "Prediction, Pick, Odds" or similar (that's real
  analysis content, not boilerplate), just the specific pattern Jeff flagged.
- Forward-only: this stops NEW junk from being inserted, doesn't retroactively remove what's
  already in `team_news` from before today. Jeff can optionally run a one-time cleanup:
  `wrangler d1 execute edge-rush --remote --command "DELETE FROM team_news WHERE headline LIKE '%how to watch%' OR headline LIKE '%live stream%' OR headline LIKE '%how to stream%';"`
  (SQLite's LIKE is case-insensitive for ASCII by default, so this catches the same rows the
  Python filter would have).
- Verified: `python3 -m py_compile` plus a standalone test of `is_low_value_headline()` against
  5 real titles pulled from the live API earlier today (2 "how to watch" titles correctly
  filtered, 3 real headlines including a "Prediction, Pick, Odds" one correctly kept) -- all
  passed.

## Data gaps (documented, not fixable)
- Moneylines/odds: 0% coverage 1999-2005 (doesn't exist in the source), scattered gaps 2006-2009, essentially complete 2010+.
- Injuries data: only available 2009-2025, nothing before that.
- Player stats: 1999-2024 pulled; 2025 not yet published by nflverse as of this writing.
