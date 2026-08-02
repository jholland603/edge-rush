#!/usr/bin/env python3
"""
Phase 1, calibration test: does the model's edge (or its underlying features)
carry any real information about P(cover), and can that be used to rank picks?

Builds on backtest_v2's output (predictions_v2.csv), which already has
model_edge and the raw features (pass_edge, rush_edge, rest_diff, wind, dome,
qb_change_home, qb_change_away, injury_edge) per game -- no need to rebuild
ratings from scratch.

Two walk-forward (no-lookahead) logistic models are fit, season by season,
using only prior seasons:

  Model A ("edge-only"): P(home_covers) ~ model_edge
    Tests whether the existing point-margin model's disagreement size,
    properly calibrated via a logistic link (not just eyeballed bucket
    averages), carries real information about cover probability.

  Model B ("full-feature"): P(home_covers) ~ pass_edge + rush_edge +
    rest_diff + qb_change_home + qb_change_away + injury_edge
    Tests whether a model built FOR classification (rather than repurposed
    from a margin regression) finds separation the margin-based edge misses.
    (wind/dome dropped -- they had ~0 coefficient in the margin model.)

For both models: a calibration table (predicted probability bucket vs.
actual hit rate -- the actual "is this trustworthy" check), overall
Brier score, and a repeat of the top-N-picks-per-week test using predicted
probability instead of raw |edge| to rank.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

TRAIN_MIN = 300

EDGE_FEATURES = ["model_edge"]
FULL_FEATURES = ["pass_edge", "rush_edge", "rest_diff",
                  "qb_change_home", "qb_change_away", "injury_edge"]


def load(preds_path: Path) -> pd.DataFrame:
    df = pd.read_csv(preds_path)
    df["home_cover_margin"] = df["result"] - df["spread_line"]
    df = df[df["home_cover_margin"] != 0].copy()  # drop pushes
    df["home_covers"] = (df["home_cover_margin"] > 0).astype(int)
    return df


def walk_forward_logistic(df: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    seasons = sorted(df["season"].unique())
    out = []
    for season in seasons:
        train = df[df["season"] < season]
        if len(train) < TRAIN_MIN:
            continue
        X_train = train[features].to_numpy(dtype=float)
        y_train = train["home_covers"].to_numpy(dtype=int)
        clf = LogisticRegression(max_iter=1000)
        clf.fit(X_train, y_train)

        test = df[df["season"] == season].copy()
        X_test = test[features].to_numpy(dtype=float)
        test["p_home_covers"] = clf.predict_proba(X_test)[:, 1]
        # probability of the model's PREFERRED side covering (whichever side
        # the point-margin model liked) -- symmetric confidence measure
        test["side"] = np.where(test["model_edge"] > 0, "home", "away")
        test["p_side_covers"] = np.where(
            test["side"] == "home", test["p_home_covers"], 1 - test["p_home_covers"]
        )
        test["side_covers"] = np.where(
            test["side"] == "home", test["home_covers"], 1 - test["home_covers"]
        )
        out.append(test)
    return pd.concat(out, ignore_index=True)


def brier(df: pd.DataFrame) -> float:
    return float(np.mean((df["p_side_covers"] - df["side_covers"]) ** 2))


def calibration_table(df: pd.DataFrame, n_buckets=5) -> pd.DataFrame:
    d = df.copy()
    d["bucket"] = pd.qcut(d["p_side_covers"], n_buckets, duplicates="drop")
    t = d.groupby("bucket", observed=True).agg(
        games=("side_covers", "size"),
        avg_predicted=("p_side_covers", "mean"),
        actual_hit_rate=("side_covers", "mean"),
    ).reset_index()
    t["bucket"] = t["bucket"].astype(str)
    return t.round(4)


def topn_by_probability(df: pd.DataFrame, n: int, min_p=0.5) -> tuple[float, int]:
    picks = []
    for (season, week), g in df.groupby(["season", "week"]):
        g = g[g["p_side_covers"] >= min_p].sort_values("p_side_covers", ascending=False)
        picks.append(g.head(n))
    picks = pd.concat(picks)
    return float(picks["side_covers"].mean()), len(picks)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preds", default="predictions_v2.csv", type=Path)
    parser.add_argument("--out-dir", default="calibration_out", type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    df = load(args.preds)
    print(f"Loaded {len(df)} non-push games")

    results = {}
    for name, features in [("edge_only", EDGE_FEATURES), ("full_feature", FULL_FEATURES)]:
        print(f"\n=== Model: {name} ({features}) ===")
        pred = walk_forward_logistic(df, features)
        b = brier(pred)
        cal = calibration_table(pred)
        print(f"games scored: {len(pred)}  Brier score: {b:.4f}  (0.25 = always guess 50%)")
        print(cal.to_string(index=False))

        topn_results = {}
        for n in [1, 2, 3, 4, 5]:
            hr, cnt = topn_by_probability(pred, n)
            topn_results[f"top_{n}_per_week"] = {"games": cnt, "hit_rate": round(hr, 4)}
            print(f"  top-{n}/week by predicted probability: games={cnt} hit_rate={hr:.4f}")

        overall_hit_rate = float(pred["side_covers"].mean())
        results[name] = {
            "games_scored": len(pred),
            "brier_score": round(b, 4),
            "overall_hit_rate_all_picks": round(overall_hit_rate, 4),
            "calibration_table": cal.to_dict(orient="records"),
            "top_n_by_probability": topn_results,
        }
        pred.to_csv(args.out_dir / f"calibrated_{name}.csv", index=False)

    (args.out_dir / "calibration_summary.json").write_text(json.dumps(results, indent=2))
    print(f"\nWrote {args.out_dir}/calibration_summary.json and calibrated_*.csv")


if __name__ == "__main__":
    main()
