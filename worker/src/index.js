/**
 * edge-rush API worker -- serves the site's games/teams/players/compare pages
 * from the D1 database instead of the static data/*.json tree.
 *
 * Routes (all GET, JSON responses):
 *   /index                              -- replaces index.json
 *   /games/:season                      -- replaces data/games/{season}.json
 *   /games/:season/:week/leans          -- per-game situational/stat "lean" tallies for
 *                                           that week, plus an `odds_movement` block per
 *                                           game (average spread/total at the earliest vs.
 *                                           latest odds_snapshot, only present once a game
 *                                           has moved >= 1pt on either -- see
 *                                           getOddsMovement()). Powers games.html's
 *                                           direction-arrow cells.
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
 *                                           stat totals, head-to-head history between the two
 *                                           teams, and `odds_history` -- every odds_snapshot
 *                                           row for this game, every bookmaker, unfiltered
 *                                           (the games.html summary's 1pt movement threshold
 *                                           does not apply here, see getGameDetail())
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
      // Was max-age=300 (5 min), written back when data only changed on a
      // weekly manual re-import. No longer true: odds snapshots and model
      // scores now refresh up to 16x/day (see .github/workflows/odds-
      // snapshot.yml), and a 5-minute browser cache meant reloading the
      // site right after a refresh could still silently show the previous
      // response -- confirmed directly (a plain fetch() returned a stale
      // game detail missing the odds_average.draftkings field that had
      // just been deployed, while a cache-busted fetch to the identical
      // URL returned the current one). D1 reads cost nothing at this
      // traffic level, so this is now just enough to absorb rapid repeat
      // loads (e.g. several tabs open at once), not a real staleness
      // window.
      "Cache-Control": "public, max-age=30",
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
      if ((m = path.match(/^\/games\/(\d{4})\/(\d{1,2})\/leans$/))) {
        return json(await getWeekLeans(DB, Number(m[1]), Number(m[2])));
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

      if ((m = path.match(/^\/fantasy\/(\d{4})\/(\d{1,2})\/([A-Za-z]+)$/))) {
        const position = m[3].toUpperCase();
        if (!FANTASY_POSITIONS.includes(position)) {
          return json({ error: `unknown position ${position}, expected one of ${FANTASY_POSITIONS.join(", ")}` }, 400);
        }
        // Defaults to top 10 for the rankings page; the lineup optimizer
        // asks for the full pool (?limit=300) since it needs every
        // salary-eligible player, not just the best 10, to solve the cap
        // problem properly. Capped at 500 -- the largest position pool
        // (WR) doesn't come close to that, so this is just abuse-proofing.
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 500);
        const result = await getFantasyRankings(DB, Number(m[1]), Number(m[2]), position, limit);
        if (result === null) return notFound(`no schedule for ${m[1]} week ${m[2]}`);
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

// How many of a team's most recent played games (any season, any game
// type -- REG or playoffs) feed the "recent form" numbers below. Chosen
// over a full-season average so the numbers stay recency-weighted
// year-round, not just as an early-season patch -- see HANDOFF.md.
const RECENT_GAMES_WINDOW = 10;

// ---------------------------------------------------------------------------
// Rolling last-N-games aggregate -- same stat columns as getTeamAggregate,
// but windowed by the team's most recent N *played* games ordered by
// actual calendar date (gameday), not season/week. Deliberately spans
// season boundaries -- playoff games sort in correctly by date, and a new
// season's Week 1 naturally pulls a window that's mostly-to-entirely last
// season, shifting to entirely this season a couple months in. No
// separate "is the current-season sample thin yet" fallback logic needed
// -- this replaced that entirely (see HANDOFF.md). This is what "Last N"
// on Team Comparison and the season-context situational signals (pass D
// allowed, common opponents, turnover margin) are built from.
// ---------------------------------------------------------------------------
async function getTeamRollingAggregate(DB, team, beforeGameday, limit) {
  const recentClause = `
    SELECT tg.team_game_id
    FROM team_game tg JOIN game g ON g.game_id = tg.game_id
    WHERE tg.team = ? AND g.result IS NOT NULL AND g.gameday < ?
    ORDER BY g.gameday DESC
    LIMIT ?
  `;
  const args = [team, beforeGameday, limit];

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
      FROM (${recentClause}) recent
      JOIN team_game_offense o ON o.team_game_id = recent.team_game_id
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(d.def_sacks) def_sacks, SUM(d.def_interceptions) def_interceptions,
             SUM(d.def_tackles_for_loss) def_tackles_for_loss, SUM(d.def_qb_hits) def_qb_hits,
             SUM(d.def_fumbles_forced) def_fumbles_forced, SUM(d.def_tds) def_tds
      FROM (${recentClause}) recent
      JOIN team_game_defense d ON d.team_game_id = recent.team_game_id
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(s.fg_made) fg_made, SUM(s.fg_att) fg_att, SUM(s.pat_made) pat_made, SUM(s.pat_att) pat_att,
             SUM(s.pt_att) pt_att, SUM(s.pt_net_yards) pt_net_yards
      FROM (${recentClause}) recent
      JOIN team_game_special_teams s ON s.team_game_id = recent.team_game_id
      `
    )
      .bind(...args)
      .first(),
    DB.prepare(
      `
      SELECT SUM(m.penalties) penalties, SUM(m.penalty_yards) penalty_yards,
             SUM(m.fumble_recovery_opp) fumble_recovery_opp, SUM(m.fumbles_lost_total) fumbles_lost_total
      FROM (${recentClause}) recent
      JOIN team_game_misc m ON m.team_game_id = recent.team_game_id
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

// Up to 8 of a team's most recent COMPLETED games strictly before `week`,
// SAME SEASON ONLY -- enough to read off a road-game streak (rarely 4+ in
// practice) and whether the last one went to overtime. Deliberately does
// NOT reach back into the prior season: a road trip or an OT game from
// last year's finale has no bearing on Week 1 (a team's travel streak
// resets every offseason), unlike the rolling-N-games "recent form" stats
// elsewhere on this page, which intentionally do span season boundaries.
// Week 1 (or any week with no prior games this season) correctly returns
// an empty list -- teamFatigueFacts() below already treats that as "no
// streak, no OT info" rather than reaching for stale data.
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
    SELECT * FROM tg WHERE season = ? AND week < ?
    ORDER BY week DESC LIMIT ?
    `
  )
    .bind(team, team, season, week, limit)
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

// Defensive pass rating allowed -- NOT one of the model's ratings (those
// are EPA-based); this is the traditional NFL passer-rating formula applied
// to whatever the OPPOSING offense did against this team's defense, over
// its last N games (RECENT_GAMES_WINDOW, same rolling window as
// getTeamRollingAggregate). `team_game.opponent_team` lets this join
// straight to the opponent's own `team_game_offense` row for each of this
// team's games, no separate "defense allowed" table needed. Untested as a
// standalone ATS signal in this project -- it's a real, standard quality
// metric, just not backtested here.
async function getTeamPassDefenseAllowedRolling(DB, team, beforeGameday, limit) {
  return DB.prepare(
    `
    SELECT SUM(o.completions) completions, SUM(o.attempts) attempts, SUM(o.passing_yards) passing_yards,
           SUM(o.passing_tds) passing_tds, SUM(o.passing_interceptions) passing_interceptions
    FROM (
      SELECT tg.team_game_id
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      WHERE tg.opponent_team = ? AND g.result IS NOT NULL AND g.gameday < ?
      ORDER BY g.gameday DESC
      LIMIT ?
    ) recent
    JOIN team_game_offense o ON o.team_game_id = recent.team_game_id
    `
  )
    .bind(team, beforeGameday, limit)
    .first();
}

function passerRating(stats) {
  if (!stats || !stats.attempts) return null;
  const clamp = (v) => Math.max(0, Math.min(2.375, v));
  const att = stats.attempts;
  const a = clamp(((stats.completions / att) - 0.3) * 5);
  const b = clamp(((stats.passing_yards / att) - 3) * 0.25);
  const c = clamp((stats.passing_tds / att) * 20);
  const d = clamp(2.375 - (stats.passing_interceptions / att) * 25);
  return Math.round((((a + b + c + d) / 6) * 100) * 10) / 10;
}

// Common opponents -- every opponent BOTH teams have played in their last
// N games (RECENT_GAMES_WINDOW), with each side's scoring margin against
// that opponent. Classic scouting comparison, not a repeatable trend, so
// there's nothing to backtest -- purely contextual, per-matchup.
async function getTeamRollingResults(DB, team, beforeGameday, limit) {
  const { results } = await DB.prepare(
    `
    SELECT
      CASE WHEN g.home_team = ? THEN g.away_team ELSE g.home_team END AS opponent,
      CASE WHEN g.home_team = ? THEN g.home_score - g.away_score ELSE g.away_score - g.home_score END AS margin
    FROM game g
    WHERE (g.home_team = ? OR g.away_team = ?) AND g.result IS NOT NULL AND g.gameday < ?
    ORDER BY g.gameday DESC
    LIMIT ?
    `
  )
    .bind(team, team, team, team, beforeGameday, limit)
    .all();
  return results;
}

function commonOpponents(homeResults, awayResults, homeTeam, awayTeam) {
  const groupByOpp = (rows) => {
    const map = {};
    for (const r of rows) {
      if (r.opponent === homeTeam || r.opponent === awayTeam) continue; // meetings between these two -- that's Head-to-Head, not a "common" 3rd team
      (map[r.opponent] ||= []).push(r.margin);
    }
    return map;
  };
  const homeMap = groupByOpp(homeResults);
  const awayMap = groupByOpp(awayResults);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const common = Object.keys(homeMap)
    .filter((opp) => awayMap[opp])
    .map((opp) => ({
      opponent: opp,
      home_avg_margin: Math.round(avg(homeMap[opp]) * 10) / 10,
      home_games: homeMap[opp].length,
      away_avg_margin: Math.round(avg(awayMap[opp]) * 10) / 10,
      away_games: awayMap[opp].length,
    }))
    .sort((a, b) => a.opponent.localeCompare(b.opponent));
  return common;
}

// Weekday/primetime -- tested (see below), no signal. Uses game.weekday/
// gametime, already selected by getGameDetail, no extra query needed.
function primetimeBucket(weekday, gametime) {
  if (!weekday) return null;
  if (weekday === "Thursday") return "Thursday";
  if (weekday === "Monday") return "Monday";
  if (weekday === "Saturday") return "Saturday";
  if (weekday === "Sunday") {
    const hour = gametime ? Number(gametime.slice(0, 2)) : null;
    return hour !== null && hour >= 19 ? "Sunday Night" : "Sunday Day";
  }
  return "Other";
}

// Opponent-similarity-weighted form -- Jeff's idea: instead of a flat
// average over a team's last 10 games, weight each of those games by how
// similar that game's opponent was (in the relevant unit) to this week's
// opponent. Computed by weekly_update.py (see the big comment above
// similarity_weighted_ratings() there) and stored in `model_similarity`,
// keyed by game_id -- NOT computed live here, so the number shown always
// matches exactly what was actually backtested (backtest_v6_similarity_
// weighted.py). Null until that script has scored this game (same
// "not every game has this yet" pattern as `model` and `weather_forecast`).
async function getModelSimilarity(DB, gameId) {
  return DB.prepare(
    `SELECT bandwidth_multiplier, flat_pass_edge, flat_rush_edge,
            weighted_pass_edge, weighted_rush_edge, home_avg_ess, away_avg_ess, updated
     FROM model_similarity WHERE game_id = ?`
  )
    .bind(gameId)
    .first();
}

// Expert straight-up pick consensus (ESPN, see scripts/fetch_expert_picks.py)
// -- forward-looking only, same as getOddsMovement/getModelSimilarity above.
// experts_json is a JSON-encoded array of {name, pick} stored as-is; parsed
// here rather than at read time everywhere it's used.
async function getExpertConsensus(DB, gameId) {
  const row = await DB.prepare(
    `SELECT source, num_experts, home_picks, away_picks, experts_json, snapshot_time
     FROM expert_consensus WHERE game_id = ?`
  )
    .bind(gameId)
    .first();
  if (!row) return null;
  let experts = [];
  try {
    experts = JSON.parse(row.experts_json || "[]");
  } catch {
    experts = [];
  }
  return { ...row, experts };
}

async function getGameSituationalSignals(DB, game) {
  const bigHomeDogApplies = game.spread_line !== null && game.spread_line <= -7;

  const [
    homeRecentGames, awayRecentGames, homeQb, awayQb, coachTenure, draftCapital, refereeName,
    homePassDef, awayPassDef, homeCoResults, awayCoResults, similarity, oddsMovement, expertConsensus,
  ] = await Promise.all([
    getTeamRecentGames(DB, game.home_team, game.season, game.week),
    getTeamRecentGames(DB, game.away_team, game.season, game.week),
    getTeamQbInfo(DB, game.home_team, game.season, game.week, game.home_qb_id),
    getTeamQbInfo(DB, game.away_team, game.season, game.week, game.away_qb_id),
    getCoachTenure(DB, game.game_id),
    getDraftCapital(DB, game.home_team, game.away_team),
    getRefereeName(DB, game.referee_id),
    getTeamPassDefenseAllowedRolling(DB, game.home_team, game.gameday, RECENT_GAMES_WINDOW),
    getTeamPassDefenseAllowedRolling(DB, game.away_team, game.gameday, RECENT_GAMES_WINDOW),
    getTeamRollingResults(DB, game.home_team, game.gameday, RECENT_GAMES_WINDOW),
    getTeamRollingResults(DB, game.away_team, game.gameday, RECENT_GAMES_WINDOW),
    getModelSimilarity(DB, game.game_id),
    getOddsMovement(DB, [game.game_id]),
    getExpertConsensus(DB, game.game_id),
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
      home: teamFatigueFacts(homeRecentGames, game.home_rest, true),
      away: teamFatigueFacts(awayRecentGames, game.away_rest, false),
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
    pass_defense_allowed: {
      home: passerRating(homePassDef),
      away: passerRating(awayPassDef),
      note: `Not tested as a standalone ATS signal in this project -- a standard, real quality metric (traditional NFL passer rating formula applied to what each defense has allowed), just not backtested here. Different from the model's own EPA-based ratings. Last ${RECENT_GAMES_WINDOW} games, any season (see Team Comparison note above).`,
    },
    common_opponents: {
      opponents: commonOpponents(homeCoResults, awayCoResults, game.home_team, game.away_team),
      note: `Not a repeatable trend, nothing to backtest -- a scouting comparison, not a signal. Positive margin = that team won by that many points on average against the shared opponent. Each side's last ${RECENT_GAMES_WINDOW} games, any season.`,
    },
    primetime: {
      bucket: primetimeBucket(game.weekday, game.gametime),
      note: "Tested: Thursday/Sunday-night/Monday/Saturday games all land within a point or two of a 50/50 home cover rate (48.3-51.5% across n=250-5,517 each) -- no clean trend by time slot.",
    },
    turnover_margin_note:
      `Not tested in this project. Widely-cited public research (fumble recovery rates in particular are close to a coin flip) suggests raw turnover margin doesn't reliably predict future performance -- shown as a descriptive fact only, computed from takeaways (defensive INTs + recovered opponent fumbles) minus giveaways (INTs thrown + fumbles lost), over each team's last ${RECENT_GAMES_WINDOW} games.`,
    opponent_similarity: similarity
      ? {
          flat_pass_edge: similarity.flat_pass_edge,
          flat_rush_edge: similarity.flat_rush_edge,
          weighted_pass_edge: similarity.weighted_pass_edge,
          weighted_rush_edge: similarity.weighted_rush_edge,
          home_avg_ess: similarity.home_avg_ess,
          away_avg_ess: similarity.away_avg_ess,
          bandwidth_multiplier: similarity.bandwidth_multiplier,
          note: "Tested (backtest_v6_similarity_weighted.py, backtest_v7_recency_similarity.py): reweighting each team's last 10 games toward opponents similar to this week's, plus recent games more heavily (last 4 = 2x, next 3 = 1.5x, oldest 3 = 1x), was the first version of this idea to move hit rate up at all when added to the model (51.26% -> 51.33%) -- still well short of the 52.4% breakeven, not something to treat as validated, shown here as context only, never part of the model prediction above. Positive = favors home, same sign convention as the model's own pass_edge/rush_edge. Effective sample size (out of 10) shows how concentrated the weighting actually is for this matchup -- 10 would mean it's identical to a flat average.",
        }
      : null,
    // Line movement -- NOT tested, and can't be yet: odds_snapshot collection
    // only started 2026-08-07 (see .github/workflows/odds-snapshot.yml), so
    // there's no history of graded games with snapshot data to backtest
    // against. Built now anyway (Jeff's call) as forward-only infrastructure,
    // same pattern as weather_forecast before it had a season behind it --
    // this table keeps growing every run, so once enough games have both
    // movement history AND a final score, a real backtest becomes possible.
    // Until then this is a fact, not a signal. Median across bookmakers at
    // the earliest vs. latest snapshot -- see getOddsMovement() for the
    // sign-convention note (spread here is negative-home-favored, opposite
    // game.spread_line, unlike the direction/moved flags which are already
    // self-consistent).
    line_movement: oddsMovement[game.game_id]
      ? {
          spread: oddsMovement[game.game_id].spread,
          total: oddsMovement[game.game_id].total,
          note: "Not tested, not in the model -- line-movement history only started being collected 2026-08-07, so there isn't a season of graded games behind this yet to backtest against. Shown as a fact (open vs. latest median line across bookmakers) so it accumulates for a future backtest once enough games have both movement data and a final score. Threshold for 'moved' is 1.0 point.",
        }
      : null,
    // Expert straight-up pick consensus (ESPN, see scripts/fetch_expert_picks.py)
    // -- can't be backtested, and never fully will be: no free source publishes
    // a historical archive of past expert picks, and this is a live opinion
    // captured going forward, not a stat derived from the game itself. Built
    // 2026-08-10 (Jeff's call) after checking several other free sources
    // (Pickwatch's real pick data is paywalled; CBS's old ATS panel and
    // Sporting News's picks page are both gone; Yahoo now just redirects to
    // Pickswise; Pickswise is free and ATS-focused but wasn't scriptable yet
    // and is one outlet, not a multi-expert panel). Straight-up (who wins),
    // not against the spread -- no free ATS *panel* exists right now.
    expert_consensus: expertConsensus
      ? {
          source: expertConsensus.source,
          num_experts: expertConsensus.num_experts,
          home_picks: expertConsensus.home_picks,
          away_picks: expertConsensus.away_picks,
          experts: expertConsensus.experts,
          snapshot_time: expertConsensus.snapshot_time,
          note: "Not tested, not in the model -- straight-up picks (who wins outright), not against the spread, and there's no free historical archive of past expert picks to backtest against even in principle. Shown as a fact so it's on record. A lopsided lean toward the underdog is the more interesting case here; a lean toward the favorite mostly just restates what the market already says.",
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// /games/:season/:week/leans -- games.html's "which team does the pile of
// situational signals/stats lean toward" columns. Deliberately scoped to a
// single week (not a whole season) -- computing the full situational-
// signals payload per game is ~15 D1 queries each (see
// getGameSituationalSignals above), and a full season is 285 games; a week
// is ~16. "1 point per" per Jeff -- every signal/stat gets equal weight for
// now regardless of whether it's tested-and-real (Big Home Dog, QB Status)
// or purely descriptive (Draft Capital, Referee, etc.) -- weighting is a
// planned future step, not this one. Because tested and untested signals
// are deliberately mixed with equal weight here, this reports "Ahead: TEAM
// (n-m)" (the same neutral gray-badge language/style as Team Comparison's
// per-category tally on game.html), NOT "Favors TEAM" -- that green badge
// is reserved for the two individually-tested-and-real signals, and this
// combined tally doesn't have that same backing as a whole.
// ---------------------------------------------------------------------------

// Same "which side is ahead" rule as pairHighlight() in page-game.js,
// re-implemented server-side for this tally (kept in sync by hand -- no
// shared module between Worker and site in this project).
function directionalPoint(awayVal, homeVal, higherBetter) {
  if (higherBetter === null || higherBetter === undefined) return null;
  if (typeof awayVal !== "number" || typeof homeVal !== "number" || awayVal === homeVal) return null;
  return (higherBetter ? awayVal > homeVal : awayVal < homeVal) ? "away" : "home";
}

function turnoverMarginFromStats(stats) {
  if (!stats) return null;
  const takeaways = (stats.def_interceptions || 0) + (stats.fumble_recovery_opp || 0);
  const giveaways = (stats.passing_interceptions || 0) + (stats.fumbles_lost_total || 0);
  return takeaways - giveaways;
}

// Situational signals that DO have a defensible "which side is ahead"
// direction, matching exactly what's highlighted (bold/badge) on
// game.html. Deliberately excludes: Timezone Crossing, Coaching Tenure,
// Matchup Type, Referee, Game Slot (no defensible direction on game.html
// either) and Common Opponents (a list of per-opponent rows, not a single
// scalar comparison -- folding it into a single point isn't well-defined
// yet; revisit if/when this gets real weighting).
function tallySituational(signals, homeRecentStats, awayRecentStats) {
  let home = 0;
  let away = 0;
  const add = (side) => {
    if (side === "home") home++;
    else if (side === "away") away++;
  };

  if (signals.big_home_dog.applies) add("home");

  const { home: hq, away: aq } = signals.qb_status;
  if (hq.changed && !aq.changed) add("away");
  else if (aq.changed && !hq.changed) add("home");

  add(directionalPoint(signals.fatigue.away.rest_days, signals.fatigue.home.rest_days, true));
  // road_streak_entering, NOT including_this_game -- the latter is always
  // "at least 1" for whichever team is away regardless of history, which
  // would silently award a point to home every single game. Entering-
  // streak is the actual leak-free history: 0 for both sides is a true
  // push, not a home point.
  add(directionalPoint(
    signals.fatigue.away.road_streak_entering,
    signals.fatigue.home.road_streak_entering,
    false
  ));
  add(directionalPoint(
    signals.fatigue.away.coming_off_overtime === null ? null : signals.fatigue.away.coming_off_overtime ? 1 : 0,
    signals.fatigue.home.coming_off_overtime === null ? null : signals.fatigue.home.coming_off_overtime ? 1 : 0,
    false
  ));
  add(directionalPoint(signals.draft_capital.away, signals.draft_capital.home, true));
  add(directionalPoint(signals.pass_defense_allowed.away, signals.pass_defense_allowed.home, false));
  add(directionalPoint(
    turnoverMarginFromStats(awayRecentStats),
    turnoverMarginFromStats(homeRecentStats),
    true
  ));

  return { home_points: home, away_points: away };
}

// Mirrors STAT_GROUPS in page-game.js -- same rows, same higherBetter
// directions, flattened into one list since the games-list tally doesn't
// need the group/category breakdown, just a total. Kept in sync by hand
// with page-game.js if those rows ever change.
const LEAN_STAT_ROWS = [
  { get: (t) => t.passing_yards, higherBetter: true },
  { get: (t) => t.passing_tds, higherBetter: true },
  { get: (t) => (t.attempts ? t.passing_epa / t.attempts : null), higherBetter: true },
  { get: (t) => t.passing_interceptions, higherBetter: false },
  { get: (t) => t.rushing_yards, higherBetter: true },
  { get: (t) => t.rushing_tds, higherBetter: true },
  { get: (t) => (t.carries ? t.rushing_epa / t.carries : null), higherBetter: true },
  { get: (t) => t.def_sacks, higherBetter: true },
  { get: (t) => t.def_interceptions, higherBetter: true },
  { get: (t) => t.def_tackles_for_loss, higherBetter: true },
  { get: (t) => t.def_fumbles_forced, higherBetter: true },
  {
    get: (t) => (t.sack_fumbles_lost || 0) + (t.rushing_fumbles_lost || 0) + (t.receiving_fumbles_lost || 0),
    higherBetter: false,
  },
  // FG Made/Att skipped -- shown as a fraction on game.html, higherBetter
  // null there too (not a single comparable number).
  { get: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), higherBetter: true },
  { get: (t) => t.penalties, higherBetter: false },
  { get: (t) => t.penalty_yards, higherBetter: false },
];

function tallyStats(homeStats, awayStats) {
  let home = 0;
  let away = 0;
  for (const row of LEAN_STAT_ROWS) {
    const side = directionalPoint(row.get(awayStats || {}), row.get(homeStats || {}), row.higherBetter);
    if (side === "home") home++;
    else if (side === "away") away++;
  }
  return { home_points: home, away_points: away };
}

// Minimum average movement (points) before games.html shows an arrow at
// all -- Jeff's call: small noise between bookmakers/snapshots shouldn't
// read as "the line is moving." Applies to spread and total independently.
const ODDS_MOVEMENT_THRESHOLD = 1.0;

// NOTE ON SIGN CONVENTION: `odds_snapshot.spread_line` (from
// fetch_odds_snapshot.py / The Odds API) is the HOME team's own bookmaker
// line, standard sportsbook convention -- negative means the home team is
// favored. This is the OPPOSITE sign convention from `game.spread_line`
// (nflverse, this codebase's existing convention -- positive means home
// favored, see Util.spreadForTeam on the site). Don't reuse
// Util.favoredTeamLine on raw odds_snapshot values without accounting for
// this -- it'll show the wrong team as favored. Only the *direction of
// change* (open vs. latest average) is used below, which is self-consistent
// regardless of which convention you pick, so this doesn't need converting
// for the arrow logic -- just documented so nobody gets bitten wiring up
// the per-book detail table later.
//
// Batched (one query, not one per game) average spread/total at each
// game's EARLIEST and LATEST snapshot timestamp, across all bookmakers.
// Games with only one snapshot timestamp so far are silently omitted (the
// WHERE clause requires two distinct timestamps) -- no movement to report
// yet, not an error.
// Uses the MEDIAN across bookmakers, not the mean -- Jeff's call, after we
// caught a case where a single book (bovada) had a stale/wrong line 7
// points off every other book's number, and the plain mean smeared that
// into what looked like real (but fake) line movement. SQLite/D1 has no
// built-in MEDIAN aggregate, so it's done by hand: rank values within each
// (game_id, bucket) partition, then average the middle one or two ranks
// (the standard odd/even-count median trick -- for an odd count both
// picked ranks are the same row, so it's a no-op; for an even count it
// splits the difference between the two middle values). Spread and total
// are ranked independently since a book can quote one market and not the
// other (e.g. betmgm with no spread posted) -- excluded from that market's
// ranking via the IS NOT NULL filter, not treated as a value.
async function getOddsMovement(DB, gameIds) {
  if (!gameIds.length) return {};
  const placeholders = gameIds.map(() => "?").join(",");
  const { results } = await DB.prepare(
    `
    WITH bounds AS (
      SELECT game_id, MIN(snapshot_time) AS first_time, MAX(snapshot_time) AS last_time
      FROM odds_snapshot
      WHERE game_id IN (${placeholders})
      GROUP BY game_id
      HAVING MIN(snapshot_time) != MAX(snapshot_time)
    ),
    tagged AS (
      SELECT o.game_id,
             CASE WHEN o.snapshot_time = b.first_time THEN 'open'
                  WHEN o.snapshot_time = b.last_time THEN 'latest' END AS bucket,
             o.spread_line, o.total_line
      FROM odds_snapshot o
      JOIN bounds b ON b.game_id = o.game_id
      WHERE o.snapshot_time IN (b.first_time, b.last_time)
    ),
    spread_ranked AS (
      SELECT game_id, bucket, spread_line,
             ROW_NUMBER() OVER (PARTITION BY game_id, bucket ORDER BY spread_line) AS rn,
             COUNT(*) OVER (PARTITION BY game_id, bucket) AS cnt
      FROM tagged
      WHERE spread_line IS NOT NULL AND bucket IS NOT NULL
    ),
    spread_median AS (
      SELECT game_id, bucket, AVG(spread_line) AS median_spread
      FROM spread_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY game_id, bucket
    ),
    total_ranked AS (
      SELECT game_id, bucket, total_line,
             ROW_NUMBER() OVER (PARTITION BY game_id, bucket ORDER BY total_line) AS rn,
             COUNT(*) OVER (PARTITION BY game_id, bucket) AS cnt
      FROM tagged
      WHERE total_line IS NOT NULL AND bucket IS NOT NULL
    ),
    total_median AS (
      SELECT game_id, bucket, AVG(total_line) AS median_total
      FROM total_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY game_id, bucket
    )
    SELECT b.game_id,
           so.median_spread AS open_spread, sl.median_spread AS latest_spread,
           tmo.median_total AS open_total, tml.median_total AS latest_total
    FROM bounds b
    LEFT JOIN spread_median so ON so.game_id = b.game_id AND so.bucket = 'open'
    LEFT JOIN spread_median sl ON sl.game_id = b.game_id AND sl.bucket = 'latest'
    LEFT JOIN total_median tmo ON tmo.game_id = b.game_id AND tmo.bucket = 'open'
    LEFT JOIN total_median tml ON tml.game_id = b.game_id AND tml.bucket = 'latest'
    `
  )
    .bind(...gameIds)
    .all();

  const movement = {};
  for (const row of results) {
    const spreadDelta = row.open_spread !== null && row.latest_spread !== null ? row.latest_spread - row.open_spread : null;
    const totalDelta = row.open_total !== null && row.latest_total !== null ? row.latest_total - row.open_total : null;
    movement[row.game_id] = {
      spread: {
        open: row.open_spread, latest: row.latest_spread,
        moved: spreadDelta !== null && Math.abs(spreadDelta) >= ODDS_MOVEMENT_THRESHOLD,
        direction: spreadDelta === null ? null : spreadDelta > 0 ? "up" : spreadDelta < 0 ? "down" : "flat",
      },
      total: {
        open: row.open_total, latest: row.latest_total,
        moved: totalDelta !== null && Math.abs(totalDelta) >= ODDS_MOVEMENT_THRESHOLD,
        direction: totalDelta === null ? null : totalDelta > 0 ? "up" : totalDelta < 0 ? "down" : "flat",
      },
    };
  }
  return movement;
}

// Current across-bookmaker MEDIAN spread/total for each game, as of its
// LATEST snapshot -- unlike getOddsMovement() above, this needs only one
// snapshot to return something (no HAVING two-distinct-timestamps filter),
// since "what's the market right now" doesn't require movement to exist
// yet. Median, not mean, for the same reason as getOddsMovement() above --
// see the comment there. Converts spread to game.spread_line's
// home-favored-positive convention (negating the raw odds_snapshot value --
// see the sign-convention note above) so callers can hand it straight to
// Util.favoredTeamLine like any other spread number. Total needs no
// conversion (same convention everywhere). The function/field names still
// say "average" -- that's the label shown on the site ("Average spread"),
// median is just how it's computed underneath.
//
// Also pulls DraftKings' own line at that same snapshot (Jeff bets at DK
// specifically, so "how does my book compare to the field" is a genuinely
// different, useful question from "what's the market doing" -- a book can
// legitimately sit off the median without being wrong/stale, e.g. for
// liability-management reasons, and that gap is exactly what's worth
// seeing before placing a bet there instead of shopping it). Null if DK
// hasn't posted that market yet at this snapshot -- not an error, some
// books lag others on posting certain lines.
async function getLatestOddsAverage(DB, gameIds) {
  if (!gameIds.length) return {};
  const placeholders = gameIds.map(() => "?").join(",");
  const { results } = await DB.prepare(
    `
    WITH latest_time AS (
      SELECT game_id, MAX(snapshot_time) AS snapshot_time
      FROM odds_snapshot
      WHERE game_id IN (${placeholders})
      GROUP BY game_id
    ),
    latest_rows AS (
      SELECT o.game_id, o.bookmaker, o.spread_line, o.total_line
      FROM odds_snapshot o
      JOIN latest_time lt ON lt.game_id = o.game_id AND lt.snapshot_time = o.snapshot_time
    ),
    spread_ranked AS (
      SELECT game_id, spread_line,
             ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY spread_line) AS rn,
             COUNT(*) OVER (PARTITION BY game_id) AS cnt
      FROM latest_rows
      WHERE spread_line IS NOT NULL
    ),
    spread_median AS (
      SELECT game_id, AVG(spread_line) AS median_spread
      FROM spread_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY game_id
    ),
    total_ranked AS (
      SELECT game_id, total_line,
             ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY total_line) AS rn,
             COUNT(*) OVER (PARTITION BY game_id) AS cnt
      FROM latest_rows
      WHERE total_line IS NOT NULL
    ),
    total_median AS (
      SELECT game_id, AVG(total_line) AS median_total
      FROM total_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY game_id
    ),
    book_counts AS (
      SELECT game_id, COUNT(DISTINCT bookmaker) AS book_count
      FROM latest_rows
      GROUP BY game_id
    ),
    draftkings AS (
      SELECT game_id, spread_line AS dk_spread_raw, total_line AS dk_total
      FROM latest_rows
      WHERE bookmaker = 'draftkings'
    )
    SELECT lt.game_id, lt.snapshot_time,
           sm.median_spread AS median_spread_raw, tm.median_total,
           bc.book_count,
           dk.dk_spread_raw, dk.dk_total
    FROM latest_time lt
    LEFT JOIN spread_median sm ON sm.game_id = lt.game_id
    LEFT JOIN total_median tm ON tm.game_id = lt.game_id
    LEFT JOIN book_counts bc ON bc.game_id = lt.game_id
    LEFT JOIN draftkings dk ON dk.game_id = lt.game_id
    `
  )
    .bind(...gameIds)
    .all();

  const average = {};
  for (const row of results) {
    average[row.game_id] = {
      spread: row.median_spread_raw === null ? null : -row.median_spread_raw,
      total: row.median_total,
      book_count: row.book_count,
      snapshot_time: row.snapshot_time,
      draftkings: {
        spread: row.dk_spread_raw === null || row.dk_spread_raw === undefined ? null : -row.dk_spread_raw,
        total: row.dk_total === undefined ? null : row.dk_total,
      },
    };
  }
  return average;
}

async function getWeekLeans(DB, season, week) {
  const { results: games } = await DB.prepare(
    `
    SELECT g.game_id, g.season, g.week, g.gameday, g.weekday, g.gametime, g.home_team, g.away_team,
           g.home_rest, g.away_rest, g.div_game, g.home_qb_id, g.away_qb_id, g.referee_id, g.spread_line
    FROM game g
    WHERE g.season = ? AND g.week = ?
    ORDER BY g.game_id
    `
  )
    .bind(season, week)
    .all();

  const [leans, oddsMovement, oddsAverage] = await Promise.all([
    Promise.all(
      games.map(async (game) => {
        const [signals, homeRecent, awayRecent] = await Promise.all([
          getGameSituationalSignals(DB, game),
          getTeamRollingAggregate(DB, game.home_team, game.gameday, RECENT_GAMES_WINDOW),
          getTeamRollingAggregate(DB, game.away_team, game.gameday, RECENT_GAMES_WINDOW),
        ]);
        return {
          game_id: game.game_id,
          situational: tallySituational(signals, homeRecent, awayRecent),
          stats: tallyStats(homeRecent, awayRecent),
        };
      })
    ),
    getOddsMovement(DB, games.map((g) => g.game_id)),
    getLatestOddsAverage(DB, games.map((g) => g.game_id)),
  ]);

  for (const lean of leans) {
    lean.odds_movement = oddsMovement[lean.game_id] || null;
    lean.odds_average = oddsAverage[lean.game_id] || null;
  }

  return { season, week, updated: new Date().toISOString(), leans };
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

  const [model, homeRecent, awayRecent, homeFull, awayFull, h2h, teamNames, signals, oddsHistory, oddsAverageMap] = await Promise.all([
    DB.prepare(
      `SELECT matchup, market_spread, model_spread, edge, p_home_covers, flagged, market_total, updated, note
       FROM model WHERE game_id = ?`
    )
      .bind(gameId)
      .first(),
    getTeamRollingAggregate(DB, game.home_team, game.gameday, RECENT_GAMES_WINDOW),
    getTeamRollingAggregate(DB, game.away_team, game.gameday, RECENT_GAMES_WINDOW),
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
    // Full per-bookmaker snapshot history for this game -- "details" view,
    // no movement-threshold gating here (unlike the games.html summary
    // arrows) since arriving at this page is already an intentional look
    // at this specific game. Sign convention note: spread_line here is the
    // HOME team's own bookmaker line (negative = home favored) -- the
    // OPPOSITE convention from game.spread_line above (positive = home
    // favored). See the comment on getOddsMovement().
    DB.prepare(
      `
      SELECT bookmaker, snapshot_time, home_moneyline, away_moneyline,
             spread_line, home_spread_odds, away_spread_odds,
             total_line, over_odds, under_odds
      FROM odds_snapshot
      WHERE game_id = ?
      ORDER BY snapshot_time ASC, bookmaker ASC
      `
    )
      .bind(gameId)
      .all(),
    getLatestOddsAverage(DB, [gameId]),
  ]);

  const team_names = {};
  for (const row of teamNames.results) team_names[row.team_abbr] = row.team_name;

  return {
    game,
    model: model ? { ...model, flagged: !!model.flagged } : null,
    signals,
    home: { team: game.home_team, recent: homeRecent, full_season: homeFull },
    away: { team: game.away_team, recent: awayRecent, full_season: awayFull },
    team_names,
    head_to_head: h2h.results,
    odds_history: oddsHistory.results,
    odds_average: oddsAverageMap[gameId] || null,
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

// ---------------------------------------------------------------------------
// Fantasy rankings -- top 10 per position for a given week, ranked by a
// matchup-adjusted projection: each player's own trailing-N-game average
// (same season-spanning rolling-window convention as RECENT_GAMES_WINDOW
// everywhere else in this file) times a multiplier for how many fantasy
// points their Week opponent has recently allowed to that position, relative
// to the league average. This is a convenience ranking, not a backtested
// model -- unlike the betting model, nothing here has been checked against
// actual weekly outcomes for predictive skill. Jeff's own DraftKings-style
// use case: no lineup-slot logic, just the best players at each position.
// ---------------------------------------------------------------------------

const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

// Standard fantasy kicker scoring (3pt for any FG under 40, 4pt 40-49, 5pt
// 50+, 1pt PAT, -1 missed FG) and standard DST scoring (1/sack, 2/INT,
// 2/fumble recovery, 2/safety, 6/defensive or return TD, plus a standard
// points-allowed tier table) -- not verified against DraftKings' own current
// rule sheet specifically (draftkings.com isn't reachable from this
// project's browsing tools, blocked as a gambling site), so treat these as a
// close, standard approximation rather than exact payout math. QB/RB/WR/TE
// use nflverse's own precomputed fantasy_points_ppr instead of a formula
// here -- reliable, but it's nflverse's standard PPR formula, not
// necessarily byte-identical to DK's own (e.g. DK's 100-yard rush/rec
// bonuses aren't in nflverse's column). Point values below are easy to
// adjust if exact DK parity ever matters more than directional ranking.
const KICKER_SCORE_SQL = `
  (COALESCE(s.fg_made_0_19,0)*3 + COALESCE(s.fg_made_20_29,0)*3 + COALESCE(s.fg_made_30_39,0)*3
   + COALESCE(s.fg_made_40_49,0)*4 + COALESCE(s.fg_made_50_59,0)*5 + COALESCE(s.fg_made_60_,0)*5
   + COALESCE(s.pat_made,0)*1 - COALESCE(s.fg_missed,0)*1)
`;

// Every team, this week's opponent, and this week's earliest kickoff date --
// used as a single uniform "before" cutoff for every rolling average below.
// Slightly conservative for teams playing later in the week (a Sunday/Monday
// team's trailing window is a few days less current than it could be), but
// avoids per-team cutoff bookkeeping for a tradeoff that doesn't matter at
// weekly granularity, and guarantees nothing from this week ever leaks into
// its own projection.
async function getFantasyWeekContext(DB, season, week) {
  const { results } = await DB.prepare(
    `
    SELECT home_team AS team, away_team AS opponent_team, gameday FROM game WHERE season = ? AND week = ?
    UNION ALL
    SELECT away_team AS team, home_team AS opponent_team, gameday FROM game WHERE season = ? AND week = ?
    `
  )
    .bind(season, week, season, week)
    .all();
  if (!results.length) return null;
  const opponents = {};
  let cutoff = null;
  for (const row of results) {
    opponents[row.team] = row.opponent_team;
    if (cutoff === null || row.gameday < cutoff) cutoff = row.gameday;
  }
  return { opponents, cutoff };
}

// QB/RB/WR/TE/K share the same shape: player-level rows, filtered by
// position_code, with a SQL expression giving that player-game's fantasy
// score. Ranks every player's game history by recency (rn), takes rn=1 as
// their current team (most recent game at this position -- filtered below by
// a recency cutoff so a long-retired player's old team doesn't get treated
// as current, since team_abbr values don't change and would otherwise still
// join fine against today's opponent map), and averages rn<=N as their own
// trailing form.
async function getSkillPositionOwnAverages(DB, position, scoreSql, fromTable, cutoff, window) {
  const { results } = await DB.prepare(
    `
    WITH ranked AS (
      SELECT pg.player_id, pg.team, ${scoreSql} AS score, g.gameday,
             ROW_NUMBER() OVER (PARTITION BY pg.player_id ORDER BY g.gameday DESC) AS rn
      FROM player_game pg
      JOIN game g ON g.game_id = pg.game_id
      JOIN ${fromTable} s ON s.player_game_id = pg.player_game_id
      WHERE pg.position_code = ? AND g.result IS NOT NULL AND g.gameday < ?
    ),
    current_team AS (
      SELECT player_id, team, gameday AS last_game FROM ranked WHERE rn = 1
    ),
    own_avg AS (
      SELECT player_id, AVG(score) AS own_avg, COUNT(*) AS games_played
      FROM ranked WHERE rn <= ?
      GROUP BY player_id
    )
    SELECT ct.player_id, p.display_name, ct.team, ct.last_game, oa.own_avg, oa.games_played
    FROM current_team ct
    JOIN own_avg oa ON oa.player_id = ct.player_id
    JOIN player p ON p.player_id = ct.player_id
    -- Only players who've played this position within the last ~2 seasons
    -- (730 days) -- excludes retired/long-inactive players.
    WHERE julianday(?) - julianday(ct.last_game) <= 730
    `
  )
    .bind(position, cutoff, window, cutoff)
    .all();
  return results;
}

// Points allowed to `position` per game, per team, over that team's last N
// games -- the standard "matchup rating" input. Averaged again across all
// teams by the caller to get the league-average baseline for the multiplier.
async function getAllowedToPosition(DB, position, scoreSql, fromTable, cutoff, window) {
  const { results } = await DB.prepare(
    `
    WITH recent_team_games AS (
      SELECT tg.team, tg.game_id,
             ROW_NUMBER() OVER (PARTITION BY tg.team ORDER BY g.gameday DESC) AS rn
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      WHERE g.result IS NOT NULL AND g.gameday < ?
    ),
    limited AS (SELECT team, game_id FROM recent_team_games WHERE rn <= ?),
    per_game_allowed AS (
      SELECT l.team, l.game_id, SUM(${scoreSql}) AS allowed_points
      FROM limited l
      JOIN player_game pg ON pg.game_id = l.game_id AND pg.opponent_team = l.team
      JOIN ${fromTable} s ON s.player_game_id = pg.player_game_id
      WHERE pg.position_code = ?
      GROUP BY l.team, l.game_id
    )
    SELECT team, AVG(allowed_points) AS avg_allowed, COUNT(*) AS games
    FROM per_game_allowed
    GROUP BY team
    `
  )
    .bind(cutoff, window, position)
    .all();
  const byTeam = {};
  let sum = 0;
  for (const row of results) {
    byTeam[row.team] = row.avg_allowed;
    sum += row.avg_allowed;
  }
  return { byTeam, leagueAvg: results.length ? sum / results.length : null };
}

// DST is team-level, not player-level, and its "matchup" runs the opposite
// direction from every other position: a good matchup means facing a WEAK
// opposing offense, not a defense that "allows a lot" (there's no such
// thing as a defense allowing fantasy points to another defense). Multiplier
// is league-average points scored / this week's opponent's own recent
// scoring average -- a below-average offense pushes the multiplier above 1.
async function getDstOwnAverages(DB, cutoff, window) {
  const { results } = await DB.prepare(
    `
    WITH base AS (
      SELECT tg.team, g.gameday, d.def_sacks, d.def_interceptions, d.def_fumbles, d.def_safeties, d.def_tds,
             st.pt_return_tds,
             CASE WHEN g.home_team = tg.team THEN g.away_score ELSE g.home_score END AS pts_allowed
      FROM team_game tg
      JOIN game g ON g.game_id = tg.game_id
      JOIN team_game_defense d ON d.team_game_id = tg.team_game_id
      LEFT JOIN team_game_special_teams st ON st.team_game_id = tg.team_game_id
      WHERE g.result IS NOT NULL AND g.gameday < ?
    ),
    scored AS (
      SELECT team, gameday,
        (COALESCE(def_sacks,0)*1 + COALESCE(def_interceptions,0)*2 + COALESCE(def_fumbles,0)*2
         + COALESCE(def_safeties,0)*2 + COALESCE(def_tds,0)*6 + COALESCE(pt_return_tds,0)*6
         + CASE
             WHEN pts_allowed = 0 THEN 10
             WHEN pts_allowed BETWEEN 1 AND 6 THEN 7
             WHEN pts_allowed BETWEEN 7 AND 13 THEN 4
             WHEN pts_allowed BETWEEN 14 AND 20 THEN 1
             WHEN pts_allowed BETWEEN 21 AND 27 THEN 0
             WHEN pts_allowed BETWEEN 28 AND 34 THEN -1
             ELSE -4
           END) AS score,
        ROW_NUMBER() OVER (PARTITION BY team ORDER BY gameday DESC) AS rn
      FROM base
    )
    SELECT team, AVG(score) AS own_avg, COUNT(*) AS games_played, MAX(gameday) AS last_game
    FROM scored WHERE rn <= ?
    GROUP BY team
    -- Same recency guard as getSkillPositionOwnAverages -- this schema
    -- keeps orphaned historical team_abbr values around (e.g. "OAK" has
    -- team_game rows only through the 2002 season, unrelated to the "LV"
    -- rows used for every game since; both exist as distinct entries in
    -- the team dimension table). Without this, a defunct abbreviation
    -- with a handful of 20-year-old games can rank purely because rn<=N
    -- trivially includes its entire (tiny, ancient) history. In practice
    -- the opponent-map filter downstream in getFantasyRankings would
    -- already drop these (they're not a valid current-week opponent), but
    -- this makes the guarantee explicit here too rather than relying on
    -- that alone.
    HAVING julianday(?) - julianday(MAX(gameday)) <= 730
    `
  )
    .bind(cutoff, window, cutoff)
    .all();
  return results;
}

// Each team's own recent scoring average (points, not fantasy points) --
// the input to the DST matchup multiplier above (a weak recent offense is a
// good DST matchup for whoever's facing them this week).
async function getTeamPointsScored(DB, cutoff, window) {
  const { results } = await DB.prepare(
    `
    WITH recent AS (
      SELECT tg.team,
             CASE WHEN g.home_team = tg.team THEN g.home_score ELSE g.away_score END AS points_scored,
             ROW_NUMBER() OVER (PARTITION BY tg.team ORDER BY g.gameday DESC) AS rn
      FROM team_game tg JOIN game g ON g.game_id = tg.game_id
      WHERE g.result IS NOT NULL AND g.gameday < ?
    )
    SELECT team, AVG(points_scored) AS avg_scored, COUNT(*) AS games
    FROM recent WHERE rn <= ?
    GROUP BY team
    `
  )
    .bind(cutoff, window)
    .all();
  const byTeam = {};
  let sum = 0;
  for (const row of results) {
    byTeam[row.team] = row.avg_scored;
    sum += row.avg_scored;
  }
  return { byTeam, leagueAvg: results.length ? sum / results.length : null };
}

// Most recent injury-report status per player for this exact (season, week)
// -- empty for a week that hasn't had a report filed yet (normal well before
// game week, not an error). A team can file more than one update in a week;
// ORDER BY date_modified DESC + first-wins in JS keeps only the latest.
async function getInjuryStatuses(DB, season, week, playerIds) {
  if (!playerIds.length) return {};
  const placeholders = playerIds.map(() => "?").join(",");
  const { results } = await DB.prepare(
    `
    SELECT player_id, report_status, date_modified
    FROM injury_report
    WHERE season = ? AND week = ? AND player_id IN (${placeholders})
    ORDER BY date_modified DESC
    `
  )
    .bind(season, week, ...playerIds)
    .all();
  const statuses = {};
  for (const row of results) {
    if (!(row.player_id in statuses)) statuses[row.player_id] = row.report_status;
  }
  return statuses;
}

async function getFantasyRankings(DB, season, week, position, limit = 10) {
  const ctx = await getFantasyWeekContext(DB, season, week);
  if (!ctx) return null;
  const { opponents, cutoff } = ctx;
  const window = RECENT_GAMES_WINDOW;

  if (position === "DST") {
    const [ownRows, offense] = await Promise.all([
      getDstOwnAverages(DB, cutoff, window),
      getTeamPointsScored(DB, cutoff, window),
    ]);
    const rankings = ownRows
      .map((r) => {
        const opponent = opponents[r.team] || null;
        const oppScored = opponent ? offense.byTeam[opponent] : null;
        const multiplier = oppScored && offense.leagueAvg ? offense.leagueAvg / oppScored : 1;
        return {
          team: r.team,
          opponent,
          own_avg: r.own_avg,
          games_played: r.games_played,
          matchup_multiplier: multiplier,
          opponent_points_scored_avg: oppScored,
          league_avg_points_scored: offense.leagueAvg,
          projected: r.own_avg * multiplier,
        };
      })
      .filter((r) => r.opponent)
      .sort((a, b) => b.projected - a.projected)
      .slice(0, limit);
    return { season, week, position, cutoff, window, scoring_note: "Standard DST scoring, not verified against DraftKings' current rule sheet -- see comment on DST_SCORE_SQL in the Worker source.", rankings };
  }

  const scoreSql = position === "K" ? KICKER_SCORE_SQL : "s.fantasy_points_ppr";
  const fromTable = position === "K" ? "player_game_special_teams" : "player_game_offense";

  const [ownRows, allowed] = await Promise.all([
    getSkillPositionOwnAverages(DB, position, scoreSql, fromTable, cutoff, window),
    getAllowedToPosition(DB, position, scoreSql, fromTable, cutoff, window),
  ]);

  const candidates = ownRows
    .map((r) => {
      const opponent = opponents[r.team] || null;
      const oppAllowed = opponent ? allowed.byTeam[opponent] : null;
      const multiplier = oppAllowed && allowed.leagueAvg ? oppAllowed / allowed.leagueAvg : 1;
      return {
        player_id: r.player_id,
        name: r.display_name,
        team: r.team,
        opponent,
        own_avg: r.own_avg,
        games_played: r.games_played,
        last_game: r.last_game,
        matchup_multiplier: multiplier,
        opponent_allowed_avg: oppAllowed,
        league_avg_allowed: allowed.leagueAvg,
        projected: r.own_avg * multiplier,
      };
    })
    .filter((r) => r.opponent);

  // Look up injury status for a shortlist, not every candidate -- RB/WR
  // especially can have 150-300+ eligible players league-wide, and
  // getInjuryStatuses binds one SQL parameter per player_id. D1 caps bound
  // parameters per query (100), so querying the full candidate pool in one
  // shot was throwing a real error for the high-volume positions (RB/WR/TE
  // all 500'd; QB/K, with far smaller pools, happened to stay under the
  // limit and worked -- that's what gave it away). Sorted by projected
  // points first, then chunked into batches of 90 (comfortably under the
  // limit alongside the season/week params) run in parallel -- covers the
  // whole requested pool (needed when the optimizer asks for limit=300+,
  // not just the top-10 rankings page's default) without hitting the cap.
  candidates.sort((a, b) => b.projected - a.projected);
  const shortlist = candidates.slice(0, Math.max(limit, 40));
  const CHUNK = 90;
  const injuryChunks = await Promise.all(
    Array.from({ length: Math.ceil(shortlist.length / CHUNK) || 0 }, (_, i) =>
      getInjuryStatuses(DB, season, week, shortlist.slice(i * CHUNK, (i + 1) * CHUNK).map((c) => c.player_id))
    )
  );
  const injuries = Object.assign({}, ...injuryChunks);
  for (const c of shortlist) c.injury_status = injuries[c.player_id] || null;

  // Exclude players ruled Out -- can't recommend starting them. Questionable/
  // Doubtful stay in, flagged, since those are still real game-time-decision
  // players worth seeing ranked rather than silently dropped.
  const rankings = shortlist.filter((c) => c.injury_status !== "Out").slice(0, limit);

  const scoringNote =
    position === "K"
      ? "Standard kicker scoring, not verified against DraftKings' current rule sheet -- see comment on KICKER_SCORE_SQL in the Worker source."
      : "nflverse's standard PPR fantasy_points_ppr, not necessarily identical to DraftKings' exact formula (e.g. 100-yard rush/rec bonuses).";

  return { season, week, position, cutoff, window, scoring_note: scoringNote, rankings };
}
