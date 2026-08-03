(async function () {
  const searchInput = document.getElementById("player-search");
  const resultsEl = document.getElementById("search-results");
  const detailEl = document.getElementById("player-detail");

  const params = new URLSearchParams(location.search);
  let playersIndex = null; // { id: {name, position, seasons} }
  let teamNames = {};

  function teamName(abbr) {
    return teamNames[abbr] || abbr;
  }

  const { groupFor, CAREER_STAT_GROUPS, statCardValue, WEEK_COLUMNS, FALLBACK_WEEK_COLUMNS } = PlayerStats;

  function renderResults(query) {
    if (!query || query.length < 2) {
      resultsEl.innerHTML = "";
      return;
    }
    const q = query.toLowerCase();
    const matches = Object.entries(playersIndex)
      .filter(([, p]) => p.name.toLowerCase().includes(q))
      .sort((a, b) => Math.max(...b[1].seasons) - Math.max(...a[1].seasons))
      .slice(0, 20);

    if (!matches.length) {
      resultsEl.innerHTML = `<ul><li><a href="#" style="pointer-events:none;color:var(--color-text-faint);">No matches</a></li></ul>`;
      return;
    }

    resultsEl.innerHTML = `<ul>${matches
      .map(
        ([id, p]) => `
        <li>
          <a href="players.html?id=${encodeURIComponent(id)}" data-id="${id}">
            <span>${Util.escapeHtml(p.name)}</span>
            <span class="pos">${Util.escapeHtml(p.position)} &middot; ${Math.min(...p.seasons)}&ndash;${Math.max(...p.seasons)}</span>
          </a>
        </li>`
      )
      .join("")}</ul>`;

    resultsEl.querySelectorAll("a[data-id]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        searchInput.value = a.querySelector("span").textContent;
        resultsEl.innerHTML = "";
        selectPlayer(a.dataset.id);
      });
    });
  }

  function renderCareerCard(career) {
    const group = groupFor(career.position);
    const specs = CAREER_STAT_GROUPS[group];
    const totals = career.career_totals || {};

    let body;
    if (!specs) {
      body = `<p class="text-faint">No individual stat line is tracked for this position in the source data (offensive line / long snapper) -- games played and team history above are all that's available.</p>`;
    } else {
      const statCards = specs
        .map((spec) => {
          const display = statCardValue(totals, spec);
          if (display === null) return "";
          return `<div class="stat-card card"><div class="value">${display}</div><div class="label">${spec.label}</div></div>`;
        })
        .join("");
      body = `<div class="card-grid">${statCards}</div>`;
    }

    return `
      <div class="page-header" style="margin-bottom: var(--space-5);">
        <h1>${Util.escapeHtml(career.player_display_name)}</h1>
        <p>${Util.escapeHtml(career.position)} &middot; ${career.teams.join(", ")} &middot; ${career.games_played} games &middot; ${Math.min(...career.seasons)}&ndash;${Math.max(...career.seasons)}
          &middot; <a href="compare.html?ids=${encodeURIComponent(career.player_id)}">Compare this player &rarr;</a></p>
      </div>
      <h2 style="margin-top:0;">Career totals</h2>
      ${body}
    `;
  }

  async function selectPlayer(id) {
    detailEl.innerHTML = `<div class="loading">Loading player&hellip;</div>`;
    const p = new URLSearchParams();
    p.set("id", id);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);

    let career;
    try {
      career = await Data.getPlayerCareer(id);
    } catch (err) {
      Util.showError(detailEl, err);
      return;
    }

    const seasons = [...career.seasons].sort((a, b) => b - a);
    detailEl.innerHTML = `
      ${renderCareerCard(career)}
      <h2>Season log</h2>
      <div class="controls">
        <div class="control">
          <label for="player-season-select">Season</label>
          <select id="player-season-select"></select>
        </div>
      </div>
      <div class="table-wrap" id="player-season-table"><div class="loading">Loading&hellip;</div></div>
    `;

    const seasonSelect = document.getElementById("player-season-select");
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);

    async function renderSeason() {
      const tableWrap = document.getElementById("player-season-table");
      Util.showLoading(tableWrap);
      try {
        const seasonData = await Data.getPlayersSeason(seasonSelect.value);
        const playerSeason = seasonData.players[id];
        if (!playerSeason || !playerSeason.weeks.length) {
          Util.showEmpty(tableWrap, "No games logged this season.");
          return;
        }
        const group = groupFor(playerSeason.position);
        const columns = WEEK_COLUMNS[group] || FALLBACK_WEEK_COLUMNS;

        const weeks = playerSeason.weeks.slice().sort((a, b) => a.week - b.week);
        const rows = weeks
          .map(
            (w) => `
            <tr>
              <td>${w.week}</td>
              <td>${Util.escapeHtml(w.season_type)}</td>
              <td>${w.opponent_team ? `${w.is_home ? "vs" : "@"} ${Util.escapeHtml(teamName(w.opponent_team))}` : "-"}</td>
              ${columns.map((c) => `<td class="num">${c.render(w)}</td>`).join("")}
            </tr>`
          )
          .join("");

        tableWrap.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Wk</th><th>Type</th><th>Opp</th>
                ${columns.map((c) => `<th class="num">${c.label}</th>`).join("")}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      } catch (err) {
        Util.showError(tableWrap, err);
      }
    }

    seasonSelect.addEventListener("change", () => {
      const p2 = new URLSearchParams(location.search);
      p2.set("season", seasonSelect.value);
      history.replaceState(null, "", `${location.pathname}?${p2.toString()}`);
      renderSeason();
    });

    renderSeason();
  }

  searchInput.addEventListener(
    "input",
    Util.debounce((e) => renderResults(e.target.value), 150)
  );
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".player-search-results")) resultsEl.innerHTML = "";
  });

  try {
    const index = await Data.getIndex();
    playersIndex = index.players;
    teamNames = index.team_names || {};
    const wantedId = params.get("id");
    if (wantedId && playersIndex[wantedId]) {
      searchInput.value = playersIndex[wantedId].name;
      selectPlayer(wantedId);
    }
  } catch (err) {
    Util.showError(detailEl, err);
  }
})();
