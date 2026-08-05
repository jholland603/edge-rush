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
 *   /picks/season/:season                -- every picks_log row for a season, keyed by game_id
 *                                           (used to fold the "Bet/Closing Line/CLV/Result"
 *                                           columns into the games.html schedule table --
 *                                           replaces the old standalone picks.html page)
 *   /game/:gameId                       -- single-game detail: the game row, its model
 *                                           prediction (if any), a `signals` block (the
 *                                           big-home-dog rule + every fatigue fact --
 *                                           rest/road-streak/OT/timezone -- shown regardless
 *                                           of whether it tested out as predictive, see
 *                                           getGameSituationalSignals), each team's
 *                                           season-to-date (before this game) and full-season
 *                                           stat totals, and head-to-head history between the
 *                                           two teams
 *   /game/:gameId/players/:team         -- every player on `team` who recorded a snap of
 *                                           offense in this game (passing/rushing/receiving),
 *                                           powers the "show players" expand row on the
 *                                           teams.html weekly log
 *   /trends                             -- situational ATS trends (home dogs by size,
 *                                           rest-advantage buckets, divisional vs. not),
 *                                           full 1999-present history, used by trends.html
 *   /trends/query?role=&side=&divisional=&month=&season_from=&season_to=
 *                &min_points=&max_points=&prior_result=&prior_min_margin=
 *                                        -- free-form ATS backtest: pick a role
 *                                           (home/away/any), favorite/underdog, a spread-size
 *                                           range, divisional yes/no, a calendar month, a
 *                                           season range, and optionally "coming off a
 *                                           win/loss by at least N points" -- returns n /
 *                                           covers / non_covers / cover_pct for that exact
 *                                           slice, full 1999-present history. Every filter
 *                                           value is validated against a whitelist or coerced
 *                                           to a number server-side before being used, same
 *                                           no-injection-surface discipline as /leaders/*.
 *                                           Used by trends.html's query-builder section.
 *   /leaders/catalog                    -- available leaderboard categories (players + teams)
 *   /leaders/players?stat=&from=&to=&position=&limit=
 *                                        -- top players by summed stat over a season range
 *   /leaders/teams?stat=&from=&to=&limit=
 *                                        -- top teams by summed stat over a season range
 *   /leaders/teams/:team/players?stat=&from=&to=&scope=&limit=
 *                                        -- players on `team` who contributed to that
 *                                           team's stat total over the same range (the
 *                                           "show players" expand on a team leaders row).
 *                                           Not available for points_scored.
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
        const scope = url.searchParams.get("scope");
        const career = await getPlayerCareer(DB, playerId, from, to, scope);
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
      if ((m = path.match(/^\/picks\/season\/(\d{4})$/))) {
        return json(await getPicksSeason(DB, Number(m[1])));
      }

      if ((m = path.match(/^\/model\/season\/(\d{4})$/))) {
        return json(await getModelSeason(DB, Number(m[1])));
      }
      if ((m = path.match(/^\/game\/([^/]+)$/))) {
        const detail = await getGameDetail(DB, decodeURIComponent(m[1]));
        if (!detail) return notFound(`no game ${m[1]}`);
        return json(detail);
      }
      if ((m = path.match(/^\/game\/([^/]+)\/players\/([^/]+)$/))) {
        const players = await getGameTeamPlayers(DB, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        return json({ game_id: m[1], team: m[2], players });
      }

      if (path === "/trends") {
        return json(await getTrends(DB));
      }
      if (path === "/trends/query") {
        const result = await getTrendsQuery(DB, url.searchParams);
        if (result === null) return json({ error: "invalid filter value" }, 400);
        return json(result);
      }

      if (path === "/leaders/catalog") {
        return json(getLeadersCatalog());
      }
      if (path === "/leaders/players") {
        const statId = url.searchParams.get("stat");
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        const position = url.searchParams.get("position") || null;
        const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
        const scope = url.searchParams.get("scope");
        if (!statId || !from || !to) return json({ error: "stat, from, and to are required" }, 400);
        const result = await getPlayerLeaders(DB, statId, from, to, position, limit, scope);
        if (result === null) return notFound(`unknown stat ${statId}`);
        return json(result);
      }
      if (path === "/leaders/teams") {
        const statId = url.searchParams.get("stat");
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 32);
        const scope = url.searchParams.get("scope");
        if (!statId || !from || !to) return json({ error: "stat, from, and to are required" }, 400);
        const result = await getTeamLeaders(DB, statId, from, to, limit, scope);
        if (result === null) return notFound(`unknown stat ${statId}`);
        return json(result);
      }
      if ((m = path.match(/^\/leaders\/teams\/([^/]+)\/players$/))) {
        const team = decodeURIComponent(m[1]);
        const statId = url.searchParams.get("stat");
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
        const scope = url.searchParams.get("scope");
        if (!statId || !from || !to) return json({ error: "stat, from, and to are required" }, 400);
        const result = await getTeamStatPlayers(DB, team, statId, from, to, scope, limit);
        if (result === null) return notFound(`no player breakdown for stat ${statId}`);
        return json(result);
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
    // for the distinct-seasons list, joined together at the end. LEFT JOINed
    // (not INNER) against `player` so historical players who exist purely via
    // player_career_override -- zero player_game rows, e.g. a pre-1999
    // retiree -- still show up in search instead of silently vanishing from
    // the index. Their position (when known) and career_span come from the
    // override table instead.
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
      ),
      overrides AS (
        SELECT player_id, MAX(career_span) AS career_span, MAX(position) AS position
        FROM player_career_override
        GROUP BY player_id
      )
      SELECT p.player_id, p.display_name AS name,
             COALESCE(r.position_code, o.position) AS position,
             s.seasons_csv, o.career_span
      FROM player p
      LEFT JOIN seasons s ON s.player_id = p.player_id
      LEFT JOIN ranked r ON r.player_id = p.player_id AND r.rn = 1
      LEFT JOIN overrides o ON o.player_id = p.player_id
      WHERE s.player_id IS NOT NULL OR o.player_id IS NOT NULL
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
      career_span: row.career_span || null,
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
// /players/career/:playerId[?from=YYYY&to=YYYY&scope=reg|post|all] --
// aggregated totals across the player's whole career, or a specific
// inclusive season range when from/to are given (the compare-page
// year-range filter). `scope` defaults to "reg" (regular season only) --
// counting playoff games in these totals would unfairly reward players
// whose teams made deep playoff runs over equally-good players whose teams
// didn't. Direct join+SUM against the category tables (not the
// v_player_season_* views, which pre-aggregate REG+playoffs together with
// no way to separate them back out).
// ---------------------------------------------------------------------------
async function getPlayerCareer(DB, playerId, from, to, scope) {
  const hasRange = from && to;
  const fromY = hasRange ? Number(from) : 1900;
  const toY = hasRange ? Number(to) : 2100;
  const typeFilter = scopeClause(scope, "g");

  const player = await DB.prepare("SELECT player_id, display_name FROM player WHERE player_id = ?")
    .bind(playerId)
    .first();
  if (!player) return null;

  // player_career_override holds true full-career totals for historical
  // players whose careers predate (or partly predate) our 1999-2026 D1
  // coverage. Same rule as /leaders/players: only merge these in when the
  // requested range spans the DB's whole season coverage -- they're
  // full-career numbers, not season-sliceable. A player who exists purely
  // via override (no player_game rows at all, e.g. a pre-1999 retiree) would
  // otherwise 404 below once `seasons.length` comes back empty.
  const bounds = await DB.prepare(`SELECT MIN(season_year) AS min_s, MAX(season_year) AS max_s FROM season`).first();
  const isCareerRange = bounds && fromY <= bounds.min_s && toY >= bounds.max_s;
  const overrideRows = isCareerRange
    ? (await DB.prepare(`SELECT stat, value, career_span, source, position FROM player_career_override WHERE player_id = ?`).bind(playerId).all()).results
    : [];

  const [offense, defense, special, misc, teamsRows, seasonsRows, posRow, gamesRow] = await Promise.all([
    DB.prepare(
      `
      SELECT SUM(o.completions) completions, SUM(o.attempts) attempts, SUM(o.passing_yards) passing_yards,
             SUM(o.passing_tds) passing_tds, SUM(o.passing_interceptions) passing_interceptions,
             SUM(o.sacks_suffered) sacks_suffered, SUM(o.passing_air_yards) passing_air_yards,
             SUM(o.passing_first_downs) passing_first_downs, SUM(o.passing_epa) passing_epa,
             SUM(o.passing_2pt_conversions) passing_2pt_conversions,
             SUM(o.carries) carries, SUM(o.rushing_yards) rushing_yards, SUM(o.rushing_tds) rushing_tds,
             SUM(o.rushing_first_downs) rushing_first_downs, SUM(o.rushing_epa) rushing_epa,
             SUM(o.rushing_2pt_conversions) rushing_2pt_conversions,
             SUM(o.receptions) receptions, SUM(o.targets) targets, SUM(o.receiving_yards) receiving_yards,
             SUM(o.receiving_tds) receiving_tds, SUM(o.receiving_first_downs) receiving_first_downs,
             SUM(o.receiving_epa) receiving_epa, SUM(o.receiving_2pt_conversions) receiving_2pt_conversions,
             SUM(o.fantasy_points) fantasy_points, SUM(o.fantasy_points_ppr) fantasy_points_ppr
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN player_game_offense o ON o.player_game_id = pg.player_game_id
      WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `
      SELECT SUM(d.def_tackles_solo) def_tackles_solo, SUM(d.def_tackle_assists) def_tackle_assists,
             SUM(d.def_tackles_for_loss) def_tackles_for_loss, SUM(d.def_fumbles_forced) def_fumbles_forced,
             SUM(d.def_sacks) def_sacks, SUM(d.def_sack_yards) def_sack_yards, SUM(d.def_qb_hits) def_qb_hits,
             SUM(d.def_interceptions) def_interceptions, SUM(d.def_interception_yards) def_interception_yards,
             SUM(d.def_pass_defended) def_pass_defended, SUM(d.def_tds) def_tds, SUM(d.def_safeties) def_safeties
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN player_game_defense d ON d.player_game_id = pg.player_game_id
      WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `
      SELECT SUM(s.fg_made) fg_made, SUM(s.fg_att) fg_att, SUM(s.fg_missed) fg_missed, SUM(s.fg_blocked) fg_blocked,
             SUM(s.pat_made) pat_made, SUM(s.pat_att) pat_att, SUM(s.gwfg_made) gwfg_made,
             SUM(s.pt_att) pt_att, SUM(s.pt_yards) pt_yards, SUM(s.pt_net_yards) pt_net_yards, SUM(s.pt_inside_20) pt_inside_20,
             SUM(s.punt_returns) punt_returns, SUM(s.punt_return_yards) punt_return_yards,
             SUM(s.kickoff_returns) kickoff_returns, SUM(s.kickoff_return_yards) kickoff_return_yards
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN player_game_special_teams s ON s.player_game_id = pg.player_game_id
      WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}
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
      WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}
      `
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `SELECT DISTINCT pg.team FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter} ORDER BY pg.team`
    )
      .bind(playerId, fromY, toY)
      .all(),
    DB.prepare(
      `SELECT DISTINCT g.season FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter} ORDER BY g.season`
    )
      .bind(playerId, fromY, toY)
      .all(),
    DB.prepare(
      `SELECT pg.position_code FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}
       ORDER BY g.season DESC, g.week DESC LIMIT 1`
    )
      .bind(playerId, fromY, toY)
      .first(),
    DB.prepare(
      `SELECT COUNT(*) AS n FROM player_game pg JOIN game g ON g.game_id = pg.game_id
       WHERE pg.player_id = ? AND g.season BETWEEN ? AND ? ${typeFilter}`
    )
      .bind(playerId, fromY, toY)
      .first(),
  ]);

  const seasons = seasonsRows.results.map((r) => r.season);
  // A player exists in the dimension table but has zero games in this
  // range/scope. That used to always mean "no data, 404" -- but a historical
  // player who's purely override-sourced (career entirely pre-1999) will
  // always land here, since they have no player_game rows at all. Only 404
  // if there's also no override data to fall back on.
  if (!seasons.length && !overrideRows.length) return null;

  const career_totals = { ...offense, ...defense, ...special, ...misc };
  for (const k of Object.keys(career_totals)) {
    // SUM() over zero matching rows (e.g. a lineman has no offense rows at
    // all) comes back NULL, not 0 -- normalize so the site's stat-card logic
    // (which checks `=== null` to mean "don't show this card") only sees
    // null for genuinely position-inapplicable stats, not this artifact.
    if (career_totals[k] === null) career_totals[k] = 0;
  }

  let career_span = null;
  let historical_source = null;
  for (const row of overrideRows) {
    // Override wins over the game-summed figure -- it's the sourced true
    // career number, while the summed value (if any) is necessarily partial
    // for a GAP player (missing whatever seasons fall outside 1999-2026).
    career_totals[row.stat] = row.value;
    if (row.career_span && !career_span) career_span = row.career_span;
    if (row.source && !historical_source) historical_source = row.source;
  }

  return {
    player_id: playerId,
    player_display_name: player.display_name,
    position: posRow ? posRow.position_code : overrideRows.length && overrideRows[0].position ? overrideRows[0].position : null,
    teams: teamsRows.results.map((r) => r.team),
    seasons,
    // Once any override applies, games_played/seasons (whatever partial
    // in-DB games this player happens to have, e.g. Favre's 1999-2010 rows
    // out of his full 1991-2010 career) would misleadingly pair a full-career
    // total with a partial game count -- null it out so the front end shows
    // the sourced career_span instead.
    games_played: seasons.length && !overrideRows.length ? gamesRow.n : null,
    scope: normalizeScope(scope),
    updated: new Date().toISOString(),
    career_totals,
    career_span,
    historical_source,
  };
}

// ---------------------------------------------------------------------------
// /model/manifest -- distinct (season, week) pairs available in `model`,
// newest last, mirrors data/model/manifest.json's {weeks, latest} shape.
// ---------------------------------------------------------------------------
async function getModelManifest(DB) {
  const { results } = await DB.prepare(
    `
    SELECT DISTINCT m.season, m.week, g.game_type_code AS game_type
    FROM model m JOIN game g ON g.game_id = m.game_id
    ORDER BY m.season, m.week
    `
  ).all();
  const weeks = results.map((r) => ({ season: r.season, week: r.week, game_type: r.game_type }));
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
// /picks/season/:season -- every picks_log row for a season, keyed by
// game_id, mirrors getModelSeason's shape/pattern so games.html can overlay
// the pick-log columns (bet placed, closing line, CLV, result) onto the
// schedule table the same way it already overlays model edge. picks_log.season
// is a direct column (frozen at flag time), no join needed. `covered` is
// stored as 0/1/NULL -- NULL means "not graded yet" (game hasn't been played
// or reconcile_picks.py hasn't run), which the site should render as "-",
// not as "did not cover" -- so it's normalized to real `null`, not `false`.
// ---------------------------------------------------------------------------
async function getPicksSeason(DB, season) {
  const { results } = await DB.prepare(
    `SELECT game_id, week, bet_placed, market_spread, model_spread, edge, p_home_covers,
            closing_line, actual_result, clv, side, covered
     FROM picks_log WHERE season = ?`
  )
    .bind(season)
    .all();
  return results.map((r) => ({ ...r, covered: r.covered === null ? null : !!r.covered }));
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
// Situational signals for /game/:gameId -- every situational data point
// Jeff asked to see, shown regardless of whether it tested out as a real
// predictive edge (unlike /trends and the old /signals route, which only
// showed signals that survived backtesting). Each fact is labeled with its
// tested status client-side (game.html) so "shown" never gets read as
// "proven." Two pieces:
//   1. big_home_dog -- market_spread <= -7. Tested, real (54-56% ATS across
//      two samples, see HANDOFF.md "Task #27 tested"), but not folded into
//      the model itself.
//   2. fatigue -- short rest, consecutive true road games, coming off
//      overtime, timezone crossing. Tested (HANDOFF.md "Situational fatigue
//      score"), found NO signal in any of these individually. Shown anyway,
//      as facts, because Jeff wants full visibility regardless of how a
//      signal tracked -- explicitly not framed as "favors team X."
// Team timezones are a coarse, hardcoded (not DST-aware) lookup by current
// team_abbr -- documented as the one imprecise piece in the fatigue writeup.
// ---------------------------------------------------------------------------
const TEAM_TZ_OFFSET = {
  ARI: -7, ATL: -5, BAL: -5, BUF: -5, CAR: -5, CHI: -6, CIN: -5, CLE: -5,
  DAL: -6, DEN: -7, DET: -5, GB: -6, HOU: -6, IND: -5, JAX: -5, KC: -6,
  LA: -8, LAC: -8, LV: -8, MIA: -5, MIN: -6, NE: -5, NO: -6, NYG: -5,
  NYJ: -5, PHI: -5, PIT: -5, SEA: -8, SF: -8, TB: -5, TEN: -6, WAS: -5,
  OAK: -8, SD: -8, STL: -6,
};

// Up to 8 of a team's most recent COMPLETED games strictly before
// (season, week) -- enough to read off a road-game streak (rarely 4+ in
// practice) and whether the last one went to overtime.
async function getTeamRecentGames(DB, team, season, week, limit = 8) {
  const { results } = await DB.prepare(
    `
    WITH tg AS (
      SELECT g.season, g.week, 1 AS is_home, g.overtime
      FROM game g WHERE g.home_team = ? AND g.result IS NOT NULL
      UNION ALL
      SELECT g.season, g.week, 0 AS is_home, g.overtime
      FROM game g WHERE g.away_team = ? AND g.result IS NOT NULL
    )
    SELECT * FROM tg WHERE season < ? OR (season = ? AND week < ?)
    ORDER BY season DESC, week DESC LIMIT ?
    `
  )
    .bind(team, team, season, season, week, limit)
    .all();
  return results;
}

function teamFatigueFacts(recentGames, restDays, isHomeThisGame) {
  let roadStreakEntering = 0;
  for (const g of recentGames) {
    if (g.is_home === 0) roadStreakEntering++;
    else break;
  }
  return {
    rest_days: restDays,
    short_week: restDays !== null && restDays !== undefined ? restDays <= 4 : null,
    road_streak_entering: roadStreakEntering,
    road_streak_including_this_game: isHomeThisGame ? 0 : roadStreakEntering + 1,
    coming_off_overtime: recentGames.length ? !!recentGames[0].overtime : null,
  };
}

// QB status -- the strongest VALIDATED signal in the whole project (Phase 1
// backtest: ~3.8-point effect, real, matches independent public research --
// see backtest/phase1_results.md), currently baked invisibly into the
// model's one combined number. Broken out here as its own fact. "Established
// starter" = the mode of a team's last 8 starts strictly before this game
// (same definition as weekly_update.py's established_starters()). For a
// game already played, the actual starter comes straight off
// game.home_qb_id/away_qb_id. For a game that hasn't been played yet (those
// columns are NULL), falls back to the same forward-looking check
// weekly_update.py uses: is the established starter listed "Out" on this
// week's injury report?
async function getTeamQbInfo(DB, team, season, week, actualQbId) {
  const { results } = await DB.prepare(
    `
    WITH tg AS (
      SELECT season, week, home_qb_id AS qb_id FROM game WHERE home_team = ? AND home_qb_id IS NOT NULL
      UNION ALL
      SELECT season, week, away_qb_id AS qb_id FROM game WHERE away_team = ? AND away_qb_id IS NOT NULL
    )
    SELECT qb_id FROM tg WHERE season < ? OR (season = ? AND week < ?)
    ORDER BY season DESC, week DESC LIMIT 8
    `
  )
    .bind(team, team, season, season, week)
    .all();

  const qbIds = results.map((r) => r.qb_id);
  if (!qbIds.length) {
    return { established_qb_id: null, actual_qb_id: actualQbId || null, changed: null, source: "no_history" };
  }
  const counts = {};
  for (const id of qbIds) counts[id] = (counts[id] || 0) + 1;
  const established = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  if (actualQbId) {
    return { established_qb_id: established, actual_qb_id: actualQbId, changed: actualQbId !== established, source: "actual" };
  }

  const inj = await DB.prepare(
    `SELECT report_status FROM injury_report
     WHERE team = ? AND player_id = ? AND season = ? AND week = ?
     ORDER BY date_modified DESC LIMIT 1`
  )
    .bind(team, established, season, week)
    .first();
  const establishedOut = !!(inj && inj.report_status === "Out");
  return {
    established_qb_id: established,
    actual_qb_id: establishedOut ? null : established,
    changed: establishedOut,
    source: "inferred_from_injury_report",
  };
}

async function playerNamesById(DB, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { results } = await DB.prepare(
    `SELECT player_id, display_name FROM player WHERE player_id IN (${unique.map(() => "?").join(",")})`
  )
    .bind(...unique)
    .all();
  const map = {};
  for (const r of results) map[r.player_id] = r.display_name;
  return map;
}

// Coaching tenure -- Task #27's sniff test (HANDOFF.md): raw scoring margin
// trends cleanly with the tenure gap, but the ATS margin does NOT -- the
// market already seems to price in whatever tenure is a proxy for. Shown as
// a fact with that finding attached, not as a pick.
async function getCoachTenure(DB, gameId) {
  const { results } = await DB.prepare(
    `SELECT ct.team, ct.tenure_games_before, c.name AS coach_name
     FROM coach_tenure ct JOIN coach c ON c.coach_id = ct.coach_id
     WHERE ct.game_id = ?`
  )
    .bind(gameId)
    .all();
  const byTeam = {};
  for (const r of results) byTeam[r.team] = { games_with_team: r.tenure_games_before, coach_name: r.coach_name };
  return byTeam;
}

// Draft capital -- Task #28, a coarse stopgap (round 1-3 picks, last 4
// drafts, pick COUNT not pick VALUE) that sniff-tested inconclusive on one
// season of data, not a negative finding, just underpowered. See HANDOFF.md.
async function getDraftCapital(DB, homeTeam, awayTeam) {
  const { results } = await DB.prepare(
    `SELECT team, picks_rounds123_2022_2025 FROM draft_capital_recent WHERE team IN (?, ?)`
  )
    .bind(homeTeam, awayTeam)
    .all();
  const map = {};
  for (const r of results) map[r.team] = r.picks_rounds123_2022_2025;
  return map;
}

async function getRefereeName(DB, refereeId) {
  if (!refereeId) return null;
  const row = await DB.prepare(`SELECT name FROM referee WHERE referee_id = ?`).bind(refereeId).first();
  return row ? row.name : null;
}

async function getGameSituationalSignals(DB, game) {
  const bigHomeDogApplies = game.spread_line !== null && game.spread_line <= -7;

  const [homeRecent, awayRecent, homeQb, awayQb, coachTenure, draftCapital, refereeName] = await Promise.all([
    getTeamRecentGames(DB, game.home_team, game.season, game.week),
    getTeamRecentGames(DB, game.away_team, game.season, game.week),
    getTeamQbInfo(DB, game.home_team, game.season, game.week, game.home_qb_id),
    getTeamQbInfo(DB, game.away_team, game.season, game.week, game.away_qb_id),
    getCoachTenure(DB, game.game_id),
    getDraftCapital(DB, game.home_team, game.away_team),
    getRefereeName(DB, game.referee_id),
  ]);

  const homeTz = TEAM_TZ_OFFSET[game.home_team];
  const awayTz = TEAM_TZ_OFFSET[game.away_team];
  const timezoneCrossing = homeTz !== undefined && awayTz !== undefined ? Math.abs(homeTz - awayTz) : null;

  const qbNames = await playerNamesById(DB, [
    homeQb.established_qb_id, homeQb.actual_qb_id, awayQb.established_qb_id, awayQb.actual_qb_id,
  ]);
  const withNames = (qb) => ({
    ...qb,
    established_qb_name: qbNames[qb.established_qb_id] || null,
    actual_qb_name: qb.actual_qb_id ? qbNames[qb.actual_qb_id] || null : null,
  });

  return {
    big_home_dog: {
      applies: bigHomeDogApplies,
      side: bigHomeDogApplies ? "home" : null,
      note: "Tested: home dogs of 7+ points cover 54-56% ATS across two historical samples. Real, but not folded into the model's own pick (doing so made the model's picks worse -- see HANDOFF.md).",
    },
    fatigue: {
      home: teamFatigueFacts(homeRecent, game.home_rest, true),
      away: teamFatigueFacts(awayRecent, game.away_rest, false),
      timezone_crossing: timezoneCrossing,
      note: "Tested against 27 years of history (rest, road streaks, coming off OT, timezone crossing) -- none showed a real predictive edge on their own. Shown here as context only, not a pick.",
    },
    qb_status: {
      home: withNames(homeQb),
      away: withNames(awayQb),
      note: "Tested and real: a team starting a QB other than its established starter (mode of last 8 starts) is worth ~3.8 points, matches independent public research. The one signal here that's actually baked into the model's own prediction above.",
    },
    coach_tenure: {
      home: coachTenure[game.home_team] || null,
      away: coachTenure[game.away_team] || null,
      note: "Tested: raw scoring margin trends with the tenure gap, but the ATS margin does not -- the market already seems to price in what tenure is a proxy for. Not a betting signal on its own.",
    },
    divisional: {
      applies: !!game.div_game,
      note: "Tested: divisional games run ~0.85 pts under non-divisional on average (avg O/U margin +0.17 vs +1.02) and see slightly fewer home covers (47.6% vs 49.9%). Modest, a total lean more than a side pick.",
    },
    draft_capital: {
      home: draftCapital[game.home_team] ?? null,
      away: draftCapital[game.away_team] ?? null,
      note: "Inconclusive, not negative -- round 1-3 picks over the last 4 drafts (a crude pick-COUNT proxy, not pick-value), sniff-tested on one season with no usable trend. Underpowered, not disproven.",
    },
    referee: {
      name: refereeName,
      note: "Not tested at all -- no backtest has been run comparing referees to any outcome. Shown purely as a fact.",
    },
  };
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
           g.home_qb_id, g.away_qb_id, g.stadium_id, g.referee_id,
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

  const [model, homeToDate, awayToDate, homeFull, awayFull, h2h, teamNames, signals] = await Promise.all([
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
      SELECT game_id, season, week, game_type_code AS game_type, gameday, home_team, away_team, home_score, away_score, result, spread_line
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
    getGameSituationalSignals(DB, game),
  ]);

  const team_names = {};
  for (const row of teamNames.results) team_names[row.team_abbr] = row.team_name;

  return {
    game,
    model: model ? { ...model, flagged: !!model.flagged } : null,
    signals,
    home: { team: game.home_team, season_to_date: homeToDate, full_season: homeFull },
    away: { team: game.away_team, season_to_date: awayToDate, full_season: awayFull },
    team_names,
    head_to_head: h2h.results,
    updated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// /game/:gameId/players/:team -- the offensive players (passing/rushing/
// receiving) on `team` in this specific game, i.e. the breakdown behind the
// team-total columns shown per row on teams.html. Filters out players with
// no offensive touches (attempts/carries/targets all 0) so defense/special
// teams-only players don't clutter the list -- a lineman or corner still
// has a player_game row for this game but nothing to show here.
// ---------------------------------------------------------------------------
async function getGameTeamPlayers(DB, gameId, team) {
  const { results } = await DB.prepare(
    `
    SELECT pg.player_id, p.display_name, pg.position_code AS position,
           o.completions, o.attempts, o.passing_yards, o.passing_tds, o.passing_interceptions,
           o.carries, o.rushing_yards, o.rushing_tds,
           o.receptions, o.targets, o.receiving_yards, o.receiving_tds
    FROM player_game pg
    JOIN player p ON p.player_id = pg.player_id
    JOIN player_game_offense o ON o.player_game_id = pg.player_game_id
    WHERE pg.game_id = ? AND pg.team = ?
      AND (o.attempts > 0 OR o.carries > 0 OR o.targets > 0)
    ORDER BY o.passing_yards DESC, o.rushing_yards DESC, o.receiving_yards DESC
    `
  )
    .bind(gameId, team)
    .all();
  return results;
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

// ---------------------------------------------------------------------------
// /trends/query -- the free-form historical trend backtester ("how do
// divisional road underdogs perform in November coming off a blowout loss
// since 2005" style questions). Built on a team-perspective CTE (one row per
// team per game, home and away both normalized to "team"/"opponent" so the
// same WHERE clause works regardless of role) plus a LAG() window function
// for the "coming off a win/loss of at least N points" filter. Every enum
// param is checked against a fixed whitelist (falls back to "any"/ignored,
// never interpolated raw), and every numeric param is coerced with Number()
// and bound as a query parameter -- no request value ever becomes part of
// the SQL text itself, same discipline as /leaders/*'s catalog lookups.
// Returns null (-> 400) only for a genuinely malformed month value.
// ---------------------------------------------------------------------------
async function getTrendsQuery(DB, searchParams) {
  const role = ["home", "away"].includes(searchParams.get("role")) ? searchParams.get("role") : "any";
  const side = ["favorite", "underdog"].includes(searchParams.get("side")) ? searchParams.get("side") : "any";
  const divisional = ["yes", "no"].includes(searchParams.get("divisional")) ? searchParams.get("divisional") : "any";
  const priorResult = ["win", "loss"].includes(searchParams.get("prior_result")) ? searchParams.get("prior_result") : "any";

  const monthRaw = searchParams.get("month");
  let month = null;
  if (monthRaw && monthRaw !== "any") {
    const n = Number(monthRaw);
    if (!Number.isInteger(n) || n < 1 || n > 12) return null;
    month = n;
  }

  const seasonFrom = Number(searchParams.get("season_from")) || 1999;
  const seasonTo = Number(searchParams.get("season_to")) || 2100;

  const minPointsRaw = searchParams.get("min_points");
  const maxPointsRaw = searchParams.get("max_points");
  const minPoints = minPointsRaw !== null && minPointsRaw !== "" && !Number.isNaN(Number(minPointsRaw)) ? Number(minPointsRaw) : null;
  const maxPoints = maxPointsRaw !== null && maxPointsRaw !== "" && !Number.isNaN(Number(maxPointsRaw)) ? Number(maxPointsRaw) : null;

  const priorMinMarginRaw = searchParams.get("prior_min_margin");
  const priorMinMargin = priorMinMarginRaw !== null && priorMinMarginRaw !== "" && !Number.isNaN(Number(priorMinMarginRaw))
    ? Math.abs(Number(priorMinMarginRaw))
    : 0;

  const conditions = ["season BETWEEN ? AND ?"];
  const binds = [seasonFrom, seasonTo];

  if (role === "home") conditions.push("is_home = 1");
  if (role === "away") conditions.push("is_home = 0");
  if (side === "favorite") conditions.push("team_spread > 0");
  if (side === "underdog") conditions.push("team_spread < 0");
  if (divisional === "yes") conditions.push("div_game = 1");
  if (divisional === "no") conditions.push("div_game = 0");
  if (month !== null) {
    conditions.push("CAST(substr(gameday, 6, 2) AS INTEGER) = ?");
    binds.push(month);
  }
  if (minPoints !== null) {
    conditions.push("ABS(team_spread) >= ?");
    binds.push(minPoints);
  }
  if (maxPoints !== null) {
    conditions.push("ABS(team_spread) <= ?");
    binds.push(maxPoints);
  }
  if (priorResult === "loss") {
    conditions.push("prior_margin IS NOT NULL AND prior_margin <= ?");
    binds.push(-priorMinMargin);
  }
  if (priorResult === "win") {
    conditions.push("prior_margin IS NOT NULL AND prior_margin >= ?");
    binds.push(priorMinMargin);
  }

  const sql = `
    WITH team_games AS (
      SELECT g.game_id, g.season, g.week, g.gameday, g.home_team AS team, g.away_team AS opponent, 1 AS is_home,
             (g.home_score - g.away_score) AS team_margin, g.spread_line AS team_spread, g.div_game
      FROM game g WHERE g.result IS NOT NULL AND g.spread_line IS NOT NULL AND g.gameday IS NOT NULL
      UNION ALL
      SELECT g.game_id, g.season, g.week, g.gameday, g.away_team AS team, g.home_team AS opponent, 0 AS is_home,
             (g.away_score - g.home_score) AS team_margin, -g.spread_line AS team_spread, g.div_game
      FROM game g WHERE g.result IS NOT NULL AND g.spread_line IS NOT NULL AND g.gameday IS NOT NULL
    ),
    with_prior AS (
      SELECT *, LAG(team_margin) OVER (PARTITION BY team ORDER BY season, week) AS prior_margin
      FROM team_games
    )
    SELECT
      COUNT(*) n,
      SUM(CASE WHEN team_margin - team_spread > 0 THEN 1 ELSE 0 END) covers,
      SUM(CASE WHEN team_margin - team_spread < 0 THEN 1 ELSE 0 END) non_covers,
      SUM(CASE WHEN team_margin - team_spread = 0 THEN 1 ELSE 0 END) pushes,
      ROUND(100.0 * SUM(CASE WHEN team_margin - team_spread > 0 THEN 1 ELSE 0 END) /
        NULLIF(SUM(CASE WHEN team_margin - team_spread > 0 THEN 1 ELSE 0 END) + SUM(CASE WHEN team_margin - team_spread < 0 THEN 1 ELSE 0 END), 0), 1) AS cover_pct
    FROM with_prior
    WHERE ${conditions.join(" AND ")}
  `;

  const row = await DB.prepare(sql).bind(...binds).first();

  return {
    filters: {
      role,
      side,
      divisional,
      month,
      season_from: seasonFrom,
      season_to: seasonTo,
      min_points: minPoints,
      max_points: maxPoints,
      prior_result: priorResult,
      prior_min_margin: priorResult !== "any" ? priorMinMargin : null,
    },
    n: row.n || 0,
    covers: row.covers || 0,
    non_covers: row.non_covers || 0,
    pushes: row.pushes || 0,
    cover_pct: row.cover_pct,
  };
}

// ---------------------------------------------------------------------------
// /leaders/* -- top players/teams by a summed stat over a season range.
// Both catalogs are a deliberately curated whitelist (mirrors the same
// curation philosophy as site/assets/js/player-stats.js) -- table/column
// names come from these server-side constants only, never interpolated
// from the request, so there's no injection surface even though the query
// itself is built dynamically per catalog entry.
// ---------------------------------------------------------------------------
const PLAYER_STAT_CATALOG = [
  { id: "passing_yards", label: "Passing Yards", table: "player_game_offense", column: "passing_yards", position: "QB" },
  { id: "passing_tds", label: "Passing TDs", table: "player_game_offense", column: "passing_tds", position: "QB" },
  { id: "passing_interceptions", label: "Interceptions Thrown", table: "player_game_offense", column: "passing_interceptions", position: "QB" },
  { id: "rushing_yards", label: "Rushing Yards", table: "player_game_offense", column: "rushing_yards" },
  { id: "rushing_tds", label: "Rushing TDs", table: "player_game_offense", column: "rushing_tds" },
  { id: "receptions", label: "Receptions", table: "player_game_offense", column: "receptions" },
  { id: "receiving_yards", label: "Receiving Yards", table: "player_game_offense", column: "receiving_yards" },
  { id: "receiving_tds", label: "Receiving TDs", table: "player_game_offense", column: "receiving_tds" },
  { id: "def_sacks", label: "Sacks", table: "player_game_defense", column: "def_sacks" },
  { id: "def_interceptions", label: "Interceptions (Defense)", table: "player_game_defense", column: "def_interceptions" },
  { id: "def_tackles_solo", label: "Solo Tackles", table: "player_game_defense", column: "def_tackles_solo" },
  { id: "def_tackles_for_loss", label: "Tackles for Loss", table: "player_game_defense", column: "def_tackles_for_loss" },
  { id: "def_fumbles_forced", label: "Forced Fumbles", table: "player_game_defense", column: "def_fumbles_forced" },
  { id: "fg_made", label: "Field Goals Made", table: "player_game_special_teams", column: "fg_made", position: "K" },
  { id: "fantasy_points_ppr", label: "Fantasy Points (PPR)", table: "player_game_offense", column: "fantasy_points_ppr" },
];

const TEAM_STAT_CATALOG = [
  { id: "points_scored", label: "Points Scored" }, // special-cased below, not column-based
  { id: "passing_yards", label: "Passing Yards", table: "team_game_offense", column: "passing_yards" },
  { id: "rushing_yards", label: "Rushing Yards", table: "team_game_offense", column: "rushing_yards" },
  { id: "passing_tds", label: "Passing TDs", table: "team_game_offense", column: "passing_tds" },
  { id: "def_sacks", label: "Sacks", table: "team_game_defense", column: "def_sacks" },
  { id: "def_interceptions", label: "Interceptions (Defense)", table: "team_game_defense", column: "def_interceptions" },
  { id: "def_tackles_for_loss", label: "Tackles for Loss", table: "team_game_defense", column: "def_tackles_for_loss" },
  { id: "def_fumbles_forced", label: "Forced Fumbles", table: "team_game_defense", column: "def_fumbles_forced" },
  { id: "penalties", label: "Penalties", table: "team_game_misc", column: "penalties" },
  { id: "penalty_yards", label: "Penalty Yards", table: "team_game_misc", column: "penalty_yards" },
];

// "reg" (default) = regular season only -- the fair, apples-to-apples
// comparison, since not every player/team makes the playoffs. "post" =
// playoff games only (WC/DIV/CON/SB). "all" = regular season + playoffs
// combined. Used by /leaders/* and /players/career/:id so the same
// fairness logic applies to leaderboards, career totals, and Compare.
function normalizeScope(raw) {
  return raw === "post" || raw === "all" ? raw : "reg";
}
function scopeClause(scope, alias) {
  const sc = normalizeScope(scope);
  if (sc === "post") return `AND ${alias}.game_type_code != 'REG'`;
  if (sc === "all") return "";
  return `AND ${alias}.game_type_code = 'REG'`;
}

function getLeadersCatalog() {
  return {
    players: PLAYER_STAT_CATALOG.map(({ id, label, position }) => ({ id, label, position: position || null })),
    teams: TEAM_STAT_CATALOG.map(({ id, label }) => ({ id, label })),
  };
}

async function getPlayerLeaders(DB, statId, from, to, position, limit, scope) {
  const spec = PLAYER_STAT_CATALOG.find((s) => s.id === statId);
  if (!spec) return null;

  // Position shown is just whichever position_code appears on this player's
  // games within the selected range (MAX is an arbitrary but cheap and
  // almost-always-stable pick -- players essentially never change position
  // mid-range). A "true most recent career position" lookup was tried first
  // but cost an extra ~1.5s per query (correlated subquery per player), not
  // worth it for a display-only field.
  const posFilter = position ? "AND pg.position_code = ?" : "";
  const typeFilter = scopeClause(scope, "g");

  // player_career_override holds true full-career totals for historical
  // players whose careers predate (or partly predate) our 1999-2026 D1
  // coverage -- game-by-game data simply doesn't exist for those seasons.
  // These are full-career numbers, not season-sliceable, so they only get
  // merged in when the requested range spans every season we have (i.e. the
  // "Career" view). Slicing to any single season/sub-range uses the
  // game-summed totals exactly as before -- no behavior change there.
  const bounds = await DB.prepare(`SELECT MIN(season_year) AS min_s, MAX(season_year) AS max_s FROM season`).first();
  const isCareerRange = bounds && from <= bounds.min_s && to >= bounds.max_s;

  if (!isCareerRange) {
    const sql = `
      SELECT pg.player_id, p.display_name AS name, MAX(pg.position_code) AS position,
             SUM(t.${spec.column}) AS total, COUNT(*) AS games
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN ${spec.table} t ON t.player_game_id = pg.player_game_id
      JOIN player p ON p.player_id = pg.player_id
      WHERE g.season BETWEEN ? AND ? ${typeFilter} ${posFilter}
      GROUP BY pg.player_id
      HAVING total IS NOT NULL
      ORDER BY total DESC
      LIMIT ?
    `;
    const params = position ? [from, to, position, limit] : [from, to, limit];
    const { results } = await DB.prepare(sql).bind(...params).all();
    return { stat: statId, label: spec.label, from, to, position: position || null, scope: normalizeScope(scope), leaders: results };
  }

  // Career range: merge game-summed totals with historical overrides.
  // The override wins when present -- a GAP player's game-summed total is
  // necessarily incomplete (missing whatever seasons fall outside 1999-2026),
  // while the override is the sourced true career number. ABSENT players
  // (zero game rows at all) show up purely from the override side, with
  // games = NULL -- the front end renders that as "career total" rather
  // than a per-game count.
  const overridePosFilter = position ? "AND COALESCE(gt.position, o.position) = ?" : "";
  const sql = `
    WITH game_totals AS (
      SELECT pg.player_id, MAX(pg.position_code) AS position, SUM(t.${spec.column}) AS total, COUNT(*) AS games
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN ${spec.table} t ON t.player_game_id = pg.player_game_id
      WHERE g.season BETWEEN ? AND ? ${typeFilter}
      GROUP BY pg.player_id
      HAVING total IS NOT NULL
    )
    SELECT p.player_id, p.display_name AS name,
           COALESCE(gt.position, o.position) AS position,
           COALESCE(o.value, gt.total) AS total,
           CASE WHEN o.value IS NOT NULL THEN NULL ELSE gt.games END AS games,
           o.career_span AS career_span
    FROM player p
    LEFT JOIN game_totals gt ON gt.player_id = p.player_id
    LEFT JOIN player_career_override o ON o.player_id = p.player_id AND o.stat = ?
    WHERE (gt.player_id IS NOT NULL OR o.player_id IS NOT NULL)
      ${overridePosFilter}
    ORDER BY total DESC
    LIMIT ?
  `;
  const params = position ? [from, to, statId, position, limit] : [from, to, statId, limit];
  const { results } = await DB.prepare(sql).bind(...params).all();
  return { stat: statId, label: spec.label, from, to, position: position || null, scope: normalizeScope(scope), leaders: results };
}

async function getTeamLeaders(DB, statId, from, to, limit, scope) {
  if (statId === "points_scored") {
    const typeFilter = scopeClause(scope, "x");
    const { results } = await DB.prepare(
      `
      SELECT team, tn.team_name, SUM(pts) AS total, COUNT(*) AS games
      FROM (
        SELECT home_team AS team, home_score AS pts, season, game_type_code FROM game WHERE home_score IS NOT NULL
        UNION ALL
        SELECT away_team AS team, away_score AS pts, season, game_type_code FROM game WHERE away_score IS NOT NULL
      ) x
      JOIN team tn ON tn.team_abbr = x.team
      WHERE x.season BETWEEN ? AND ? ${typeFilter}
      GROUP BY team
      ORDER BY total DESC
      LIMIT ?
      `
    ).bind(from, to, limit).all();
    return { stat: statId, label: "Points Scored", from, to, scope: normalizeScope(scope), leaders: results };
  }

  const spec = TEAM_STAT_CATALOG.find((s) => s.id === statId);
  if (!spec) return null;
  const typeFilter = scopeClause(scope, "g");

  const { results } = await DB.prepare(
    `
    SELECT tg.team, tn.team_name, SUM(t.${spec.column}) AS total, COUNT(*) AS games
    FROM team_game tg
    JOIN game g ON g.game_id = tg.game_id
    JOIN ${spec.table} t ON t.team_game_id = tg.team_game_id
    JOIN team tn ON tn.team_abbr = tg.team
    WHERE g.season BETWEEN ? AND ? ${typeFilter}
    GROUP BY tg.team
    HAVING total IS NOT NULL
    ORDER BY total DESC
    LIMIT ?
    `
  ).bind(from, to, limit).all();
  return { stat: statId, label: spec.label, from, to, scope: normalizeScope(scope), leaders: results };
}

// Every team_game_* category table has an identically-columned player_game_*
// counterpart, so a team stat's (table, column) maps straight across --
// used by getTeamStatPlayers below to break a team leaderboard row down into
// the players who produced it. "points_scored" has no single-column player
// equivalent (it's a mix of TDs across positions plus kicking), so it's
// excluded from the catalog entries eligible for breakdown -- the route
// returns a 404-style null for it and the UI hides the toggle.
const TEAM_TO_PLAYER_TABLE = {
  team_game_offense: "player_game_offense",
  team_game_defense: "player_game_defense",
  team_game_misc: "player_game_misc",
};

// /leaders/teams/:team/players?stat=&from=&to=&scope=&limit= -- the players
// on `team` who contributed to that team's summed stat total over the same
// season range/scope as the leaders table row it's expanding. Mirrors
// getPlayerLeaders but scoped to one team instead of the whole league.
async function getTeamStatPlayers(DB, team, statId, from, to, scope, limit) {
  const spec = TEAM_STAT_CATALOG.find((s) => s.id === statId);
  if (!spec || !spec.table) return null; // points_scored or unknown stat
  const playerTable = TEAM_TO_PLAYER_TABLE[spec.table];
  if (!playerTable) return null;

  const typeFilter = scopeClause(scope, "g");
  const { results } = await DB.prepare(
    `
    SELECT pg.player_id, p.display_name AS name, MAX(pg.position_code) AS position,
           SUM(t.${spec.column}) AS total, COUNT(*) AS games
    FROM player_game pg
    JOIN game g ON g.game_id = pg.game_id
    JOIN ${playerTable} t ON t.player_game_id = pg.player_game_id
    JOIN player p ON p.player_id = pg.player_id
    WHERE pg.team = ? AND g.season BETWEEN ? AND ? ${typeFilter}
    GROUP BY pg.player_id
    HAVING total IS NOT NULL AND total != 0
    ORDER BY total DESC
    LIMIT ?
    `
  )
    .bind(team, from, to, limit)
    .all();
  return { stat: statId, label: spec.label, team, from, to, scope: normalizeScope(scope), players: results };
}
