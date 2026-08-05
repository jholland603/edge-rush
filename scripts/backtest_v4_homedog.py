#!/usr/bin/env python3
"""
Phase 1 backtest v4: tests whether adding a "big home dog" flag (spread_line
<= -7, i.e. home team getting 7+ points) as a regression feature on top of
the v2 model closes any of the gap to breakeven. This is the walk-forward
test that Task #27 in HANDOFF.md called for, following up on the sniff test
in the Situational Trends page that found home dogs of 7+ points cover
55.8% ATS (n=521) league-wide -- a real, sizable-sample edge on its own, but
never tested inside the actual leak-free walk-forward model before.

Reuses every function from backtest_v2.py unchanged (same ratings, same
walk-forward discipline, same scoring) -- the only difference is one added
binary feature column and re-running the same pipeline with it in FEATURES.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import backtest_v2 as bv2  # noqa: E402


def main():
    raw_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "backtest_v4_out")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading team-game pass/rush EPA ...")
    team_games = bv2.load_team_games(raw_dir)

    print("Building 4-way ratings (off/def x pass/rush) ...")
    ratings = bv2.build_ratings(team_games)

    print("Building matchup feature table (rest, weather, QB, injuries) ...")
    m = bv2.build_matchups(raw_dir, ratings)

    # The new feature: known at prediction time (it's just the market's own
    # posted spread, no leakage), same threshold as the /trends sniff test.
    m["big_home_dog"] = (m["spread_line"] <= -7).astype(int)
    print(f"  {len(m)} games with full features, {m['big_home_dog'].sum()} are big-home-dog games")

    bv2.FEATURES = bv2.FEATURES + ["big_home_dog"]

    print("Walk-forward predicting ...")
    preds = bv2.walk_forward_predict(m)
    print(f"  {len(preds)} games scored")

    print("Scoring vs. closing line ...")
    preds, flagged = bv2.score(preds)
    summary = bv2.summarize(preds, flagged)
    print(json.dumps(summary["overall"], indent=2))
    print(json.dumps(summary["avg_coefficients"], indent=2))

    dog_flagged = flagged[flagged["big_home_dog"] == 1]
    other_flagged = flagged[flagged["big_home_dog"] == 0]
    dog_summary = {
        "big_home_dog_flagged_games": len(dog_flagged),
        "big_home_dog_hit_rate": round(float(dog_flagged["model_win"].mean()), 4) if len(dog_flagged) else None,
        "other_flagged_games": len(other_flagged),
        "other_hit_rate": round(float(other_flagged["model_win"].mean()), 4) if len(other_flagged) else None,
    }
    print(json.dumps(dog_summary, indent=2))
    summary["big_home_dog_breakdown"] = dog_summary

    cols = ["season", "week", "game_id", "home_team", "away_team", "result", "spread_line",
            "predicted_margin", "model_edge"] + bv2.FEATURES
    preds[cols].to_csv(out_dir / "predictions_v4.csv", index=False)
    (out_dir / "summary_v4.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWrote {out_dir/'predictions_v4.csv'} and {out_dir/'summary_v4.json'}")


if __name__ == "__main__":
    main()
