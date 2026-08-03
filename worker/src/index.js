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
 *   /model/manifest                     -- replaces data/model/manifest.json
 *   /model/:season/:week                -- replaces data/model/{season}-week{week}.json
 *   /model/season/:season               -- every model row for a season, keyed by game_id
 *                                           (used to overlay predicted edge on the schedule page)
 *   /picks                              -- replaces data/log/picks_log.json
 *   /game/:gameId                       -- single-game detail: the game row, its model
 *                                           prediction (if any), each team's season-to-date
 *                                           (before this game) and full-season stat totals,
 *                                           and head-to-head history between the two teams
 *   /trends                             -- situational ATS trends (home dogs by size,
 *                                           rest-advantage buckets, divisional vs. not),
 *                                           full 1999-present history, used by trends.html
 *
 * model/picks_log are written by scripts/weekly_update.py and
 * scripts/reconcile_picks.py (both rewired to write D1 directly via
 * `wrangler d1 execute --remote`, see HANDOFF.md).
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

      if (path === "/model/manifest") {
        return json(await getModelManifest(DB));
      }
      if ((m = path.match(/^\/model\/(\d{4})\/(\d{1,2})$/))) {
        const week = await getModelWeek(DB, Number(m[1]), Number(m[2]));
        if (!week) return notFound(`no model data for ${m[1]} week ${m[2]}`);
        return json(week);
      }
      if (path === "/picks") {
        return json(await getPicksLog(DB));
      }

      if ((m = path.match(/^\/model\/season\/(\d{4})$/))) {
        return json(await getModelSeason(DB, Number(m[1])));
      }
      if ((m = path.match(/^\/game\/([^/]+)$/))) {
        const detail = await getGameDetail(DB, decodeURIComponent(m[1]));
        if (!detail) return notFound(`no game ${m[1]}`);
        return json(detail);
      }

      if (path === "/trends") {
        return json(await getTrends(DB));
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
    DB.prepare("SELECT team_abbr, team_name FROM team ORDER BY team_abbr").all(),
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

  const team_names = {};
  for (const row of teams.results) team_names[row.team_abbr] = row.team_name;

  return {
    updated: new Date().toISOString(),
    seasons: {
      games: gamesSeasons.results.map((r) => r.season),
      teams: teamSeasons.results.map((r) => r.season),
      players: playerSeasons.results.map((r) => r.season),
    },
    teams: teams.results.map((r) => r.team_abbr),
    team_names,
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
    SELECT g.game_id, g.season, g.week, g.game_type_code AS game_type, g.gameday, g.weekday, g.gametime,
           g.home_team, g.away_team, g.home_score, g.away_score, g.result, g.total, g.overtime,
           g.home_rest, g.away_rest, g.div_game, g.roof, g.surface, g.temp, g.wind,
           g.home_qb_id, g.away_qb_id, g.stadium_id,
           g.spread_line, g.home_spread_odds, g.away_spread_odds, g.total_line,
           g.over_odds, g.under_odds, g.home_moneyline, g.away_moneyline,
           wf.forecast_temp, wf.forecast_wind, wf.forecast_precip_prob, wf.fetched_at AS forecast_fetched_at
    FROM game g
    LEFT JOIN weather_forecast wf ON wf.game_id = g.game_id
    WHERE g.season = ?
    ORDER BY g.week, g.game_id
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
//
// NOTE: this used to be a single query with `o.*, d.*, s.*, m.*` all joined
// together. That blew past SQLite/D1's limit on columns in one result set
// (133+ columns across the 4 wide category tables) and every request 500'd
// with "too many columns in result set" -- confirmed directly against D1.
// Fixed by running 5 narrower queries (hub + one per category table, each
// well under the limit) and merging them here by team_game_id instead.
// ---------------------------------------------------------------------------
async function getTeamsSeason(DB, season) {
  const [hub, offense, defense, special, misc] = await Promise.all([
    DB.prepare(
      `SELECT tg.team_game_id, tg.team, tg.opponent_team, g.week, g.game_type_code AS season_type, tg.game_id,
              CASE WHEN tg.team = g.home_team THEN 1 ELSE 0 END AS is_home
       FROM team_game tg JOIN game g ON g.game_id = tg.game_id
       WHERE g.season = ? ORDER BY tg.team, g.week`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT o.* FROM team_game_offense o
       JOIN team_game tg ON tg.team_game_id = o.team_game_id JOIN game g ON g.game_id = tg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT d.* FROM team_game_defense d
       JOIN team_game tg ON tg.team_game_id = d.team_game_id JOIN game g ON g.game_id = tg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT s.* FROM team_game_special_teams s
       JOIN team_game tg ON tg.team_game_id = s.team_game_id JOIN game g ON g.game_id = tg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT m.* FROM team_game_misc m
       JOIN team_game tg ON tg.team_game_id = m.team_game_id JOIN game g ON g.game_id = tg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
  ]);

  const byId = new Map();
  const teamById = new Map();
  for (const row of hub.results) {
    const { team_game_id, team, ...rest } = row;
    byId.set(team_game_id, { ...rest, is_home: !!row.is_home });
    teamById.set(team_game_id, team);
  }
  for (const catResult of [offense, defense, special, misc]) {
    for (const row of catResult.results) {
      const { team_game_id, ...rest } = row;
      const target = byId.get(team_game_id);
      if (target) Object.assign(target, rest);
    }
  }

  const teams = {};
  for (const [id, row] of byId) {
    (teams[teamById.get(id)] ||= []).push(row);
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
//
// Same fix as getTeamsSeason above: 5 narrower queries (hub + one per
// category table) merged here by player_game_id, instead of one query with
// `o.*, d.*, s.*, m.*` all joined together -- that hit D1's column-count
// limit and 500'd on every request.
// ---------------------------------------------------------------------------
async function getPlayersSeason(DB, season) {
  const [hub, offense, defense, special, misc] = await Promise.all([
    DB.prepare(
      `SELECT pg.player_game_id, pg.player_id, p.display_name AS player_display_name,
              pg.position_code AS position, pg.team, pg.opponent_team,
              g.week, g.game_type_code AS season_type, pg.game_id,
              CASE WHEN pg.team = g.home_team THEN 1 ELSE 0 END AS is_home
       FROM player_game pg
       JOIN game g ON g.game_id = pg.game_id
       JOIN player p ON p.player_id = pg.player_id
       WHERE g.season = ? ORDER BY pg.player_id, g.week`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT o.* FROM player_game_offense o
       JOIN player_game pg ON pg.player_game_id = o.player_game_id JOIN game g ON g.game_id = pg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT d.* FROM player_game_defense d
       JOIN player_game pg ON pg.player_game_id = d.player_game_id JOIN game g ON g.game_id = pg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT s.* FROM player_game_special_teams s
       JOIN player_game pg ON pg.player_game_id = s.player_game_id JOIN game g ON g.game_id = pg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
    DB.prepare(
      `SELECT m.* FROM player_game_misc m
       JOIN player_game pg ON pg.player_game_id = m.player_game_id JOIN game g ON g.game_id = pg.game_id
       WHERE g.season = ?`
    )
      .bind(season)
      .all(),
  ]);

  const byId = new Map();
  const playerIdById = new Map();
  for (const row of hub.results) {
    const { player_game_id, player_id, player_display_name, position, team, ...rest } = row;
    // "current team" for the season header = the team on this player's
    // first game that season (matches the original build_json.py logic).
    byId.set(player_game_id, { player_display_name, position, team, weekRow: { ...rest, is_home: !!row.is_home } });
    playerIdById.set(player_game_id, player_id);
  }
  for (const catResult of [offense, defense, special, misc]) {
    for (const row of catResult.results) {
      const { player_game_id, ...rest } = row;
      const target = byId.get(player_game_id);
      if (target) Object.assign(target.weekRow, rest);
    }
  }

  const players = {};
  for (const [pgid, { player_display_name, position, team, weekRow }] of byId) {
    const player_id = playerIdById.get(pgid);
    let p = players[player_id];
    if (!p) {
      p = { player_display_name, position, team, weeks: [] };
      players[player_id] = p;
    }
    p.weeks.push(weekRow);
  }

  const ids = Object.keys(players);

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

// ---------------------------------------------------------------------------
// /model/manifest -- distinct (season, week) pairs available in `model`,
// newest last, mirrors data/model/manifest.json's {weeks, latest} shape.
// ---------------------------------------------------------------------------
async function getModelManifest(DB) {
  const { results } = await DB.prepare(
    "SELECT DISTINCT season, week FROM model ORDER BY season, week"
  ).all();
  const weeks = results.map((r) => ({ season: r.season, week: r.week }));
  return {
    weeks,
    latest: weeks.length ? weeks[weeks.length - 1] : null,
  };
}

// ---------------------------------------------------------------------------
// /model/:season/:week -- one row per game for that week, mirrors
// data/model/{season}-week{week}.json's {week, season, updated, note, games}
// shape. `updated`/`note` are the same for every game in the week (written
// together by weekly_update.py), so just read them off the first row.
// ---------------------------------------------------------------------------
async function getModelWeek(DB, season, week) {
  const { results } = await DB.prepare(
    `SELECT m.game_id, m.matchup, g.home_team, g.away_team,
            m.market_spread, m.model_spread, m.edge, m.p_home_covers, m.flagged,
            m.market_total, m.updated, m.note
     FROM model m JOIN game g ON g.game_id = m.game_id
     WHERE m.season = ? AND m.week = ? ORDER BY m.game_id`
  )
    .bind(season, week)
    .all();
  if (!results.length) return null;

  return {
    week,
    season,
    updated: results[0].updated,
    note: results[0].note,
    games: results.map((r) => ({
      game_id: r.game_id,
      matchup: r.matchup,
      home_team: r.home_team,
      away_team: r.away_team,
      market_spread: r.market_spread,
      model_spread: r.model_spread,
      edge: r.edge,
      p_home_covers: r.p_home_covers,
      flagged: !!r.flagged,
      market_total: r.market_total,
    })),
  };
}

// ---------------------------------------------------------------------------
// /picks -- the full picks log, mirrors data/log/picks_log.json (a flat
// array of every flagged pick, append-only except for the outcome columns
// reconcile_picks.py fills in once each game has been played).
// ---------------------------------------------------------------------------
async function getPicksLog(DB) {
  const { results } = await DB.prepare(
    `SELECT logged_at, season, week, game_id, gameday, home_team, away_team,
            market_spread, model_spread, edge, p_home_covers, bet_placed,
            closing_line, actual_result, clv, side, covered
     FROM picks_log ORDER BY logged_at, game_id`
  ).all();
  return results;
}

// ---------------------------------------------------------------------------
// /model/season/:season -- every model row for a season, keyed by game_id,
// so the schedule page (games.html) can overlay predicted edge/flagged
// without fetching week-by-week.
// ---------------------------------------------------------------------------
async function getModelSeason(DB, season) {
  const { results } = await DB.prepare(
    `SELECT game_id, market_spread, model_spread, edge, p_home_covers, flagged
     FROM model WHERE season = ?`
  )
    .bind(season)
    .all();
  return results.map((r) => ({ ...r, flagged: !!r.flagged }));
}

// ---------------------------------------------------------------------------
// Shared helper for /game/:gameId -- one team's aggregated offense/defense/
// special_teams/misc totals for a season, either the whole season
// (beforeWeek = null) or only games strictly before a given week (used for
// "season-to-date entering this game"). Same SUM-over-category-tables
// pattern as getPlayerCareer, just grouped by team instead of player and
// with an optional week cutoff instead of a season range.
// ---------------------------------------------------------------------------
async function getTeamAggregate(DB, team, season, beforeWeek) {
  const weekClause = beforeWeek != null ? "AND g.week < ?" : "";
  const args = beforeWeek != null ? [team, season, beforeWeek] : [team, season];

  const [offense, defense, special, misc] = await Promise.all([
    DB.prepare(
      `
      SELECT COUNT(*) games_played,
             SUM(o.attempts) attempts, SUM(o.completions) completions,
             SUM(o.passing_yards) passing_yards, SUM(o.passing_tds) passing_tds,
             SUM(o.passing_interceptions) passing_interceptions, SUM(o.passing_epa) passing_epa,
             SUM(o.carries) carries, SUM(o.rushing_yards) rushing_yards,
             SUM(o.rushing_tds) rushing_tds, SUM(o.rushing_epa) rushing_epa,
             SUM(o.sack_fumbles_lost) sack_fumbles_lost, SUM(o.rushing_fumbles_lost) rushing_fumbles_lost,
             SUM(o.receiving_fumbles_lost) receiving_fumbles_lost
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      JOIN team_game_offense o ON o.team_game_id = tg.team_game_id
      WHERE tg.team = ? AND g.season = ? ${weekClause}
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(d.def_sacks) def_sacks, SUM(d.def_interceptions) def_interceptions,
             SUM(d.def_tackles_for_loss) def_tackles_for_loss, SUM(d.def_qb_hits) def_qb_hits,
             SUM(d.def_fumbles_forced) def_fumbles_forced, SUM(d.def_tds) def_tds
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      JOIN team_game_defense d ON d.team_game_id = tg.team_game_id
      WHERE tg.team = ? AND g.season = ? ${weekClause}
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(s.fg_made) fg_made, SUM(s.fg_att) fg_att, SUM(s.pat_made) pat_made, SUM(s.pat_att) pat_att,
             SUM(s.pt_att) pt_att, SUM(s.pt_net_yards) pt_net_yards
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      JOIN team_game_special_teams s ON s.team_game_id = tg.team_game_id
      WHERE tg.team = ? AND g.season = ? ${weekClause}
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(m.penalties) penalties, SUM(m.penalty_yards) penalty_yards,
             SUM(m.fumble_recovery_opp) fumble_recovery_opp, SUM(m.fumbles_lost_total) fumbles_lost_total
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      JOIN team_game_misc m ON m.team_game_id = tg.team_game_id
      WHERE tg.team = ? AND g.season = ? ${weekClause}
      `
    )
      .bind(...args)
      .first(),
  ]);

  return { ...offense, ...defense, ...special, ...misc };
}

// ---------------------------------------------------------------------------
// /game/:gameId -- everything a single-game detail page needs in one call:
// the game row itself, its model prediction (if this game was ever scored),
// each team's season-to-date stats entering this game and full-season
// stats, and up to the last 10 meetings between these two franchises.
// ---------------------------------------------------------------------------
async function getGameDetail(DB, gameId) {
  const game = await DB.prepare(
    `
    SELECT g.game_id, g.season, g.week, g.game_type_code AS game_type, g.gameday, g.weekday, g.gametime,
           g.home_team, g.away_team, g.home_score, g.away_score, g.result, g.total, g.overtime,
           g.home_rest, g.away_rest, g.div_game, g.roof, g.surface, g.temp, g.wind,
           g.home_qb_id, g.away_qb_id, g.stadium_id,
           g.spread_line, g.home_spread_odds, g.away_spread_odds, g.total_line,
           g.over_odds, g.under_odds, g.home_moneyline, g.away_moneyline,
           wf.forecast_temp, wf.forecast_wind, wf.forecast_precip_prob, wf.fetched_at AS forecast_fetched_at
    FROM game g
    LEFT JOIN weather_forecast wf ON wf.game_id = g.game_id
    WHERE g.game_id = ?
    `
  )
    .bind(gameId)
    .first();
  if (!game) return null;

  const [model, homeToDate, awayToDate, homeFull, awayFull, h2h, teamNames] = await Promise.all([
    DB.prepare(
      `SELECT matchup, market_spread, model_spread, edge, p_home_covers, flagged, market_total, updated, note
       FROM model WHERE game_id = ?`
    )
      .bind(gameId)
      .first(),
    getTeamAggregate(DB, game.home_team, game.season, game.week),
    getTeamAggregate(DB, game.away_team, game.season, game.week),
    getTeamAggregate(DB, game.home_team, game.season, null),
    getTeamAggregate(DB, game.away_team, game.season, null),
    DB.prepare(
      `
      SELECT game_id, season, week, gameday, home_team, away_team, home_score, away_score, result, spread_line
      FROM game
      WHERE game_id != ? AND result IS NOT NULL
        AND ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
      ORDER BY season DESC, week DESC
      LIMIT 10
      `
    )
      .bind(gameId, game.home_team, game.away_team, game.away_team, game.home_team)
      .all(),
    DB.prepare("SELECT team_abbr, team_name FROM team WHERE team_abbr IN (?, ?)")
      .bind(game.home_team, game.away_team)
      .all(),
  ]);

  const team_names = {};
  for (const row of teamNames.results) team_names[row.team_abbr] = row.team_name;

  return {
    game,
    model: model ? { ...model, flagged: !!model.flagged } : null,
    home: { team: game.home_team, season_to_date: homeToDate, full_season: homeFull },
    away: { team: game.away_team, season_to_date: awayToDate, full_season: awayFull },
    team_names,
    head_to_head: h2h.results,
    updated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// /trends -- situational ATS trends computed straight from `game`, full
// 1999-present history. Each block reports a cover % from the picked side's
// perspective (home cover % for the home-dog and rest-edge blocks, "home
// cover %" again for divisional -- read the bucket labels). Pushes are
// excluded from the cover % denominator but included in `n`.
// ---------------------------------------------------------------------------
async function getTrends(DB) {
  const [homeDogsBySize, restEdge, divisional] = await Promise.all([
    DB.prepare(
      `
      SELECT
        CASE
          WHEN spread_line > -3 THEN 'Home dog by < 3'
          WHEN spread_line > -7 THEN 'Home dog by 3-7'
          ELSE 'Home dog by 7+'
        END AS bucket,
        count(*) n,
        sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) home_covers,
        sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END) away_covers,
        sum(CASE WHEN result - spread_line = 0 THEN 1 ELSE 0 END) pushes,
        round(100.0 * sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) /
          NULLIF(sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) + sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END), 0), 1) home_cover_pct
      FROM game
      WHERE spread_line < 0 AND result IS NOT NULL AND spread_line IS NOT NULL
      GROUP BY bucket ORDER BY bucket
      `
    ).all(),
    DB.prepare(
      `
      SELECT
        CASE
          WHEN home_rest - away_rest <= -4 THEN 'Away rest edge 4+ days'
          WHEN home_rest - away_rest < 0 THEN 'Away rest edge 1-3 days'
          WHEN home_rest - away_rest = 0 THEN 'Equal rest'
          WHEN home_rest - away_rest < 4 THEN 'Home rest edge 1-3 days'
          ELSE 'Home rest edge 4+ days'
        END AS bucket,
        count(*) n,
        sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) home_covers,
        sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END) away_covers,
        round(100.0 * sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) /
          NULLIF(sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) + sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END), 0), 1) home_cover_pct
      FROM game
      WHERE result IS NOT NULL AND spread_line IS NOT NULL AND home_rest IS NOT NULL AND away_rest IS NOT NULL
      GROUP BY bucket ORDER BY bucket
      `
    ).all(),
    DB.prepare(
      `
      SELECT
        CASE WHEN div_game = 1 THEN 'Divisional' ELSE 'Non-divisional' END AS bucket,
        count(*) n,
        sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) home_covers,
        sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END) away_covers,
        round(100.0 * sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) /
          NULLIF(sum(CASE WHEN result - spread_line > 0 THEN 1 ELSE 0 END) + sum(CASE WHEN result - spread_line < 0 THEN 1 ELSE 0 END), 0), 1) home_cover_pct,
        round(avg(total - total_line), 2) avg_ou_margin,
        sum(CASE WHEN total - total_line > 0 THEN 1 ELSE 0 END) overs,
        sum(CASE WHEN total - total_line < 0 THEN 1 ELSE 0 END) unders
      FROM game
      WHERE result IS NOT NULL AND spread_line IS NOT NULL AND div_game IS NOT NULL
      GROUP BY bucket ORDER BY bucket
      `
    ).all(),
  ]);

  return {
    updated: new Date().toISOString(),
    home_dogs_by_size: homeDogsBySize.results,
    rest_edge: restEdge.results,
    divisional: divisional.results,
  };
}
