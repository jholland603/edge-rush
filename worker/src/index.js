/**
 * edge-rush API worker -- serves the site's games/teams/players/compare pages
 * from the D1 database instead of the static data/*.json tree.
 *
 * Routes (all GET, JSON responses):
 *   /index                              -- replaces index.json
 *   /games/:season                      -- replaces data/games/{season}.json
 *   /teams/:season                      -- replaces data/teams/{season}.json
 *   /players/season/:season             -- replaces data/players/season/{season}.json
 *   /players/career/:playerId           -- replaces data/players/career/{playerId}.json
 *   /players/career/:playerId?from=YYYY&to=YYYY
 *                                        -- same shape, totals restricted to that
 *                                           inclusive season range (the compare-page
 *                                           year-range filter this whole D1 migration
 *                                           was originally for)
 *
 * The `model/*.json` and `log/picks_log.json` data is NOT covered here -- that's
 * Phase 2/3 (weekly automation, live tracking) data that was never migrated into
 * D1, and index.html / picks.html still read those static files directly. See
 * HANDOFF.md for the reasoning.
 *
 * CORS is wide open (`*`) since this only ever serves public, read-only NFL
 * stats -- no auth, no per-user data, nothing sensitive to restrict access to.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // Static data that only changes when someone re-runs the import --
      // fine for the browser (and any CDN in front of this Worker) to cache
      // for a few minutes rather than hit D1 on every page view.
      "Cache-Control": "public, max-age=300",
    },
  });
}

function notFound(message = "not found") {
  return json({ error: message }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const DB = env.DB;

    try {
      if (path === "/" || path === "") {
        return json({ ok: true, service: "edge-rush-api" });
      }

      if (path === "/index") {
        return json(await getIndex(DB));
      }

      let m;
      if ((m = path.match(/^\/games\/(\d{4})$/))) {
        return json(await getGamesSeason(DB, Number(m[1])));
      }
      if ((m = path.match(/^\/teams\/(\d{4})$/))) {
        return json(await getTeamsSeason(DB, Number(m[1])));
      }
      if ((m = path.match(/^\/players\/season\/(\d{4})$/))) {
        return json(await getPlayersSeason(DB, Number(m[1])));
      }
      if ((m = path.match(/^\/players\/career\/([^/]+)$/))) {
        const playerId = decodeURIComponent(m[1]);
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const career = await getPlayerCareer(DB, playerId, from, to);
        if (!career) return notFound(`no data for player ${playerId}`);
        return json(career);
      }

      return notFound();
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// /index -- lookup: available seasons per data type, team list, and every
// player's display name / most-recent position / seasons played (mirrors
// index.json's shape so the site's search-by-name UI needs no changes).
// ---------------------------------------------------------------------------
async function getIndex(DB) {
  const [gamesSeasons, teamSeasons, playerSeasons, teams, playerRows] = await Promise.all([
    DB.prepare("SELECT DISTINCT season FROM game ORDER BY season").all(),
    DB.prepare(
      "SELECT DISTINCT g.season AS season FROM team_game tg JOIN game g ON g.game_id = tg.game_id ORDER BY season"
    ).all(),
    DB.prepare(
      "SELECT DISTINCT g.season AS season FROM player_game pg JOIN game g ON g.game_id = pg.game_id ORDER BY season"
    ).all(),
    DB.prepare("SELECT team_abbr FROM team ORDER BY team_abbr").all(),
    // Single pass over player_game+game for "most recent position" (window
    // function, not a per-player correlated subquery -- with 11,366 players
    // that would be 11,366 separate scans instead of one) and a second pass
    // for the distinct-seasons list, joined together at the end.
    DB.prepare(
      `
      WITH ranked AS (
        SELECT pg.player_id, pg.position_code,
               ROW_NUMBER() OVER (PARTITION BY pg.player_id ORDER BY g.season DESC, g.week DESC) AS rn
        FROM player_game pg JOIN game g ON g.game_id = pg.game_id
      ),
      seasons AS (
        SELECT pg.player_id, GROUP_CONCAT(DISTINCT g.season) AS seasons_csv
        FROM player_game pg JOIN game g ON g.game_id = pg.game_id
        GROUP BY pg.player_id
      )
      SELECT p.player_id, p.display_name AS name, r.position_code AS position, s.seasons_csv
      FROM player p
      JOIN seasons s ON s.player_id = p.player_id
      LEFT JOIN ranked r ON r.player_id = p.player_id AND r.rn = 1
      `
    ).all(),
  ]);

  const players = {};
  for (const row of playerRows.results) {
    players[row.player_id] = {
      name: row.name,
      position: row.position,
      seasons: row.seasons_csv
        ? row.seasons_csv.split(",").map(Number).sort((a, b) => a - b)
        : [],
    };
  }

  return {
    updated: new Date().toISOString(),
    seasons: {
      games: gamesSeasons.results.map((r) => r.season),
      teams: teamSeasons.results.map((r) => r.season),
      players: playerSeasons.results.map((r) => r.season),
    },
    teams: teams.results.map((r) => r.team_abbr),
    player_count: playerRows.results.length,
    players,
  };
}

// ---------------------------------------------------------------------------
// /games/:season -- straight from the `game` table, one row per game.
// ---------------------------------------------------------------------------
async function getGamesSeason(DB, season) {
  const { results } = await DB.prepare(
    `
    SELECT game_id, season, week, game_type_code AS game_type, gameday, weekday, gametime,
           home_team, away_team, home_score, away_score, result, total, overtime,
           home_rest, away_rest, div_game, roof, surface, temp, wind,
           home_qb_id, away_qb_id, stadium_id,
           spread_line, home_spread_odds, away_spread_odds, total_line,
           over_odds, under_odds, home_moneyline, away_moneyline
    FROM game
    WHERE season = ?
    ORDER BY week, game_id
    `
  )
    .bind(season)
    .all();

  return {
    season,
    updated: new Date().toISOString(),
    game_count: results.length,
    games: results,
  };
}

// ---------------------------------------------------------------------------
// /teams/:season -- every team_game row for the season, all 4 category
// tables joined in, grouped by team (mirrors data/teams/{season}.json).
// ---------------------------------------------------------------------------
async function getTeamsSeason(DB, season) {
  const { results } = await DB.prepare(
    `
    SELECT tg.team, tg.opponent_team, g.week, g.game_type_code AS season_type, tg.game_id,
           o.*, d.*, s.*, m.*
    FROM team_game tg
    JOIN game g ON g.game_id = tg.game_id
    LEFT JOIN team_game_offense o ON o.team_game_id = tg.team_game_id
    LEFT JOIN team_game_defense d ON d.team_game_id = tg.team_game_id
    LEFT JOIN team_game_special_teams s ON s.team_game_id = tg.team_game_id
    LEFT JOIN team_game_misc m ON m.team_game_id = tg.team_game_id
    WHERE g.season = ?
    ORDER BY tg.team, g.week
    `
  )
    .bind(season)
    .all();

  const teams = {};
  for (const row of results) {
    const { team, ...rest } = row;
    delete rest.team_game_id; // join-key column, duplicated across o/d/s/m, not needed in output
    (teams[team] ||= []).push(rest);
  }

  return {
    season,
    updated: new Date().toISOString(),
    team_count: Object.keys(teams).length,
    teams,
  };
}

// ---------------------------------------------------------------------------
// /players/season/:season -- every player_game row for the season, all 4
// category tables joined in, grouped by player (mirrors
// data/players/season/{season}.json). Display names are fetched in one
// batched follow-up query rather than joining `player` per row.
// ---------------------------------------------------------------------------
async function getPlayersSeason(DB, season) {
  const { results } = await DB.prepare(
    `
    SELECT pg.player_id, pg.position_code AS position, pg.team, pg.opponent_team,
           g.week, g.game_type_code AS season_type, pg.game_id,
           o.*, d.*, s.*, m.*
    FROM player_game pg
    JOIN game g ON g.game_id = pg.game_id
    LEFT JOIN player_game_offense o ON o.player_game_id = pg.player_game_id
    LEFT JOIN player_game_defense d ON d.player_game_id = pg.player_game_id
    LEFT JOIN player_game_special_teams s ON s.player_game_id = pg.player_game_id
    LEFT JOIN player_game_misc m ON m.player_game_id = pg.player_game_id
    WHERE g.season = ?
    ORDER BY pg.player_id, g.week
    `
  )
    .bind(season)
    .all();

  const players = {};
  for (const row of results) {
    const { player_id, position, ...rest } = row;
    delete rest.player_game_id;
    let p = players[player_id];
    if (!p) {
      // "current team" for the season header = the team on this player's
      // first game that season (matches the original build_json.py logic).
      p = { player_display_name: null, position, team: row.team, weeks: [] };
      players[player_id] = p;
    }
    p.weeks.push(rest);
  }

  const ids = Object.keys(players);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const { results: names } = await DB.prepare(
      `SELECT player_id, display_name FROM player WHERE player_id IN (${placeholders})`
    )
      .bind(...ids)
      .all();
    for (const n of names) {
      if (players[n.player_id]) players[n.player_id].player_display_name = n.display_name;
    }
  }

  return {
    season,
    updated: new Date().toISOString(),
    player_count: ids.length,
    players,
  };
}

// ---------------------------------------------------------------------------
// /players/career/:playerId[?from=YYYY&to=YYYY] -- aggregated totals across
// the player's whole career, or a specific inclusive season range when
// from/to are given (this is the compare-page year-range filter). Uses the
// v_player_season_* views (which already SUM per season) for offense/defense/
// special_teams, since those expose a `season` column to filter on; misc has
// no view, so it's a direct join+SUM instead.
// ---------------------------------------------------------------------------
async function getPlayerCareer(DB, playerId, from, to) {
  const hasRange = from && to;
  const fromY = hasRange ? Number(from) : 1900;
  const toY = hasRange ? Number(to) : 2100;

  const player = await DB.prepare("SELECT player_id, display_name FROM player WHERE player_id = ?")
    .bind(playerId)
    .first();
  if (!player) return null;

  const [offense, defense, special, misc, teamsRows, seasonsRows, posRow, gamesRow] = await Promise.all([
    DB.prepare(
      `
      SELECT SUM(completions) completions, SUM(attempts) attempts, SUM(passing_yards) passing_yards,
             SUM(passing_tds) passing_tds, SUM(passing_interceptions) passing_interceptions,
             SUM(sacks_suffered) sacks_suffered, SUM(passing_air_yards) passing_air_yards,
             SUM(passing_first_downs) passing_first_downs, SUM(passing_epa) passing_epa,
             SUM(passing_2pt_conversions) passing_2pt_conversions,
             SUM(carries) carries, SUM(rushing_yards) rushing_yards, SUM(rushing_tds) rushing_tds,
             SUM(rushing_first_downs) rushing_first_downs, SUM(rushing_epa) rushing_epa,
             SUM(rushing_2pt_conversions) rushing_2pt_conversions,
             SUM(receptions) receptions, SUM(targets) targets, SUM(receiving_yards) receiving_yards,
             SUM(receiving_tds) receiving_tds, SUM(receiving_first_downs) receiving_first_downs,
             SUM(receiving_epa) receiving_epa, SUM(receiving_2pt_conversions) receiving_2pt_conversions,
             SUM(fantasy_points) fantasy_points, SUM(fantasy_points_ppr) fantasy_points_ppr
      FROM v_player_season_offense WHERE player_id = ? AND season BETWEEN ? AND ?
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `
      SELECT SUM(def_tackles_solo) def_tackles_solo, SUM(def_tackle_assists) def_tackle_assists,
             SUM(def_tackles_for_loss) def_tackles_for_loss, SUM(def_fumbles_forced) def_fumbles_forced,
             SUM(def_sacks) def_sacks, SUM(def_sack_yards) def_sack_yards, SUM(def_qb_hits) def_qb_hits,
             SUM(def_interceptions) def_interceptions, SUM(def_interception_yards) def_interception_yards,
             SUM(def_pass_defended) def_pass_defended, SUM(def_tds) def_tds, SUM(def_safeties) def_safeties
      FROM v_player_season_defense WHERE player_id = ? AND season BETWEEN ? AND ?
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `
      SELECT SUM(fg_made) fg_made, SUM(fg_att) fg_att, SUM(fg_missed) fg_missed, SUM(fg_blocked) fg_blocked,
             SUM(pat_made) pat_made, SUM(pat_att) pat_att, SUM(gwfg_made) gwfg_made,
             SUM(pt_att) pt_att, SUM(pt_yards) pt_yards, SUM(pt_net_yards) pt_net_yards, SUM(pt_inside_20) pt_inside_20,
             SUM(punt_returns) punt_returns, SUM(punt_return_yards) punt_return_yards,
             SUM(kickoff_returns) kickoff_returns, SUM(kickoff_return_yards) kickoff_return_yards
      FROM v_player_season_special_teams WHERE player_id = ? AND season BETWEEN ? AND ?
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `
      SELECT SUM(m.penalties) penalties, SUM(m.penalty_yards) penalty_yards,
             SUM(m.fumble_recovery_own) fumble_recovery_own, SUM(m.fumble_recovery_yards_own) fumble_recovery_yards_own,
             SUM(m.fumble_recovery_opp) fumble_recovery_opp, SUM(m.fumble_recovery_yards_opp) fumble_recovery_yards_opp,
             SUM(m.fumble_recovery_tds) fumble_recovery_tds, SUM(m.misc_yards) misc_yards,
             SUM(m.fumbles_forced_by_opp) fumbles_forced_by_opp, SUM(m.fumbles_not_forced) fumbles_not_forced,
             SUM(m.fumbles_out_of_bounds) fumbles_out_of_bounds, SUM(m.fumbles_total) fumbles_total,
             SUM(m.fumbles_lost_total) fumbles_lost_total, SUM(m.special_teams_tds) special_teams_tds
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN player_game_misc m ON m.player_game_id = pg.player_game_id
      WHERE pg.player_id = ? AND g.season BETWEEN ? AND ?
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `SELECT DISTINCT pg.team FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ORDER BY pg.team`
    )
      .bind(playerId, fromY, toY)
      .all(),
    DB.prepare(
      `SELECT DISTINCT g.season FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ORDER BY g.season`
    )
      .bind(playerId, fromY, toY)
      .all(),
    DB.prepare(
      `SELECT pg.position_code FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ?
       ORDER BY g.season DESC, g.week DESC LIMIT 1`
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `SELECT COUNT(*) AS n FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ?`
    )
      .bind(playerId, fromY, toY)
      .first(),
  ]);

  const seasons = seasonsRows.results.map((r) => r.season);
  if (!seasons.length) return null; // player exists in the dimension table but has no games in this range

  const career_totals = { ...offense, ...defense, ...special, ...misc };
  for (const k of Object.keys(career_totals)) {
    // SUM() over zero matching rows (e.g. a lineman has no offense rows at
    // all) comes back NULL, not 0 -- normalize so the site's stat-card logic
    // (which checks `=== null` to mean "don't show this card") only sees
    // null for genuinely position-inapplicable stats, not this artifact.
    if (career_totals[k] === null) career_totals[k] = 0;
  }

  return {
    player_id: playerId,
    player_display_name: player.display_name,
    position: posRow ? posRow.position_code : null,
    teams: teamsRows.results.map((r) => r.team),
    seasons,
    games_played: gamesRow.n,
    updated: new Date().toISOString(),
    career_totals,
  };
}
