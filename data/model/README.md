# model/

`{season}-week{N}.json` files contain real, current predictions from `scripts/weekly_update.py` -- but read the `note` field in each file before trusting anything in it. Phase 1's calibration test (see `backtest/phase1_results.md`) found this model's confidence is not reliably calibrated (Brier score at or above a naive 50/50 baseline), so everything here is logged for tracking purposes only, not acted on as real picks.

`_template.json` documents the original intended file shape and is kept for reference.

Regenerate any time with:
```
python scripts/weekly_update.py --raw-dir raw --data-dir data --backtest-dir backtest --predictions-v2 backtest/predictions_v2.csv --season 2026
```
