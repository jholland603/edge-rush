(async function () {
  const scopeSelect = document.getElementById("scope-select");
  const statSelect = document.getElementById("stat-select");
  const fromSelect = document.getElementById("from-select");
  const toSelect = document.getElementById("to-select");
  const positionControl = document.getElementById("position-control");
  const positionToggle = document.getElementById("position-toggle");
  const positionToggleLabel = document.getElementById("position-toggle-label");
  const careerToggle = document.getElementById("career-toggle");
  const seasonTypeSelect = document.getElementById("season-type-select");
  const tableWrap = document.getElementById("leaders-table-wrap");

  const params = new URLSearchParams(location.search);
  let catalog = { players: [], teams: [] };
  let teamNames = {};
  let allSeasons = []; // ascending, every season with a schedule -- for the from/to option lists + "Career" full range
  let playerStatsSeasons = []; // seasons with real player_game stats
  let teamStatsSeasons = []; // seasons with real team_game stats
  const teamStatPlayersCache = new Map(); // `${team}:${stat}:${from}-${to}:${scope}` -> players array

  // Newest season with real stats for the given scope -- NOT just the
  // newest scheduled season (that's `allSeasons`'s job, e.g. 2026 already
  // has a schedule loaded with zero stats). Only games.html is meant to
  // default to "current/future"; every other page defaults to the newest
  // season that actually has data, per Jeff.
  function currentSeasonForScope(scope) {
    const list = scope === "teams" ? teamStatsSeasons : playerStatsSeasons;
    return list.length ? Math.max(...list) : allSeasons[allSeasons.length - 1];
  }

  function applyCareerRange() {
    if (!allSeasons.length) return;
    fromSelect.value = String(allSeasons[0]);
    toSelect.value = String(allSeasons[allSeasons.length - 1]);
    fromSelect.disabled = true;
    toSelect.disabled = true;
  }

  function currentStatList() {
    return scopeSelect.value === "teams" ? catalog.teams : catalog.players;
  }

  function currentStatSpec() {
    return currentStatList().find((s) => s.id === statSelect.value);
  }

  function populateStatSelect() {
    const list = currentStatList();
    Util.fillSelect(statSelect, list.map((s) => ({ value: s.id, label: s.label })));
    const wanted = params.get("stat");
    if (wanted && list.some((s) => s.id === wanted)) statSelect.value = wanted;
  }

  function updatePositionControl() {
    const spec = currentStatSpec();
    if (scopeSelect.value === "players" && spec && spec.position) {
      positionControl.style.display = "";
      positionToggleLabel.textContent = `Only ${spec.position}s`;
      positionToggle.checked = true;
    } else {
      positionControl.style.display = "none";
      positionToggle.checked = false;
    }
  }

  function syncUrl() {
    const p = new URLSearchParams();
    p.set("scope", scopeSelect.value);
    p.set("stat", statSelect.value);
    p.set("from", fromSelect.value);
    p.set("to", toSelect.value);
    p.set("season_type", seasonTypeSelect.value);
    if (careerToggle.checked) p.set("career", "1");
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function render() {
    Util.showLoading(tableWrap);
    const spec = currentStatSpec();
    if (!spec) {
      Util.showEmpty(tableWrap, "No categories available.");
      return;
    }
    const from = Number(fromSelect.value);
    const to = Number(toSelect.value);
    if (from > to) {
      Util.showEmpty(tableWrap, "“From” season is after “To” season — pick a valid range.");
      return;
    }

    try {
      const seasonType = seasonTypeSelect.value;
      let rows, isTeams;
      if (scopeSelect.value === "teams") {
        isTeams = true;
        const data = await Data.getTeamLeaders({ stat: spec.id, from, to, limit: 32, scope: seasonType });
        rows = data.leaders;
      } else {
        isTeams = false;
        const position = positionControl.style.display !== "none" && positionToggle.checked ? spec.position : null;
        const data = await Data.getPlayerLeaders({ stat: spec.id, from, to, position, limit: 25, scope: seasonType });
        rows = data.leaders;
      }

      if (!rows.length) {
        Util.showEmpty(tableWrap, "No qualifying games in this range.");
        return;
      }

      const breakdownAvailable = isTeams && spec.id !== "points_scored";

      const bodyRows = rows
        .map((r, i) => {
          const rank = i + 1;
          if (isTeams) {
            const toggleCell = breakdownAvailable
              ? `<td><button type="button" class="expand-toggle" data-idx="${i}">Players &#9656;</button></td>`
              : `<td class="text-faint" title="No single player-level stat maps to Points Scored (it's a mix of TDs across positions plus kicking)">&ndash;</td>`;
            const expandRow = breakdownAvailable
              ? `<tr class="expand-row" data-idx="${i}" style="display:none;">
                   <td colspan="5"><div class="expand-body">Loading&hellip;</div></td>
                 </tr>`
              : "";
            return `
              <tr>
                <td class="num">${rank}</td>
                <td>${Util.escapeHtml(r.team_name || r.team)}</td>
                <td class="num">${Util.num(r.total, 0)}</td>
                <td class="num">${r.games}</td>
                ${toggleCell}
              </tr>
              ${expandRow}`;
          }
          return `
            <tr>
              <td class="num">${rank}</td>
              <td><a href="players.html?id=${encodeURIComponent(r.player_id)}">${Util.escapeHtml(r.name)}</a></td>
              <td>${Util.escapeHtml(r.position || "-")}</td>
              <td class="num">${Util.num(r.total, 0)}</td>
              <td class="num">${r.games}</td>
            </tr>`;
        })
        .join("");

      const headerCells = isTeams
        ? `<th class="num">Rank</th><th>Team</th><th class="num">${Util.escapeHtml(spec.label)}</th><th class="num">Games</th><th></th>`
        : `<th class="num">Rank</th><th>Player</th><th>Pos</th><th class="num">${Util.escapeHtml(spec.label)}</th><th class="num">Games</th>`;

      tableWrap.innerHTML = `
        <table>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;

      if (isTeams && breakdownAvailable) {
        tableWrap.querySelectorAll(".expand-toggle").forEach((btn) => {
          btn.addEventListener("click", () => toggleTeamExpand(btn, rows[Number(btn.dataset.idx)], spec, from, to, seasonType));
        });
      }
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  }

  function renderTeamPlayerBreakdown(players) {
    if (!players.length) {
      return `<p class="text-faint" style="margin:0;">No player-level data for this stat/range.</p>`;
    }
    const rows = players
      .map(
        (p) => `
        <tr>
          <td><a href="players.html?id=${encodeURIComponent(p.player_id)}">${Util.escapeHtml(p.name)}</a></td>
          <td>${Util.escapeHtml(p.position || "-")}</td>
          <td class="num">${Util.num(p.total, 0)}</td>
          <td class="num">${p.games}</td>
        </tr>`
      )
      .join("");
    return `
      <div class="subtable">
        <table>
          <thead><tr><th>Player</th><th>Pos</th><th class="num">Total</th><th class="num">Games</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async function toggleTeamExpand(btn, row, spec, from, to, scope) {
    const idx = btn.dataset.idx;
    const expandRow = tableWrap.querySelector(`tr.expand-row[data-idx="${idx}"]`);
    if (!expandRow) return;

    const isOpen = expandRow.style.display !== "none";
    if (isOpen) {
      expandRow.style.display = "none";
      btn.innerHTML = "Players &#9656;";
      return;
    }

    expandRow.style.display = "";
    btn.innerHTML = "Players &#9662;";

    const body = expandRow.querySelector(".expand-body");
    const key = `${row.team}:${spec.id}:${from}-${to}:${scope}`;
    try {
      if (!teamStatPlayersCache.has(key)) {
        teamStatPlayersCache.set(
          key,
          await Data.getTeamStatPlayers({ team: row.team, stat: spec.id, from, to, scope, limit: 25 })
        );
      }
      const { players } = teamStatPlayersCache.get(key);
      body.innerHTML = renderTeamPlayerBreakdown(players);
    } catch (err) {
      body.innerHTML = `<p class="text-faint" style="margin:0;">Failed to load player breakdown.</p>`;
    }
  }

  scopeSelect.addEventListener("change", () => {
    populateStatSelect();
    updatePositionControl();
    syncUrl();
    render();
  });
  statSelect.addEventListener("change", () => {
    updatePositionControl();
    syncUrl();
    render();
  });
  positionToggle.addEventListener("change", () => render());
  fromSelect.addEventListener("change", () => {
    syncUrl();
    render();
  });
  toSelect.addEventListener("change", () => {
    syncUrl();
    render();
  });
  seasonTypeSelect.addEventListener("change", () => {
    syncUrl();
    render();
  });
  careerToggle.addEventListener("change", () => {
    if (careerToggle.checked) {
      applyCareerRange();
    } else {
      fromSelect.disabled = false;
      toSelect.disabled = false;
    }
    syncUrl();
    render();
  });

  try {
    const [index, leadersCatalog] = await Promise.all([Data.getIndex(), Data.getLeadersCatalog()]);
    catalog = leadersCatalog;
    teamNames = index.team_names || {};

    const seasons = [...index.seasons.games].sort((a, b) => a - b);
    allSeasons = seasons;
    playerStatsSeasons = index.seasons.players || [];
    teamStatsSeasons = index.seasons.teams || [];
    const seasonsDesc = [...seasons].sort((a, b) => b - a);
    Util.fillSelect(fromSelect, seasonsDesc);
    Util.fillSelect(toSelect, seasonsDesc);

    const wantedScope = params.get("scope");
    scopeSelect.value = wantedScope === "teams" ? "teams" : "players";
    populateStatSelect();

    // Default to the current season only (not the full 1999-present history)
    // unless the URL says otherwise -- "Leaders" landing on 26 years of
    // combined totals isn't a useful first view. Full history is still one
    // click away via the "Career" checkbox below. "Current" means newest
    // season with real stats for whichever scope is selected, not just
    // newest scheduled season (see currentSeasonForScope above).
    const currentSeason = currentSeasonForScope(scopeSelect.value);
    const wantedFrom = Number(params.get("from"));
    const wantedTo = Number(params.get("to"));
    fromSelect.value = seasons.includes(wantedFrom) ? String(wantedFrom) : String(currentSeason);
    toSelect.value = seasons.includes(wantedTo) ? String(wantedTo) : String(currentSeason);

    if (params.get("career") === "1") {
      careerToggle.checked = true;
      applyCareerRange();
    }

    const wantedSeasonType = params.get("season_type");
    if (["reg", "post", "all"].includes(wantedSeasonType)) seasonTypeSelect.value = wantedSeasonType;

    updatePositionControl();
    render();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
