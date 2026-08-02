(async function () {
  const seasonSelect = document.getElementById("season-select");
  const teamSelect = document.getElementById("team-select");
  const summaryEl = document.getElementById("summary-cards");
  const tableWrap = document.getElementById("team-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentSeasonData = null;

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (teamSelect.value) p.set("team", teamSelect.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    const seasons = [...index.seasons.teams].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  async function loadTeamsForSeason() {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    currentSeasonData = await Data.getTeamsSeason(season);
    const teamNames = Object.keys(currentSeasonData.teams).sort();
    Util.fillSelect(teamSelect, teamNames);
    const wanted = params.get("team");
    teamSelect.value = teamNames.includes(wanted) ? wanted : teamNames[0];
  }

  function renderTeam() {
    if (!currentSeasonData) return;
    const team = teamSelect.value;
    const rows = (currentSeasonData.teams[team] || [])
      .slice()
      .sort((a, b) => a.week - b.week);

    if (!rows.length) {
      Util.showEmpty(tableWrap, "No games found for this team/season.");
      summaryEl.innerHTML = "";
      return;
    }

    // Season summary (regular + postseason combined)
    const totalAtt = rows.reduce((s, r) => s + (r.attempts || 0), 0);
    const totalCarries = rows.reduce((s, r) => s + (r.carries || 0), 0);
    const totalPassEpa = rows.reduce((s, r) => s + (r.passing_epa || 0), 0);
    const totalRushEpa = rows.reduce((s, r) => s + (r.rushing_epa || 0), 0);
    const passEpaPlay = totalAtt ? totalPassEpa / totalAtt : 0;
    const rushEpaPlay = totalCarries ? totalRushEpa / totalCarries : 0;
    const turnovers = rows.reduce(
      (s, r) => s + (r.passing_interceptions || 0) + (r.rushing_fumbles_lost || 0) + (r.sack_fumbles_lost || 0) + (r.receiving_fumbles_lost || 0),
      0
    );

    summaryEl.innerHTML = `
      <div class="stat-card card"><div class="value">${rows.length}</div><div class="label">Games played</div></div>
      <div class="stat-card card"><div class="value">${Util.signed(passEpaPlay, 2)}</div><div class="label">Pass EPA / play</div></div>
      <div class="stat-card card"><div class="value">${Util.signed(rushEpaPlay, 2)}</div><div class="label">Rush EPA / play</div></div>
      <div class="stat-card card"><div class="value">${turnovers}</div><div class="label">Turnovers lost</div></div>
    `;

    const bodyRows = rows
      .map((r) => {
        const passEpaP = r.attempts ? r.passing_epa / r.attempts : null;
        const rushEpaP = r.carries ? r.rushing_epa / r.carries : null;
        return `
          <tr>
            <td>${r.week}</td>
            <td>${Util.escapeHtml(r.season_type)}</td>
            <td>@${Util.escapeHtml(r.opponent_team)}</td>
            <td class="num">${r.passing_yards ?? "-"}</td>
            <td class="num">${r.passing_tds ?? "-"}</td>
            <td class="num">${Util.signed(passEpaP, 2)}</td>
            <td class="num">${r.rushing_yards ?? "-"}</td>
            <td class="num">${r.rushing_tds ?? "-"}</td>
            <td class="num">${Util.signed(rushEpaP, 2)}</td>
            <td class="num">${r.sacks_suffered ?? "-"}</td>
            <td class="num">${r.passing_interceptions ?? "-"}</td>
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Wk</th><th>Type</th><th>Opp</th>
            <th class="num">Pass Yds</th><th class="num">Pass TD</th><th class="num">Pass EPA/play</th>
            <th class="num">Rush Yds</th><th class="num">Rush TD</th><th class="num">Rush EPA/play</th>
            <th class="num">Sacks Allowed</th><th class="num">INT</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;
  }

  seasonSelect.addEventListener("change", async () => {
    syncUrl();
    try {
      await loadTeamsForSeason();
      renderTeam();
      syncUrl();
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  });

  teamSelect.addEventListener("change", () => {
    renderTeam();
    syncUrl();
  });

  try {
    await loadSeasons();
    await loadTeamsForSeason();
    renderTeam();
    syncUrl();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
