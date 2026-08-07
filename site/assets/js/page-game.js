(async function () {
  const titleEl = document.getElementById("game-title");
  const subtitleEl = document.getElementById("game-subtitle");
  const summaryWrap = document.getElementById("game-summary-wrap");
  const modelWrap = document.getElementById("model-wrap");
  const signalsWrap = document.getElementById("signals-wrap");
  const compareWrap = document.getElementById("compare-table-wrap");
  const oddsWrap = document.getElementById("odds-table-wrap");
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
        <div class="stat-card card">
          <div class="value">${played ? `${g.away_score}&ndash;${g.home_score}` : "-"}</div>
          <div class="label">Final score (${Util.escapeHtml(g.away_team)}&ndash;${Util.escapeHtml(g.home_team)})</div>
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
        ${model.p_home_covers !== null && model.p_home_covers !== undefined ? `, P(${Util.escapeHtml(g.home_team)} covers) ${Util.pct(model.p_home_covers, 1)}` : ""}.
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

  // `favorTeam` is only ever set on the two signals this project has
  // actually tested and found real (Big Home Dog, QB Status) -- it renders
  // an explicit "Favors <team>" badge. Every other card only ever gets the
  // neutral bold/accent highlight from pairHighlight() below, never this
  // badge -- reserving "Favors" language for signals with real backing
  // keeps it from reading as a claim the untested/no-signal cards can't
  // support. `status` is kept as a param (unused visually now -- no more
  // dot) since call sites already pass it and it's harmless to leave; easy
  // to bring back if wanted later.
  function signalCard(title, status, bodyHtml, note, favorTeam) {
    return `
      <div class="signal-card">
        <div class="signal-card__title">
          <span>${Util.escapeHtml(title)}</span>
        </div>
        ${favorTeam ? `<div class="badge positive" style="margin-bottom:6px;">Favors ${Util.escapeHtml(favorTeam)}</div>` : ""}
        <div class="signal-card__body">${bodyHtml}</div>
        ${note ? `<details><summary class="text-faint" style="cursor:pointer; font-size:0.78rem; margin-top:6px;">What this means</summary><p class="text-faint" style="font-size:0.78rem; margin-top:4px;">${Util.escapeHtml(note)}</p></details>` : ""}
      </div>
    `;
  }

  // Shared bold/accent highlight for a two-value (away/home) comparison --
  // used both by Situational Signal cards and Team Comparison rows so the
  // same visual language means the same thing everywhere on this page.
  // Purely descriptive of which raw number is ahead, never a prediction.
  function pairHighlight(awayVal, homeVal, higherBetter) {
    if (higherBetter === null || higherBetter === undefined) return { awayCls: "", homeCls: "" };
    if (typeof awayVal !== "number" || typeof homeVal !== "number" || awayVal === homeVal) return { awayCls: "", homeCls: "" };
    const awayWins = higherBetter ? awayVal > homeVal : awayVal < homeVal;
    // "value-lead" (bold + accent + a leading arrow, see style.css) reads
    // clearly against the dimmed default -- plain color-only highlighting
    // (the first version of this) turned out too subtle to notice next to
    // the rest of the card.
    return { awayCls: awayWins ? "value-lead" : "", homeCls: !awayWins ? "value-lead" : "" };
  }

  // Two stacked "TEAM value" rows (the pattern every signal card already
  // uses), with whichever side is ahead bolded via pairHighlight() -- drop
  // in replacement for the plain two-`.row` blocks used before.
  function pairRows(awayTeam, awayVal, homeTeam, homeVal, higherBetter, fmt) {
    const format = fmt || ((v) => (v === null || v === undefined ? "-" : v));
    const { awayCls, homeCls } = pairHighlight(awayVal, homeVal, higherBetter);
    return (
      `<div class="row"><span>${Util.escapeHtml(awayTeam)}</span><span class="${awayCls}">${format(awayVal)}</span></div>` +
      `<div class="row"><span>${Util.escapeHtml(homeTeam)}</span><span class="${homeCls}">${format(homeVal)}</span></div>`
    );
  }

  function qbLine(teamAbbr, qb) {
    const established = qb.established_qb_name || "unknown";
    if (qb.changed === null) return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span class="text-faint">no history</span></div>`;
    if (!qb.changed) return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span>${Util.escapeHtml(established)} (starter)</span></div>`;
    const actual = qb.actual_qb_name || "backup (TBD)";
    return `<div class="row"><span>${Util.escapeHtml(teamAbbr)}</span><span class="text-accent">${Util.escapeHtml(actual)} <span class="text-faint">(vs. ${Util.escapeHtml(established)})</span></span></div>`;
  }

  function turnoverMargin(stats) {
    if (!stats) return null;
    const takeaways = (stats.def_interceptions || 0) + (stats.fumble_recovery_opp || 0);
    const giveaways = (stats.passing_interceptions || 0) + (stats.fumbles_lost_total || 0);
    return takeaways - giveaways;
  }

  function renderSignals(signals, g, detail) {
    if (!signals) {
      signalsWrap.innerHTML = "";
      return;
    }
    const {
      big_home_dog, fatigue, qb_status, coach_tenure, divisional, draft_capital, referee,
      pass_defense_allowed, common_opponents, primetime, turnover_margin_note,
    } = signals;

    const cards = [];

    cards.push(
      signalCard(
        "Big Home Dog",
        "real",
        big_home_dog.applies
          ? `<strong class="text-accent">Applies</strong> &mdash; ${Util.escapeHtml(g.home_team)} +${Math.abs(g.spread_line).toFixed(1).replace(/\.0$/, "")}`
          : `Doesn't apply`,
        big_home_dog.note,
        big_home_dog.applies ? g.home_team : null
      )
    );

    // QB change hurts the team that changed (~3.8 pts, tested/real) -- so
    // the badge only fires when it's a clean one-sided change. Both teams
    // changing, or neither, is a wash -- no badge, would be asserting
    // something the finding doesn't actually say.
    const qbFavor =
      qb_status.home.changed && !qb_status.away.changed
        ? g.away_team
        : qb_status.away.changed && !qb_status.home.changed
        ? g.home_team
        : null;
    cards.push(
      signalCard(
        "QB Status",
        "real",
        qbLine(g.away_team, qb_status.away) + qbLine(g.home_team, qb_status.home),
        qb_status.note,
        qbFavor
      )
    );

    cards.push(
      signalCard(
        "Rest",
        "none",
        pairRows(
          g.away_team, fatigue.away.rest_days, g.home_team, fatigue.home.rest_days, true,
          (v) => (v === null || v === undefined ? "-" : `${v} days`)
        ),
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Road Trip",
        "none",
        pairRows(
          // road_streak_entering (not including_this_game) -- this game
          // itself would always show as "at least 1" for whichever team is
          // away regardless of history, which reads exactly like a leaked
          // streak even when it isn't one. Entering-streak is unambiguous:
          // 0 always means "no streak coming in," full stop.
          g.away_team, fatigue.away.road_streak_entering,
          g.home_team, fatigue.home.road_streak_entering, false,
          (v) => (v === null || v === undefined ? "-" : v === 0 ? "No streak coming in" : `${v} straight coming in`)
        ),
        fatigue.note
      )
    );

    cards.push(
      signalCard(
        "Coming Off OT",
        "none",
        pairRows(
          g.away_team, fatigue.away.coming_off_overtime === null ? null : fatigue.away.coming_off_overtime ? 1 : 0,
          g.home_team, fatigue.home.coming_off_overtime === null ? null : fatigue.home.coming_off_overtime ? 1 : 0,
          false,
          (v) => (v === null || v === undefined ? "-" : v ? "Yes" : "No")
        ),
        fatigue.note
      )
    );

    // The away team is always the one traveling (home team never leaves
    // its own timezone), so name them directly instead of making the
    // reader work out which side a bare zone count refers to.
    cards.push(
      signalCard(
        "Timezone Crossing",
        "none",
        fatigue.timezone_crossing === null || fatigue.timezone_crossing === undefined
          ? "-"
          : fatigue.timezone_crossing === 0
          ? `${Util.escapeHtml(g.away_team)}: no time zone change`
          : `${Util.escapeHtml(g.away_team)} crossing ${fatigue.timezone_crossing} time zone${fatigue.timezone_crossing === 1 ? "" : "s"}`,
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
        pairRows(g.away_team, draft_capital.away, g.home_team, draft_capital.home, true, (v) => (v ?? "-") + " picks"),
        draft_capital.note
      )
    );

    cards.push(
      signalCard("Referee", "untested", referee.name ? Util.escapeHtml(referee.name) : "-", referee.note)
    );

    cards.push(
      signalCard(
        "Pass Defense Allowed",
        "untested",
        pairRows(g.away_team, pass_defense_allowed.away, g.home_team, pass_defense_allowed.home, false),
        pass_defense_allowed.note
      )
    );

    const awayTO = turnoverMargin(detail.away.recent);
    const homeTO = turnoverMargin(detail.home.recent);
    cards.push(
      signalCard(
        "Turnover Margin",
        "untested",
        pairRows(g.away_team, awayTO, g.home_team, homeTO, true, (v) => (v === null || v === undefined ? "-" : Util.signed(v, 0))),
        turnover_margin_note
      )
    );

    cards.push(
      signalCard("Game Slot", "none", primetime.bucket ? Util.escapeHtml(primetime.bucket) : "-", primetime.note)
    );

    const commonOppRows = common_opponents.opponents.length
      ? common_opponents.opponents
          .map((o) => {
            const { awayCls, homeCls } = pairHighlight(o.away_avg_margin, o.home_avg_margin, true);
            return `
              <div class="row"><span>vs ${Util.escapeHtml(o.opponent)}</span><span>
                <span class="${awayCls}">${Util.escapeHtml(g.away_team)} ${Util.signed(o.away_avg_margin, 1)}${o.away_games > 1 ? ` (${o.away_games}g)` : ""}</span>,
                <span class="${homeCls}">${Util.escapeHtml(g.home_team)} ${Util.signed(o.home_avg_margin, 1)}${o.home_games > 1 ? ` (${o.home_games}g)` : ""}</span>
              </span></div>
            `;
          })
          .join("")
      : `<span class="text-faint">No common opponents in either team's recent games.</span>`;
    cards.push(signalCard("Common Opponents", "untested", commonOppRows, common_opponents.note));

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
    const { awayCls, homeCls } = pairHighlight(awayRaw, homeRaw, stat.higherBetter);
    return `
      <div class="compare-row">
        <span class="compare-row__label">${Util.escapeHtml(stat.label)}</span>
        <span class="compare-row__val ${awayCls}">${fmt(awayRaw)}</span>
        <span class="compare-row__val ${homeCls}">${fmt(homeRaw)}</span>
      </div>
    `;
  }

  // Per-category roll-up: how many stats in this group is each team ahead
  // on. "Ahead" language (not "Favors") and a neutral gray badge, on
  // purpose -- this is a completed-box-score tally, not a tested predictive
  // signal, and shouldn't visually read the same as the QB Status/Big Home
  // Dog "Favors" badges above, which do have real backing.
  function categoryLeaderBadge(group, awayStats, homeStats, awayTeam, homeTeam) {
    let awayWins = 0;
    let homeWins = 0;
    let comparable = 0;
    for (const stat of group.rows) {
      const awayRaw = stat.get(awayStats || {});
      const homeRaw = stat.get(homeStats || {});
      const { awayCls, homeCls } = pairHighlight(awayRaw, homeRaw, stat.higherBetter);
      if (!awayCls && !homeCls) continue;
      comparable++;
      if (awayCls) awayWins++;
      else homeWins++;
    }
    if (!comparable) return "";
    if (awayWins === homeWins) return `<div class="badge neutral" style="margin-bottom:6px;">Even (${awayWins}-${homeWins})</div>`;
    const leader = awayWins > homeWins ? awayTeam : homeTeam;
    const score = awayWins > homeWins ? `${awayWins}-${homeWins}` : `${homeWins}-${awayWins}`;
    return `<div class="badge neutral" style="margin-bottom:6px;">Ahead: ${Util.escapeHtml(leader)} (${score})</div>`;
  }

  // Condensed into category cards instead of one long table, and to 2 value
  // columns (Away/Home) instead of always showing both "to date" and "full
  // season" at once -- the view toggle in game.html switches scope instead
  // of doubling the width to show both.
  function renderCompare(detail, view) {
    // "Full season" is a hindsight/retrospective view of the current
    // season only (most useful for a past game already played). "Recent"
    // is the rolling last-N-games window from the Worker (RECENT_GAMES_
    // WINDOW), which spans season boundaries on its own -- no separate
    // early-season handling needed here anymore.
    const awayStats = view === "full_season" ? detail.away.full_season : detail.away.recent;
    const homeStats = view === "full_season" ? detail.home.full_season : detail.home.recent;
    const awayGames = awayStats && awayStats.games_played;
    const homeGames = homeStats && homeStats.games_played;

    const cards = STAT_GROUPS.map(
      (group) => `
        <div class="signal-card">
          <div class="signal-card__title"><span>${Util.escapeHtml(group.title)}</span></div>
          ${categoryLeaderBadge(group, awayStats, homeStats, detail.away.team, detail.home.team)}
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

  /** American moneyline, e.g. +150 / -170 -- "-" for null/undefined. */
  function moneyline(v) {
    if (v === null || v === undefined) return "-";
    const n = Number(v);
    return n > 0 ? `+${n}` : String(n);
  }

  // Full per-bookmaker snapshot history -- no movement-threshold gating
  // (unlike games.html's summary arrows), since landing on this page is
  // already an intentional look at this one game. One row per
  // bookmaker/snapshot-time pair, oldest first (matches the Worker's
  // ORDER BY).
  //
  // Sign-convention note (see the same note in page-games.js's oddsArrow):
  // odds_snapshot.spread_line is the HOME team's own bookmaker line,
  // negative = home favored -- the OPPOSITE convention from game.spread_line
  // (positive = home favored), which is what Util.favoredTeamLine expects.
  // Negate before handing it to that helper so this table's "TEAM -3.5"
  // reads the same way as every other spread on the site, instead of
  // silently flipping the favorite.
  function renderOdds(history, g) {
    if (!history || !history.length) {
      Util.showEmpty(oddsWrap, "No odds snapshots recorded for this game yet.");
      return;
    }
    const rows = history
      .map((r) => {
        const spread = Util.favoredTeamLine(r.spread_line === null || r.spread_line === undefined ? null : -r.spread_line, g.home_team, g.away_team);
        return `
          <tr>
            <td>${Util.formatDateTime(r.snapshot_time)}</td>
            <td>${Util.escapeHtml(r.bookmaker)}</td>
            <td class="num">${spread}</td>
            <td class="num">${Util.num(r.total_line, 1)}</td>
            <td class="num">${moneyline(r.away_moneyline)}</td>
            <td class="num">${moneyline(r.home_moneyline)}</td>
          </tr>
        `;
      })
      .join("");

    oddsWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Snapshot</th><th>Book</th>
            <th class="num">Spread</th><th class="num">Total</th>
            <th class="num">${Util.escapeHtml(g.away_team)} ML</th><th class="num">${Util.escapeHtml(g.home_team)} ML</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
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
            <th class="num">Score (Away @ Home)</th><th class="num">Line</th><th>ATS</th>
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
    Util.showEmpty(oddsWrap, "No game id in the URL.");
    Util.showEmpty(h2hWrap, "No game id in the URL.");
    return;
  }

  const compareToggle = document.getElementById("compare-toggle");
  let compareView = "recent";

  try {
    const detail = await Data.getGameDetail(gameId);
    renderSummary(detail.game, detail.team_names || {});
    renderModel(detail.model, detail.game);
    renderSignals(detail.signals, detail.game, detail);
    renderCompare(detail, compareView);
    renderOdds(detail.odds_history, detail.game);
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
    Util.showError(oddsWrap, err);
    Util.showError(h2hWrap, err);
  }
})();
