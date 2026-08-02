/**
 * Shared data-access layer. Every page module goes through these functions
 * instead of calling fetch() directly, so the JSON tree only has one set of
 * paths to update if it ever moves, and repeat lookups (e.g. re-picking the
 * same season) don't re-fetch over the network.
 */

const DATA_ROOT = "../data";
const INDEX_PATH = "../index.json";

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
  getIndex: () => fetchJSON(INDEX_PATH),

  getGamesSeason: (season) => fetchJSON(`${DATA_ROOT}/games/${season}.json`),

  getTeamsSeason: (season) => fetchJSON(`${DATA_ROOT}/teams/${season}.json`),

  getPlayersSeason: (season) => fetchJSON(`${DATA_ROOT}/players/season/${season}.json`),

  getPlayerCareer: (playerId) => fetchJSON(`${DATA_ROOT}/players/career/${playerId}.json`),

  getModelManifest: () => fetchJSON(`${DATA_ROOT}/model/manifest.json`),

  getModelWeek: (season, week) => fetchJSON(`${DATA_ROOT}/model/${season}-week${week}.json`),

  getPicksLog: () => fetchJSON(`${DATA_ROOT}/log/picks_log.json`),
};

window.Data = Data;
