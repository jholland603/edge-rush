#!/usr/bin/env python3
"""
Fetch a weather forecast (temp / wind / precip chance) for upcoming REG-
season games at non-dome stadiums and upsert it into D1's `weather_forecast`
table.

This is the GitHub-Actions port of the old local Cowork scheduled task
`nfl-weather-forecast-refresh` (see HANDOFF.md, "Weather forecast pipeline").
That task had to route its Open-Meteo call through the Claude-in-Chrome
browser tools because the Cowork sandbox's plain fetch tool returned empty
output against that JSON API. A GitHub Actions runner has normal outbound
internet, so this script just calls the API directly -- no such workaround
needed here.

Design, and why:
  - Window: REG games in the next 14 days (matches the old task -- Open-Meteo
    forecasts are only meaningful ~10-16 days out anyway; asking for more
    would just return nothing useful).
  - Skips permanently-domed stadiums (`roof == 'dome'`) -- weather can't
    reach the field there. Keeps outdoor stadiums AND the 5 retractable-roof
    ones (`roof` is NULL for those until the game-day decision, per
    Util.roofLabel in the site code) since the roof might end up open.
  - One row per game, always overwritten (`ON CONFLICT ... DO UPDATE`) --
    unlike odds_snapshot's append-only history, there's no value in keeping
    a stale forecast around once a fresher one exists (matches the original
    table design in HANDOFF.md).
  - Uses Open-Meteo's *daily* endpoint (temperature_2m_max /
    precipitation_probability_max / wind_speed_10m_max for the exact
    `gameday` date) rather than trying to match an hourly forecast to kickoff
    time. `games.csv`'s `gametime` field isn't reliably in stadium-local time
    across nflverse's own data, and the site only ever displays one
    temp/wind/precip figure per game (see `Util.forecastLabel`) -- a
    day-level "what kind of day is it" figure is what's actually being shown,
    so this avoids a timezone-matching bug for a distinction nobody sees.
  - Stadium lat/long isn't in games.csv -- it lives in D1's `stadium` table
    (`stadium.latitude` / `stadium.longitude`, added directly via wrangler,
    see HANDOFF.md). Rather than hardcoding 30 coordinate pairs here (a
    second copy that could drift from the source of truth), this script
    reads them straight from D1 with `wrangler d1 execute --command --json`
    before building the forecast requests.

Usage:
    python3 scripts/fetch_weather_forecast.py --sql-out /tmp/weather.sql
    python3 scripts/fetch_weather_forecast.py   # reads stadium coords from D1, applies via wrangler

Requires `wrangler` on PATH and a working Cloudflare auth (env vars
CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, same as every other script in
this pipeline) -- needed either way, since even --sql-out mode has to read
stadium coordinates from D1 first.
"""

import argparse
import json
import subprocess
import tempfile
import urllib.request
import urllib.error
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

import pandas as pd

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_WINDOW_DAYS = 14


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    try:
        if pd.isna(v):
            return "NULL"
    except TypeError:
        pass
    return str(v)


def run_wrangler_json(args_list):
    """Run a wrangler command that prints --json output and return the
    parsed result. Raises SystemExit with wrangler's own stderr on failure
    -- same "let the real error surface" approach as the rest of this
    pipeline; nothing here is worth silently swallowing."""
    cmd = ["wrangler", *args_list]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"wrangler command failed: {' '.join(cmd)}\n{proc.stderr}")
    return json.loads(proc.stdout)


def fetch_stadium_coords(db_name):
    """{stadium_id: (latitude, longitude)} for every stadium D1 has
    coordinates for."""
    result = run_wrangler_json([
        "d1", "execute", db_name, "--remote", "--json",
        "--command", "SELECT stadium_id, latitude, longitude FROM stadium "
                      "WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
    ])
    rows = result[0]["results"]
    return {r["stadium_id"]: (r["latitude"], r["longitude"]) for r in rows}


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


def load_upcoming_games(games_csv_path, window_days):
    games = pd.read_csv(games_csv_path, low_memory=False)
    today = date.today()
    horizon = today + timedelta(days=window_days)
    games["gameday_date"] = pd.to_datetime(games["gameday"]).dt.date

    upcoming = games[
        (games["game_type"] == "REG")
        & games["result"].isna()
        & (games["gameday_date"] >= today)
        & (games["gameday_date"] <= horizon)
        & (games["roof"].str.lower() != "dome")  # NaN stays in (retractable/unknown)
    ]
    return upcoming[["game_id", "gameday_date", "stadium_id", "roof"]]


def fetch_forecast(lat, lon, game_date):
    date_str = game_date.isoformat()
    params = (
        f"?latitude={lat}&longitude={lon}"
        f"&daily=temperature_2m_max,precipitation_probability_max,wind_speed_10m_max"
        f"&temperature_unit=fahrenheit&wind_speed_unit=mph"
        f"&start_date={date_str}&end_date={date_str}&timezone=auto"
    )
    req = urllib.request.Request(OPEN_METEO_URL + params)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  Open-Meteo request failed for ({lat}, {lon}) on {date_str}: {e.code} {e.reason} -- {body}")
        return None
    except urllib.error.URLError as e:
        print(f"  Open-Meteo request failed for ({lat}, {lon}) on {date_str}: {e}")
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games-csv", default="raw/games.csv", type=Path)
    parser.add_argument("--window-days", type=int, default=FORECAST_WINDOW_DAYS)
    parser.add_argument("--db-name", default="edge-rush")
    parser.add_argument("--sql-out", type=Path, default=None,
                         help="Write generated SQL here instead of applying it via "
                              "`wrangler d1 execute`. Stadium coordinates are still read "
                              "live from D1 either way.")
    args = parser.parse_args()

    print(f"Loading upcoming REG games from {args.games_csv} "
          f"(next {args.window_days} days, non-dome stadiums)...")
    upcoming = load_upcoming_games(args.games_csv, args.window_days)
    print(f"  {len(upcoming)} game(s) in window")

    if upcoming.empty:
        print("Nothing to do.")
        if args.sql_out:
            args.sql_out.parent.mkdir(parents=True, exist_ok=True)
            args.sql_out.write_text("")
        return

    print("Reading stadium coordinates from D1...")
    coords = fetch_stadium_coords(args.db_name)
    print(f"  {len(coords)} stadium(s) with known coordinates")

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    upsert_stmts = []
    skipped_no_coords, skipped_no_data = [], []

    for _, row in upcoming.iterrows():
        game_id = row["game_id"]
        stadium_id = row["stadium_id"]
        game_date = row["gameday_date"]

        latlon = coords.get(stadium_id)
        if not latlon:
            skipped_no_coords.append(f"{game_id} (stadium_id={stadium_id})")
            continue

        lat, lon = latlon
        data = fetch_forecast(lat, lon, game_date)
        daily = (data or {}).get("daily", {})
        temps = daily.get("temperature_2m_max") or []
        winds = daily.get("wind_speed_10m_max") or []
        precips = daily.get("precipitation_probability_max") or []
        if not temps:
            skipped_no_data.append(f"{game_id} ({game_date}, {args.window_days}-day window "
                                    f"-- Open-Meteo forecasts only reach out ~16 days)")
            continue

        upsert_stmts.append(
            "INSERT INTO weather_forecast "
            "(game_id, forecast_temp, forecast_wind, forecast_precip_prob, fetched_at, source) "
            f"VALUES ({sql_str(game_id)}, {sql_num(temps[0])}, {sql_num(winds[0] if winds else None)}, "
            f"{sql_num(precips[0] if precips else None)}, {sql_str(fetched_at)}, {sql_str('open-meteo')}) "
            "ON CONFLICT(game_id) DO UPDATE SET "
            "forecast_temp=excluded.forecast_temp, "
            "forecast_wind=excluded.forecast_wind, "
            "forecast_precip_prob=excluded.forecast_precip_prob, "
            "fetched_at=excluded.fetched_at, "
            "source=excluded.source;"
        )

    print(f"\n{len(upsert_stmts)} forecast(s) to upsert")
    if skipped_no_coords:
        print(f"{len(skipped_no_coords)} game(s) skipped -- no stadium coordinates in D1:")
        for s in skipped_no_coords:
            print(f"  - {s}")
    if skipped_no_data:
        print(f"{len(skipped_no_data)} game(s) skipped -- Open-Meteo had no forecast yet (not an error, too far out):")
        for s in skipped_no_data:
            print(f"  - {s}")

    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text("\n".join(upsert_stmts) + ("\n" if upsert_stmts else ""))
        print(f"\nWrote statements to {args.sql_out} (not applied -- apply it yourself)")
    else:
        print("\nApplying to D1...")
        run_d1_statements(upsert_stmts, args.db_name)

    print("\nDone.")


if __name__ == "__main__":
    main()
