(async function () {
  const titleEl = document.getElementById("game-title");
  const subtitleEl = document.getElementById("game-subtitle");
  const summaryWrap = document.getElementById("game-summary-wrap");
  const modelWrap = document.getElementById("model-wrap");
  const teamNewsWrap = document.getElementById("team-news-wrap");
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

  function renderSummary(g, teamNames, oddsAverage) {
    const played = g.home_score !== null && g.home_score !== undefined;
    const ats = atsResult(g);
    const ou = ouResult(g);

    // For a game that's already been played, g.spread_line/total_line is
    // the real closing line (nflverse records it after the fact) -- keep
    // showing that, unchanged. For an upcoming game, that same field is
    // just whatever line nflverse's schedule CSV had at the last weekly
    // import (not live), so once odds_snapshot has at least one real
    // bookmaker reading, prefer the live across-book average instead and
    // label it accordingly. Falls back to the old label/value if no
    // snapshot has landed yet for this game.
    const useAverage = !played && oddsAverage;
    const spreadValue = useAverage && oddsAverage.spread !== null ? oddsAverage.spread : g.spread_line;
    const totalValue = useAverage && oddsAverage.total !== null ? oddsAverage.total : g.total_line;
    const spreadLabel = useAverage && oddsAverage.spread !== null ? "Average spread" : "Closing spread";
    const totalLabel = useAverage && oddsAverage.total !== null ? "Average total" : "Total line";

    // Jeff bets at DraftKings specifically, so once we're already showing
    // the live median (useAverage), also show DK's own line and how far
    // it sits from that median -- a book can legitimately differ from the
    // field (liability management, slower to move, etc.), and that gap is
    // exactly what's worth seeing before betting there instead of
    // shopping the number elsewhere. Spread's delta is computed in
    // game.spread_line's convention (both values already converted), so a
    // plain subtraction is valid -- no sign-flip needed here.
    function dkNote(market, formatValue) {
      if (!useAverage || !oddsAverage.draftkings) return "";
      const dkValue = oddsAverage.draftkings[market];
      const medianValue = oddsAverage[market];
      if (dkValue === null || dkValue === undefined || medianValue === null || medianValue === undefined) return "";
      const delta = dkValue - medianValue;
      const deltaLabel = Math.abs(delta) < 0.01 ? "matches median" : `${delta > 0 ? "+" : ""}${Util.num(delta, 2)} vs. median`;
      return `<div class="text-faint" style="font-size:0.8rem;margin-top:4px;">DK: ${formatValue(dkValue)} (${Util.escapeHtml(deltaLabel)})</div>`;
    }
    const spreadDkNote = dkNote("spread", (v) => Util.favoredTeamLine(v, g.home_team, g.away_team));
    const totalDkNote = dkNote("total", (v) => Util.num(v, 1));

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
          <div class="value">${Util.favoredTeamLine(spreadValue, g.home_team, g.away_team)}</div>
          <div class="label">${spreadLabel}${ats ? ` &mdash; ${Util.escapeHtml(ats)}` : ""}</div>
          ${spreadDkNote}
        </div>
        <div class="stat-card card">
          <div class="value">${Util.num(totalValue, 1)}</div>
          <div class="label">${totalLabel}${ou ? ` &mdash; ${Util.escapeHtml(ou)}` : ""}</div>
          ${totalDkNote}
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

  // Team News -- its own top-level page section (Jeff's call, 2026-08-12:
  // didn't want this buried as one more small card in the Situational
  // Signals grid alongside 15 other cards, wanted it to actually stand
  // out). Reads D1's team_news table (populated daily by
  // scripts/fetch_team_news.py via GitHub Actions) -- was briefly a live
  // per-request fetch straight from the Worker instead, reverted the same
  // day after confirming Google News blocks Cloudflare Workers' IP range
  // as automated traffic (HTTP 503, "your computer or network may be
  // sending automated queries") -- see the Worker's getTeamNewsFromD1()
  // comment for the full story. So "latest" here means as of the last
  // daily run, not real-time. "No recent headlines" for a team is still
  // expected sometimes, not an error -- not every team gets daily press
  // coverage.
  function newsLine(item) {
    const sourceHtml = item.source ? ` <span class="text-faint">&mdash; ${Util.escapeHtml(item.source)}</span>` : "";
    return (
      `<div class="row" style="font-size:0.85rem; align-items:flex-start; padding:6px 0; border-bottom:1px solid var(--color-border);">` +
      `<a href="${Util.escapeHtml(item.link)}" target="_blank" rel="noopener">${Util.escapeHtml(item.title)}</a>${sourceHtml}` +
      `</div>`
    );
  }
  // Show the first 5, collapse the rest behind a "Show N more" toggle
  // (Jeff's call, 2026-08-12) -- backend still returns up to
  // TEAM_NEWS_LIMIT (8, see the Worker), this just controls how many are
  // visible by default. Delegated click listener (below, set up once) so
  // it keeps working after renderTeamNews() replaces teamNewsWrap's
  // innerHTML on every page load/refresh.
  const TEAM_NEWS_VISIBLE = 5;
  function teamNewsList(items) {
    if (!items || !items.length) return `<span class="text-faint">No recent headlines.</span>`;
    const visible = items.slice(0, TEAM_NEWS_VISIBLE).map(newsLine).join("");
    const rest = items.slice(TEAM_NEWS_VISIBLE);
    if (!rest.length) return visible;
    return (
      visible +
      `<div class="team-news-more" data-expanded="false">` +
      `<div class="team-news-more-items" style="display:none;">${rest.map(newsLine).join("")}</div>` +
      `<button type="button" class="team-news-more-toggle" style="background:none;border:none;color:var(--color-accent);cursor:pointer;padding:6px 0 0;font-size:0.8rem;">Show ${rest.length} more</button>` +
      `</div>`
    );
  }
  if (teamNewsWrap) {
    teamNewsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".team-news-more-toggle");
      if (!btn) return;
      const wrap = btn.closest(".team-news-more");
      const list = wrap.querySelector(".team-news-more-items");
      const expanded = wrap.dataset.expanded === "true";
      list.style.display = expanded ? "none" : "";
      wrap.dataset.expanded = expanded ? "false" : "true";
      btn.textContent = expanded ? `Show ${list.children.length} more` : "Show less";
    });
  }
  function renderTeamNews(team_news, g) {
    if (!teamNewsWrap) return;
    if (!team_news) {
      teamNewsWrap.innerHTML = `<div class="loading">Loading&hellip;</div>`;
      return;
    }
    teamNewsWrap.innerHTML = `
      <div class="card-grid">
        <div class="card stat-card">
          <div class="signal-card__title"><span>${Util.escapeHtml(g.away_team)}</span></div>
          ${teamNewsList(team_news.away)}
        </div>
        <div class="card stat-card">
          <div class="signal-card__title"><span>${Util.escapeHtml(g.home_team)}</span></div>
          ${teamNewsList(team_news.home)}
        </div>
      </div>
      <p class="text-faint" style="font-size:0.78rem;">Refreshed daily via Google News RSS -- as of the last scheduled run, not real-time.</p>
    `;
  }

  function renderSignals(signals, g, detail) {
    if (!signals) {
      signalsWrap.innerHTML = "";
      return;
    }
    const {
      big_home_dog, fatigue, qb_status, divisional,
      pass_defense_allowed, common_opponents, primetime, turnover_margin_note, opponent_similarity,
      line_movement, expert_consensus, notable_injured_players,
    } = signals;
    // coach_tenure / draft_capital / referee are still returned by the
    // Worker (see getGameSituationalSignals) but no longer rendered as
    // cards here -- removed 2026-08-11 (Jeff's call).

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

    // Injury report -- home_injuries_out/away_injuries_out (from the
    // `model` table) give the raw headcount; notable_injured_players (from
    // signals, see getNotableInjuredPlayers in the Worker) names every
    // player with a final Out/Doubtful status plus their trailing per-game
    // production, so the card answers "who, and does it matter" instead of
    // just "how many." Jeff's framing (2026-08-11): don't need to see the
    // backup with 5 catches, do need to see the guy with 90 -- backtest_v15
    // tried folding a value-weighted version of this into the model itself
    // (QB/RB/WR-TE/front-seven/K, all backtested) and it never cleared
    // breakeven, so this stays a display-only judgment call, not a pick.
    const model = detail.model;
    const countsHtml =
      model && model.home_injuries_out !== null && model.home_injuries_out !== undefined
        ? pairRows(g.away_team, model.away_injuries_out, g.home_team, model.home_injuries_out, false)
        : "";
    function playerInjuryLine(p) {
      const stat =
        p.stat_label && p.stat_per_game !== null && p.stat_per_game !== undefined
          ? ` <span class="text-faint">&mdash; ${Util.num(p.stat_per_game, 1)} ${Util.escapeHtml(p.stat_label)}</span>`
          : "";
      const statusCls = p.report_status === "Out" ? "text-accent" : "";
      return (
        `<div class="row" style="font-size:0.85rem;">` +
        `<span>${Util.escapeHtml(p.name)} <span class="text-faint">(${Util.escapeHtml(p.position || "?")})</span></span>` +
        `<span class="${statusCls}">${Util.escapeHtml(p.report_status)}${stat}</span>` +
        `</div>`
      );
    }
    const notable = notable_injured_players;
    const namedListHtml = notable && (notable.home.length || notable.away.length)
      ? `<div class="text-faint" style="font-size:0.78rem;margin-top:6px;">${Util.escapeHtml(g.away_team)}</div>` +
        (notable.away.length ? notable.away.map(playerInjuryLine).join("") : `<span class="text-faint">None listed.</span>`) +
        `<div class="text-faint" style="font-size:0.78rem;margin-top:6px;">${Util.escapeHtml(g.home_team)}</div>` +
        (notable.home.length ? notable.home.map(playerInjuryLine).join("") : `<span class="text-faint">None listed.</span>`)
      : `<div class="text-faint" style="font-size:0.78rem;margin-top:6px;">No players listed Out or Doubtful for either team yet.</div>`;

    if (countsHtml || namedListHtml) {
      cards.push(
        signalCard(
          "Injury Report",
          "none",
          countsHtml + namedListHtml,
          "Counts above are every player on the report (Questionable/Doubtful/Out all count) -- dropped from the model's inputs 2026-08-11 in favor of a cleaner pass_edge+rush_edge-only model. Names below are only final Out/Doubtful, with trailing per-game production over the last 10 games attached so you can judge who actually matters. backtest_v15 tested a value-weighted version of this by position (QB/RB/WR-TE/front-seven/K) as an actual model input and it didn't clear breakeven -- shown here as a fact, not a pick."
        )
      );
    } else {
      cards.push(
        signalCard(
          "Injury Report",
          "none",
          `<span class="text-faint">Not scored yet for this game.</span>`,
          "Populated once this game has a posted line and that week's injury report is available."
        )
      );
    }

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

    // Road Trip and Coming Off OT cards removed 2026-08-11 (Jeff's call) --
    // fatigue.road_streak_entering / .coming_off_overtime are still computed
    // by the Worker (fatigue.note / Rest / Timezone Crossing above still use
    // the same fatigue object) but no longer rendered as their own cards.

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

    // Coaching Tenure card removed 2026-08-11 (Jeff's call).

    cards.push(
      signalCard(
        "Matchup Type",
        "none",
        divisional.applies ? `Divisional game` : `Non-divisional`,
        divisional.note
      )
    );

    // Draft Capital and Referee cards removed 2026-08-11 (Jeff's call).

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

    // Opponent-similarity-weighted form -- Jeff's idea, backtested (no
    // meaningful improvement, see the note text below), shown anyway as
    // context. Null until weekly_update.py has scored this game (same
    // "not every game has this yet" pattern as the Model Prediction banner
    // and the weather forecast card).
    if (opponent_similarity) {
      // Same convention as the model's own pass_edge/rush_edge: positive =
      // favors home. Was a bare signed number (e.g. "+0.484") with no team
      // attached -- reusing favoredTeamLine (same helper the spread/model
      // prediction cards use) instead so this reads as "SEA -0.484" (SEA
      // favored by that much) rather than requiring the sign convention to
      // be memorized. 3 decimals since these values are much smaller than
      // a real spread.
      const fmtEdge = (v) => (v === null || v === undefined ? "-" : Util.favoredTeamLine(v, g.home_team, g.away_team, 3));
      const fmtEss = (v) => (v === null || v === undefined ? "-" : `${Util.num(v, 1)}/10`);
      cards.push(
        signalCard(
          "Recency + Opponent-Similarity-Adjusted Form",
          "tested_no_signal",
          `<div class="row"><span>Pass edge (flat &rarr; weighted)</span><span>${fmtEdge(opponent_similarity.flat_pass_edge)} &rarr; ${fmtEdge(opponent_similarity.weighted_pass_edge)}</span></div>` +
            `<div class="row"><span>Rush edge (flat &rarr; weighted)</span><span>${fmtEdge(opponent_similarity.flat_rush_edge)} &rarr; ${fmtEdge(opponent_similarity.weighted_rush_edge)}</span></div>` +
            `<div class="row text-faint" style="font-size:0.78rem;"><span>Eff. sample size</span><span>${Util.escapeHtml(g.away_team)} ${fmtEss(opponent_similarity.away_avg_ess)}, ${Util.escapeHtml(g.home_team)} ${fmtEss(opponent_similarity.home_avg_ess)}</span></div>`,
          opponent_similarity.note
        )
      );
    } else {
      cards.push(
        signalCard(
          "Recency + Opponent-Similarity-Adjusted Form",
          "tested_no_signal",
          `<span class="text-faint">Not scored yet for this game.</span>`,
          "Tested (backtest_v6/v7): reweighting each team's last 10 games toward opponents similar to this week's, plus recent games more heavily, was the least-bad variant tried but still short of breakeven. Populated by weekly_update.py once this game has a posted line."
        )
      );
    }

    // Line movement -- can't be backtested yet (odds_snapshot collection
    // only started 2026-08-07, no graded games have movement history behind
    // them), shown as a fact so it's on record while history accumulates,
    // same "build the infra now, judge it later" pattern as opponent_similarity
    // above. Values come out of odds_snapshot in its own convention
    // (negative = home favored) -- negate before handing to
    // favoredTeamLine (same conversion renderOdds() below already does),
    // so this reads as "SEA -3.5 -> NE +1.5" instead of a bare signed
    // number with no team attached. No separate direction arrow here (Jeff
    // doesn't want home/away-only labels, and once both ends of the move
    // are team-qualified, an arrow tied to the raw number's sign is more
    // confusing than the plain open -> latest values already are).
    if (line_movement) {
      const fmtSpread = (v) =>
        v === null || v === undefined ? "-" : Util.favoredTeamLine(-v, g.home_team, g.away_team);
      const fmtTotal = (v) => (v === null || v === undefined ? "-" : Util.num(v, 1));
      cards.push(
        signalCard(
          "Line Movement",
          "untested",
          `<div class="row"><span>Spread</span><span>${fmtSpread(line_movement.spread.open)} &rarr; ${fmtSpread(line_movement.spread.latest)}</span></div>` +
            `<div class="row"><span>Total</span><span>${fmtTotal(line_movement.total.open)} &rarr; ${fmtTotal(line_movement.total.latest)}</span></div>`,
          line_movement.note
        )
      );
    } else {
      cards.push(
        signalCard(
          "Line Movement",
          "untested",
          `<span class="text-faint">Not enough snapshots yet -- needs at least two odds pulls for this game.</span>`,
          "Not tested, not in the model -- collection only started 2026-08-07, no graded-game history behind it yet. Shown as a fact once this game has at least two snapshot times, so it accumulates for a future backtest."
        )
      );
    }

    // Expert straight-up pick consensus (ESPN) -- can't be backtested even
    // in principle (no free historical archive of past expert picks exists),
    // shown purely as a live fact. Straight-up, not ATS -- see the note text
    // for why no free ATS panel is used. pairHighlight here just bolds
    // whichever side got more picks for readability, same visual language
    // as every other two-value row on this page -- not a claim about which
    // side is "right."
    if (expert_consensus) {
      const { awayCls, homeCls } = pairHighlight(expert_consensus.away_picks, expert_consensus.home_picks, true);
      const pct = (picks) => (expert_consensus.num_experts ? `${Math.round((picks / expert_consensus.num_experts) * 100)}%` : "-");
      cards.push(
        signalCard(
          "Expert Pick Consensus (ESPN, straight-up)",
          "untested",
          `<div class="row"><span>${Util.escapeHtml(g.away_team)}</span><span class="${awayCls}">${expert_consensus.away_picks}/${expert_consensus.num_experts} (${pct(expert_consensus.away_picks)})</span></div>` +
            `<div class="row"><span>${Util.escapeHtml(g.home_team)}</span><span class="${homeCls}">${expert_consensus.home_picks}/${expert_consensus.num_experts} (${pct(expert_consensus.home_picks)})</span></div>`,
          expert_consensus.note
        )
      );
    } else {
      cards.push(
        signalCard(
          "Expert Pick Consensus (ESPN, straight-up)",
          "untested",
          `<span class="text-faint">No picks posted yet -- ESPN's analysts usually post a few days before kickoff.</span>`,
          "Not tested, not in the model -- straight-up picks (who wins outright), not against the spread, and there's no free historical archive of past expert picks to backtest against even in principle. Shown as a fact once posted."
        )
      );
    }

    signalsWrap.innerHTML = cards.join("");
  }

  // Per-game, not raw totals over the window -- added 2026-08-11 (Jeff's
  // call). Raw totals over "last 10" or "full season" aren't directly
  // comparable when the two teams' windows don't have the same number of
  // games behind them (bye weeks, early season, a team with a short full-
  // season sample) -- per-game averages are what "Yards", "Points Scored",
  // etc. mean everywhere else in football anyway (YPG, PPG), so this also
  // matches how bettors already read these numbers. EPA/play, FG Made/Att,
  // and Punt Net Avg are left alone -- they're already rates (per-play or
  // per-attempt), not raw totals, so dividing by games again would be wrong.
  function perGame(t, field) {
    return t && t.games_played ? t[field] / t.games_played : null;
  }
  const fmt1 = (v) => Util.num(v, 1);

  // Grouped into a handful of category cards instead of one long 16-row
  // table -- same data, far less vertical space. `higherBetter` drives a
  // subtle bold/accent highlight on whichever team has the better raw
  // number for that stat (true = higher wins, false = lower wins, null =
  // no clear direction, e.g. FG made/att shown as a fraction) -- this is
  // just describing which team's box score is ahead, not a prediction.
  const STAT_GROUPS = [
    {
      title: "Scoring",
      rows: [
        { label: "Points Scored/G", get: (t) => perGame(t, "points_scored"), fmt: fmt1, higherBetter: true },
        { label: "Points Allowed/G", get: (t) => perGame(t, "points_allowed"), fmt: fmt1, higherBetter: false },
      ],
    },
    {
      title: "Passing",
      rows: [
        { label: "Yards/G", get: (t) => perGame(t, "passing_yards"), fmt: fmt1, higherBetter: true },
        { label: "TD/G", get: (t) => perGame(t, "passing_tds"), fmt: fmt1, higherBetter: true },
        { label: "EPA/play", get: (t) => (t.attempts ? t.passing_epa / t.attempts : null), fmt: (v) => Util.signed(v, 2), higherBetter: true },
        { label: "INT Thrown/G", get: (t) => perGame(t, "passing_interceptions"), fmt: fmt1, higherBetter: false },
      ],
    },
    {
      title: "Rushing",
      rows: [
        { label: "Yards/G", get: (t) => perGame(t, "rushing_yards"), fmt: fmt1, higherBetter: true },
        { label: "TD/G", get: (t) => perGame(t, "rushing_tds"), fmt: fmt1, higherBetter: true },
        { label: "EPA/play", get: (t) => (t.carries ? t.rushing_epa / t.carries : null), fmt: (v) => Util.signed(v, 2), higherBetter: true },
      ],
    },
    {
      title: "Defense",
      rows: [
        { label: "Sacks/G", get: (t) => perGame(t, "def_sacks"), fmt: fmt1, higherBetter: true },
        { label: "INT/G", get: (t) => perGame(t, "def_interceptions"), fmt: fmt1, higherBetter: true },
        { label: "TFL/G", get: (t) => perGame(t, "def_tackles_for_loss"), fmt: fmt1, higherBetter: true },
        { label: "Forced Fum./G", get: (t) => perGame(t, "def_fumbles_forced"), fmt: fmt1, higherBetter: true },
      ],
    },
    {
      title: "Discipline & Special Teams",
      rows: [
        {
          label: "Turnovers Lost/G",
          get: (t) =>
            t && t.games_played
              ? ((t.sack_fumbles_lost || 0) + (t.rushing_fumbles_lost || 0) + (t.receiving_fumbles_lost || 0)) / t.games_played
              : null,
          fmt: fmt1,
          higherBetter: false,
        },
        { label: "FG Made/Att", get: (t) => `${t.fg_made ?? 0}/${t.fg_att ?? 0}`, fmt: (v) => v, higherBetter: null },
        { label: "Punt Net Avg", get: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), fmt: (v) => Util.num(v, 1), higherBetter: true },
        { label: "Penalties/G", get: (t) => perGame(t, "penalties"), fmt: fmt1, higherBetter: false },
        { label: "Penalty Yds/G", get: (t) => perGame(t, "penalty_yards"), fmt: fmt1, higherBetter: false },
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
    renderSummary(detail.game, detail.team_names || {}, detail.odds_average || null);
    renderModel(detail.model, detail.game);
    renderTeamNews(detail.team_news, detail.game);
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
