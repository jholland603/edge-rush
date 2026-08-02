(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const teamFilter = document.getElementById("team-filter");
  const tableWrap = document.getElementById("games-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentGames = [];

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (weekSelect.value) p.set("week", weekSelect.value);
    if (teamFilter.value) p.set("team", teamFilter.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    const seasons = [...index.seasons.games].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  async function loadSeasonGames() {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    const data = await Data.getGamesSeason(season);
    currentGames = data.games;

    const weeks = [...new Set(currentGames.map((g) => g.week))].sort((a, b) => a - b);
    Util.fillSelect(weekSelect, weeks, { placeholder: "All weeks" });
    const wanted = params.get("week");
    weekSelect.value = weeks.map(String).includes(wanted) ? wanted : "";
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
            <td>${Util.escapeHtml(g.away_team)} @ ${Util.escapeHtml(g.home_team)}</td>
            <td class="num">${score}</td>
            <td class="num">${Util.signed(g.spread_line, 1)}</td>
            <td class="num">${Util.num(g.total_line, 1)}</td>
            <td>${atsBadge(g)}</td>
            <td>${ouBadge(g)}</td>
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Wk</th><th>Type</th><th>Date</th><th>Matchup</th>
            <th class="num">Score (Away&ndash;Home)</th><th class="num">Home Line</th><th class="num">Total</th>
            <th>ATS</th><th>O/U</th>
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
