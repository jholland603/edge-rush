#!/usr/bin/env python3
"""Quick check: does L2-regularized (ridge) regression, instead of plain
OLS, improve out-of-sample hit rate on the current 8-feature model? Ridge
shrinks weak/noisy coefficients (wind, dome, injury_edge) toward zero
instead of letting them drift freely each season's refit -- cheap to test,
no new data needed."""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, ".")
import backtest_v2 as bv2

ALPHA_GRID = [0.0, 1.0, 5.0, 20.0, 50.0]  # 0.0 = plain OLS, for reference

def walk_forward_ridge(m, alpha):
    seasons = sorted(m["season"].unique())
    train_cutoff_seasons = seasons[:bv2.TRAIN_SEASONS]
    results = []
    for season in seasons:
        if season in train_cutoff_seasons:
            continue
        train = m[m["season"] < season]
        if len(train) < 200:
            continue
        X = train[bv2.FEATURES].to_numpy(dtype=float)
        X = np.column_stack([np.ones(len(X)), X])
        y = train["result"].to_numpy(dtype=float)
        # standardize features (excluding intercept) so one alpha is comparable
        # in scale across pass_edge (~0.1) and qb_change (0/1) etc.
        mu = X[:, 1:].mean(axis=0)
        sd = X[:, 1:].std(axis=0)
        sd[sd == 0] = 1.0
        Xs = X.copy()
        Xs[:, 1:] = (X[:, 1:] - mu) / sd
        n_feat = Xs.shape[1]
        reg = np.eye(n_feat) * alpha
        reg[0, 0] = 0.0  # never regularize the intercept
        if alpha == 0:
            coef_s, *_ = np.linalg.lstsq(Xs, y, rcond=None)  # matches bv2's plain-OLS path, robust to rank-deficiency
        else:
            coef_s = np.linalg.solve(Xs.T @ Xs + reg, Xs.T @ y)
        # convert standardized coefficients back to raw feature scale
        coef = coef_s.copy()
        coef[1:] = coef_s[1:] / sd
        coef[0] = coef_s[0] - np.sum(coef_s[1:] * mu / sd)

        test = m[m["season"] == season].copy()
        Xt = test[bv2.FEATURES].to_numpy(dtype=float)
        Xt = np.column_stack([np.ones(len(Xt)), Xt])
        test["predicted_margin"] = Xt @ coef
        test["train_games"] = len(train)
        for name, val in zip(["intercept"] + bv2.FEATURES, coef):
            test[f"coef_{name}"] = val
        results.append(test)
    return pd.concat(results, ignore_index=True)

print("Building v2 matchup table (current production feature set)...")
team_games = bv2.load_team_games(Path("raw"))
ratings = bv2.build_ratings(team_games)
m = bv2.build_matchups(Path("raw"), ratings)
bv2.FEATURES = ["pass_edge", "rush_edge", "rest_diff", "wind", "dome",
                "qb_change_home", "qb_change_away", "injury_edge"]
print(f"{len(m)} games\n")

out = {}
for alpha in ALPHA_GRID:
    preds = walk_forward_ridge(m, alpha)
    preds, flagged = bv2.score(preds)
    summary = bv2.summarize(preds, flagged)
    label = "OLS (alpha=0, baseline)" if alpha == 0 else f"ridge alpha={alpha}"
    print(f"=== {label} ===")
    print(json.dumps(summary["overall"], indent=2))
    print("avg coefficients:", json.dumps(summary["avg_coefficients"], indent=2))
    print()
    out[label] = summary["overall"]

Path("backtest_v10_out").mkdir(exist_ok=True)
with open("backtest_v10_out/summary_v10.json", "w") as f:
    json.dump(out, f, indent=2, default=str)
print("Wrote backtest_v10_out/summary_v10.json")
