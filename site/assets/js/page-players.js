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

  // Landing-page mini leaderboards, shown when no player is selected yet
  // (instead of a bare "search above" message). Deliberately a curated
  // handful, not a full leaders.html clone -- this is meant to be a glance,
  // not a destination. All 6 ids already exist in the Worker's player stat
  // catalog, so no backend changes were needed for this.
  const LANDING_STAT_IDS = [
    "passing_yards",
    "rushing_yards",
    "receiving_yards",
    "def_sacks",
    "def_interceptions",
    "def_tackles_solo",
  ];

  async function renderLanding(season) {
    detailEl.innerHTML = `<div class="loading">Loading leaders&hellip;</div>`;
    try {
      const catalog = await Data.getLeadersCatalog();
      const labelById = new Map(catalog.players.map((s) => [s.id, s.label]));

      const results = await Promise.all(
        LANDING_STAT_IDS.map((id) =>
          Data.getPlayerLeaders({ stat: id, from: season, to: season, limit: 5, scope: "reg" }).catch(() => null)
        )
      );

      const cards = LANDING_STAT_IDS.map((id, i) => {
        const label = labelById.get(id) || id;
        const leaders = (results[i] && results[i].leaders) || [];
        const rows = leaders.length
          ? leaders
              .map(
                (r, rank) => `
                <tr>
                  <td class="num">${rank + 1}</td>
                  <td><a href="players.html?id=${encodeURIComponent(r.player_id)}">${Util.escapeHtml(r.name)}</a></td>
                  <td>${Util.escapeHtml(r.position || "-")}</td>
                  <td class="num">${Util.num(r.total, 0)}</td>
                </tr>`
              )
              .join("")
          : `<tr><td colspan="4" class="text-faint">No games yet.</td></tr>`;

        return `
          <div class="card leaders-card">
            <h3>${Util.escapeHtml(label)}</h3>
            <div class="subtable">
              <table>
                <thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th class="num">${Util.escapeHtml(label)}</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <a href="leaders.html?scope=players&stat=${encodeURIComponent(id)}&from=${season}&to=${season}">Full leaderboard &rarr;</a>
          </div>
        `;
      }).join("");

      detailEl.innerHTML = `
        <div class="section-intro">
          Top players for the ${season} season (regular season). Search above for anyone specific, or
          <a href="leaders.html?scope=players&from=${season}&to=${season}">browse the full leaderboard &amp; team stats &rarr;</a>
        </div>
        <div class="card-grid leaders-grid">${cards}</div>
      `;
    } catch (err) {
      Util.showError(detailEl, err);
    }
  }

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

  const SEASON_TYPE_LABELS = { reg: "Regular season only", post: "Playoffs only", all: "Regular season + playoffs" };

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
      <p>${Util.escapeHtml(career.position)} &middot; ${career.teams.join(", ")} &middot; ${career.games_played} games &middot; ${Math.min(...career.seasons)}&ndash;${Math.max(...career.seasons)}
        &middot; <a href="compare.html?ids=${encodeURIComponent(career.player_id)}">Compare this player &rarr;</a></p>
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
      career = await Data.getPlayerCareer(id, null, "reg");
    } catch (err) {
      Util.showError(detailEl, err);
      return;
    }
    if (!career) {
      Util.showEmpty(detailEl, "No regular-season games for this player.");
      return;
    }

    const seasons = [...career.seasons].sort((a, b) => b - a);
    detailEl.innerHTML = `
      <div class="page-header" style="margin-bottom: var(--space-5);">
        <h1>${Util.escapeHtml(career.player_display_name)}</h1>
      </div>
      <div class="controls">
        <div class="control">
          <label for="career-scope-select">Career totals</label>
          <select id="career-scope-select">
            <option value="reg">Regular season only</option>
            <option value="post">Playoffs only</option>
            <option value="all">Regular season + playoffs</option>
          </select>
        </div>
      </div>
      <div id="career-card-wrap">${renderCareerCard(career)}</div>
      <h2>Season log</h2>
      <div class="controls">
        <div class="control">
          <label for="player-season-select">Season</label>
          <select id="player-season-select"></select>
        </div>
      </div>
      <div class="table-wrap" id="player-season-table"><div class="loading">Loading&hellip;</div></div>
    `;

    const careerScopeSelect = document.getElementById("career-scope-select");
    const careerCardWrap = document.getElementById("career-card-wrap");
    careerScopeSelect.addEventListener("change", async () => {
      careerCardWrap.innerHTML = `<div class="loading">Loading&hellip;</div>`;
      try {
        const scopedCareer = await Data.getPlayerCareer(id, null, careerScopeSelect.value);
        if (!scopedCareer) {
          Util.showEmpty(careerCardWrap, `No games for "${SEASON_TYPE_LABELS[careerScopeSelect.value]}" in this player's career.`);
          return;
        }
        careerCardWrap.innerHTML = renderCareerCard(scopedCareer);
      } catch (err) {
        Util.showError(careerCardWrap, err);
      }
    });

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
              <td>${Util.escapeHtml(Util.weekLabelShort(w.week, w.season_type))}</td>
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
    } else {
      // No player picked yet -- land on top-5 mini leaderboards instead of a
      // bare "search above" message. "Current season" here means the newest
      // season with real player stats, not just the newest scheduled one
      // (that's games.html's job) -- so this correctly shows 2025 today and
      // will auto-advance to 2026 the first week real stats exist for it.
      const playerSeasons = index.seasons.players || [];
      if (playerSeasons.length) {
        renderLanding(Math.max(...playerSeasons));
      }
    }
  } catch (err) {
    Util.showError(detailEl, err);
  }
})();
