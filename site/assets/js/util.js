/**
 * Small formatting / DOM helpers shared by every page controller.
 */

const Util = {
  escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /** number with fixed decimals, "-" for null/undefined/NaN */
  num(value, decimals = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return Number(value).toFixed(decimals);
  },

  /** always-signed number, e.g. +3.5 / -2.0 */
  signed(value, decimals = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    const n = Number(value);
    const s = n.toFixed(decimals);
    return n > 0 ? `+${s}` : s;
  },

  pct(value, decimals = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return `${(Number(value) * 100).toFixed(decimals)}%`;
  },

  /** American spread convention for display, e.g. home -3.5 / away +3.5 */
  spreadForTeam(spreadHomePositive, isHome) {
    if (spreadHomePositive === null || spreadHomePositive === undefined) return "-";
    // Convention used across this project's data: positive spread_line = home favored.
    // Displayed as a standard bookmaker line (favorite shown negative).
    const val = isHome ? -spreadHomePositive : spreadHomePositive;
    return Util.signed(val, 1);
  },

  /**
   * Label WHICH team is favored, bookmaker-style (favorite always shown
   * negative), e.g. "NE -3.5" or "SEA +3.5" -- same idea for `spread_line`
   * (positive = home favored) and model `edge` (positive = model favors
   * home relative to the market). Returns "PICK" at exactly 0, "-" for
   * null/undefined/NaN.
   */
  favoredTeamLine(value, homeAbbr, awayAbbr, decimals = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    const n = Number(value);
    if (n === 0) return "PICK";
    const team = n > 0 ? homeAbbr : awayAbbr;
    return `${Util.escapeHtml(team)} ${(-Math.abs(n)).toFixed(decimals)}`;
  },

  /**
   * Stadiums with a retractable roof -- `game.roof` is null for these until
   * the game-time decision is made (usually not known far in advance), so
   * a null roof there means "TBD," not missing data. Every other stadium's
   * roof type is fixed and known even for future games.
   */
  RETRACTABLE_STADIUMS: new Set(["ATL97", "DAL00", "HOU00", "IND00", "PHO00"]),

  /** Human label for a game's roof/venue type, e.g. "Dome", "Outdoors", "Retractable (TBD)" */
  roofLabel(roof, stadiumId) {
    switch (roof) {
      case "dome":
        return "Dome";
      case "outdoors":
        return "Outdoors";
      case "closed":
        return "Retractable (closed)";
      case "open":
        return "Retractable (open)";
      default:
        return Util.RETRACTABLE_STADIUMS.has(stadiumId) ? "Retractable (TBD)" : "-";
    }
  },

  /** Short forecast summary, e.g. "72°F, 8mph, 20% rain" -- "-" if no forecast on file */
  forecastLabel(g) {
    if (g.forecast_temp === null || g.forecast_temp === undefined) return "-";
    const parts = [`${Math.round(g.forecast_temp)}°F`];
    if (g.forecast_wind !== null && g.forecast_wind !== undefined) parts.push(`${Math.round(g.forecast_wind)}mph`);
    if (g.forecast_precip_prob !== null && g.forecast_precip_prob !== undefined) parts.push(`${Math.round(g.forecast_precip_prob)}% rain`);
    return parts.join(", ");
  },

  /** Postseason round names, keyed by game_type_code / season_type. */
  PLAYOFF_ROUND_LABELS: {
    WC: "Wild Card",
    DIV: "Divisional",
    CON: "Conference Championship",
    SB: "Super Bowl",
  },

  /** "Week 3" for regular season, "Wild Card" etc. for postseason -- for
   * standalone text (subtitles, dropdown options, inline "2024 Week 3"). */
  weekLabel(week, gameType) {
    return Util.PLAYOFF_ROUND_LABELS[gameType] || `Week ${week}`;
  },

  /** Bare "3" for regular season, "Wild Card" etc. for postseason -- for
   * table cells under an existing "Wk"/"Week" column header. */
  weekLabelShort(week, gameType) {
    return Util.PLAYOFF_ROUND_LABELS[gameType] || String(week);
  },

  /**
   * The "current" week within a season's games list: the first week whose
   * games haven't all been played yet (by gameday), so mid-season this is
   * whichever week is in progress or coming up next. Before the season's
   * first game (e.g. during the offseason, once next year's schedule is
   * loaded), that's week 1 -- no games have a gameday in the past yet, so
   * the very first week qualifies. After the season's last game, falls back
   * to the final week (e.g. the Super Bowl week stays "current" until a new
   * season's games exist). Returns null for an empty games list. Used to
   * default the games-page week filter instead of "All weeks".
   */
  currentWeek(games) {
    if (!games.length) return null;
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
    const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
    for (const w of weeks) {
      const lastGameday = games
        .filter((g) => g.week === w)
        .reduce((max, g) => (g.gameday > max ? g.gameday : max), "");
      if (lastGameday >= today) return w;
    }
    return weeks[weeks.length - 1];
  },

  formatDate(dateStr) {
    if (!dateStr) return "-";
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  },

  formatDateTime(isoStr) {
    if (!isoStr) return "-";
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },

  debounce(fn, wait = 200) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  },

  /** build a <select> element's option list from an array of {value,label} or plain values */
  fillSelect(selectEl, items, { placeholder } = {}) {
    selectEl.innerHTML = "";
    if (placeholder) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = placeholder;
      selectEl.appendChild(opt);
    }
    for (const item of items) {
      const opt = document.createElement("option");
      if (typeof item === "object") {
        opt.value = item.value;
        opt.textContent = item.label;
      } else {
        opt.value = item;
        opt.textContent = item;
      }
      selectEl.appendChild(opt);
    }
  },

  el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  },

  showLoading(container, label = "Loading...") {
    container.innerHTML = `<div class="loading">${label}</div>`;
  },

  showEmpty(container, label = "No data found.") {
    container.innerHTML = `<div class="empty-state">${label}</div>`;
  },

  showError(container, err) {
    container.innerHTML = `<div class="empty-state text-danger">Couldn't load data: ${Util.escapeHtml(err.message || err)}</div>`;
  },
};

window.Util = Util;
