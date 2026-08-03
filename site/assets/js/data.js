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

  getPicksLog: () => fetchJSON(`${API_BASE}/picks`),

  getGameDetail: (gameId) => fetchJSON(`${API_BASE}/game/${encodeURIComponent(gameId)}`),

  getTrends: () => fetchJSON(`${API_BASE}/trends`),

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
};

window.Data = Data;
