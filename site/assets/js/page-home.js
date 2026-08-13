(async function () {
  const banner = document.getElementById("status-banner");
  const newsWrap = document.getElementById("latest-news-wrap");
  const newsTeamFilter = document.getElementById("news-team-filter");

  // Latest News -- home page feed of headlines across every team, last
  // 48h (widened 2026-08-13 from the original 24h -- 24h was going empty
  // too often on quiet news days), added 2026-08-12 (Jeff's ask). Backend
  // (/news/recent, see the Worker's getRecentTeamNews()) returns up to
  // 40, newest first; this
  // shows the first 10 with a "Show N more" toggle for the rest, same
  // collapse pattern as game.html's per-team Team News card
  // (site/assets/js/page-game.js's teamNewsList()) -- kept as a
  // self-contained copy here rather than a shared helper module, matching
  // this project's existing one-file-per-page convention.
  //
  // Team filter (added 2026-08-13, Jeff's ask) -- client-side only, no new
  // Worker route. /news/recent already returns up to RECENT_NEWS_LIMIT (40)
  // items for the full 48h window in one call; filtering that same
  // already-fetched list by team is simpler than round-tripping again and
  // gives identical results, since the dropdown is just narrowing what's
  // already on screen, not asking for a longer lookback for one team (the
  // teams.html news card is the place for that -- no time limit there, see
  // its own comment). All 32 teams are listed regardless of whether they
  // have headlines right now, same as every other team dropdown on this
  // site (e.g. teams.html) -- picking a quiet team is expected to show "no
  // headlines," not disappear from the list.
  const NEWS_VISIBLE = 10;
  let allNewsItems = [];
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
  function renderNewsList(items) {
    if (!items || !items.length) {
      const scope = newsTeamFilter && newsTeamFilter.value ? "this team" : "the last 48 hours";
      return `<p class="text-faint">No headlines for ${scope}.</p>`;
    }
    const visible = items.slice(0, NEWS_VISIBLE).map(newsLine).join("");
    const rest = items.slice(NEWS_VISIBLE);
    const restHtml = rest.length
      ? `<div class="team-news-more" data-expanded="false">` +
        `<div class="team-news-more-items" style="display:none;">${rest.map(newsLine).join("")}</div>` +
        `<button type="button" class="team-news-more-toggle" style="background:none;border:none;color:var(--color-accent);cursor:pointer;padding:6px 0 0;font-size:0.8rem;">Show ${rest.length} more</button>` +
        `</div>`
      : "";
    return `<div class="card">${visible}${restHtml}</div>`;
  }
  let lastRefreshedHtml = "";
  function renderNewsWrap() {
    const filterValue = newsTeamFilter ? newsTeamFilter.value : "";
    const filtered = filterValue ? allNewsItems.filter((item) => item.team === filterValue) : allNewsItems;
    newsWrap.innerHTML = `${lastRefreshedHtml}${renderNewsList(filtered)}`;
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

    if (newsTeamFilter) {
      newsTeamFilter.addEventListener("change", renderNewsWrap);
    }

    Promise.all([Data.getRecentTeamNews(), Data.getIndex()])
      .then(([{ items, updated }, index]) => {
        allNewsItems = items || [];
        // "Last refreshed" -- MAX(fetched) across the whole team_news
        // table (see getRecentTeamNews() in the Worker), shown even when
        // there's nothing in the last 48h so an empty feed still reads as
        // "checked recently, genuinely quiet" rather than "broken." Not
        // affected by the team filter -- it's about the pipeline as a
        // whole, not this one team's slice of it.
        lastRefreshedHtml = updated
          ? `<p class="text-faint" style="font-size:0.78rem; margin-bottom:8px;">Last refreshed: ${Util.escapeHtml(Util.formatRelativeDateTime(updated))}</p>`
          : "";
        if (newsTeamFilter) {
          const teamNames = index.team_names || {};
          const teamOptions = [...(index.teams || [])]
            .sort((a, b) => (teamNames[a] || a).localeCompare(teamNames[b] || b))
            .map((abbr) => ({ value: abbr, label: teamNames[abbr] || abbr }));
          Util.fillSelect(newsTeamFilter, teamOptions, { placeholder: "All teams" });
        }
        renderNewsWrap();
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
