(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const positionToggle = document.getElementById("position-toggle");
  const scoringNoteEl = document.getElementById("scoring-note");
  const tableWrap = document.getElementById("fantasy-table-wrap");

  const params = new URLSearchParams(location.search);
  let currentPosition = (params.get("position") || "QB").toUpperCase();
  if (!positionToggle.querySelector(`[data-position="${currentPosition}"]`)) currentPosition = "QB";

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (weekSelect.value) p.set("week", weekSelect.value);
    p.set("position", currentPosition);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    const seasons = [...index.seasons.games].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  // Populates the week dropdown for whichever season is selected, and
  // defaults to the current week (same helper games.html uses) rather than
  // always landing on Week 1 -- for an in-progress or upcoming season that's
  // almost always the more useful default.
  async function loadWeeks({ defaultToCurrentWeek = false } = {}) {
    const season = seasonSelect.value;
    const data = await Data.getGamesSeason(season);
    const games = data.games;
    const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
    const weekOptions = weeks.map((w) => {
      const example = games.find((g) => g.week === w);
      return { value: String(w), label: Util.weekLabel(w, example && example.game_type) };
    });
    Util.fillSelect(weekSelect, weekOptions);
    const wanted = params.get("week");
    if (weeks.map(String).includes(wanted)) {
      weekSelect.value = wanted;
    } else if (defaultToCurrentWeek) {
      const cw = Util.currentWeek(games);
      if (cw !== null) weekSelect.value = String(cw);
    }
  }

  function matchupCell(oppAbbr, multiplier) {
    if (!oppAbbr) return `<span class="text-faint">-</span>`;
    if (multiplier === null || multiplier === undefined) return Util.escapeHtml(oppAbbr);
    const pct = Math.round((multiplier - 1) * 100);
    const cls = pct > 5 ? "text-accent" : pct < -5 ? "text-faint" : "";
    const sign = pct > 0 ? "+" : "";
    return `${Util.escapeHtml(oppAbbr)} <span class="${cls}">(${sign}${pct}% matchup)</span>`;
  }

  function injuryBadge(status) {
    if (!status || status === "Probable") return "";
    const cls = status === "Doubtful" ? "negative" : "warn";
    return ` <span class="badge ${cls}">${Util.escapeHtml(status)}</span>`;
  }

  function renderSkillPosition(payload) {
    const rows = payload.rankings
      .map(
        (r, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${Util.escapeHtml(r.name)}${injuryBadge(r.injury_status)}</td>
          <td>${Util.escapeHtml(r.team)}</td>
          <td>${matchupCell(r.opponent, r.matchup_multiplier)}</td>
          <td class="num">${Util.num(r.own_avg, 1)}</td>
          <td class="num">${Util.num(r.projected, 1)}</td>
          <td class="num">${r.games_played}</td>
        </tr>
      `
      )
      .join("");
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th class="num">#</th><th>Player</th><th>Team</th><th>Opponent</th>
            <th class="num">Recent avg</th><th class="num">Projected</th><th class="num">Games</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderDst(payload) {
    const rows = payload.rankings
      .map(
        (r, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${Util.escapeHtml(r.team)}</td>
          <td>${matchupCell(r.opponent, r.matchup_multiplier)}</td>
          <td class="num">${Util.num(r.own_avg, 1)}</td>
          <td class="num">${Util.num(r.projected, 1)}</td>
          <td class="num">${r.games_played}</td>
        </tr>
      `
      )
      .join("");
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th class="num">#</th><th>Team</th><th>Opponent</th>
            <th class="num">Recent avg</th><th class="num">Projected</th><th class="num">Games</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadRankings() {
    Util.showLoading(tableWrap);
    scoringNoteEl.textContent = "";
    const season = seasonSelect.value;
    const week = weekSelect.value;
    if (!season || !week) {
      Util.showEmpty(tableWrap, "Pick a season and week.");
      return;
    }
    try {
      const payload = await Data.getFantasyRankings(season, week, currentPosition);
      scoringNoteEl.textContent = payload.scoring_note || "";
      if (!payload.rankings || !payload.rankings.length) {
        Util.showEmpty(
          tableWrap,
          "No eligible players found for this position/week -- either too early in the schedule for enough history, or everyone eligible is marked Out."
        );
        return;
      }
      if (currentPosition === "DST") renderDst(payload);
      else renderSkillPosition(payload);
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  }

  positionToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-position]");
    if (!btn) return;
    currentPosition = btn.dataset.position;
    for (const b of positionToggle.querySelectorAll("button")) b.classList.toggle("active", b === btn);
    syncUrl();
    loadRankings();
  });

  seasonSelect.addEventListener("change", async () => {
    await loadWeeks();
    syncUrl();
    loadRankings();
  });

  weekSelect.addEventListener("change", () => {
    syncUrl();
    loadRankings();
  });

  for (const b of positionToggle.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.position === currentPosition);
  }

  await loadSeasons();
  await loadWeeks({ defaultToCurrentWeek: !params.get("week") });
  syncUrl();
  await loadRankings();
})();
