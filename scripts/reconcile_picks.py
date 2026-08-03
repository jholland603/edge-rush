#!/usr/bin/env python3
"""
Phase 3: reconcile the D1 `picks_log` table against games that have since
been played.

The log written by weekly_update.py is "locked in" the moment it's written --
this script only ever fills in the closing_line, actual_result, clv, side,
and covered columns for rows that don't have a result yet. It never touches
logged_at, market_spread, model_spread, or edge (the frozen, at-the-time-of-
flag values), which is the whole point of a pick log: you can't quietly
rewrite what you predicted.

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

D1 access: this script shells out to `wrangler d1 execute --remote`, the
same CLI already used for the historical import (see d1/import.ps1) and by
weekly_update.py. You must have already run `wrangler login` once.
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    if isinstance(v, float) and np.isnan(v):
        return "NULL"
    return str(v)


def run_d1_statements(statements, db_name):
    if not statements:
        return
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".sql", delete=False, encoding="utf-8"
    ) as f:
        f.write("\n".join(statements))
        tmp_path = Path(f.name)
    try:
        cmd = ["wrangler", "d1", "execute", db_name, "--remote", f"--file={tmp_path}"]
        print(f"  running: {' '.join(cmd)}  ({len(statements)} statement(s))")
        subprocess.run(cmd, check=True)
    finally:
        tmp_path.unlink(missing_ok=True)


def d1_query(sql, db_name):
    """Run a read-only query via `wrangler d1 execute --remote --json` and
    return the list of result rows (dicts)."""
    cmd = ["wrangler", "d1", "execute", db_name, "--remote", "--json", f"--command={sql}"]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    parsed = json.loads(result.stdout)
    return parsed[0]["results"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw", type=Path)
    parser.add_argument("--db-name", default="edge-rush",
                         help="D1 database name (wrangler.toml database_name)")
    parser.add_argument("--pending-json", type=Path, default=None,
                         help="Read the list of picks_log rows awaiting a result from this "
                              "JSON file (list of {game_id, market_spread, model_spread}) "
                              "instead of querying D1 via wrangler. Use this in a Cowork "
                              "scheduled task, where you fetch that list yourself via the "
                              "D1 MCP tool first.")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated UPDATE statements here instead of applying "
                              "them via `wrangler d1 execute`. Pairs with --pending-json.")
    args = parser.parse_args()

    if args.pending_json:
        print(f"Reading pending picks_log rows from {args.pending_json}...")
        pending = json.loads(args.pending_json.read_text())
    else:
        print("Fetching picks_log rows still awaiting a result from D1...")
        pending = d1_query(
            "SELECT game_id, market_spread, model_spread FROM picks_log "
            "WHERE actual_result IS NULL;",
            args.db_name,
        )
    print(f"{len(pending)} logged picks still awaiting a result")

    if not pending:
        print("Nothing to reconcile.")
        return

    games = pd.read_csv(args.raw_dir / "games.csv", low_memory=False).set_index("game_id")

    update_stmts = []
    updated = 0
    for row in pending:
        gid = row["game_id"]
        if gid not in games.index:
            continue
        g = games.loc[gid]
        if pd.isna(g["result"]):
            continue  # still not played

        closing_line = float(g["spread_line"]) if pd.notna(g["spread_line"]) else None
        result = float(g["result"])
        market_spread = float(row["market_spread"])
        model_spread = float(row["model_spread"])
        side = "home" if model_spread > market_spread else "away"

        clv = None
        if closing_line is not None:
            clv = round(
                (closing_line - market_spread) if side == "home" else (market_spread - closing_line),
                2,
            )

        cover_margin = result - (closing_line if closing_line is not None else market_spread)
        covered = None
        row_side = None
        if cover_margin != 0:  # skip push
            row_side = side
            covered = (cover_margin > 0) if side == "home" else (cover_margin < 0)

        update_stmts.append(
            "UPDATE picks_log SET "
            f"closing_line={sql_num(closing_line)}, actual_result={sql_num(result)}, "
            f"clv={sql_num(clv)}, side={sql_str(row_side)}, "
            f"covered={('NULL' if covered is None else ('1' if covered else '0'))} "
            f"WHERE game_id={sql_str(gid)};"
        )
        updated += 1

    print(f"\n{updated} pick(s) newly reconciled...")
    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("\n".join(update_stmts) + ("\n" if update_stmts else ""))
        print(f"  wrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        print("Applying to D1...")
        run_d1_statements(update_stmts, args.db_name)

        if updated:
            print("Fetching updated career stats from D1...")
            graded = d1_query(
                "SELECT clv, covered FROM picks_log WHERE actual_result IS NOT NULL AND covered IS NOT NULL;",
                args.db_name,
            )
            if graded:
                hit_rate = sum(1 for r in graded if r["covered"]) / len(graded)
                clv_vals = [r["clv"] for r in graded if r["clv"] is not None]
                avg_clv = sum(clv_vals) / len(clv_vals) if clv_vals else float("nan")
                print(f"Career so far: {len(graded)} graded picks, hit rate {hit_rate:.1%}, "
                      f"avg CLV {avg_clv:+.2f} pts")
                print("(Still far short of the ~270-game minimum sample the project's own "
                      "instructions call for before drawing any conclusion from this.)")

    print("\nDone.")


if __name__ == "__main__":
    main()
