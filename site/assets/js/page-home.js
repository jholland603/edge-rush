(async function () {
  const banner = document.getElementById("status-banner");
  const newsWrap = document.getElementById("latest-news-wrap");

  // Latest News -- home page feed of headlines across every team, last
  // 24h, added 2026-08-12 (Jeff's ask). Backend (/news/recent, see the
  // Worker's getRecentTeamNews()) returns up to 40, newest first; this
  // shows the first 10 with a "Show N more" toggle for the rest, same
  // collapse pattern as game.html's per-team Team News card
  // (site/assets/js/page-game.js's teamNewsList()) -- kept as a
  // self-contained copy here rather than a shared helper module, matching
  // this project's existing one-file-per-page convention.
  const NEWS_VISIBLE = 10;
  function newsLine(item) {
    const sourceHtml = item.source ? ` <span class="text-faint">&mdash; ${Util.escapeHtml(item.source)}</span>` : "";
    const dateHtml = item.pub_date
      ? `<span class="text-faint">${Util.escapeHtml(Util.formatDateTime(item.pub_date))}</span>`
      : "";
    const teamHtml = item.game_id
      ? `<a href="game.html?id=${encodeURIComponent(item.game_id)}" class="badge neutral">${Util.escapeHtml(item.team)}</a>`
      : `<span class="badge neutral">${Util.escapeHtml(item.team)}</span>`;
    return `
      <div class="row" style="display:flex; flex-direction:column; gap:2px; padding:10px 0; border-bottom:1px solid var(--color-border); font-size:0.85rem;">
        <div>${teamHtml} <a href="${Util.escapeHtml(item.link)}" target="_blank" rel="noopener">${Util.escapeHtml(item.title)}</a></div>
        <div style="display:flex; gap:8px;">${dateHtml}${sourceHtml}</div>
      </div>
    `;
  }
  if (newsWrap) {
    newsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".team-news-more-toggle");
      if (!btn) return;
      const wrap = btn.closest(".team-news-more");
      const list = wrap.querySelector(".team-news-more-items");
      const expanded = wrap.dataset.expanded === "true";
      list.style.display = expanded ? "none" : "";
      wrap.dataset.expanded = expanded ? "false" : "true";
      btn.textContent = expanded ? `Show ${list.children.length} more` : "Show less";
    });

    Data.getRecentTeamNews()
      .then(({ items, updated }) => {
        // "Last refreshed" -- MAX(fetched) across the whole team_news
        // table (see getRecentTeamNews() in the Worker), shown even when
        // there's nothing in the last 24h so an empty feed still reads as
        // "checked recently, genuinely quiet" rather than "broken."
        const refreshedHtml = updated
          ? `<p class="text-faint" style="font-size:0.78rem; margin-bottom:8px;">Last refreshed: ${Util.escapeHtml(Util.formatDateTime(updated))}</p>`
          : "";
        if (!items || !items.length) {
          newsWrap.innerHTML = `${refreshedHtml}<p class="text-faint">No headlines in the last 24 hours.</p>`;
          return;
        }
        const visible = items.slice(0, NEWS_VISIBLE).map(newsLine).join("");
        const rest = items.slice(NEWS_VISIBLE);
        const restHtml = rest.length
          ? `<div class="team-news-more" data-expanded="false">` +
            `<div class="team-news-more-items" style="display:none;">${rest.map(newsLine).join("")}</div>` +
            `<button type="button" class="team-news-more-toggle" style="background:none;border:none;color:var(--color-accent);cursor:pointer;padding:6px 0 0;font-size:0.8rem;">Show ${rest.length} more</button>` +
            `</div>`
          : "";
        newsWrap.innerHTML = `${refreshedHtml}<div class="card">${visible}${restHtml}</div>`;
      })
      .catch(() => {
        newsWrap.innerHTML = `<p class="text-faint">Couldn't load news right now.</p>`;
      });
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
      <a href="games.html?season=${season}&week=${week}">See these games &amp; picks &rarr;</a>
    `;
  } catch (err) {
    banner.className = "banner info";
    banner.innerHTML = "No model predictions available yet.";
  }
})();
