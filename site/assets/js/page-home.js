(async function () {
  const banner = document.getElementById("status-banner");
  const cardsEl = document.getElementById("stat-cards");

  function setCards({ seasonRange, teamCount, playerCount, updated }) {
    cardsEl.innerHTML = `
      <div class="stat-card card"><div class="value">${seasonRange}</div><div class="label">Seasons of data</div></div>
      <div class="stat-card card"><div class="value">${teamCount}</div><div class="label">Teams tracked</div></div>
      <div class="stat-card card"><div class="value">${playerCount.toLocaleString()}</div><div class="label">Players tracked</div></div>
      <div class="stat-card card"><div class="value" style="font-size:1.1rem;">${Util.formatDateTime(updated)}</div><div class="label">Data last updated</div></div>
    `;
  }

  try {
    const index = await Data.getIndex();
    const seasons = index.seasons.games;
    const seasonRange = `${Math.min(...seasons)}&ndash;${Math.max(...seasons)}`;
    setCards({
      seasonRange,
      teamCount: index.teams.length,
      playerCount: index.player_count,
      updated: index.updated,
    });
  } catch (err) {
    Util.showError(cardsEl, err);
  }

  try {
    const manifest = await Data.getModelManifest();
    if (!manifest.latest) {
      banner.className = "banner info";
      banner.innerHTML = "No model predictions have been generated yet.";
      return;
    }
    const { season, week, game_type } = manifest.latest;
    const week1 = await Data.getModelWeek(season, week);
    const flaggedCount = week1.games.filter((g) => g.flagged).length;
    banner.className = "banner warn";
    banner.innerHTML = `
      <strong>Latest model run:</strong> Season ${season}, ${Util.escapeHtml(Util.weekLabel(week, game_type))} &mdash;
      ${week1.games.length} games, ${flaggedCount} flagged (|edge| &ge; 2.0 pts).
      Paper trading only &mdash; this model's confidence is not reliably calibrated.
      <a href="picks.html">See full picks &amp; log &rarr;</a>
    `;
  } catch (err) {
    banner.className = "banner info";
    banner.innerHTML = "No model predictions available yet.";
  }
})();
