#!/usr/bin/env python3
"""Does a model using ONLY the rating (pass_edge/rush_edge) -- no QB
availability, rest, weather, or injury features -- do better or worse if
that rating is the recency+similarity-weighted version instead of the flat
rolling-10? Jeff's direct question: what if we used ONLY the weighted
rating as the whole model, not as an addition to the existing feature set."""
import pickle, sys, json
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, ".")
import backtest_v2 as bv2

with open("/tmp/v7_state.pkl", "rb") as f:
    state = pickle.load(f)
with open("/tmp/v7_results.pkl", "rb") as f:
    results = pickle.load(f)

print("Building EWMA baseline matchup table (has result/spread_line/rest/wind/etc)...")
ewma_ratings = bv2.build_ratings(state["team_games"])
ewma_m = bv2.build_matchups(Path("raw"), ewma_ratings)

combo_edges = results["combined_0.5x_std"][["game_id", "home_team", "away_team", "pass_edge", "rush_edge"]].rename(
    columns={"pass_edge": "pass_edge_combo", "rush_edge": "rush_edge_combo"}
)
combined_m = ewma_m.merge(combo_edges, on=["game_id", "home_team", "away_team"], how="inner").dropna(
    subset=["pass_edge_combo", "rush_edge_combo"]
)
print(f"{len(combined_m)} games with both flat and weighted ratings")

def run(features, label, m):
    bv2.FEATURES = features
    preds = bv2.walk_forward_predict(m)
    preds, flagged = bv2.score(preds)
    summary = bv2.summarize(preds, flagged)
    print(f"\n=== {label} ===")
    print(json.dumps(summary["overall"], indent=2))
    print("avg coefficients:", json.dumps(summary["avg_coefficients"], indent=2))
    return summary

out = {}
out["flat_rating_only"] = run(["pass_edge", "rush_edge"], "FLAT rating only (pass_edge, rush_edge) -- no QB/rest/weather/injury", combined_m)
out["weighted_rating_only"] = run(["pass_edge_combo", "rush_edge_combo"], "WEIGHTED rating only (recency+similarity) -- no QB/rest/weather/injury", combined_m)
out["flat_full_8_features"] = run(["pass_edge", "rush_edge", "rest_diff", "wind", "dome", "qb_change_home", "qb_change_away", "injury_edge"], "FLAT rating + full feature set (current production)", combined_m)
out["weighted_full_8_features"] = run(["pass_edge_combo", "rush_edge_combo", "rest_diff", "wind", "dome", "qb_change_home", "qb_change_away", "injury_edge"], "WEIGHTED rating (swapped in) + full feature set", combined_m)

Path("backtest_v8_out").mkdir(exist_ok=True)
with open("backtest_v8_out/summary_v8.json", "w") as f:
    json.dump({k: v["overall"] for k, v in out.items()}, f, indent=2, default=str)
print("\nWrote backtest_v8_out/summary_v8.json")
