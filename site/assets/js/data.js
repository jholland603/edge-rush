/**
 * Shared data-access layer. Every page module goes through these functions
 * instead of calling fetch() directly.
 *
 * Every page (games/teams/players/compare/home/picks) is now backed by the
 * edge-rush-api Worker, which reads live from D1 -- including model
 * predictions and the picks log (migrated from static JSON, see HANDOFF.md).
 */

// Set this to your deployed Worker's URL after running `wrangler deploy`
// from the worker/ directory (wrangler prints it, looks like
// "https://edge-rush-api.<your-subdomain>.workers.dev"). Until this is set
// to the real URL, every page will fail to load.
const API_BASE = "https://edge-rush-api.disttrkr.workers.dev";

const _cache = new Map();

async function fetchJSON(path) {
  if (_cache.has(path)) return _cache.get(path);
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  _cache.set(path, json);
  return json;
}

const Data = {
  getIndex: () => fetchJSON(`${API_BASE}/index`),

  getGamesSeason: (season) => fetchJSON(`${API_BASE}/games/${season}`),

  // Situational-signal / stat "lean" tallies for games.html's two summary
  // columns -- scoped to a single week (not a whole season) since each
  // game costs ~15 D1 queries to compute; see getWeekLeans() in the
  // Worker.
  getWeekLeans: (season, week) => fetchJSON(`${API_BASE}/games/${season}/${week}/leans`),

  getTeamsSeason: (season) => fetchJSON(`${API_BASE}/teams/${season}`),

  getPlayersSeason: (season) => fetchJSON(`${API_BASE}/players/season/${season}`),

  // `range` is optional: {from, to} (inclusive season years) restricts the
  // returned career_totals to that window instead of the player's whole
  // career -- this is the compare-page year-range filter. `scope` is
  // "reg" (default, regular season only), "post" (playoffs only), or "all"
  // (regular season + playoffs). Cached per id+range+scope so switching
  // either doesn't serve a stale response back.
  getPlayerCareer: (playerId, range, scope) => {
    const p = new URLSearchParams();
    if (range && range.from && range.to) {
      p.set("from", range.from);
      p.set("to", range.to);
    }
    if (scope) p.set("scope", scope);
    const q = p.toString();
    return fetchJSON(`${API_BASE}/players/career/${encodeURIComponent(playerId)}${q ? `?${q}` : ""}`);
  },

  getModelManifest: () => fetchJSON(`${API_BASE}/model/manifest`),

  getModelWeek: (season, week) => fetchJSON(`${API_BASE}/model/${season}/${week}`),

  getModelSeason: (season) => fetchJSON(`${API_BASE}/model/season/${season}`),

  // Picks-log rows for a season, keyed by game_id -- folded into the
  // games.html schedule table (Bet/Closing Line/CLV/Result columns) instead
  // of a standalone picks page.
  getPicksSeason: (season) => fetchJSON(`${API_BASE}/picks/season/${season}`),

  getGameDetail: (gameId) => fetchJSON(`${API_BASE}/game/${encodeURIComponent(gameId)}`),

  // Players who logged offensive touches for `team` in a single game --
  // the breakdown behind a team-stats weekly-log row.
  getGamePlayers: (gameId, team) =>
    fetchJSON(`${API_BASE}/game/${encodeURIComponent(gameId)}/players/${encodeURIComponent(team)}`),

  getTrends: () => fetchJSON(`${API_BASE}/trends`),

  // Top-10-per-position fantasy rankings for a given week -- see
  // getFantasyRankings() in the Worker for the projection methodology.
  getFantasyRankings: (season, week, position) =>
    fetchJSON(`${API_BASE}/fantasy/${season}/${week}/${encodeURIComponent(position)}`),

  // Free-form historical trend query -- not cached (each filter combination
  // is effectively a unique query, caching would just grow _cache forever
  // for no benefit since nobody re-runs the exact same filter set twice in
  // one visit).
  getTrendsQuery: (filters) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters || {})) {
      if (v !== null && v !== undefined && v !== "") p.set(k, v);
    }
    return fetch(`${API_BASE}/trends/query?${p.toString()}`).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed to load trends query: ${res.status}`);
      return body;
    });
  },

  getLeadersCatalog: () => fetchJSON(`${API_BASE}/leaders/catalog`),

  getPlayerLeaders: ({ stat, from, to, position, limit, scope }) => {
    const p = new URLSearchParams({ stat, from, to });
    if (position) p.set("position", position);
    if (limit) p.set("limit", limit);
    if (scope) p.set("scope", scope);
    return fetchJSON(`${API_BASE}/leaders/players?${p.toString()}`);
  },

  getTeamLeaders: ({ stat, from, to, limit, scope }) => {
    const p = new URLSearchParams({ stat, from, to });
    if (limit) p.set("limit", limit);
    if (scope) p.set("scope", scope);
    return fetchJSON(`${API_BASE}/leaders/teams?${p.toString()}`);
  },

  // Players on `team` who contributed to that team's leaderboard total --
  // the "show players" expand on a team-leaders row. Not available for
  // points_scored (no single-column player equivalent); the Worker 404s.
  getTeamStatPlayers: ({ team, stat, from, to, scope, limit }) => {
    const p = new URLSearchParams({ stat, from, to });
    if (limit) p.set("limit", limit);
    if (scope) p.set("scope", scope);
    return fetchJSON(`${API_BASE}/leaders/teams/${encodeURIComponent(team)}/players?${p.toString()}`);
  },
};

window.Data = Data;
