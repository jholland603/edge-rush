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

## Data gaps (documented, not fixable)
- Moneylines/odds: 0% coverage 1999-2005 (doesn't exist in the source), scattered gaps 2006-2009, essentially complete 2010+.
- Injuries data: only available 2009-2025, nothing before that.
- Player stats: 1999-2024 pulled; 2025 not yet published by nflverse as of this writing.
