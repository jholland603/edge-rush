# Open threads / decisions log

Running notes so nothing gets lost between sessions. Not a deliverable, just a scratchpad.

## Model refinement (not yet done)
- Isolate the QB-availability feature on its own (strip out weather/general injury count, which came back near-zero in v2) and see if it clears breakeven by itself. This is the most promising thread from the Phase 1 backtest — see `backtest/phase1_results.md`.

## Weekly data refresh (once 2026 season starts)
- This sandbox can't directly download from nflverse's release-asset host (network allowlist restriction) — refresh has to go through the browser (Chrome extension), same as the historical backfill.
- Each week during the season: pull the current `games.csv` (for that week's lines + prior week's results), `stats_team_week_2026.csv`, `player_stats_2026.csv` (once published — lagged behind team stats historically), and `injuries_2026.csv`.
- Once files land in `raw/`, the rebuild (`scripts/build_json.py`) and backtest scoring (`scripts/backtest_v2.py`) are already fast and automated.
- Open question: whether to set up a weekly reminder for this, or just do it on request.

## Expert picks / public consensus (forward-looking only, Phase 2/3)
- No free historical dataset exists for this — can't backtest it, only use it live going forward.
- Sources to pull from once building this out (closer to kickoff, nothing real to scrape yet):
  - **NFL Pickwatch** (nflpickwatch.com) — aggregates picks from many media experts (ESPN, CBS, FOX, etc.), tracks accuracy. Picks table is JS-rendered, needs Chrome browsing to read, not a plain fetch.
  - **CBS Sports** experts ATS page (cbssports.com/nfl/picks/experts/against-the-spread) — single-outlet named panel.
  - Other sources not yet vetted: SportsLine, Pickswise, SI Betting — worth checking closer to the season for reliability/coverage before picking a final set.
- The market closing line already reflects aggregate expert/sharp opinion by construction — this is a supplementary signal, not a replacement for the market comparison already in the backtest.

## Data gaps (documented, not fixable)
- Moneylines/odds: 0% coverage 1999-2005 (doesn't exist in the source), scattered gaps 2006-2009, essentially complete 2010+.
- Injuries data: only available 2009-2025, nothing before that.
- Player stats: 1999-2024 pulled; 2025 not yet published by nflverse as of this writing.
