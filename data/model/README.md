# model/

**Stale as of the D1 migration** -- the site now reads live predictions from D1's `model`/`picks_log` tables via the Worker API, not from JSON files in this folder. The `{season}-week{N}.json` files and `manifest.json` here are leftovers from before that migration, kept only as a record of the original file shape; nothing regenerates them anymore.

Current predictions come from `scripts/weekly_update.py`, which upserts straight into D1 -- but read the `note` field on each row before trusting anything in it. Phase 1's calibration test (see `backtest/phase1_results.md`) found the model's confidence is not reliably calibrated (Brier score at or above a naive 50/50 baseline), so everything here is logged for tracking purposes only, not acted on as real picks.

As of 2026-08, the rating method is a rolling last-10-games average (any season, regular season + playoffs both count), not the original full-history EWMA -- Jeff's call, made aware that `backtest/backtest_v5_rolling10.py` found no ATS signal from a rolling window at any size and no improvement over the EWMA model it replaced. Chosen for recency over history anyway; more model tweaks (e.g. expert picks) are expected on top of this. Coefficients are fit occasionally/by hand (`scripts/fit_model_coefficients.py`, needs the full historical `raw/team/` archive) and saved to `backtest/model_coefficients.json`; `weekly_update.py` just reads that file and never fits anything itself, which is what lets it run as often as the odds snapshots (see `.github/workflows/odds-snapshot.yml`) without needing decades of CSVs on every run.

`_template.json` documents the original intended file shape and is kept for reference.
