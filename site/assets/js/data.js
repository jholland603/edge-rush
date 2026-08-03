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
  // career -- this is the compare-page year-range filter. Cached per
  // id+range so switching the range doesn't serve a stale full-career
  // response back.
  getPlayerCareer: (playerId, range) => {
    const q = range && range.from && range.to ? `?from=${range.from}&to=${range.to}` : "";
    return fetchJSON(`${API_BASE}/players/career/${encodeURIComponent(playerId)}${q}`);
  },

  getModelManifest: () => fetchJSON(`${API_BASE}/model/manifest`),

  getModelWeek: (season, week) => fetchJSON(`${API_BASE}/model/${season}/${week}`),

  getModelSeason: (season) => fetchJSON(`${API_BASE}/model/season/${season}`),

  getPicksLog: () => fetchJSON(`${API_BASE}/picks`),

  getGameDetail: (gameId) => fetchJSON(`${API_BASE}/game/${encodeURIComponent(gameId)}`),

  getTrends: () => fetchJSON(`${API_BASE}/trends`),

  getLeadersCatalog: () => fetchJSON(`${API_BASE}/leaders/catalog`),

  getPlayerLeaders: ({ stat, from, to, position, limit }) => {
    const p = new URLSearchParams({ stat, from, to });
    if (position) p.set("position", position);
    if (limit) p.set("limit", limit);
    return fetchJSON(`${API_BASE}/leaders/players?${p.toString()}`);
  },

  getTeamLeaders: ({ stat, from, to, limit }) => {
    const p = new URLSearchParams({ stat, from, to });
    if (limit) p.set("limit", limit);
    return fetchJSON(`${API_BASE}/leaders/teams?${p.toString()}`);
  },
};

window.Data = Data;
