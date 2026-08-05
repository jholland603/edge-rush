(async function () {
  const titleEl = document.getElementById("game-title");
  const subtitleEl = document.getElementById("game-subtitle");
  const summaryWrap = document.getElementById("game-summary-wrap");
  const modelWrap = document.getElementById("model-wrap");
  const signalsWrap = document.getElementById("signals-wrap");
  const compareWrap = document.getElementById("compare-table-wrap");
  const h2hWrap = document.getElementById("h2h-table-wrap");

  const params = new URLSearchParams(location.search);
  const gameId = params.get("id");

  function atsResult(g) {
    if (g.result === null || g.result === undefined || g.spread_line === null || g.spread_line === undefined) {
      return null;
    }
    const margin = g.result - g.spread_line;
    if (margin === 0) return "Push";
    return margin > 0 ? `${g.home_team} covered` : `${g.away_team} covered`;
  }

  function ouResult(g) {
    if (g.total === null || g.total === undefined || g.total_line === null || g.total_line === undefined) {
      return null;
    }
    const diff = g.total - g.total_line;
    if (diff === 0) return "Push";
    return diff > 0 ? "Over" : "Under";
  }

  function renderSummary(g, teamNames) {
    const played = g.home_score !== null && g.home_score !== undefined;
    const ats = atsResult(g);
    const ou = ouResult(g);

    titleEl.textContent = `${teamNames[g.away_team] || g.away_team} @ ${teamNames[g.home_team] || g.home_team}`;
    subtitleEl.textContent = `${g.season} · ${Util.weekLabel(g.week, g.game_type)} · ${Util.formatDate(g.gameday)}`;

    const weather = [];
    const roofLabel = Util.roofLabel(g.roof, g.stadium_id);
    if (roofLabel !== "-") weather.push(Util.escapeHtml(roofLabel));
    if (g.surface) weather.push(Util.escapeHtml(g.surface));
    if (g.temp !== null && g.temp !== undefined) {
      // Actual post-game weather takes priority once it exists.
      weather.push(`${g.temp}°F`);
      if (g.wind !== null && g.wind !== undefined) weather.push(`${g.wind} mph wind`);
    } else {
      const forecast = Util.forecastLabel(g);
      if (forecast !== "-") weather.push(`forecast: ${Util.escapeHtml(forecast)}`);
    }

    summaryWrap.innerHTML = `
      <div class="card-grid">
        <div class="stat-card card">
          <div class="value">${played ? `${g.away_score}&ndash;${g.home_score}` : "-"}</div>
          <div class="label">Final score (away&ndash;home)</div>
        </div>
        <div class="stat-card card">
          <div class="value">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</div>
          <div class="label">Closing spread${ats ? ` &mdash; ${Util.escapeHtml(ats)}` : ""}</div>
        </div>
        <div class="stat-card card">
          <div class="value">${Util.num(g.total_line, 1)}</div>
          <div class="label">Total line${ou ? ` &mdash; ${Util.escapeHtml(ou)}` : ""}</div>
        </div>
        <div class="stat-card card">
          <div class="value" style="font-size:1.1rem;">${weather.length ? weather.join(", ") : "-"}</div>
          <div class="label">Conditions</div>
        </div>
      </div>
    `;
  }

  function renderModel(model, g) {
    if (!model) {
      modelWrap.innerHTML = "";
      return;
    }
    modelWrap.innerHTML = `
      <div class="banner ${model.flagged ? "warn" : "info"}">
        <strong>Model prediction:</strong> favors ${Util.favoredTeamLine(model.model_spread, g.home_team, g.away_team)}
        vs. a market of ${Util.favoredTeamLine(model.market_spread, g.home_team, g.away_team)}
        &mdash; edge favors ${Util.favoredTeamLine(model.edge, g.home_team, g.away_team)}
        ${model.p_home_covers !== null && model.p_home_covers !== undefined ? `, P(home covers) ${Util.pct(model.p_home_covers, 1)}` : ""}.
        ${model.flagged ? "This game was flagged (|edge| &ge; 2.0 pts)." : "Not flagged."}
        <a href="games.html?season=${g.season}&week=${g.week}">See this week's picks &amp; log &rarr;</a>
      </div>
    `;
  }

  // "Situational signals" -- every fact Jeff wanted visible, shown
  // regardless of whether it tested out as predictive. Compact dashboard
  // cards instead of prose/tables -- a status dot says what the backtest
  // found (see the legend in game.html), the full explanation lives in a
  // <details> so it doesn't eat vertical space by default. See HANDOFF.md
  // for the underlying tests.
  function yesNo(v) {
    if (v === null || v === undefined) return "-";
    return v ? "Yes" : "No";
  }

  function signalCard(title, status, bodyHtml, note) {
    return `
      <div class="signal-card">
        <div class="signal-card__title">
          <span>${Util.escapeHtml(title)}</span>
          <span class="status-dot ${status}"></span>
        </div>
        <div class="signal-card__body">${bodyHtml}</div>
        ${note ? `<details><summary class="text-faint" style="cursor:pointer; font-size:0.78rem; margin-top:6px;">What this means</summary><p class="text-faint" style="font-size:0.78rem; margin-top:4px;">${Util.escapeHtml(note)}</p></details>` : ""}
      </div>
    `;
  }

  function qbLine(teamAbbr, qb) {
    const established = qb.established_qb_name || "unknown";
    if (qb.changed === null) return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span class="text-faint">no history</span></div>`;
    if (!qb.changed) return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span>${Util.escapeHtml(established)} (starter)</span></div>`;
    const actual = qb.actual_qb_name || "backup (TBD)";
    return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span class="text-accent">${Util.escapeHtml(actual)} <span class="text-faint">(vs. ${Util.escapeHtml(established)})</span></span></div>`;
  }

  function renderSignals(signals, g) {
    if (!signals) {
      signalsWrap.innerHTML = "";
      return;
    }
    const { big_home_dog, fatigue, qb_status, coach_tenure, divisional, draft_capital, referee } = signals;

    const cards = [];

    cards.push(
      signalCard(
        "Big Home Dog",
        "real",
        big_home_dog.applies
          ? `<strong class="text-accent">Applies</strong> &mdash; ${Util.escapeHtml(g.home_team)} +${Math.abs(g.spread_line).toFixed(1).replace(/\.0$/, "")}`
          : `Doesn't apply`,
        big_home_dog.note
      )
    );

    cards.push(
      signalCard(
        "QB Status",
        "real",
        qbLine(g.away_team, qb_status.away) + qbLine(g.home_team, qb_status.home),
        qb_status.note
      )
    );

    cards.push(
      signalCard(
        "Rest",
        "none",
        `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span>${fatigue.away.rest_days ?? "-"} days${fatigue.away.short_week ? " (short)" : ""}</span></div>` +
          `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span>${fatigue.home.rest_days ?? "-"} days${fatigue.home.short_week ? " (short)" : ""}</span></div>`,
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Road Trip",
        "none",
        `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span>${fatigue.away.road_streak_including_this_game} straight</span></div>` +
          `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span>${fatigue.home.road_streak_including_this_game} straight</span></div>`,
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Coming Off OT",
        "none",
        `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span>${yesNo(fatigue.away.coming_off_overtime)}</span></div>` +
          `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span>${yesNo(fatigue.home.coming_off_overtime)}</span></div>`,
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Timezone Crossing",
        "none",
        fatigue.timezone_crossing === null || fatigue.timezone_crossing === undefined
          ? "-"
          : `${fatigue.timezone_crossing} zone${fatigue.timezone_crossing === 1 ? "" : "s"}`,
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Coaching Tenure",
        "none",
        (coach_tenure.away
          ? `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span>${Util.escapeHtml(coach_tenure.away.coach_name)} (${coach_tenure.away.games_with_team}g)</span></div>`
          : `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span class="text-faint">-</span></div>`) +
          (coach_tenure.home
            ? `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span>${Util.escapeHtml(coach_tenure.home.coach_name)} (${coach_tenure.home.games_with_team}g)</span></div>`
            : `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span class="text-faint">-</span></div>`),
        coach_tenure.note
      )
    );

    cards.push(
      signalCard(
        "Matchup Type",
        "none",
        divisional.applies ? `Divisional game` : `Non-divisional`,
        divisional.note
      )
    );

    cards.push(
      signalCard(
        "Draft Capital (Rd 1-3, '22-'25)",
        "inconclusive",
        `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span>${draft_capital.away ?? "-"} picks</span></div>` +
          `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span>${draft_capital.home ?? "-"} picks</span></div>`,
        draft_capital.note
      )
    );

    cards.push(
      signalCard("Referee", "untested", referee.name ? Util.escapeHtml(referee.name) : "-", referee.note)
    );

    signalsWrap.innerHTML = cards.join("");
  }

  // Grouped into a handful of category cards instead of one long 16-row
  // table -- same data, far less vertical space. `higherBetter` drives a
  // subtle bold/accent highlight on whichever team has the better raw
  // number for that stat (true = higher wins, false = lower wins, null =
  // no clear direction, e.g. FG made/att shown as a fraction) -- this is
  // just describing which team's box score is ahead, not a prediction.
  const STAT_GROUPS = [
    {
      title: "Passing",
      rows: [
        { label: "Yards", get: (t) => t.passing_yards, higherBetter: true },
        { label: "TD", get: (t) => t.passing_tds, higherBetter: true },
        { label: "EPA/play", get: (t) => (t.attempts ? t.passing_epa / t.attempts : null), fmt: (v) => Util.signed(v, 2), higherBetter: true },
        { label: "INT Thrown", get: (t) => t.passing_interceptions, higherBetter: false },
      ],
    },
    {
      title: "Rushing",
      rows: [
        { label: "Yards", get: (t) => t.rushing_yards, higherBetter: true },
        { label: "TD", get: (t) => t.rushing_tds, higherBetter: true },
        { label: "EPA/play", get: (t) => (t.carries ? t.rushing_epa / t.carries : null), fmt: (v) => Util.signed(v, 2), higherBetter: true },
      ],
    },
    {
      title: "Defense",
      rows: [
        { label: "Sacks", get: (t) => t.def_sacks, higherBetter: true },
        { label: "INT", get: (t) => t.def_interceptions, higherBetter: true },
        { label: "TFL", get: (t) => t.def_tackles_for_loss, higherBetter: true },
        { label: "Forced Fum.", get: (t) => t.def_fumbles_forced, higherBetter: true },
      ],
    },
    {
      title: "Discipline & Special Teams",
      rows: [
        {
          label: "Turnovers Lost",
          get: (t) => (t.sack_fumbles_lost || 0) + (t.rushing_fumbles_lost || 0) + (t.receiving_fumbles_lost || 0),
          higherBetter: false,
        },
        { label: "FG Made/Att", get: (t) => `${t.fg_made ?? 0}/${t.fg_att ?? 0}`, fmt: (v) => v, higherBetter: null },
        { label: "Punt Net Avg", get: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), fmt: (v) => Util.num(v, 1), higherBetter: true },
        { label: "Penalties", get: (t) => t.penalties, higherBetter: false },
        { label: "Penalty Yds", get: (t) => t.penalty_yards, higherBetter: false },
      ],
    },
  ];

  function compareRow(stat, awayStats, homeStats) {
    const fmt = stat.fmt || ((v) => (v === null || v === undefined ? "-" : v));
    const awayRaw = stat.get(awayStats || {});
    const homeRaw = stat.get(homeStats || {});
    let awayCls = "";
    let homeCls = "";
    if (stat.higherBetter !== null && typeof awayRaw === "number" && typeof homeRaw === "number" && awayRaw !== homeRaw) {
      const awayWins = stat.higherBetter ? awayRaw > homeRaw : awayRaw < homeRaw;
      awayCls = awayWins ? "text-accent" : "";
      homeCls = !awayWins ? "text-accent" : "";
    }
    return `
      <div class="compare-row">
        <span class="compare-row__label">${Util.escapeHtml(stat.label)}</span>
        <span class="compare-row__val ${awayCls}">${fmt(awayRaw)}</span>
        <span class="compare-row__val ${homeCls}">${fmt(homeRaw)}</span>
      </div>
    `;
  }

  // Condensed into category cards instead of one long table, and to 2 value
  // columns (Away/Home) instead of always showing both "to date" and "full
  // season" at once -- the view toggle in game.html switches scope instead
  // of doubling the width to show both.
  function renderCompare(detail, view) {
    const awayStats = view === "full_season" ? detail.away.full_season : detail.away.season_to_date;
    const homeStats = view === "full_season" ? detail.home.full_season : detail.home.season_to_date;
    const awayGames = awayStats && awayStats.games_played;
    const homeGames = homeStats && homeStats.games_played;

    const cards = STAT_GROUPS.map(
      (group) => `
        <div class="signal-card">
          <div class="signal-card__title"><span>${Util.escapeHtml(group.title)}</span></div>
          <div class="compare-row compare-row--header">
            <span class="compare-row__label"></span>
            <span class="compare-row__val">${Util.escapeHtml(detail.away.team)}</span>
            <span class="compare-row__val">${Util.escapeHtml(detail.home.team)}</span>
          </div>
          ${group.rows.map((stat) => compareRow(stat, awayStats, homeStats)).join("")}
        </div>
      `
    ).join("");

    compareWrap.innerHTML = `
      <p class="text-faint" style="margin-bottom:var(--space-3);">
        Games: ${Util.escapeHtml(detail.away.team)} ${awayGames ?? "-"} &middot; ${Util.escapeHtml(detail.home.team)} ${homeGames ?? "-"}
      </p>
      <div class="signals-grid">${cards}</div>
    `;
  }

  function renderH2H(detail, games) {
    const teamNames = detail.team_names || {};
    if (!games.length) {
      const awayName = teamNames[detail.away.team] || detail.away.team;
      const homeName = teamNames[detail.home.team] || detail.home.team;
      Util.showEmpty(h2hWrap, `No prior meetings between ${Util.escapeHtml(awayName)} and ${Util.escapeHtml(homeName)} in the data set.`);
      return;
    }
    const rows = games
      .map((g) => {
        const ats = atsResult(g);
        return `
          <tr>
            <td>${g.season} ${Util.escapeHtml(Util.weekLabel(g.week, g.game_type))}</td>
            <td>${Util.formatDate(g.gameday)}</td>
            <td><a href="game.html?id=${encodeURIComponent(g.game_id)}">${Util.escapeHtml(teamNames[g.away_team] || g.away_team)} @ ${Util.escapeHtml(teamNames[g.home_team] || g.home_team)}</a></td>
            <td class="num">${g.away_score}&ndash;${g.home_score}</td>
            <td class="num">${Util.favoredTeamLine(g.spread_line, g.home_team, g.away_team)}</td>
            <td>${ats ? Util.escapeHtml(ats) : "-"}</td>
          </tr>
        `;
      })
      .join("");

    h2hWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Week</th><th>Date</th><th>Matchup</th>
            <th class="num">Score (Away&ndash;Home)</th><th class="num">Line</th><th>ATS</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  if (!gameId) {
    titleEl.textContent = "No game selected";
    subtitleEl.textContent = "";
    Util.showEmpty(compareWrap, "No game id in the URL.");
    Util.showEmpty(h2hWrap, "No game id in the URL.");
    return;
  }

  const compareToggle = document.getElementById("compare-toggle");
  let compareView = "to_date";

  try {
    const detail = await Data.getGameDetail(gameId);
    renderSummary(detail.game, detail.team_names || {});
    renderModel(detail.model, detail.game);
    renderSignals(detail.signals, detail.game);
    renderCompare(detail, compareView);
    renderH2H(detail, detail.head_to_head);

    compareToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-view]");
      if (!btn) return;
      compareView = btn.dataset.view;
      for (const b of compareToggle.querySelectorAll("button")) b.classList.toggle("active", b === btn);
      renderCompare(detail, compareView);
    });
  } catch (err) {
    titleEl.textContent = "Couldn't load game";
    subtitleEl.textContent = "";
    Util.showError(summaryWrap, err);
    Util.showError(signalsWrap, err);
    Util.showError(compareWrap, err);
    Util.showError(h2hWrap, err);
  }
})();
