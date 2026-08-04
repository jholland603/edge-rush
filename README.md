# edge-rush

A personal sports-handicapping project: build power ratings from play-by-play data, test them rigorously against the closing betting line, and be honest about whether an edge actually exists before ever acting on one.

> The market is efficient until proven otherwise. The point isn't to build a model that predicts football — it's to test rigorously whether one has an edge.

Currently scoped to NFL (1999–2026), using [nflverse-data](https://github.com/nflverse/nflverse-data) as the sole data source. Nothing here is betting advice, and nothing here is currently acted on with real money — see [Status](#status) below.

## Status

**Phase 1 (backtest) is done. The honest result: no confirmed edge yet, one real but modest signal, and the model cannot currently rank its own best picks.**

- A baseline EPA/play power-rating model does not beat the closing line (48.4% hit rate on flagged games, below the 52.4% breakeven).
- Adding offense/defense splits, run/pass splits, rest, weather, and QB-availability/injury data closes most of the gap (51.3% hit rate) — still short of breakeven, but the QB-availability effect (~3.8 points when a team starts a non-established QB) is real, sane, and matches independent public research.
- The actual goal — reliably picking the "best" 2–4 games a week — was tested directly with a calibration analysis (Brier score). Result: this model's confidence is **not** reliably calibrated (Brier score at/above the naive 50/50 baseline). Ranking picks by edge size, or by predicted probability, does not track actual hit rate.

Full writeup, methodology, and every number above: [`backtest/phase1_results.md`](backtest/phase1_results.md).

Phase 2 (weekly automation) and Phase 3 (pick logging + closing-line-value tracking) are built and running in **paper-trading mode only** — predictions are generated and logged every week, but flagged as unreliable and not acted on. See [`data/model/README.md`](data/model/README.md).

## Project structure

```
edge-rush/
├── nfl-handicapping-project-instructions.md   original project brief (4 phases, guiding principle)
├── raw/                  source CSVs from nflverse-data (gitignored — see "Reproducing raw/" below)
├── scripts/
│   ├── build_json.py         builds the whole data/ JSON tree from raw/
│   ├── backtest.py            Phase 1, v1 model (single combined EPA rating)
│   ├── backtest_v2.py         Phase 1, v2 model (split ratings + situational features)
│   ├── calibrate.py            calibration / Brier score test
│   ├── weekly_update.py        Phase 2: generates this week's predictions
│   └── reconcile_picks.py      Phase 3: fills in results/CLV once games are played
├── backtest/              backtest outputs, predictions, and phase1_results.md
├── data/                  static JSON data tree (games, teams, players, model picks, log)
│   └── model/README.md       what's in data/model, with the paper-trading disclaimer
├── index.json             top-level index (seasons, teams, player lookup) for the site
└── site/                  static browsing site — reads data/ and index.json directly
    ├── index.html, teams.html, players.html, games.html (model picks/log folded in)
    └── assets/
        ├── css/style.css          shared design system
        └── js/
            ├── components.js       <site-header>/<site-footer> web components
            ├── data.js              shared fetch/cache layer over data/
            ├── util.js              formatting helpers
            └── page-*.js            per-page controllers
```

## Browsing the site locally

Modern browsers block `fetch()` against `file://` URLs, so the site needs to be served over HTTP, not opened directly.

Easiest: double-click `serve-site.bat` (Windows) — it starts a local server and opens the site automatically. To do it manually:

```
python -m http.server 8000
```

then visit `http://localhost:8000/site/index.html`.

## Reproducing `raw/`

`raw/` isn't checked into the repo (see `.gitignore`) since it's fully reproducible and already distilled into `data/` and `backtest/`. To rebuild it, pull these from the latest [nflverse-data releases](https://github.com/nflverse/nflverse-data/releases) into the matching subfolder:

- `games.csv` → `raw/games.csv`
- `stats_team_week_{season}.csv` (1999–2025) → `raw/team/`
- `player_stats_{season}.csv` (1999–2024) → `raw/player/`
- `injuries_{season}.csv` (2009–2025 only — not available before 2009) → `raw/injuries/`

## Regenerating data / running the weekly pipeline

Rebuild the full `data/` JSON tree from `raw/`:

```
python scripts/build_json.py --stage all
```

Run the weekly prediction + logging pipeline (paper trading only):

```
python scripts/weekly_update.py --raw-dir raw --data-dir data --backtest-dir backtest --predictions-v2 backtest/predictions_v2.csv --season 2026
```

Reconcile the pick log against games that have since been played (safe to run any time — no-op for ungraded games):

```
python scripts/reconcile_picks.py --raw-dir raw --data-dir data --log-csv backtest/picks_log.csv
```

## Disclaimer

Everything under `data/model/` and `backtest/picks_log.csv` is generated by an explicitly unvalidated model (see [Status](#status)). It's logged for tracking purposes only — not a recommendation, and not currently backing any real bets.
