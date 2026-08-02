(async function () {
  const searchInput = document.getElementById("player-search");
  const resultsEl = document.getElementById("search-results");
  const chipRow = document.getElementById("chip-row");
  const tableWrap = document.getElementById("compare-table-wrap");

  const { groupFor, CAREER_STAT_GROUPS, statCardValue } = PlayerStats;
  const MAX_PLAYERS = 6;

  let playersIndex = null; // { id: {name, position, seasons} }
  let selectedIds = []; // ordered array of player_id, most-recently-added last
  const careerCache = new Map(); // id -> career json

  function syncUrl() {
    const p = new URLSearchParams();
    if (selectedIds.length) p.set("ids", selectedIds.join(","));
    history.replaceState(null, "", `${location.pathname}${p.toString() ? "?" + p.toString() : ""}`);
  }

  function renderResults(query) {
    if (!query || query.length < 2) {
      resultsEl.innerHTML = "";
      return;
    }
    const q = query.toLowerCase();
    const matches = Object.entries(playersIndex)
      .filter(([id, p]) => p.name.toLowerCase().includes(q) && !selectedIds.includes(id))
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
          <a href="#" data-id="${id}">
            <span>${Util.escapeHtml(p.name)}</span>
            <span class="pos">${Util.escapeHtml(p.position)} &middot; ${Math.min(...p.seasons)}&ndash;${Math.max(...p.seasons)}</span>
          </a>
        </li>`
      )
      .join("")}</ul>`;

    resultsEl.querySelectorAll("a[data-id]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        addPlayer(a.dataset.id);
        searchInput.value = "";
        resultsEl.innerHTML = "";
        searchInput.focus();
      });
    });
  }

  function addPlayer(id) {
    if (selectedIds.includes(id) || !playersIndex[id]) return;
    if (selectedIds.length >= MAX_PLAYERS) {
      chipRow.insertAdjacentHTML(
        "beforeend",
        `<div class="badge warn" style="margin-left:8px;">Max ${MAX_PLAYERS} players</div>`
      );
      return;
    }
    selectedIds.push(id);
    syncUrl();
    render();
  }

  function removePlayer(id) {
    selectedIds = selectedIds.filter((x) => x !== id);
    syncUrl();
    render();
  }

  function renderChips() {
    if (!selectedIds.length) {
      chipRow.innerHTML = "";
      return;
    }
    chipRow.innerHTML = selectedIds
      .map((id) => {
        const p = playersIndex[id];
        return `
          <span class="chip">
            ${Util.escapeHtml(p.name)} <span class="text-faint">(${Util.escapeHtml(p.position)})</span>
            <button type="button" class="chip-remove" data-id="${id}" aria-label="Remove ${Util.escapeHtml(p.name)}">&times;</button>
          </span>
        `;
      })
      .join("");
    chipRow.querySelectorAll(".chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => removePlayer(btn.dataset.id));
    });
  }

  // Merge the stat-group columns for every selected player's position group,
  // in the order players were added, deduping by label so e.g. two WRs don't
  // repeat "Rec Yds" twice.
  function mergedSpecs(careers) {
    const seen = new Set();
    const merged = [];
    for (const career of careers) {
      const group = groupFor(career.position);
      const specs = CAREER_STAT_GROUPS[group] || [];
      for (const spec of specs) {
        if (seen.has(spec.label)) continue;
        seen.add(spec.label);
        merged.push(spec);
      }
    }
    return merged;
  }

  async function render() {
    renderChips();

    if (selectedIds.length < 2) {
      Util.showEmpty(tableWrap, "Add at least 2 players to compare.");
      return;
    }

    Util.showLoading(tableWrap, "Loading players…");
    let careers;
    try {
      careers = await Promise.all(
        selectedIds.map(async (id) => {
          if (!careerCache.has(id)) {
            careerCache.set(id, await Data.getPlayerCareer(id));
          }
          return careerCache.get(id);
        })
      );
    } catch (err) {
      Util.showError(tableWrap, err);
      return;
    }

    const specs = mergedSpecs(careers);

    const headerCells = [
      "Player", "Pos", "Teams", "Seasons", "Games",
      ...specs.map((s) => s.label),
    ];

    const rows = careers
      .map((career) => {
        const totals = career.career_totals || {};
        const statCells = specs
          .map((spec) => {
            const display = statCardValue(totals, spec);
            return `<td class="num">${display === null ? "-" : display}</td>`;
          })
          .join("");
        return `
          <tr>
            <td><a href="players.html?id=${encodeURIComponent(career.player_id)}">${Util.escapeHtml(career.player_display_name)}</a></td>
            <td>${Util.escapeHtml(career.position)}</td>
            <td>${career.teams.join(", ")}</td>
            <td>${Math.min(...career.seasons)}&ndash;${Math.max(...career.seasons)}</td>
            <td class="num">${career.games_played}</td>
            ${statCells}
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>${headerCells.map((h, i) => `<th${i >= 4 ? ' class="num"' : ""}>${h}</th>`).join("")}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
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
    const params = new URLSearchParams(location.search);
    const wanted = (params.get("ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter((id) => id && playersIndex[id]);
    selectedIds = [...new Set(wanted)].slice(0, MAX_PLAYERS);
    render();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
