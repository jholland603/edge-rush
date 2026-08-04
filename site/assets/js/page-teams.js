(async function () {
  const seasonSelect = document.getElementById("season-select");
  const teamSelect = document.getElementById("team-select");
  const summaryEl = document.getElementById("summary-cards");
  const tableWrap = document.getElementById("team-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentSeasonData = null;
  let currentSeasonGames = [];
  let teamNames = {};
  let allTeamAbbrs = [];
  const gamePlayersCache = new Map(); // `${gameId}:${team}:${opponent}` -> {mine, theirs}

  function teamName(abbr) {
    return teamNames[abbr] || abbr;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (teamSelect.value) p.set("team", teamSelect.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    teamNames = index.team_names || {};
    allTeamAbbrs = [...(index.teams || [])].sort();
    // Use the `games` (schedule) season list, not `teams` (stats) -- the
    // schedule includes the current/future season as soon as it's loaded,
    // even before any games have been played and stats exist. That's what
    // lets this page default to the current season and fall back to a bare
    // schedule view below.
    const seasons = [...index.seasons.games].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  async function loadTeamsForSeason() {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    const [statsData, gamesData] = await Promise.all([
      Data.getTeamsSeason(season),
      Data.getGamesSeason(season),
    ]);
    currentSeasonData = statsData;
    currentSeasonGames = gamesData.games || [];
    // Team list always comes from the full league, not from which teams
    // happen to have stats rows this season -- otherwise a season with no
    // stats yet (e.g. before the season starts) would leave this dropdown
    // empty and the page unusable.
    Util.fillSelect(
      teamSelect,
      allTeamAbbrs.map((abbr) => ({ value: abbr, label: teamName(abbr) }))
    );
    const wanted = params.get("team");
    teamSelect.value = allTeamAbbrs.includes(wanted) ? wanted : allTeamAbbrs[0];
  }

  function renderTeam() {
    if (!currentSeasonData) return;
    const team = teamSelect.value;
    const season = seasonSelect.value;

    // Merge this team's scheduled games with whatever stats rows exist for
    // them. A game with no stats yet (season hasn't started, or hasn't
    // reached this week) still shows up as a schedule row with "-" stats
    // and no player breakdown, instead of the row disappearing entirely.
    const statByGameId = new Map((currentSeasonData.teams[team] || []).map((r) => [r.game_id, r]));
    const teamGames = currentSeasonGames.filter((g) => g.home_team === team || g.away_team === team);

    const rows = teamGames
      .map((g) => {
        const stat = statByGameId.get(g.game_id);
        if (stat) return { ...stat, hasStats: true };
        const isHome = g.home_team === team;
        return {
          week: g.week,
          season_type: g.game_type,
          game_id: g.game_id,
          opponent_team: isHome ? g.away_team : g.home_team,
          is_home: isHome,
          hasStats: false,
        };
      })
      .sort((a, b) => a.week - b.week);

    if (!rows.length) {
      Util.showEmpty(tableWrap, "No games found for this team/season.");
      summaryEl.innerHTML = "";
      return;
    }

    const statRows = rows.filter((r) => r.hasStats);

    if (!statRows.length) {
      summaryEl.innerHTML = `
        <div class="banner info" style="grid-column: 1 / -1;">
          No stats logged yet for ${Util.escapeHtml(teamName(team))} in ${Util.escapeHtml(season)}
          &mdash; showing the schedule below.
        </div>
      `;
    } else {
      // Season summary (regular + postseason combined), only over games that
      // actually have stats -- future/unplayed games in a mixed season
      // shouldn't drag these averages toward zero.
      const totalAtt = statRows.reduce((s, r) => s + (r.attempts || 0), 0);
      const totalCarries = statRows.reduce((s, r) => s + (r.carries || 0), 0);
      const totalPassEpa = statRows.reduce((s, r) => s + (r.passing_epa || 0), 0);
      const totalRushEpa = statRows.reduce((s, r) => s + (r.rushing_epa || 0), 0);
      const passEpaPlay = totalAtt ? totalPassEpa / totalAtt : 0;
      const rushEpaPlay = totalCarries ? totalRushEpa / totalCarries : 0;
      const turnovers = statRows.reduce(
        (s, r) => s + (r.passing_interceptions || 0) + (r.rushing_fumbles_lost || 0) + (r.sack_fumbles_lost || 0) + (r.receiving_fumbles_lost || 0),
        0
      );

      summaryEl.innerHTML = `
        <div class="stat-card card"><div class="value">${statRows.length}</div><div class="label">Games played</div></div>
        <div class="stat-card card"><div class="value">${Util.signed(passEpaPlay, 2)}</div><div class="label">Pass EPA / play</div></div>
        <div class="stat-card card"><div class="value">${Util.signed(rushEpaPlay, 2)}</div><div class="label">Rush EPA / play</div></div>
        <div class="stat-card card"><div class="value">${turnovers}</div><div class="label">Turnovers lost</div></div>
      `;
    }

    const bodyRows = rows
      .map((r, i) => {
        const oppCell = `${r.is_home ? "vs" : "@"} ${Util.escapeHtml(teamName(r.opponent_team))}`;

        if (!r.hasStats) {
          return `
            <tr>
              <td>${Util.escapeHtml(Util.weekLabelShort(r.week, r.season_type))}</td>
              <td>${Util.escapeHtml(r.season_type)}</td>
              <td>${oppCell}</td>
              <td class="num">-</td><td class="num">-</td><td class="num">-</td>
              <td class="num">-</td><td class="num">-</td><td class="num">-</td>
              <td class="num">-</td><td class="num">-</td>
              <td class="text-faint">-</td>
            </tr>
          `;
        }

        const passEpaP = r.attempts ? r.passing_epa / r.attempts : null;
        const rushEpaP = r.carries ? r.rushing_epa / r.carries : null;
        return `
          <tr>
            <td>${Util.escapeHtml(Util.weekLabelShort(r.week, r.season_type))}</td>
            <td>${Util.escapeHtml(r.season_type)}</td>
            <td>${oppCell}</td>
            <td class="num">${r.passing_yards ?? "-"}</td>
            <td class="num">${r.passing_tds ?? "-"}</td>
            <td class="num">${Util.signed(passEpaP, 2)}</td>
            <td class="num">${r.rushing_yards ?? "-"}</td>
            <td class="num">${r.rushing_tds ?? "-"}</td>
            <td class="num">${Util.signed(rushEpaP, 2)}</td>
            <td class="num">${r.sacks_suffered ?? "-"}</td>
            <td class="num">${r.passing_interceptions ?? "-"}</td>
            <td><button type="button" class="expand-toggle" data-idx="${i}">Players &#9656;</button></td>
          </tr>
          <tr class="expand-row" data-idx="${i}" style="display:none;">
            <td colspan="12"><div class="expand-body">Loading&hellip;</div></td>
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
            <th></th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;

    tableWrap.querySelectorAll(".expand-toggle").forEach((btn) => {
      btn.addEventListener("click", () => toggleExpand(btn, rows[Number(btn.dataset.idx)]));
    });
  }

  function renderPlayerBreakdown(players) {
    if (!players.length) {
      return `<p class="text-faint" style="margin:0;">No offensive player stats logged for this game.</p>`;
    }
    const rows = players
      .map(
        (p) => `
        <tr>
          <td><a href="players.html?id=${encodeURIComponent(p.player_id)}">${Util.escapeHtml(p.display_name)}</a></td>
          <td>${Util.escapeHtml(p.position || "-")}</td>
          <td class="num">${p.attempts ? `${p.completions}/${p.attempts}` : "-"}</td>
          <td class="num">${p.attempts ? p.passing_yards : "-"}</td>
          <td class="num">${p.attempts ? p.passing_tds : "-"}</td>
          <td class="num">${p.attempts ? p.passing_interceptions : "-"}</td>
          <td class="num">${p.carries ? p.carries : "-"}</td>
          <td class="num">${p.carries ? p.rushing_yards : "-"}</td>
          <td class="num">${p.carries ? p.rushing_tds : "-"}</td>
          <td class="num">${p.targets ? `${p.receptions}/${p.targets}` : "-"}</td>
          <td class="num">${p.targets ? p.receiving_yards : "-"}</td>
          <td class="num">${p.targets ? p.receiving_tds : "-"}</td>
        </tr>`
      )
      .join("");

    return `
      <div class="subtable">
        <table>
          <thead>
            <tr>
              <th>Player</th><th>Pos</th>
              <th class="num">Cmp/Att</th><th class="num">Pass Yds</th><th class="num">Pass TD</th><th class="num">INT</th>
              <th class="num">Car</th><th class="num">Rush Yds</th><th class="num">Rush TD</th>
              <th class="num">Rec/Tgt</th><th class="num">Rec Yds</th><th class="num">Rec TD</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Both teams that played in the game, selected team first (labeled with
  // the "Opp" column's perspective already shown on the row), opponent
  // second, with a visual separator between the two blocks.
  function renderTwoTeamBreakdown(team, teamPlayers, opponent, opponentPlayers) {
    return `
      <div class="team-players-block">
        <h4 class="team-players-heading">${Util.escapeHtml(teamName(team))}</h4>
        ${renderPlayerBreakdown(teamPlayers)}
      </div>
      <div class="team-players-separator"></div>
      <div class="team-players-block">
        <h4 class="team-players-heading">${Util.escapeHtml(teamName(opponent))}</h4>
        ${renderPlayerBreakdown(opponentPlayers)}
      </div>
    `;
  }

  async function toggleExpand(btn, row) {
    const idx = btn.dataset.idx;
    const expandRow = tableWrap.querySelector(`tr.expand-row[data-idx="${idx}"]`);
    if (!expandRow) return;

    const isOpen = expandRow.style.display !== "none";
    if (isOpen) {
      expandRow.style.display = "none";
      btn.innerHTML = "Players &#9656;";
      return;
    }

    expandRow.style.display = "";
    btn.innerHTML = "Players &#9662;";

    const body = expandRow.querySelector(".expand-body");
    const team = teamSelect.value;
    const opponent = row.opponent_team;
    const key = `${row.game_id}:${team}:${opponent}`;
    try {
      if (!gamePlayersCache.has(key)) {
        const [mine, theirs] = await Promise.all([
          Data.getGamePlayers(row.game_id, team),
          Data.getGamePlayers(row.game_id, opponent),
        ]);
        gamePlayersCache.set(key, { mine, theirs });
      }
      const { mine, theirs } = gamePlayersCache.get(key);
      body.innerHTML = renderTwoTeamBreakdown(team, mine.players, opponent, theirs.players);
    } catch (err) {
      body.innerHTML = `<p class="text-faint" style="margin:0;">Failed to load player stats.</p>`;
    }
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
