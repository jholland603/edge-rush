/**
 * Shared data-access layer. Every page module goes through these functions
 * instead of calling fetch() directly.
 *
 * games/teams/players/compare pages are backed by the edge-rush-api Worker
 * (reads live from D1). model + picks data isn't in D1 yet (Phase 2/3, never
 * migrated -- see HANDOFF.md), so the home and picks pages still read the
 * static data/*.json tree directly, same as before.
 */

// Set this to your deployed Worker's URL after running `wrangler deploy`
// from the worker/ directory (wrangler prints it, looks like
// "https://edge-rush-api.<your-subdomain>.workers.dev"). Until this is set
// to the real URL, games/teams/players/compare pages will fail to load.
const API_BASE = "https://edge-rush-api.disttrkr.workers.dev";

const DATA_ROOT = "../data"; // still used for model/*.json and the picks log only

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

  // --- still static JSON: no D1 tables for model predictions or the picks
  // log yet (Phase 2/3 data, out of scope for this migration) ---
  getModelManifest: () => fetchJSON(`${DATA_ROOT}/model/manifest.json`),

  getModelWeek: (season, week) => fetchJSON(`${DATA_ROOT}/model/${season}-week${week}.json`),

  getPicksLog: () => fetchJSON(`${DATA_ROOT}/log/picks_log.json`),
};

window.Data = Data;
