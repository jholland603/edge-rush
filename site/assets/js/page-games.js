(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const teamFilter = document.getElementById("team-filter");
  const tableWrap = document.getElementById("games-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentGames = [];
  let modelByGameId = new Map();
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

  async function loadSeasonGames() {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    const [data, model] = await Promise.all([
      Data.getGamesSeason(season),
      // Model predictions are Phase 2/3 data -- may not exist for every
      // season (only whatever weeks weekly_update.py has scored). Missing
      // is normal, not an error, so don't let it break the schedule view.
      Data.getModelSeason(season).catch(() => []),
    ]);
    currentGames = data.games;
    modelByGameId = new Map(model.map((m) => [m.game_id, m]));

    const weeks = [...new Set(currentGames.map((g) => g.week))].sort((a, b) => a - b);
    const weekOptions = weeks.map((w) => ({ value: String(w), label: weekLabel(w) }));
    Util.fillSelect(weekSelect, weekOptions, { placeholder: "All weeks" });
    const wanted = params.get("week");
    weekSelect.value = weeks.map(String).includes(wanted) ? wanted : "";
  }

  // Postseason weeks have a fixed game_type per week (REG weeks don't --
  // those just stay "Week N"). Look up any game in that week to find its type.
  const PLAYOFF_ROUND_LABELS = {
    WC: "Wild Card",
    DIV: "Divisional",
    CON: "Conference Championship",
    SB: "Super Bowl",
  };
  function weekLabel(week) {
    const example = currentGames.find((g) => g.week === week);
    const label = example && PLAYOFF_ROUND_LABELS[example.game_type];
    return label || `Week ${week}`;
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
            <td>${g.week}</td>
            <td>${Util.escapeHtml(g.game_type)}</td>
            <td>${Util.formatDate(g.gameday)}</td>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamName(g.away_team))} @ ${Util.escapeHtml(teamName(g.home_team))}</a></td>
            <td class="num">${score}</td>
            <td class="num">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</td>
            <td class="num">${Util.num(g.total_line, 1)}</td>
            <td>${atsBadge(g)}</td>
            <td>${ouBadge(g)}</td>
            <td>${edgeBadge(g)}</td>
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
            <th>ATS</th><th>O/U</th><th class="num">Model Edge</th><th>Roof</th><th>Forecast</th>
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
    await loadSeasonGames();
    render();
    syncUrl();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
