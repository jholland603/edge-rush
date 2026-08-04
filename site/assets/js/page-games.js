(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const teamFilter = document.getElementById("team-filter");
  const tableWrap = document.getElementById("games-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentGames = [];
  let modelByGameId = new Map();
  let picksByGameId = new Map();
  let teamNames = {};

  function teamName(abbr) {
    return teamNames[abbr] || abbr;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (weekSelect.value) p.set("week", weekSelect.value);
    if (teamFilter.value) p.set("team", teamFilter.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    teamNames = index.team_names || {};
    const seasons = [...index.seasons.games].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  async function loadSeasonGames({ defaultToCurrentWeek = false } = {}) {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    const [data, model, picks] = await Promise.all([
      Data.getGamesSeason(season),
      // Model predictions and the picks log are Phase 2/3 data -- may not
      // exist for every season (only whatever weeks weekly_update.py has
      // scored/flagged). Missing is normal, not an error, so don't let it
      // break the schedule view.
      Data.getModelSeason(season).catch(() => []),
      Data.getPicksSeason(season).catch(() => []),
    ]);
    currentGames = data.games;
    modelByGameId = new Map(model.map((m) => [m.game_id, m]));
    picksByGameId = new Map(picks.map((p) => [p.game_id, p]));

    const weeks = [...new Set(currentGames.map((g) => g.week))].sort((a, b) => a - b);
    const weekOptions = weeks.map((w) => {
      const example = currentGames.find((g) => g.week === w);
      return { value: String(w), label: Util.weekLabel(w, example && example.game_type) };
    });
    Util.fillSelect(weekSelect, weekOptions, { placeholder: "All weeks" });
    const wanted = params.get("week");
    if (weeks.map(String).includes(wanted)) {
      weekSelect.value = wanted;
    } else if (defaultToCurrentWeek) {
      // Only on the page's first load with no explicit week/season params --
      // land on whatever week is current instead of the full "All weeks"
      // list. Switching seasons by hand afterward goes back to "All weeks"
      // (browsing a whole past season is more useful than pinning it to
      // whatever week happens to be "current" today).
      const cw = Util.currentWeek(currentGames);
      weekSelect.value = cw !== null && weeks.includes(cw) ? String(cw) : "";
    } else {
      weekSelect.value = "";
    }
  }

  function edgeBadge(g) {
    const m = modelByGameId.get(g.game_id);
    if (!m) return `<span class="badge neutral">-</span>`;
    const cls = m.flagged ? "positive" : "neutral";
    return `<span class="badge ${cls}">${Util.favoredTeamLine(m.edge, g.home_team, g.away_team)}</span>`;
  }

  function atsBadge(g) {
    if (g.result === null || g.result === undefined || g.spread_line === null || g.spread_line === undefined) {
      return `<span class="badge neutral">-</span>`;
    }
    const margin = g.result - g.spread_line;
    if (margin === 0) return `<span class="badge neutral">Push</span>`;
    const covered = margin > 0 ? g.home_team : g.away_team;
    return `<span class="badge positive">${Util.escapeHtml(covered)} covered</span>`;
  }

  function ouBadge(g) {
    if (g.total === null || g.total === undefined || g.total_line === null || g.total_line === undefined) {
      return `<span class="badge neutral">-</span>`;
    }
    const diff = g.total - g.total_line;
    if (diff === 0) return `<span class="badge neutral">Push</span>`;
    return diff > 0
      ? `<span class="badge warn">Over</span>`
      : `<span class="badge neutral">Under</span>`;
  }

  // --- Pick-log cells (folded in from the old picks.html) --------------
  // A game only has a picks_log row if it was flagged (|edge| >= 2.0 at the
  // time weekly_update.py scored it) -- most games have no pick, hence the
  // "-" fallback everywhere below.
  function pickBetCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="text-faint">-</span>`;
    return p.bet_placed === "Y"
      ? `<span class="badge positive">Y</span>`
      : `<span class="badge neutral">N</span>`;
  }

  function pickClosingLineCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p || p.closing_line === null || p.closing_line === undefined) return `<span class="text-faint">-</span>`;
    return Util.favoredTeamLine(p.closing_line, g.home_team, g.away_team);
  }

  function pickClvCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="text-faint">-</span>`;
    return Util.signed(p.clv, 1);
  }

  function pickResultBadge(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="badge neutral">-</span>`;
    if (p.covered === null || p.covered === undefined) return `<span class="badge neutral">Pending</span>`;
    return p.covered
      ? `<span class="badge positive">${Util.escapeHtml(p.side)} covered</span>`
      : `<span class="badge negative">${Util.escapeHtml(p.side)} missed</span>`;
  }

  function render() {
    let rows = currentGames.slice();
    if (weekSelect.value) rows = rows.filter((g) => String(g.week) === weekSelect.value);
    const teamQuery = teamFilter.value.trim().toUpperCase();
    if (teamQuery) rows = rows.filter((g) => g.home_team === teamQuery || g.away_team === teamQuery);
    rows.sort((a, b) => a.week - b.week || a.gameday.localeCompare(b.gameday));

    if (!rows.length) {
      Util.showEmpty(tableWrap, "No games match these filters.");
      return;
    }

    const bodyRows = rows
      .map((g) => {
        const played = g.home_score !== null && g.home_score !== undefined;
        const score = played ? `${g.away_score}&ndash;${g.home_score}` : "-";
        return `
          <tr>
            <td>${Util.escapeHtml(Util.weekLabelShort(g.week, g.game_type))}</td>
            <td>${Util.escapeHtml(g.game_type)}</td>
            <td>${Util.formatDate(g.gameday)}</td>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamName(g.away_team))} @ ${Util.escapeHtml(teamName(g.home_team))}</a></td>
            <td class="num">${score}</td>
            <td class="num">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</td>
            <td class="num">${Util.num(g.total_line, 1)}</td>
            <td>${atsBadge(g)}</td>
            <td>${ouBadge(g)}</td>
            <td>${edgeBadge(g)}</td>
            <td>${pickBetCell(g)}</td>
            <td class="num">${pickClosingLineCell(g)}</td>
            <td class="num">${pickClvCell(g)}</td>
            <td>${pickResultBadge(g)}</td>
            <td>${Util.escapeHtml(Util.roofLabel(g.roof, g.stadium_id))}</td>
            <td>${Util.escapeHtml(Util.forecastLabel(g))}</td>
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Wk</th><th>Type</th><th>Date</th><th>Matchup</th>
            <th class="num">Score (Away&ndash;Home)</th><th class="num">Line</th><th class="num">Total</th>
            <th>ATS</th><th>O/U</th><th class="num">Model Edge</th>
            <th>Bet</th><th class="num">Closing Line</th><th class="num">CLV</th><th>Pick Result</th>
            <th>Roof</th><th>Forecast</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;
  }

  seasonSelect.addEventListener("change", async () => {
    try {
      await loadSeasonGames();
      render();
      syncUrl();
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  });
  weekSelect.addEventListener("change", () => {
    render();
    syncUrl();
  });
  teamFilter.addEventListener(
    "input",
    Util.debounce(() => {
      render();
      syncUrl();
    }, 200)
  );

  try {
    await loadSeasons();
    if (params.get("team")) teamFilter.value = params.get("team").toUpperCase();
    // Default to the current week only when the URL didn't already ask for a
    // specific season -- if it did, respect the season default logic above.
    await loadSeasonGames({ defaultToCurrentWeek: !params.get("season") });
    render();
    syncUrl();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
