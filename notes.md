# Open threads / decisions log

Running notes so nothing gets lost between sessions. Not a deliverable, just a scratchpad.

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

## Data gaps (documented, not fixable)
- Moneylines/odds: 0% coverage 1999-2005 (doesn't exist in the source), scattered gaps 2006-2009, essentially complete 2010+.
- Injuries data: only available 2009-2025, nothing before that.
- Player stats: 1999-2024 pulled; 2025 not yet published by nflverse as of this writing.
