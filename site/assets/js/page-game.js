(async function () {
  const titleEl = document.getElementById("game-title");
  const subtitleEl = document.getElementById("game-subtitle");
  const summaryWrap = document.getElementById("game-summary-wrap");
  const modelWrap = document.getElementById("model-wrap");
  const compareWrap = document.getElementById("compare-table-wrap");
  const h2hWrap = document.getElementById("h2h-table-wrap");

  const params = new URLSearchParams(location.search);
  const gameId = params.get("id");

  function atsResult(g) {
    if (g.result === null || g.result === undefined || g.spread_line === null || g.spread_line === undefined) {
      return null;
    }
    const margin = g.result - g.spread_line;
    if (margin === 0) return "Push";
    return margin > 0 ? `${g.home_team} covered` : `${g.away_team} covered`;
  }

  function ouResult(g) {
    if (g.total === null || g.total === undefined || g.total_line === null || g.total_line === undefined) {
      return null;
    }
    const diff = g.total - g.total_line;
    if (diff === 0) return "Push";
    return diff > 0 ? "Over" : "Under";
  }

  function renderSummary(g, teamNames) {
    const played = g.home_score !== null && g.home_score !== undefined;
    const ats = atsResult(g);
    const ou = ouResult(g);

    titleEl.textContent = `${teamNames[g.away_team] || g.away_team} @ ${teamNames[g.home_team] || g.home_team}`;
    subtitleEl.textContent = `${g.season} · Week ${g.week} · ${g.game_type} · ${Util.formatDate(g.gameday)}`;

    const weather = [];
    const roofLabel = Util.roofLabel(g.roof, g.stadium_id);
    if (roofLabel !== "-") weather.push(Util.escapeHtml(roofLabel));
    if (g.surface) weather.push(Util.escapeHtml(g.surface));
    if (g.temp !== null && g.temp !== undefined) {
      // Actual post-game weather takes priority once it exists.
      weather.push(`${g.temp}°F`);
      if (g.wind !== null && g.wind !== undefined) weather.push(`${g.wind} mph wind`);
    } else {
      const forecast = Util.forecastLabel(g);
      if (forecast !== "-") weather.push(`forecast: ${Util.escapeHtml(forecast)}`);
    }

    summaryWrap.innerHTML = `
      <div class="card-grid">
        <div class="stat-card card">
          <div class="value">${played ? `${g.away_score}&ndash;${g.home_score}` : "-"}</div>
          <div class="label">Final score (away&ndash;home)</div>
        </div>
        <div class="stat-card card">
          <div class="value">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</div>
          <div class="label">Closing spread${ats ? ` &mdash; ${Util.escapeHtml(ats)}` : ""}</div>
        </div>
        <div class="stat-card card">
          <div class="value">${Util.num(g.total_line, 1)}</div>
          <div class="label">Total line${ou ? ` &mdash; ${Util.escapeHtml(ou)}` : ""}</div>
        </div>
        <div class="stat-card card">
          <div class="value" style="font-size:1.1rem;">${weather.length ? weather.join(", ") : "-"}</div>
          <div class="label">Conditions</div>
        </div>
      </div>
    `;
  }

  function renderModel(model, g) {
    if (!model) {
      modelWrap.innerHTML = "";
      return;
    }
    modelWrap.innerHTML = `
      <div class="banner ${model.flagged ? "warn" : "info"}">
        <strong>Model prediction:</strong> favors ${Util.favoredTeamLine(model.model_spread, g.home_team, g.away_team)}
        vs. a market of ${Util.favoredTeamLine(model.market_spread, g.home_team, g.away_team)}
        &mdash; edge favors ${Util.favoredTeamLine(model.edge, g.home_team, g.away_team)}
        ${model.p_home_covers !== null && model.p_home_covers !== undefined ? `, P(home covers) ${Util.pct(model.p_home_covers, 1)}` : ""}.
        ${model.flagged ? "This game was flagged (|edge| &ge; 2.0 pts)." : "Not flagged."}
        <a href="picks.html">See full picks log &rarr;</a>
      </div>
    `;
  }

  const STAT_ROWS = [
    { label: "Games", get: (t) => t.games_played, fmt: (v) => (v ?? "-") },
    { label: "Pass Yds", get: (t) => t.passing_yards },
    { label: "Pass TD", get: (t) => t.passing_tds },
    { label: "Pass EPA/play", get: (t) => (t.attempts ? t.passing_epa / t.attempts : null), fmt: (v) => Util.signed(v, 2) },
    { label: "INT Thrown", get: (t) => t.passing_interceptions },
    { label: "Rush Yds", get: (t) => t.rushing_yards },
    { label: "Rush TD", get: (t) => t.rushing_tds },
    { label: "Rush EPA/play", get: (t) => (t.carries ? t.rushing_epa / t.carries : null), fmt: (v) => Util.signed(v, 2) },
    {
      label: "Turnovers Lost",
      get: (t) => (t.sack_fumbles_lost || 0) + (t.rushing_fumbles_lost || 0) + (t.receiving_fumbles_lost || 0),
    },
    { label: "Sacks (Def)", get: (t) => t.def_sacks },
    { label: "INT (Def)", get: (t) => t.def_interceptions },
    { label: "TFL (Def)", get: (t) => t.def_tackles_for_loss },
    { label: "Forced Fumbles", get: (t) => t.def_fumbles_forced },
    { label: "FG Made/Att", get: (t) => `${t.fg_made ?? 0}/${t.fg_att ?? 0}`, fmt: (v) => v },
    { label: "Punt Net Avg", get: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), fmt: (v) => Util.num(v, 1) },
    { label: "Penalties", get: (t) => t.penalties },
    { label: "Penalty Yds", get: (t) => t.penalty_yards },
  ];

  function cell(stat, teamStats) {
    const fmt = stat.fmt || ((v) => (v === null || v === undefined ? "-" : v));
    return `<td class="num">${fmt(stat.get(teamStats || {}))}</td>`;
  }

  function renderCompare(detail) {
    const rows = STAT_ROWS.map(
      (stat) => `
        <tr>
          <td>${stat.label}</td>
          ${cell(stat, detail.away.season_to_date)}
          ${cell(stat, detail.away.full_season)}
          ${cell(stat, detail.home.season_to_date)}
          ${cell(stat, detail.home.full_season)}
        </tr>
      `
    ).join("");

    compareWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Stat</th>
            <th class="num" colspan="2">${Util.escapeHtml(detail.away.team)} (away)</th>
            <th class="num" colspan="2">${Util.escapeHtml(detail.home.team)} (home)</th>
          </tr>
          <tr>
            <th></th>
            <th class="num">To date</th><th class="num">Full season</th>
            <th class="num">To date</th><th class="num">Full season</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderH2H(detail, games) {
    const teamNames = detail.team_names || {};
    if (!games.length) {
      const awayName = teamNames[detail.away.team] || detail.away.team;
      const homeName = teamNames[detail.home.team] || detail.home.team;
      Util.showEmpty(h2hWrap, `No prior meetings between ${Util.escapeHtml(awayName)} and ${Util.escapeHtml(homeName)} in the data set.`);
      return;
    }
    const rows = games
      .map((g) => {
        const ats = atsResult(g);
        return `
          <tr>
            <td>${g.season} Wk${g.week}</td>
            <td>${Util.formatDate(g.gameday)}</td>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamNames[g.away_team] || g.away_team)} @ ${Util.escapeHtml(teamNames[g.home_team] || g.home_team)}</a></td>
            <td class="num">${g.away_score}&ndash;${g.home_score}</td>
            <td class="num">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</td>
            <td>${ats ? Util.escapeHtml(ats) : "-"}</td>
          </tr>
        `;
      })
      .join("");

    h2hWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Week</th><th>Date</th><th>Matchup</th>
            <th class="num">Score (Away&ndash;Home)</th><th class="num">Line</th><th>ATS</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  if (!gameId) {
    titleEl.textContent = "No game selected";
    subtitleEl.textContent = "";
    Util.showEmpty(compareWrap, "No game id in the URL.");
    Util.showEmpty(h2hWrap, "No game id in the URL.");
    return;
  }

  try {
    const detail = await Data.getGameDetail(gameId);
    renderSummary(detail.game, detail.team_names || {});
    renderModel(detail.model, detail.game);
    renderCompare(detail);
    renderH2H(detail, detail.head_to_head);
  } catch (err) {
    titleEl.textContent = "Couldn't load game";
    subtitleEl.textContent = "";
    Util.showError(summaryWrap, err);
    Util.showError(compareWrap, err);
    Util.showError(h2hWrap, err);
  }
})();
