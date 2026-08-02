# NFL Handicapping Model — Project Work Instructions

## Goal
Build a data-driven power-rating model, backtest it against real historical closing lines (1999–present), and determine whether it identifies value versus the market. If it holds up, use it to flag spots each week during the season.

## Guiding principle
The market is efficient. The purpose of this project is not to assume an edge exists, but to test rigorously whether one does — and to track results honestly enough to find out.

---

## Data Sources (confirmed working)

All data comes from **nflverse-data**, a free, community-maintained, public GitHub repository. No API key or account needed.

**Schedules & closing lines** (spreads, totals, moneylines, weather, rest days, QBs, coaches — back to 1999, including the full 2026 schedule with opening lines already posted):
```
https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv
```

**Team-level weekly stats** (EPA/play, success rate, and ~100 other efficiency metrics per team per week):
```
https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{SEASON}.csv
```
(replace `{SEASON}` with a year, e.g. `2025`)

**Play-by-play** (if deeper custom metrics are needed later — large files, season by season):
```
https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{SEASON}.csv.gz
```

---

## Phase 1 — Backtest the Model (do this before betting anything)

1. **Pull historical data** for at least 3–5 past complete seasons.
2. **Build weekly power ratings** per team using EPA/play (offense and defense, splitting run/pass if desired). Use a rolling weighted average — recent weeks matter more, but don't overreact to any single game.
3. **Convert ratings into a predicted spread** for each matchup (rating differential + home field adjustment, typically ~1.5–2.5 points currently).
4. **Compare predicted spread to the actual closing spread** in `games.csv` for every historical game.
5. **Score the model**: for games where your prediction differed from the market by more than a threshold (start with 2 points), check who was closer to the actual result. Track this as a hit rate against the spread, not just "did the favorite cover."
6. **Be skeptical of good results.** A method that shows 55%+ against the spread across thousands of historical games is worth investigating further; anything based on a handful of games is noise. Break results out by season to check consistency, not just an aggregate.

**Output of this phase:** a clear answer — does this approach show any real signal, or does it just track the market?

---

## Phase 2 — Build the Weekly Tool (only after Phase 1 looks promising)

1. Automate the weekly pull of updated team stats and the current week's lines.
2. Recalculate power ratings and predicted lines for upcoming games.
3. Flag games where predicted line vs. market line exceeds your threshold.
4. Layer in situational adjustments not captured by EPA: confirmed injuries (especially QB), short rest, long travel, weather.
5. Log every flagged game before kickoff — required for Phase 3.

---

## Phase 3 — Live Tracking (in-season discipline)

Track every recommendation in a simple log with these columns:
- Date, matchup, your predicted line, market line at time of pick, closing line, bet placed (Y/N), result, and — most important — **closing line value (CLV)**: did the line move toward your number after you flagged it?

CLV is the real scoreboard. A model can go through a losing stretch and still be working if it's consistently beating the closing line. A model with a winning streak but negative CLV is likely running on luck.

**Minimum sample before drawing conclusions:** a full season (roughly 270 games). Anything less is not enough to distinguish skill from variance.

---

## Tools Needed
- Spreadsheet or lightweight script (Python) to pull CSVs and calculate ratings
- A place to log picks weekly before games start (a locked-in log, not edited after the fact)
- Basic bankroll plan decided in advance — flat staking or fractional Kelly, never confidence-based sizing

---

## Next Steps
Decide on:
1. Which seasons to backtest first
2. Whether to start with a spreadsheet or a script-based model
3. Rating formula specifics (I can propose a starting weighting scheme)

---

## Phase 4 — Publishing Data to a Website (JSON structure)

Once the model is working, the site should read from pre-built JSON files rather than raw CSVs or recomputing stats on every page load. Split files by purpose and by season/scale so nothing becomes an unwieldy monolith.

**Proposed folder structure:**
```
/data
  /teams
    2024.json          → team stats/ratings for that season
    2025.json
    2026.json
  /players
    /career
      00-0033873.json  → one player's full career totals, keyed by player_id
    /season
      2025.json        → every player's stats for that season only
  /games
    2025.json          → schedule + lines + results for that season
    2026.json
  /model
    2026-week1.json     → predicted lines / edges vs. market — the "live" file the site displays
  index.json             → lightweight lookup: player names → player_id, team lists, available seasons
```

**Why split this way:**
- **By season** — a lookup like "2023 Chiefs stats" shouldn't require downloading 25+ years of data. Keeps each file small and fast to fetch.
- **Career vs. season for players** — career totals are aggregated and rarely change; season files update weekly in-season. Separating them avoids regenerating a huge career file every week.
- **Separate `model` folder** — predictive output (power ratings, edges vs. market) is opinionated and will iterate independently of the raw stats data. Keeping it separate means changing the model's format doesn't touch the raw data pipeline.
- **`index.json`** — drives site navigation/search (e.g., "find this player," "list available seasons") without scanning every file. The site fetches the specific season/player file only after a selection is made.

**Sample game/model JSON shape (for reference):**
```json
{
  "week": 1,
  "season": 2026,
  "updated": "2026-09-08T12:00:00Z",
  "games": [
    {
      "matchup": "NE @ SEA",
      "market_spread": 3.5,
      "model_spread": 5.0,
      "edge": 1.5,
      "market_total": 44.5,
      "model_total": 46.0
    }
  ]
}
```

**Update cadence:**
- `games` and `model` files: refresh weekly during the season (or on-demand if live line-movement tracking is wanted later)
- `players/season` files: refresh weekly during the season
- `players/career` and historical `teams`/`games` files: build once, then only append the current season going forward

**Build note:** career stats going back to 1999 is a one-time larger processing job (script that pulls all historical seasons and aggregates). After that initial build, only the current season's files need weekly regeneration.

**Next decision:** whether the JSON files are regenerated on a schedule (script runs weekly, overwrites files) or generated on-demand per site visit. Scheduled regeneration is simpler and sufficient unless live in-week line tracking becomes a goal.
