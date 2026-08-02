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

  // The source data (nflverse's stats_player_week) tracks specific positions
  // (DE, OLB, CB, FS, ...), not the broader group. Map down to a group so we
  // can pick one sensible stat layout per group instead of dozens of cases.
  const POSITION_TO_GROUP = {
    QB: "QB",
    RB: "RB", FB: "RB",
    WR: "WR",
    TE: "TE",
    OT: "OL", OG: "OL", T: "OL", G: "OL", C: "OL", OL: "OL",
    DE: "DL", DT: "DL", NT: "DL", DL: "DL",
    OLB: "LB", ILB: "LB", MLB: "LB", LB: "LB",
    CB: "DB", S: "DB", FS: "DB", SS: "DB", SAF: "DB", DB: "DB", NB: "DB",
    K: "K",
    P: "P",
    LS: "LS",
  };
  function groupFor(position) {
    return POSITION_TO_GROUP[position] || "OTHER";
  }

  // ---- career total stat cards, per position group ----
  // {key} pulls straight from career_totals; {compute} derives a value (e.g.
  // FG% -- the source data's own fg_pct field is a naive sum-of-percentages
  // across games, not a real career rate, so we compute it correctly here).
  const CAREER_STAT_GROUPS = {
    QB: [
      { key: "passing_yards", label: "Pass Yds" },
      { key: "passing_tds", label: "Pass TD" },
      { key: "passing_interceptions", label: "INT" },
      { key: "passing_epa", label: "Pass EPA", signed: true, decimals: 1 },
      { key: "rushing_yards", label: "Rush Yds" },
      { key: "rushing_tds", label: "Rush TD" },
    ],
    RB: [
      { key: "rushing_yards", label: "Rush Yds" },
      { key: "rushing_tds", label: "Rush TD" },
      { key: "receptions", label: "Rec" },
      { key: "receiving_yards", label: "Rec Yds" },
      { key: "receiving_tds", label: "Rec TD" },
      { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
    ],
    WR: [
      { key: "receptions", label: "Rec" },
      { key: "targets", label: "Targets" },
      { key: "receiving_yards", label: "Rec Yds" },
      { key: "receiving_tds", label: "Rec TD" },
      { key: "rushing_yards", label: "Rush Yds" },
      { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
    ],
    TE: [
      { key: "receptions", label: "Rec" },
      { key: "targets", label: "Targets" },
      { key: "receiving_yards", label: "Rec Yds" },
      { key: "receiving_tds", label: "Rec TD" },
      { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
    ],
    DL: [
      { key: "def_sacks", label: "Sacks", decimals: 1 },
      { key: "def_tackles_solo", label: "Solo Tackles" },
      { key: "def_tackles_for_loss", label: "TFL" },
      { key: "def_qb_hits", label: "QB Hits" },
      { key: "def_fumbles_forced", label: "Forced Fumbles" },
    ],
    LB: [
      { key: "def_tackles_solo", label: "Solo Tackles" },
      { key: "def_tackle_assists", label: "Assisted Tackles" },
      { key: "def_sacks", label: "Sacks", decimals: 1 },
      { key: "def_interceptions", label: "INT" },
      { key: "def_pass_defended", label: "Passes Defended" },
    ],
    DB: [
      { key: "def_interceptions", label: "INT" },
      { key: "def_pass_defended", label: "Passes Defended" },
      { key: "def_tackles_solo", label: "Solo Tackles" },
      { key: "def_tds", label: "Def TD" },
      { key: "def_fumbles_forced", label: "Forced Fumbles" },
    ],
    K: [
      { key: "fg_made", label: "FG Made" },
      { key: "fg_att", label: "FG Att" },
      { compute: (t) => (t.fg_att ? (100 * t.fg_made) / t.fg_att : null), label: "FG %", decimals: 1 },
      { key: "pat_made", label: "XP Made" },
      { key: "gwfg_made", label: "Game-Winning FGs" },
    ],
    P: [
      { key: "pt_att", label: "Punts" },
      { key: "pt_yards", label: "Punt Yards" },
      { compute: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), label: "Net Avg", decimals: 1 },
      { key: "pt_inside_20", label: "Inside 20" },
    ],
  };

  function statCardValue(totals, spec) {
    const raw = spec.compute ? spec.compute(totals) : totals[spec.key];
    if (raw === undefined || raw === null || Number.isNaN(raw)) return null;
    if (spec.signed) return Util.signed(raw, spec.decimals ?? 1);
    if (spec.decimals) return Number(raw).toFixed(spec.decimals);
    return Math.round(raw).toLocaleString();
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
        <p>${Util.escapeHtml(career.position)} &middot; ${career.teams.join(", ")} &middot; ${career.games_played} games &middot; ${Math.min(...career.seasons)}&ndash;${Math.max(...career.seasons)}</p>
      </div>
      <h2 style="margin-top:0;">Career totals</h2>
      ${body}
    `;
  }

  // ---- weekly season-log table, per position group ----
  const OFFENSE_WEEK_COLUMNS = [
    { label: "Cmp/Att", render: (w) => `${w.completions ?? 0}/${w.attempts ?? 0}` },
    { label: "Pass Yds", render: (w) => w.passing_yards ?? 0 },
    { label: "Pass TD", render: (w) => w.passing_tds ?? 0 },
    { label: "INT", render: (w) => w.passing_interceptions ?? 0 },
    { label: "Car", render: (w) => w.carries ?? 0 },
    { label: "Rush Yds", render: (w) => w.rushing_yards ?? 0 },
    { label: "Rush TD", render: (w) => w.rushing_tds ?? 0 },
    { label: "Rec/Tgt", render: (w) => `${w.receptions ?? 0}/${w.targets ?? 0}` },
    { label: "Rec Yds", render: (w) => w.receiving_yards ?? 0 },
    { label: "Rec TD", render: (w) => w.receiving_tds ?? 0 },
    { label: "Fantasy (PPR)", render: (w) => Util.num(w.fantasy_points_ppr, 1) },
  ];
  const WEEK_COLUMNS = {
    QB: OFFENSE_WEEK_COLUMNS,
    RB: OFFENSE_WEEK_COLUMNS,
    WR: OFFENSE_WEEK_COLUMNS,
    TE: OFFENSE_WEEK_COLUMNS,
    DL: [
      { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
      { label: "TFL", render: (w) => w.def_tackles_for_loss ?? 0 },
      { label: "Sacks", render: (w) => Util.num(w.def_sacks, 1) },
      { label: "QB Hits", render: (w) => w.def_qb_hits ?? 0 },
      { label: "FF", render: (w) => w.def_fumbles_forced ?? 0 },
    ],
    LB: [
      { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
      { label: "Sacks", render: (w) => Util.num(w.def_sacks, 1) },
      { label: "INT", render: (w) => w.def_interceptions ?? 0 },
      { label: "PD", render: (w) => w.def_pass_defended ?? 0 },
    ],
    DB: [
      { label: "INT", render: (w) => w.def_interceptions ?? 0 },
      { label: "PD", render: (w) => w.def_pass_defended ?? 0 },
      { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
      { label: "Def TD", render: (w) => w.def_tds ?? 0 },
    ],
    K: [
      { label: "FG", render: (w) => `${w.fg_made ?? 0}/${w.fg_att ?? 0}` },
      { label: "Long", render: (w) => w.fg_long ?? "-" },
      { label: "XP", render: (w) => `${w.pat_made ?? 0}/${w.pat_att ?? 0}` },
    ],
    P: [
      { label: "Punts", render: (w) => w.pt_att ?? 0 },
      { label: "Yards", render: (w) => w.pt_yards ?? 0 },
      { label: "Net Yds", render: (w) => w.pt_net_yards ?? 0 },
      { label: "In 20", render: (w) => w.pt_inside_20 ?? 0 },
      { label: "TB", render: (w) => w.pt_touchback ?? 0 },
    ],
  };
  const FALLBACK_WEEK_COLUMNS = [
    { label: "Penalties", render: (w) => w.penalties ?? 0 },
    { label: "Penalty Yds", render: (w) => w.penalty_yards ?? 0 },
  ];

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
              <td>@${Util.escapeHtml(w.opponent_team ?? "-")}</td>
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
    const wantedId = params.get("id");
    if (wantedId && playersIndex[wantedId]) {
      searchInput.value = playersIndex[wantedId].name;
      selectPlayer(wantedId);
    }
  } catch (err) {
    Util.showError(detailEl, err);
  }
})();
