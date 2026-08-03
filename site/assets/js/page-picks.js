(async function () {
  const weekSelect = document.getElementById("week-select");
  const weekTableWrap = document.getElementById("week-table-wrap");
  const logSummary = document.getElementById("log-summary");
  const logTableWrap = document.getElementById("log-table-wrap");

  const params = new URLSearchParams(location.search);
  let teamNames = {};

  function teamName(abbr) {
    return teamNames[abbr] || abbr;
  }

  function flagBadge(flagged) {
    return flagged
      ? `<span class="badge positive">Flagged</span>`
      : `<span class="badge neutral">No edge</span>`;
  }

  async function renderWeek() {
    Util.showLoading(weekTableWrap);
    const [season, week] = weekSelect.value.split("-");
    try {
      const data = await Data.getModelWeek(season, week);
      const rows = data.games
        .slice()
        .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
        .map(
          (g) => `
          <tr>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamName(g.away_team))} @ ${Util.escapeHtml(teamName(g.home_team))}</a></td>
            <td class="num">${Util.favoredTeamLine(g.market_spread, g.home_team, g.away_team)}</td>
            <td class="num">${Util.favoredTeamLine(g.model_spread, g.home_team, g.away_team)}</td>
            <td class="num">${Util.favoredTeamLine(g.edge, g.home_team, g.away_team)}</td>
            <td class="num">${Util.pct(g.p_home_covers, 1)}</td>
            <td class="num">${Util.num(g.market_total, 1)}</td>
            <td>${flagBadge(g.flagged)}</td>
          </tr>`
        )
        .join("");

      weekTableWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Matchup</th><th class="num">Market Spread</th><th class="num">Model Spread</th>
              <th class="num">Edge</th><th class="num">P(home covers)</th><th class="num">Total</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (err) {
      Util.showError(weekTableWrap, err);
    }
  }

  async function renderLog() {
    Util.showLoading(logTableWrap);
    try {
      const log = await Data.getPicksLog();
      const graded = log.filter((r) => r.covered !== null && r.covered !== undefined);
      const hitRate = graded.length ? graded.filter((r) => r.covered).length / graded.length : null;
      const avgClv = graded.length
        ? graded.reduce((s, r) => s + (r.clv ?? 0), 0) / graded.filter((r) => r.clv !== null && r.clv !== undefined).length
        : null;

      logSummary.innerHTML = `
        <div class="stat-card card"><div class="value">${log.length}</div><div class="label">Total picks logged</div></div>
        <div class="stat-card card"><div class="value">${graded.length}</div><div class="label">Graded so far</div></div>
        <div class="stat-card card"><div class="value">${hitRate === null ? "-" : Util.pct(hitRate, 1)}</div><div class="label">Hit rate (graded)</div></div>
        <div class="stat-card card"><div class="value">${avgClv === null || Number.isNaN(avgClv) ? "-" : Util.signed(avgClv, 2)}</div><div class="label">Avg CLV, pts (graded)</div></div>
      `;

      const rows = log
        .slice()
        .sort((a, b) => b.logged_at.localeCompare(a.logged_at))
        .map((r) => {
          const pending = r.actual_result === null || r.actual_result === undefined;
          let statusBadge = `<span class="badge neutral">Pending</span>`;
          if (!pending) {
            if (r.covered === null || r.covered === undefined) statusBadge = `<span class="badge warn">Push</span>`;
            else statusBadge = r.covered
              ? `<span class="badge positive">Covered</span>`
              : `<span class="badge negative">Missed</span>`;
          }
          return `
            <tr>
              <td>${r.season} Wk${r.week}</td>
              <td>${Util.formatDate(r.gameday)}</td>
              <td><a href="game.html?id=${encodeURIComponent(r.game_id)}">${Util.escapeHtml(teamName(r.away_team))} @ ${Util.escapeHtml(teamName(r.home_team))}</a></td>
              <td class="num">${Util.favoredTeamLine(r.market_spread, r.home_team, r.away_team)}</td>
              <td class="num">${Util.favoredTeamLine(r.model_spread, r.home_team, r.away_team)}</td>
              <td class="num">${Util.favoredTeamLine(r.edge, r.home_team, r.away_team)}</td>
              <td class="num">${Util.favoredTeamLine(r.closing_line, r.home_team, r.away_team)}</td>
              <td class="num">${r.clv === null || r.clv === undefined ? "-" : Util.signed(r.clv, 2)}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        })
        .join("");

      logTableWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Week</th><th>Date</th><th>Matchup</th>
              <th class="num">Market</th><th class="num">Model</th><th class="num">Edge</th>
              <th class="num">Closing</th><th class="num">CLV</th><th>Result</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (err) {
      Util.showError(logTableWrap, err);
      logSummary.innerHTML = "";
    }
  }

  weekSelect.addEventListener("change", () => {
    const p = new URLSearchParams();
    p.set("week", weekSelect.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    renderWeek();
  });

  try {
    const index = await Data.getIndex();
    teamNames = index.team_names || {};
  } catch (err) {
    // Non-fatal -- falls back to abbreviations if /index can't be reached.
  }

  try {
    const manifest = await Data.getModelManifest();
    if (!manifest.weeks || !manifest.weeks.length) {
      Util.showEmpty(weekTableWrap, "No model predictions have been generated yet.");
    } else {
      const options = manifest.weeks.map((w) => ({
        value: `${w.season}-${w.week}`,
        label: `${w.season} · Week ${w.week}`,
      }));
      Util.fillSelect(weekSelect, options);
      const wanted = params.get("week");
      const latestValue = `${manifest.latest.season}-${manifest.latest.week}`;
      weekSelect.value = options.some((o) => o.value === wanted) ? wanted : latestValue;
      await renderWeek();
    }
  } catch (err) {
    Util.showError(weekTableWrap, err);
  }

  renderLog();
})();
