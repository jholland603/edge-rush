(async function () {
  const scopeSelect = document.getElementById("scope-select");
  const statSelect = document.getElementById("stat-select");
  const fromSelect = document.getElementById("from-select");
  const toSelect = document.getElementById("to-select");
  const positionControl = document.getElementById("position-control");
  const positionToggle = document.getElementById("position-toggle");
  const positionToggleLabel = document.getElementById("position-toggle-label");
  const tableWrap = document.getElementById("leaders-table-wrap");

  const params = new URLSearchParams(location.search);
  let catalog = { players: [], teams: [] };
  let teamNames = {};

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
      let rows, isTeams;
      if (scopeSelect.value === "teams") {
        isTeams = true;
        const data = await Data.getTeamLeaders({ stat: spec.id, from, to, limit: 32 });
        rows = data.leaders;
      } else {
        isTeams = false;
        const position = positionControl.style.display !== "none" && positionToggle.checked ? spec.position : null;
        const data = await Data.getPlayerLeaders({ stat: spec.id, from, to, position, limit: 25 });
        rows = data.leaders;
      }

      if (!rows.length) {
        Util.showEmpty(tableWrap, "No qualifying games in this range.");
        return;
      }

      const bodyRows = rows
        .map((r, i) => {
          const rank = i + 1;
          if (isTeams) {
            return `
              <tr>
                <td class="num">${rank}</td>
                <td>${Util.escapeHtml(r.team_name || r.team)}</td>
                <td class="num">${Util.num(r.total, 0)}</td>
                <td class="num">${r.games}</td>
              </tr>`;
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
        ? `<th class="num">Rank</th><th>Team</th><th class="num">${Util.escapeHtml(spec.label)}</th><th class="num">Games</th>`
        : `<th class="num">Rank</th><th>Player</th><th>Pos</th><th class="num">${Util.escapeHtml(spec.label)}</th><th class="num">Games</th>`;

      tableWrap.innerHTML = `
        <table>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;
    } catch (err) {
      Util.showError(tableWrap, err);
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

  try {
    const [index, leadersCatalog] = await Promise.all([Data.getIndex(), Data.getLeadersCatalog()]);
    catalog = leadersCatalog;
    teamNames = index.team_names || {};

    const seasons = [...index.seasons.games].sort((a, b) => a - b);
    const seasonsDesc = [...seasons].sort((a, b) => b - a);
    Util.fillSelect(fromSelect, seasonsDesc);
    Util.fillSelect(toSelect, seasonsDesc);

    const wantedScope = params.get("scope");
    scopeSelect.value = wantedScope === "teams" ? "teams" : "players";
    populateStatSelect();

    const wantedFrom = Number(params.get("from"));
    const wantedTo = Number(params.get("to"));
    fromSelect.value = seasons.includes(wantedFrom) ? String(wantedFrom) : String(seasons[0]);
    toSelect.value = seasons.includes(wantedTo) ? String(wantedTo) : String(seasons[seasons.length - 1]);

    updatePositionControl();
    render();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
