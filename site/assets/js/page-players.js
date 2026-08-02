(async function () {
  const searchInput = document.getElementById("player-search");
  const resultsEl = document.getElementById("search-results");
  const detailEl = document.getElementById("player-detail");

  const params = new URLSearchParams(location.search);
  let playersIndex = null; // { id: {name, position, seasons} }

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

  const POSITION_STAT_GROUPS = {
    QB: [
      ["passing_yards", "Pass Yds"], ["passing_tds", "Pass TD"], ["interceptions", "INT"],
      ["passing_epa", "Pass EPA"], ["rushing_yards", "Rush Yds"], ["rushing_tds", "Rush TD"],
    ],
    RB: [
      ["rushing_yards", "Rush Yds"], ["rushing_tds", "Rush TD"], ["receptions", "Rec"],
      ["receiving_yards", "Rec Yds"], ["receiving_tds", "Rec TD"], ["fantasy_points_ppr", "Fantasy Pts (PPR)"],
    ],
    WR: [
      ["receptions", "Rec"], ["targets", "Targets"], ["receiving_yards", "Rec Yds"],
      ["receiving_tds", "Rec TD"], ["rushing_yards", "Rush Yds"], ["fantasy_points_ppr", "Fantasy Pts (PPR)"],
    ],
    TE: [
      ["receptions", "Rec"], ["targets", "Targets"], ["receiving_yards", "Rec Yds"],
      ["receiving_tds", "Rec TD"], ["fantasy_points_ppr", "Fantasy Pts (PPR)"],
    ],
  };
  const DEFAULT_STATS = [
    ["passing_yards", "Pass Yds"], ["rushing_yards", "Rush Yds"], ["receiving_yards", "Rec Yds"],
    ["fantasy_points_ppr", "Fantasy Pts (PPR)"],
  ];

  function renderCareerCard(career) {
    const group = POSITION_STAT_GROUPS[career.position] || DEFAULT_STATS;
    const totals = career.career_totals || {};
    const statCards = group
      .map(([key, label]) => {
        const val = totals[key];
        if (val === undefined) return "";
        const display = key.includes("epa") ? Util.signed(val, 1) : Math.round(val).toLocaleString();
        return `<div class="stat-card card"><div class="value">${display}</div><div class="label">${label}</div></div>`;
      })
      .join("");

    return `
      <div class="page-header" style="margin-bottom: var(--space-5);">
        <h1>${Util.escapeHtml(career.player_display_name)}</h1>
        <p>${Util.escapeHtml(career.position)} &middot; ${career.teams.join(", ")} &middot; ${career.games_played} games &middot; ${Math.min(...career.seasons)}&ndash;${Math.max(...career.seasons)}</p>
      </div>
      <h2 style="margin-top:0;">Career totals</h2>
      <div class="card-grid">${statCards}</div>
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
        const weeks = playerSeason.weeks.slice().sort((a, b) => a.week - b.week);
        const rows = weeks
          .map(
            (w) => `
            <tr>
              <td>${w.week}</td>
              <td>${Util.escapeHtml(w.season_type)}</td>
              <td>@${Util.escapeHtml(w.opponent_team ?? "-")}</td>
              <td class="num">${w.completions ?? 0}/${w.attempts ?? 0}</td>
              <td class="num">${w.passing_yards ?? 0}</td>
              <td class="num">${w.passing_tds ?? 0}</td>
              <td class="num">${w.interceptions ?? 0}</td>
              <td class="num">${w.carries ?? 0}</td>
              <td class="num">${w.rushing_yards ?? 0}</td>
              <td class="num">${w.rushing_tds ?? 0}</td>
              <td class="num">${w.receptions ?? 0}/${w.targets ?? 0}</td>
              <td class="num">${w.receiving_yards ?? 0}</td>
              <td class="num">${w.receiving_tds ?? 0}</td>
              <td class="num">${Util.num(w.fantasy_points_ppr, 1)}</td>
            </tr>`
          )
          .join("");

        tableWrap.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Wk</th><th>Type</th><th>Opp</th>
                <th class="num">Cmp/Att</th><th class="num">Pass Yds</th><th class="num">Pass TD</th><th class="num">INT</th>
                <th class="num">Car</th><th class="num">Rush Yds</th><th class="num">Rush TD</th>
                <th class="num">Rec/Tgt</th><th class="num">Rec Yds</th><th class="num">Rec TD</th><th class="num">Fantasy (PPR)</th>
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
    const wantedId = params.get("id");
    if (wantedId && playersIndex[wantedId]) {
      searchInput.value = playersIndex[wantedId].name;
      selectPlayer(wantedId);
    }
  } catch (err) {
    Util.showError(detailEl, err);
  }
})();
