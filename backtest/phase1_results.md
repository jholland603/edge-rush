# Phase 1 Backtest Results

**Question:** does an EPA/play power-rating model show real signal against the closing line, or does it just track the market?

**Answer: no reliable signal found, but one promising thread (QB availability) worth isolating further.** The first version of this model (single combined EPA rating, no situational data) did not beat the closing line. A second version — adding separate offense/defense and run/pass ratings, rest, weather, and QB-availability/injury data — closed much of the gap (48.4% → 51.3% hit rate on flagged games) but still falls short of the 52.4% breakeven needed against standard vig, and doesn't show hit rate scaling with edge size the way a real signal should. See both versions below; the honest read is "closer, not there yet."

## Method summary

- **Universe:** all regular-season games, 1999–2025, where both teams had at least one prior game rated (5,493 games scored; the first 3 seasons, 1999–2001, were used only to seed the model and aren't scored).
- **Rating:** exponentially-weighted average of each team's net EPA/play (own offensive EPA/play minus opponent's offensive EPA/play allowed, i.e. defense-adjusted), using only games *before* the one being predicted — no lookahead within a season. Ratings carry over between seasons at 50% regression to the mean.
- **Conversion to a predicted spread:** each season's EPA-to-points conversion (and implied home field edge) is refit using only *prior* seasons (expanding window), so nothing about a season's outcomes leaks into that season's predictions. Full method is documented in `scripts/backtest.py`.
- **Scoring:** flagged any game where the model's predicted spread differed from the closing `spread_line` by 2+ points, then checked whether the side the model preferred actually covered.

## Headline numbers

| Metric | Value |
|---|---|
| Games scored | 5,493 (2002–2025) |
| Games flagged (edge ≥ 2 pts) | 3,103 (56.5%) |
| Hit rate on flagged games | **48.4%** |
| Breakeven at standard -110 vig | 52.4% |
| RMSE, model vs. actual result | 13.80 |
| RMSE, closing line vs. actual result | 13.16 |

The market's closing line predicts the actual final margin slightly *better* than this model does (lower RMSE), and betting the model's disagreements would have lost money against a typical vig, not made it.

## Consistency check: by season

Hit rate bounces around 50% with no trend — exactly what noise around "no edge" looks like, not a discernible signal that shows up reliably. Ranges from 40.7% (2005) to 54.0% (2004), with most seasons landing in the high-40s.

## Consistency check: by edge size

| Model disagreement | Games | Hit rate |
|---|---|---|
| 2–3 pts | 873 | 48.0% |
| 3–5 pts | 1,281 | 47.4% |
| 5–7 pts | 602 | 49.3% |
| 7+ pts | 347 | 51.3% |

If the model's disagreements with the market reflected real information, hit rate should climb meaningfully as disagreement size grows (bigger edge = more confident = more often right). It barely moves, and even the biggest-edge bucket doesn't clear breakeven. That's another mark against there being real signal here, not just an aggregate coincidence.

## Sanity checks (pipeline is doing what it's supposed to)

- Estimated home field advantage: 2.1–2.8 points, declining over the sample — matches the well-documented real-world decline in NFL home field edge (including the dip around 2020's empty stadiums).
- Estimated points-per-EPA/play conversion: ~24.7–26.6, in line with commonly cited public research on the EPA-to-points relationship.
- Spot-checked individual games against known results — all correct.

## v1 conclusion

This specific formulation (EPA/play only, no injuries/rest/weather, single combined offense-defense rating, one fixed disagreement threshold) doesn't show an exploitable edge. Per the project's own instructions, that's not a "keep tweaking until it works" signal — a method that only clears breakeven after enough parameter changes is much more likely overfit noise than a real edge. Worth being honest about before investing more time.

The more promising directions identified at the time (each a testable, falsifiable change, not a guarantee): separate offense/defense ratings instead of one combined number, split run/pass EPA, add situational adjustments (QB injuries, rest, weather), and try success rate instead of/alongside EPA/play. The first three of those were tried next, below.

---

# v2: off/def split, run/pass split, rest, weather, QB availability, injuries

**What changed:** instead of one combined "net EPA/play" rating per team, v2 tracks four separate EWMA ratings (offense-pass, offense-rush, defense-pass-allowed, defense-rush-allowed) and pits each team's offense directly against the opposing defense in that unit (`pass_edge`, `rush_edge`). It also adds `rest_diff` (from `games.csv`), `wind` and `dome` (weather, from `games.csv`), `qb_change_home`/`qb_change_away` (1 if the actual starter differs from that team's established starter over their last 8 games, derived from `games.csv` QB IDs — covers the full 1999–2025 range), and `injury_edge` (players with a final "Out" designation, home vs. away, from nflverse's injuries data — **2009–2025 only**, treated as 0 for earlier seasons since the data doesn't exist before then). All features are still walk-forward and leak-free: each season's conversion coefficients are refit using only prior seasons.

## Headline numbers: v1 vs. v2

| Metric | v1 (single EPA rating) | v2 (split ratings + situational) |
|---|---|---|
| Games scored | 5,493 | 5,537 |
| Games flagged (edge ≥ 2 pts) | 3,103 (56.5%) | 3,808 (68.8%) |
| Hit rate on flagged games | 48.4% | **51.3%** |
| Breakeven at standard -110 vig | 52.4% | 52.4% |
| RMSE, model vs. actual | 13.80 | 14.33 |
| RMSE, closing line vs. actual | 13.16 | 13.18 |

Hit rate improved meaningfully (48.4% → 51.3%) and is now much closer to breakeven — but still short of it. Interestingly, overall prediction error (RMSE) got slightly *worse*, not better; the new features help identify *which* games to disagree with the market on more than they help predict final margins across the board.

## What's actually driving the improvement

The walk-forward-averaged regression coefficients:

| Feature | Coefficient | Interpretation |
|---|---|---|
| `qb_change_home` | **-3.89** | Home team started a non-established QB: ~3.9 fewer predicted points |
| `qb_change_away` | **+3.76** | Away team started a non-established QB: ~3.8 more predicted points for home |
| `pass_edge` | 3.79 | Sensible positive relationship, passing matchup edge |
| `rush_edge` | 1.76 | Smaller than passing — consistent with public research that pass EPA is more predictive than rush EPA |
| `rest_diff` | 0.20 pts/day | Small but sensibly signed |
| `wind` | 0.02 | Effectively zero |
| `dome` | -0.07 | Effectively zero |
| `injury_edge` | -0.004 | Effectively zero — general "players out" count adds nothing once QB status is already captured |

The QB-availability flag is doing almost all of the work, and its size (~3.8 points) lines up well with independent public research on backup-QB value — a good sign this is a real effect, not noise. Weather and the broad injury count contribute essentially nothing to the spread specifically (they may still matter more for totals, which this project hasn't backtested).

## Consistency check: by season (v2)

Still bounces around, now centered closer to 51–52% instead of v1's ~48%: ranges from 44.7% (2023) to 59.6% (2018), with 13 of 24 seasons above 50% and several still clearly below. Better than v1, but still not the kind of season-over-season consistency that would make this trustworthy on its own.

## Consistency check: by edge size (v2)

| Model disagreement | Games | Hit rate |
|---|---|---|
| 2–3 pts | 589 | 51.6% |
| 3–5 pts | 1,259 | 52.9% |
| 5–7 pts | 930 | 48.8% |
| 7+ pts | 1,030 | 51.3% |

This is the most important caveat: hit rate does **not** climb monotonically with edge size (it dips in the 5–7 point bucket). A genuine, well-calibrated edge should show more confidence = more often right. This pattern is still more consistent with noise centered slightly under breakeven than with a reliable, scalable signal.

## v2 conclusion

Folding in QB availability, run/pass and off/def splits improved the model — an honest, working, sanity-checked finding (the QB coefficient especially). But even with all of that, hit rate on flagged games (51.3%) is still below the 52.4% breakeven needed to profit against standard vig, and the by-edge-size pattern doesn't show the scaling a real signal should. With n≈3,800 flagged games, 51.3% is not statistically distinguishable from 50/50 (standard error ≈0.8%), so this read as "close, not there" rather than "found it."

---

# QB isolation + top-N-per-week + calibration test

The actual goal, stated plainly: can this model reliably pick the "best" 2-4 games a week, not just flag everything it disagrees with the market on? Three follow-up tests, in order:

## 1. Is the edge concentrated in QB-change games?

Splitting the flagged games (edge ≥ 2 pts) by whether either team started a non-established QB: **51.9% hit rate on QB-change games vs. 50.8% on everything else** — a real but modest gap, and the QB-change subset is *still under breakeven on its own*. Looking at all scored games (no edge threshold), the gap actually reverses slightly (51.0% QB-change vs. 51.4% no-change) — meaning the apparent QB edge only shows up combined with the market-disagreement filter, not as a broad standalone effect. QB availability is real (the coefficient size and sign both check out) but not, by itself, enough to bet on confidently.

## 2. Does ranking by edge size find the "best" games?

Taking only the model's top 1, 2, 3, 4, or 5 highest-|edge| picks per week instead of betting every flagged game:

| Picks/week | Games | Hit rate |
|---|---|---|
| Top 1 | 413 | 50.1% |
| Top 2 | 826 | 51.0% |
| Top 3 | 1,239 | 50.9% |
| Top 4 | 1,651 | 51.1% |
| Top 5 | 2,062 | 50.9% |
| *(all flagged, for reference)* | 3,808 | 51.3% |

Flat, and top-1 is actually the worst of the group. **Bigger disagreement with the market does not mean more likely to be right.** That rules out "just take the model's biggest edges" as a way to pick a weekly shortlist.

## 3. Is the model's confidence actually calibrated? (the real test)

Point (2) tested raw edge size as a confidence proxy. This tests it properly: two walk-forward logistic regression models were fit to directly predict P(covers), then checked against a reliability diagram (do 55%-confidence picks actually hit ~55% of the time?) and Brier score (0 = perfect, 0.25 = the score you get by guessing 50% for every single game, no matter what).

**Model A (calibrate the existing edge):** P(covers) ~ model_edge alone.
Brier score: **0.2500** — statistically identical to always guessing a coin flip. The calibration table confirms it: predicted probabilities barely range outside 49–53%, and don't move monotonically with actual hit rate.

**Model B (classify directly from features):** P(covers) ~ pass_edge + rush_edge + rest_diff + qb_change_home + qb_change_away + injury_edge.
Brier score: **0.2507** — *worse* than guessing 50/50 every time. This model produces a wider, more "confident"-looking spread of predictions (37%–66%), but that confidence is miscalibrated: its most-confident weekly pick (top-1/week) hit only **47.8%** of the time, worse than a coin flip.

## Conclusion: this model cannot currently support a "best 2-4 games" feature

Not "close" — the calibration test is a clean, decisive result. A Brier score at or above the naive 50/50 baseline means there is no reliable relationship between how confident this model is and how often it's right, with the features tried so far. Presenting a ranked shortlist right now would be manufacturing false confidence, not surfacing real signal.

This doesn't contradict the earlier finding that QB availability has a real, sensible effect (part 1 above) — it means that effect, and everything else tried, isn't yet strong or well-separated enough to rank games by confidence. That's a meaningfully different and more specific finding than "no signal at all," and it points at what would actually need to change: not more situational features bolted onto the same approach, but either materially better predictors, or a much larger sample before trusting any probability estimate this model produces.

## Files

- `backtest/predictions.csv` / `summary.json` — v1 results.
- `backtest/predictions_v2.csv` / `summary_v2.json` — v2 results, including all feature values and per-season regression coefficients.
- `backtest/calibration/calibration_summary.json` — Brier scores, calibration tables, top-N-by-probability results for both calibration models.
- `backtest/calibration/calibrated_edge_only.csv` / `calibrated_full_feature.csv` — per-game predicted probabilities for both models.
- `scripts/backtest.py` — v1 model.
- `scripts/backtest_v2.py` — v2 model, fully documented and re-runnable.
- `scripts/calibrate.py` — calibration test, fully documented and re-runnable.
