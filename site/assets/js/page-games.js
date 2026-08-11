(async function () {
  const seasonSelect = document.getElementById("season-select");
  const weekSelect = document.getElementById("week-select");
  const teamFilter = document.getElementById("team-filter");
  const tableWrap = document.getElementById("games-table-wrap");
  const leansNote = document.getElementById("leans-note");

  const params = new URLSearchParams(location.search);
  let currentGames = [];
  let modelByGameId = new Map();
  let picksByGameId = new Map();
  let teamNames = {};

  // Signal/stat "lean" tallies -- scoped to a single week (see
  // Data.getWeekLeans / getWeekLeans() in the Worker for why: computing
  // the full situational-signals payload is too expensive per-game to run
  // for an entire season at once). `leansState` is "none" (no week
  // selected -- "All weeks"), "loading", or "ready"; leansByGameId is only
  // trustworthy when leansState is "ready".
  let leansByGameId = new Map();
  let leansForWeekKey = null;
  let leansState = "none";

  function teamName(abbr) {
    return teamNames[abbr] || abbr;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (seasonSelect.value) p.set("season", seasonSelect.value);
    if (weekSelect.value) p.set("week", weekSelect.value);
    if (teamFilter.value) p.set("team", teamFilter.value);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  async function loadSeasons() {
    const index = await Data.getIndex();
    teamNames = index.team_names || {};
    const seasons = [...index.seasons.games].sort((a, b) => b - a);
    Util.fillSelect(seasonSelect, seasons);
    const wanted = Number(params.get("season"));
    seasonSelect.value = seasons.includes(wanted) ? String(wanted) : String(seasons[0]);
  }

  async function loadSeasonGames({ defaultToCurrentWeek = false } = {}) {
    Util.showLoading(tableWrap);
    const season = seasonSelect.value;
    const [data, model, picks] = await Promise.all([
      Data.getGamesSeason(season),
      // Model predictions and the picks log are Phase 2/3 data -- may not
      // exist for every season (only whatever weeks weekly_update.py has
      // scored/flagged). Missing is normal, not an error, so don't let it
      // break the schedule view.
      Data.getModelSeason(season).catch(() => []),
      Data.getPicksSeason(season).catch(() => []),
    ]);
    currentGames = data.games;
    modelByGameId = new Map(model.map((m) => [m.game_id, m]));
    picksByGameId = new Map(picks.map((p) => [p.game_id, p]));

    const weeks = [...new Set(currentGames.map((g) => g.week))].sort((a, b) => a - b);
    const weekOptions = weeks.map((w) => {
      const example = currentGames.find((g) => g.week === w);
      return { value: String(w), label: Util.weekLabel(w, example && example.game_type) };
    });
    Util.fillSelect(weekSelect, weekOptions, { placeholder: "All weeks" });
    const wanted = params.get("week");
    if (weeks.map(String).includes(wanted)) {
      weekSelect.value = wanted;
    } else if (defaultToCurrentWeek) {
      // Only on the page's first load with no explicit week/season params --
      // land on whatever week is current instead of the full "All weeks"
      // list. Switching seasons by hand afterward goes back to "All weeks"
      // (browsing a whole past season is more useful than pinning it to
      // whatever week happens to be "current" today).
      const cw = Util.currentWeek(currentGames);
      weekSelect.value = cw !== null && weeks.includes(cw) ? String(cw) : "";
    } else {
      weekSelect.value = "";
    }
  }

  // Kicks off (or reuses) the leans fetch for whatever week is currently
  // selected, re-rendering once it resolves. Doesn't block the caller --
  // the table renders immediately with "-"/"..." placeholders and updates
  // in place, since this can be the slowest thing on the page (~15 D1
  // queries per game).
  function refreshLeans() {
    const season = seasonSelect.value;
    const week = weekSelect.value;
    leansNote.style.display = week ? "none" : "";

    if (!week) {
      leansByGameId = new Map();
      leansForWeekKey = null;
      leansState = "none";
      return;
    }

    const key = `${season}:${week}`;
    if (leansForWeekKey === key && leansState === "ready") return; // already have it

    leansState = "loading";
    leansForWeekKey = key;
    Data.getWeekLeans(season, week)
      .then((data) => {
        if (leansForWeekKey !== key) return; // user moved on to a different week meanwhile
        leansByGameId = new Map(data.leans.map((l) => [l.game_id, l]));
        leansState = "ready";
        render();
      })
      .catch(() => {
        if (leansForWeekKey !== key) return;
        // Non-fatal -- leans are a bonus column, not core schedule data.
        // Leave cells at "-" rather than breaking the whole table.
        leansByGameId = new Map();
        leansState = "ready";
        render();
      });
  }

  function edgeBadge(g) {
    const m = modelByGameId.get(g.game_id);
    if (!m) return `<span class="badge neutral">-</span>`;
    const cls = m.flagged ? "positive" : "neutral";
    return `<span class="badge ${cls}">${Util.favoredTeamLine(m.edge, g.home_team, g.away_team)}</span>`;
  }

  function atsBadge(g) {
    if (g.result === null || g.result === undefined || g.spread_line === null || g.spread_line === undefined) {
      return `<span class="badge neutral">-</span>`;
    }
    const margin = g.result - g.spread_line;
    if (margin === 0) return `<span class="badge neutral">Push</span>`;
    const covered = margin > 0 ? g.home_team : g.away_team;
    return `<span class="badge positive">${Util.escapeHtml(covered)} covered</span>`;
  }

  function ouBadge(g) {
    if (g.total === null || g.total === undefined || g.total_line === null || g.total_line === undefined) {
      return `<span class="badge neutral">-</span>`;
    }
    const diff = g.total - g.total_line;
    if (diff === 0) return `<span class="badge neutral">Push</span>`;
    return diff > 0
      ? `<span class="badge warn">Over</span>`
      : `<span class="badge neutral">Under</span>`;
  }

  // Situational-signal / stat lean tally -- "1 point per" for now (Jeff:
  // weighting comes later). Gray "TEAM (n-m)" badge (no "Ahead:" prefix --
  // Jeff: unnecessary, the team name + score already says it), NOT the
  // green "Favors" badge -- this combined tally deliberately mixes
  // tested-and-real signals (Big Home Dog, QB Status) with purely
  // descriptive ones (Draft Capital, Pass Defense Allowed, etc.) at equal
  // weight, so it doesn't have the same backing "Favors" implies elsewhere
  // on this site.
  function leanBadge(tally, g) {
    if (leansState === "loading") return `<span class="text-faint">&hellip;</span>`;
    if (!tally) return `<span class="text-faint">-</span>`;
    const { home_points, away_points } = tally;
    if (home_points === away_points) {
      return `<span class="badge neutral">Even (${home_points}-${away_points})</span>`;
    }
    const leader = home_points > away_points ? g.home_team : g.away_team;
    const score = home_points > away_points ? `${home_points}-${away_points}` : `${away_points}-${home_points}`;
    return `<span class="badge neutral">${Util.escapeHtml(leader)} (${score})</span>`;
  }

  // Small up/down arrow next to the Line/Total cells when the average
  // odds_snapshot line has moved >= 1pt since its earliest snapshot (see
  // ODDS_MOVEMENT_THRESHOLD / getOddsMovement() in the Worker). Only
  // renders once `lean.odds_movement` is present (2+ distinct snapshot
  // times for the game) and `.moved` is true for that market.
  //
  // Sign-convention note: odds_snapshot.spread_line (what odds_movement.spread
  // is built from) is the HOME team's own bookmaker line, negative = home
  // favored -- the OPPOSITE convention from game.spread_line, positive =
  // home favored, which is what the Line cell actually displays via
  // Util.favoredTeamLine. So the raw "up"/"down" direction from the Worker
  // is backwards relative to what's on screen -- flip it for spread so the
  // arrow always matches "the number in this cell went up/down", not the
  // raw odds_snapshot number. Totals have no such conflict (same
  // convention everywhere), so pass through as-is.
  function oddsArrow(oddsMovement, market) {
    const m = oddsMovement && oddsMovement[market];
    if (!m || !m.moved) return "";
    let direction = m.direction;
    if (market === "spread") {
      direction = direction === "up" ? "down" : direction === "down" ? "up" : direction;
    }
    if (direction !== "up" && direction !== "down") return "";
    const label = market === "spread" ? "Average line has moved" : "Average total has moved";
    return `<span class="odds-arrow odds-arrow--${direction}" title="${Util.escapeHtml(label)}"></span>`;
  }

  // DraftKings' own line, on its own line under the average -- Jeff bets at
  // DK specifically, so "is my book off the field, and by how much" is
  // worth surfacing right in the table, not just buried in game.html's
  // detail view. Only makes sense alongside the average (useAverage cases),
  // and only rendered when there's an actual gap to report.
  //
  // Used to show just the bare delta (e.g. "DK -1.50"), which was ambiguous
  // for spreads: a delta on its own doesn't say which TEAM DK favors,
  // especially when the average is a pick ("PICK DK -1.50" -- pick against
  // what?). Now shows DK's actual line the same way the main cell does
  // (favoredTeamLine for spread, the number itself for total), so it reads
  // the same way at a glance instead of needing to do sign-convention math.
  function dkLineNote(avg, market, homeTeam, awayTeam) {
    if (!avg || !avg.draftkings) return "";
    const dkValue = avg.draftkings[market];
    const medianValue = avg[market];
    if (dkValue === null || dkValue === undefined || medianValue === null || medianValue === undefined) return "";
    const delta = dkValue - medianValue;
    if (Math.abs(delta) < 0.01) return "";
    const display = market === "spread" ? Util.favoredTeamLine(dkValue, homeTeam, awayTeam) : Util.num(dkValue, 1);
    const deltaStr = `${delta > 0 ? "+" : ""}${Util.num(delta, 2)}`;
    return `<br><span class="text-faint dk-delta">DK: ${display} (${deltaStr})</span>`;
  }

  // Same reasoning as game.html's summary cards (see page-game.js): for a
  // played game, g.spread_line/total_line is the real closing line, keep
  // it. For an upcoming game, prefer the live across-bookmaker average
  // (lean.odds_average) once at least one snapshot has landed, since the
  // stored game.spread_line is just a once-a-week import, not live --
  // falls back to it if no snapshot exists yet for this game.
  function spreadCell(g, lean) {
    const played = g.home_score !== null && g.home_score !== undefined;
    const avg = lean && lean.odds_average;
    const useAverage = !played && avg && avg.spread !== null;
    const value = useAverage ? avg.spread : g.spread_line;
    const title = useAverage ? ` title="Average across ${avg.book_count} book(s)"` : "";
    const dkNote = useAverage ? dkLineNote(avg, "spread", g.home_team, g.away_team) : "";
    return `<span${title}>${Util.favoredTeamLine(value, g.home_team, g.away_team)}</span>${oddsArrow(lean && lean.odds_movement, "spread")}${dkNote}`;
  }

  function totalCell(g, lean) {
    const played = g.home_score !== null && g.home_score !== undefined;
    const avg = lean && lean.odds_average;
    const useAverage = !played && avg && avg.total !== null;
    const value = useAverage ? avg.total : g.total_line;
    const title = useAverage ? ` title="Average across ${avg.book_count} book(s)"` : "";
    const dkNote = useAverage ? dkLineNote(avg, "total", g.home_team, g.away_team) : "";
    return `<span${title}>${Util.num(value, 1)}</span>${oddsArrow(lean && lean.odds_movement, "total")}${dkNote}`;
  }

  // --- Pick-log cells (folded in from the old picks.html) --------------
  // A game only has a picks_log row if it was flagged (|edge| >= 2.0 at the
  // time weekly_update.py scored it) -- most games have no pick, hence the
  // "-" fallback everywhere below.
  function pickBetCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="text-faint">-</span>`;
    return p.bet_placed === "Y"
      ? `<span class="badge positive">Y</span>`
      : `<span class="badge neutral">N</span>`;
  }

  function pickClosingLineCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p || p.closing_line === null || p.closing_line === undefined) return `<span class="text-faint">-</span>`;
    return Util.favoredTeamLine(p.closing_line, g.home_team, g.away_team);
  }

  function pickClvCell(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="text-faint">-</span>`;
    return Util.signed(p.clv, 1);
  }

  function pickResultBadge(g) {
    const p = picksByGameId.get(g.game_id);
    if (!p) return `<span class="badge neutral">-</span>`;
    if (p.covered === null || p.covered === undefined) return `<span class="badge neutral">Pending</span>`;
    return p.covered
      ? `<span class="badge positive">${Util.escapeHtml(p.side)} covered</span>`
      : `<span class="badge negative">${Util.escapeHtml(p.side)} missed</span>`;
  }

  function render() {
    let rows = currentGames.slice();
    if (weekSelect.value) rows = rows.filter((g) => String(g.week) === weekSelect.value);
    const teamQuery = teamFilter.value.trim().toUpperCase();
    if (teamQuery) rows = rows.filter((g) => g.home_team === teamQuery || g.away_team === teamQuery);
    rows.sort((a, b) => a.week - b.week || a.gameday.localeCompare(b.gameday));

    if (!rows.length) {
      Util.showEmpty(tableWrap, "No games match these filters.");
      return;
    }

    // Score/ATS/O/U are pure results -- meaningless "-" on every row for a
    // week that hasn't happened yet. Suppress the whole column (not just
    // the cells) when nothing in the current view has been played, rather
    // than cluttering the table with a column of dashes. Model
    // Edge/Bet/Closing Line/CLV are all known before kickoff, so they stay
    // regardless; Pick Result stays too -- it already shows "Pending" for
    // an unresolved logged pick, which is real information, not a blank.
    const anyPlayed = rows.some((g) => g.home_score !== null && g.home_score !== undefined);

    const bodyRows = rows
      .map((g) => {
        const played = g.home_score !== null && g.home_score !== undefined;
        const score = played ? `${g.away_score}&ndash;${g.home_score}` : "-";
        const lean = leansByGameId.get(g.game_id);
        return `
          <tr>
            <td>${Util.escapeHtml(Util.weekLabelShort(g.week, g.game_type))}</td>
            <td>${Util.escapeHtml(g.game_type)}</td>
            <td>${Util.formatDate(g.gameday)}</td>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamName(g.away_team))} @ ${Util.escapeHtml(teamName(g.home_team))}</a></td>
            <td class="num">${spreadCell(g, lean)}</td>
            <td class="num">${totalCell(g, lean)}</td>
            <td>${leanBadge(lean && lean.situational, g)}</td>
            <td>${leanBadge(lean && lean.stats, g)}</td>
            ${anyPlayed ? `<td class="num">${score}</td><td>${atsBadge(g)}</td><td>${ouBadge(g)}</td>` : ""}
            <td>${edgeBadge(g)}</td>
            <td>${pickBetCell(g)}</td>
            <td class="num">${pickClosingLineCell(g)}</td>
            <td class="num">${pickClvCell(g)}</td>
            <td>${pickResultBadge(g)}</td>
            <td>${Util.escapeHtml(Util.roofLabel(g.roof, g.stadium_id))}</td>
            <td>${Util.escapeHtml(Util.forecastLabel(g))}</td>
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Wk</th><th>Type</th><th>Date</th><th>Matchup</th>
            <th class="num">Line</th><th class="num">Total</th>
            <th>Signals</th><th>Stats</th>
            ${anyPlayed ? `<th class="num">Score (Away&ndash;Home)</th><th>ATS</th><th>O/U</th>` : ""}
            <th class="num">Model Edge</th>
            <th>Bet</th><th class="num">Closing Line</th><th class="num">CLV</th><th>Pick Result</th>
            <th>Roof</th><th>Forecast</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;
  }

  seasonSelect.addEventListener("change", async () => {
    try {
      await loadSeasonGames();
      render();
      refreshLeans();
      syncUrl();
    } catch (err) {
      Util.showError(tableWrap, err);
    }
  });
  weekSelect.addEventListener("change", () => {
    render();
    refreshLeans();
    syncUrl();
  });
  teamFilter.addEventListener(
    "input",
    Util.debounce(() => {
      render();
      syncUrl();
    }, 200)
  );

  try {
    await loadSeasons();
    if (params.get("team")) teamFilter.value = params.get("team").toUpperCase();
    // Default to the current week only when the URL didn't already ask for a
    // specific season -- if it did, respect the season default logic above.
    await loadSeasonGames({ defaultToCurrentWeek: !params.get("season") });
    render();
    refreshLeans();
    syncUrl();
  } catch (err) {
    Util.showError(tableWrap, err);
  }
})();
