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
