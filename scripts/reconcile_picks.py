#!/usr/bin/env python3
"""
Phase 3: reconcile the picks log against games that have since been played.

The log written by weekly_update.py is "locked in" the moment it's written --
this script only ever ADDS the closing_line, actual_result, and clv columns
for rows that don't have them yet. It never touches logged_at, market_spread,
model_spread, or edge (the frozen, at-the-time-of-flag values), which is the
whole point of a pick log: you can't quietly rewrite what you predicted.

closing_line: re-reads games.csv for that game_id. Since nflverse's
spread_line settles at the closing number once a game has been played, this
captures how the market moved between when the game was flagged (market_spread)
and kickoff.

clv (closing line value): positive means the line moved TOWARD the model's
side after it was flagged -- a sign of getting a number better than the
market eventually offered, independent of whether the bet would have won.
Computed from the model's preferred side's perspective:
  side = home if model_spread > market_spread (at flag time) else away
  clv  = (closing_line - market_spread) if side == home
         else (market_spread - closing_line)

actual_result: home_score - away_score once known, plus whether the model's
preferred side actually covered the CLOSING line.

Run this any time -- it's a no-op for games that haven't been played yet.
"""

import argparse
from pathlib import Path

import numpy as np
import pandas as pd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--log-csv", default="backtest/picks_log.csv", type=Path)
    args = parser.parse_args()

    if not args.log_csv.exists():
        print(f"No log at {args.log_csv} -- nothing to reconcile.")
        return

    log = pd.read_csv(args.log_csv)
    games = pd.read_csv(args.raw_dir / "games.csv", low_memory=False)
    games = games.set_index("game_id")

    to_fill = log["actual_result"].isna()
    print(f"{to_fill.sum()} of {len(log)} logged picks still awaiting a result")

    updated = 0
    for i in log[to_fill].index:
        gid = log.at[i, "game_id"]
        if gid not in games.index:
            continue
        g = games.loc[gid]
        if pd.isna(g["result"]):
            continue  # still not played

        closing_line = float(g["spread_line"]) if pd.notna(g["spread_line"]) else None
        result = float(g["result"])
        market_spread = float(log.at[i, "market_spread"])
        model_spread = float(log.at[i, "model_spread"])
        side = "home" if model_spread > market_spread else "away"

        log.at[i, "closing_line"] = closing_line
        log.at[i, "actual_result"] = result

        if closing_line is not None:
            clv = (closing_line - market_spread) if side == "home" else (market_spread - closing_line)
            log.at[i, "clv"] = round(clv, 2)

        cover_margin = result - (closing_line if closing_line is not None else market_spread)
        if cover_margin != 0:  # skip push
            covered = (cover_margin > 0) if side == "home" else (cover_margin < 0)
            log.at[i, "side"] = side
            log.at[i, "covered"] = covered
        updated += 1

    log.to_csv(args.log_csv, index=False)
    (args.data_dir / "log").mkdir(parents=True, exist_ok=True)
    log.to_json(args.data_dir / "log" / "picks_log.json", orient="records", indent=2)

    reconciled = log.dropna(subset=["actual_result"])
    if len(reconciled) and "covered" in reconciled.columns:
        graded = reconciled.dropna(subset=["covered"])
        if len(graded):
            hit_rate = graded["covered"].mean()
            avg_clv = graded["clv"].mean() if "clv" in graded.columns else float("nan")
            print(f"\n{updated} picks newly reconciled this run.")
            print(f"Career so far: {len(graded)} graded picks, hit rate {hit_rate:.1%}, avg CLV {avg_clv:+.2f} pts")
            print("(Still far short of the ~270-game minimum sample the project's own instructions call for "
                  "before drawing any conclusion from this.)")
    print(f"\nWrote {args.log_csv} and data/log/picks_log.json")


if __name__ == "__main__":
    main()
