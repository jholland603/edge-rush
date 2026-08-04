(async function () {
  const banner = document.getElementById("status-banner");

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
      <a href="games.html?season=${season}&week=${week}">See these games &amp; picks &rarr;</a>
    `;
  } catch (err) {
    banner.className = "banner info";
    banner.innerHTML = "No model predictions available yet.";
  }
})();
