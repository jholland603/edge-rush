(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const tableWrap = document.getElementById("signals-table-wrap");

  const params = new URLSearchParams(location.search);
  let manifestWeeks = []; // [{season, week, game_type}], ascending

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (weekSelect.value) p.set("week", weekSelect.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  function teamLabel(abbr) {
    return Util.escapeHtml(abbr || "-");
  }

  // Big-home-dog rule is defined by market_spread <= -7 (home team getting
  // 7+ points) -- points-getting figure for display is just the absolute
  // value of that spread.
  function bigHomeDogPointsLabel(g) {
    if (!g.big_home_dog.applies) return "-";
    const pts = Math.abs(g.market_spread).toFixed(1).replace(/\.0$/, "");
    return `${teamLabel(g.home_team)} +${pts}`;
  }

  function modelPickLabel(g) {
    const { side, edge, flagged } = g.model;
    if (side === null || edge === null || edge === undefined) return `<span class="text-faint">-</span>`;
    const team = side === "home" ? g.home_team : g.away_team;
    const badgeClass = flagged ? "positive" : "neutral";
    const badgeText = flagged ? "PICK" : "lean";
    return `${teamLabel(team)} <span class="text-faint">(${Util.signed(edge, 1)} pts)</span> <span class="badge ${badgeClass}">${badgeText}</span>`;
  }

  function verdictLabel(g) {
    const modelTeam = g.model.side === "home" ? g.home_team : g.model.side === "away" ? g.away_team : null;
    const dogTeam = g.big_home_dog.side === "home" ? g.home_team : null;
    switch (g.agreement) {
      case "agree":
        return `<span class="badge positive">Both favor ${teamLabel(modelTeam)}</span>`;
      case "conflict":
        return `<span class="badge warn">Split &mdash; model: ${teamLabel(modelTeam)}, trend: ${teamLabel(dogTeam)}</span>`;
      case "model_only":
        return `<span class="badge neutral">Model only: ${teamLabel(modelTeam)}${g.model.flagged ? "" : " (weak lean)"}</span>`;
      case "trend_only":
        return `<span class="badge neutral">Trend rule only: ${teamLabel(dogTeam)}</span>`;
      default:
        return `<span class="text-faint">No signal</span>`;
    }
  }

  function renderTable(data) {
    if (!data.games.length) {
      Util.showEmpty(tableWrap, "No games for this week.");
      return;
    }
    const rows = data.games
      .map(
        (g) => `
        <tr>
          <td>${Util.escapeHtml(g.away_team)} @ ${Util.escapeHtml(g.home_team)}</td>
          <td class="num">${Util.favoredTeamLine(g.market_spread, g.home_team, g.away_team)}</td>
          <td>${modelPickLabel(g)}</td>
          <td>${bigHomeDogPointsLabel(g)}</td>
          <td>${verdictLabel(g)}</td>
        </tr>`
      )
      .join("");
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Matchup</th><th class="num">Market Line</th><th>Model Pick</th>
            <th>Big Home Dog Rule</th><th>Verdict</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadWeek() {
    const season = Number(seasonSelect.value);
    const week = Number(weekSelect.value);
    if (!season || !week) return;
    syncUrl();
    Util.showLoading(tableWrap);
    try {
      const data = await Data.getWeekSignals(season, week);
      renderTable(data);
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  }

  function populateWeekSelect(season) {
    const weeks = manifestWeeks.filter((w) => w.season === season);
    const options = weeks.map((w) => ({ value: String(w.week), label: Util.weekLabel(w.week, w.game_type) }));
    Util.fillSelect(weekSelect, options);
    const wantedWeek = Number(params.get("week"));
    const hasWanted = weeks.some((w) => w.week === wantedWeek);
    weekSelect.value = hasWanted ? String(wantedWeek) : String(weeks[0].week);
  }

  try {
    const manifest = await Data.getModelManifest();
    manifestWeeks = manifest.weeks || [];
    if (!manifestWeeks.length) {
      Util.showEmpty(tableWrap, "No model predictions have been generated for any week yet.");
      seasonSelect.disabled = true;
      weekSelect.disabled = true;
      return;
    }

    const seasons = [...new Set(manifestWeeks.map((w) => w.season))].sort((a, b) => a - b);
    Util.fillSelect(seasonSelect, seasons);
    const wantedSeason = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wantedSeason) ? String(wantedSeason) : String(seasons[0]);

    populateWeekSelect(Number(seasonSelect.value));
    await loadWeek();

    seasonSelect.addEventListener("change", () => {
      populateWeekSelect(Number(seasonSelect.value));
      loadWeek();
    });
    weekSelect.addEventListener("change", loadWeek);
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
