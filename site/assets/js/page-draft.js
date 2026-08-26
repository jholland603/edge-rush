/**
 * Draft War Room -- a self-contained fantasy draft-day board and pick
 * tracker. Unlike every other page on this site, this one has nothing to do
 * with the handicapping model: no D1/Worker calls, no games/teams/players
 * data. Everything lives in memory + localStorage, entirely client-side, so
 * it works offline at the kitchen table during an actual draft.
 *
 * State shape:
 *   settings: { teams, mySlot, scoring, draftType, roster: {QB,RB,WR,TE,FLEX,DST,K,BENCH}, auctionBudget }
 *   players:  [{ id, name, pos, team, tier, flags: [] }]
 *   picks:    [{ overall, playerId, owner: 'me'|'other', paid?: number }], in the order they were made
 *   ui:       { posFilter, search, hideDrafted, activeTab }
 *
 * `picks` is append-only and IS the source of truth for "whose turn is it" --
 * the current overall pick number is always picks.length + 1. Nothing else
 * (my roster, the run tracker, the strategy nudges) is stored separately;
 * it's all derived fresh from players+picks+settings on every render. That
 * makes "Reset draft" and "Undo" trivial (just mutate `picks`) instead of
 * needing to keep three data structures in sync by hand.
 */
(function () {
  "use strict";

  const ROSTER_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BENCH"];
  const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6 };
  const POSES = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"];

  // Flag -> [badge class, label]. Badge colors reuse the site's existing
  // positive/negative/neutral/warn vocabulary rather than inventing new ones.
  const FLAG_META = {
    anchor: ["positive", "anchor"],
    value: ["positive", "late value"],
    injury: ["warn", "injury risk"],
    trap: ["negative", "⚠ sexy pick"],
    rookie: ["neutral", "rookie"],
    handcuff: ["neutral", "handcuff"],
  };

  // Starter board: a preseason sketch built from 2026 consensus + reporting
  // (see draft.html's import note), NOT this site's own player database --
  // the handicapping model's D1 tables are historical box-score stats, they
  // have no concept of fantasy ADP/tiers for a season that hasn't been
  // played yet. Deliberately no bye weeks here -- the 2026 schedule-based
  // bye data isn't something this file can vouch for; import a real
  // cheat-sheet CSV close to draft day instead of trusting this list as-is.
  // prettier-ignore
  const SEED_PLAYERS = [
    ["Bijan Robinson","RB","ATL",1,"anchor"],["Jahmyr Gibbs","RB","DET",1,"anchor"],
    ["Ja'Marr Chase","WR","CIN",1,"anchor"],["Saquon Barkley","RB","PHI",1,"anchor"],
    ["Justin Jefferson","WR","MIN",1,"anchor"],["CeeDee Lamb","WR","DAL",1,"anchor"],
    ["Jonathan Taylor","RB","IND",1,"anchor"],["Puka Nacua","WR","LAR",1,""],
    ["Malik Nabers","WR","NYG",1,""],["Christian McCaffrey","RB","SF",1,"injury"],
    ["Amon-Ra St. Brown","WR","DET",1,""],["Ashton Jeanty","RB","LV",1,"rookie"],
    ["Brock Bowers","TE","LV",1,"anchor"],["De'Von Achane","RB","MIA",2,""],
    ["Derrick Henry","RB","BAL",2,"anchor"],["Nico Collins","WR","HOU",2,""],
    ["Jaxon Smith-Njigba","WR","SEA",2,""],["Brian Thomas Jr.","WR","JAX",2,""],
    ["Kyren Williams","RB","LAR",2,""],["Drake London","WR","ATL",2,""],
    ["A.J. Brown","WR","PHI",2,""],["Josh Jacobs","RB","GB",2,""],
    ["Bucky Irving","RB","TB",2,""],["Ladd McConkey","WR","LAC",2,""],
    ["Breece Hall","RB","NYJ",2,""],["Trey McBride","TE","ARI",2,""],
    ["Josh Allen","QB","BUF",2,""],["Lamar Jackson","QB","BAL",2,""],
    ["James Cook","RB","BUF",3,""],["Chase Brown","RB","CIN",3,""],
    ["Tee Higgins","WR","CIN",3,""],["Davante Adams","WR","LAR",3,""],
    ["Jayden Daniels","QB","WAS",3,""],["Omarion Hampton","RB","LAC",3,"rookie"],
    ["TreVeyon Henderson","RB","NE",3,"rookie|trap"],["Marvin Harrison Jr.","WR","ARI",3,"trap"],
    ["DK Metcalf","WR","PIT",3,""],["Terry McLaurin","WR","WAS",3,""],
    ["Sam LaPorta","TE","DET",3,""],["Alvin Kamara","RB","NO",3,"injury"],
    ["Garrett Wilson","WR","NYJ",3,""],["Patrick Mahomes","QB","KC",3,""],
    ["Rome Odunze","WR","CHI",4,""],["Cam Skattebo","RB","NYG",4,"rookie|trap"],
    ["Jameson Williams","WR","DET",4,""],["Zay Flowers","WR","BAL",4,""],
    ["DeVonta Smith","WR","PHI",4,""],["Joe Burrow","QB","CIN",4,""],
    ["Jalen Hurts","QB","PHI",4,""],["Tony Pollard","RB","TEN",4,""],
    ["Aaron Jones","RB","MIN",4,"injury"],["James Conner","RB","ARI",4,""],
    ["Chris Olave","WR","NO",4,""],["Mark Andrews","TE","BAL",4,""],
    ["George Kittle","TE","SF",4,"injury"],["Xavier Worthy","WR","KC",5,""],
    ["Rhamondre Stevenson","RB","NE",5,""],["David Montgomery","RB","DET",5,"injury"],
    ["Justin Herbert","QB","LAC",5,"value"],["C.J. Stroud","QB","HOU",5,""],
    ["Courtland Sutton","WR","DEN",5,""],["Jerry Jeudy","WR","CLE",5,""],
    ["Jayden Reed","WR","GB",5,""],["Keon Coleman","WR","BUF",5,""],
    ["Calvin Ridley","WR","TEN",5,""],["Jordan Addison","WR","MIN",5,""],
    ["Jonathon Brooks","RB","CAR",5,"injury|handcuff"],["Isiah Pacheco","RB","KC",5,""],
    ["Kyler Murray","QB","ARI",5,""],["Bo Nix","QB","DEN",5,"value"],
    ["Trevor Lawrence","QB","JAX",6,"value"],["Jared Goff","QB","DET",6,"value"],
    ["Brock Purdy","QB","SF",6,"value"],["Baker Mayfield","QB","TB",6,"value"],
    ["Tank Dell","WR","HOU",6,"injury"],["Rashee Rice","WR","KC",6,"injury"],
    ["Zamir White","RB","LV",6,"handcuff"],["Tyjae Spears","RB","TEN",6,"handcuff"],
    ["Javonte Williams","RB","DAL",6,""],["Rachaad White","RB","TB",6,""],
    ["Evan Engram","TE","DEN",6,""],["David Njoku","TE","CLE",6,""],
    ["Dallas Goedert","TE","PHI",6,""],["Kyle Pitts","TE","ATL",6,"trap"],
    ["Jonnu Smith","TE","PIT",6,""],["Justin Fields","QB","NYJ",6,""],
    ["Brandon Aubrey","K","DAL",6,""],["Harrison Butker","K","KC",6,""],
    ["Jake Moody","K","SF",6,""],["Chris Boswell","K","PIT",6,""],
    ["Cameron Dicker","K","LAC",6,""],["Denver Broncos","DST","DEN",6,""],
    ["Pittsburgh Steelers","DST","PIT",6,""],["Philadelphia Eagles","DST","PHI",6,""],
    ["Baltimore Ravens","DST","BAL",6,""],["Houston Texans","DST","HOU",6,""],
  ];

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function makeSeedPlayers() {
    return SEED_PLAYERS.map((r) => ({
      id: slugify(r[0] + "-" + r[2] + "-" + r[1]),
      name: r[0],
      pos: r[1],
      team: r[2],
      tier: r[3],
      flags: r[4] ? r[4].split("|").filter(Boolean) : [],
    }));
  }

  function defaultState() {
    return {
      settings: { teams: 12, mySlot: 5, scoring: "PPR", draftType: "SNAKE", roster: Object.assign({}, DEFAULT_ROSTER), auctionBudget: 200 },
      players: makeSeedPlayers(),
      picks: [],
      ui: { posFilter: "ALL", search: "", hideDrafted: true, activeTab: "board" },
    };
  }

  const STORE_KEY = "edgerush_draft_v1";
  let state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? JSON.parse(raw) : defaultState();
    if (!state || !state.settings || !state.players || !state.ui) state = defaultState();
  } catch (e) {
    state = defaultState(); // storage unavailable (private mode, quota, etc.) -- run in-memory only
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore -- in-memory state still works for the rest of the session */
    }
  }

  /* ---------------- derived state ---------------- */

  function totalRounds() {
    return ROSTER_ORDER.reduce((sum, k) => sum + (state.settings.roster[k] || 0), 0);
  }

  // Standard snake order: odd rounds go slot 1->T, even rounds go T->1.
  function slotOnClock(overall, teams) {
    const round = Math.ceil(overall / teams);
    const posInRound = overall - (round - 1) * teams;
    return round % 2 === 1 ? posInRound : teams - posInRound + 1;
  }

  function currentOverall() {
    return state.picks.length + 1;
  }
  function currentRound(teams) {
    return Math.ceil(currentOverall() / teams);
  }

  function picksUntilMe() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    let overall = currentOverall();
    if (slotOnClock(overall, teams) === mine) return 0;
    for (let count = 0; count < teams * 2; count++) {
      if (slotOnClock(overall, teams) === mine) return count;
      overall++;
    }
    return null;
  }

  function myPickSequence() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    const rounds = totalRounds();
    const out = [];
    for (let round = 1; round <= rounds; round++) {
      const overall = round % 2 === 1 ? (round - 1) * teams + mine : (round - 1) * teams + (teams - mine + 1);
      out.push({ round, overall });
    }
    return out;
  }

  function playerById(id) {
    return state.players.find((p) => p.id === id) || null;
  }
  function pickFor(id) {
    return state.picks.find((p) => p.playerId === id) || null;
  }
  function isDrafted(id) {
    return !!pickFor(id);
  }

  // Assigns my picks to roster slots in draft order: natural position slot
  // first, then FLEX (RB/WR/TE only), then bench, then an overflow bench
  // slot if every configured bench spot is already full. Recomputed fresh
  // every render rather than stored, so changing the roster template
  // mid-draft can't leave stale assignments behind.
  function computeMyRoster() {
    const slots = [];
    ROSTER_ORDER.forEach((type) => {
      const n = state.settings.roster[type] || 0;
      for (let i = 0; i < n; i++) slots.push({ type, playerId: null });
    });
    state.picks
      .filter((p) => p.owner === "me")
      .forEach((pk) => {
        const pl = playerById(pk.playerId);
        if (!pl) return;
        let idx = slots.findIndex((s) => s.type === pl.pos && s.playerId === null);
        if (idx === -1 && ["RB", "WR", "TE"].includes(pl.pos)) {
          idx = slots.findIndex((s) => s.type === "FLEX" && s.playerId === null);
        }
        if (idx === -1) idx = slots.findIndex((s) => s.type === "BENCH" && s.playerId === null);
        if (idx === -1) {
          slots.push({ type: "BENCH", playerId: null, overflow: true });
          idx = slots.length - 1;
        }
        slots[idx].playerId = pk.playerId;
      });
    return slots;
  }

  function positionRunLastN(n) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    state.picks.slice(-n).forEach((p) => {
      const pl = playerById(p.playerId);
      if (pl && counts.hasOwnProperty(pl.pos)) counts[pl.pos]++;
    });
    return counts;
  }

  function draftPhase(round, rounds) {
    if (round <= 3) return { label: "Foundation", text: "Best player available at RB/WR/TE. Resist the QB itch -- the position runs 15+ deep this year." };
    if (round <= 8) return { label: "Build", text: "Lock your starters. This is the window for a QB1 and your RB2/WR3 depth." };
    if (round <= Math.max(9, rounds - 4)) return { label: "Depth & bench", text: "Handcuffs with real standalone value, a TE2 if needed, high-upside bench flyers." };
    return { label: "Lottery tickets", text: "Rookie stashes, injury-comeback bets, and your DST/K -- last, always." };
  }

  function generateNudges() {
    const out = [];
    const myPicks = state.picks.filter((p) => p.owner === "me");
    const myPlayers = myPicks.map((p) => playerById(p.playerId)).filter(Boolean);
    const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
    myPlayers.forEach((pl) => { if (posCount.hasOwnProperty(pl.pos)) posCount[pl.pos]++; });
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();

    const last = myPlayers[myPlayers.length - 1];
    if (last && last.flags.includes("trap")) {
      out.push({ level: "danger", text: `"${last.name}" carries a boom/bust flag -- real name value, real bust risk. Watch early-season usage closely and don't be precious about benching or trading it.` });
    }
    if (posCount.QB === 0 && round <= 5) {
      out.push({ level: "good", text: "No QB yet -- that's fine. This position is 15+ deep; keep taking RB/WR value." });
    }
    if (posCount.QB === 0 && round >= 6 && round <= 10) {
      out.push({ level: "info", text: "Good window to grab your QB1 -- the Herbert/Lawrence/Goff/Purdy tier tends to fall right about here." });
    }
    if (posCount.QB >= 1) {
      const qbPick = myPicks.find((p) => { const pl = playerById(p.playerId); return pl && pl.pos === "QB"; });
      if (qbPick && Math.ceil(qbPick.overall / teams) <= 5) {
        out.push({ level: "warn", text: "You spent an early pick at QB -- make sure it's outproducing the RB/WR you passed on. Deep position this year, hold it to a high bar." });
      }
    }
    if (posCount.RB === 0 && round >= 4) {
      out.push({ level: "warn", text: "Zero RB territory now -- own it. Commit your next couple of picks to RB or the plan falls apart at the flex." });
    }
    const run = positionRunLastN(5);
    Object.keys(run).forEach((pos) => {
      if (run[pos] >= 3) out.push({ level: "danger", text: `${pos} run in progress -- ${run[pos]} of the last 5 picks. Decide now: get in on it or fade it and pivot.` });
    });
    if (round >= rounds - 2) {
      const openStarter = computeMyRoster().find((s) => s.playerId === null && s.type !== "BENCH");
      if (openStarter) out.push({ level: "danger", text: `Still an open starting ${openStarter.type} with the draft almost over -- don't punt it for a 4th bench flier.` });
    }
    if (out.length === 0) out.push({ level: "info", text: "No alerts right now -- keep taking the best player on your board relative to tier, not name recognition." });
    return out.slice(0, 5);
  }

  /* ---------------- rendering ---------------- */

  function statCard(label, value, variant) {
    return `<div class="card stat-card${variant ? " " + variant : ""}"><div class="value mono">${value}</div><div class="label">${label}</div></div>`;
  }

  function renderScoreboard() {
    const teams = state.settings.teams;
    const overall = currentOverall();
    const round = currentRound(teams);
    const onClock = slotOnClock(overall, teams);
    const until = picksUntilMe();
    document.getElementById("scoreboard").innerHTML =
      statCard("Round", `${Math.min(round, totalRounds())} / ${totalRounds()}`) +
      statCard("Overall pick", overall) +
      statCard("On the clock", `Slot ${onClock}`, "warn") +
      statCard("Picks till you", until === 0 ? "YOU'RE UP" : until, until === 0 ? "danger" : "");
  }

  function renderSettingsForm() {
    document.getElementById("cfg-teams").value = state.settings.teams;
    document.getElementById("cfg-slot").value = state.settings.mySlot;
    document.getElementById("cfg-scoring").value = state.settings.scoring;
    document.getElementById("cfg-budget").value = state.settings.auctionBudget;
    document.getElementById("cfg-budget-control").style.display = state.settings.draftType === "AUCTION" ? "flex" : "none";
    document.querySelectorAll("#draft-type-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === state.settings.draftType);
    });
    document.getElementById("roster-inputs").innerHTML = ROSTER_ORDER.map(
      (k) => `<div class="rf"><label>${k}</label><input type="number" min="0" max="10" data-rk="${k}" value="${state.settings.roster[k]}"></div>`
    ).join("");
  }

  function renderRosterList() {
    const slots = computeMyRoster();
    const round = currentRound(state.settings.teams);
    const rounds = totalRounds();
    document.getElementById("roster-list").innerHTML = slots.map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const urgent = !pl && round >= rounds - 3;
      return `<li style="display:flex; justify-content:space-between; gap:var(--space-2); font-size:0.85rem; ${urgent ? "color:var(--color-danger);" : ""}">
        <span class="mono text-faint">${s.type}</span>
        <span style="flex:1; text-align:right;">${pl ? Util.escapeHtml(pl.name) : "open"}</span>
      </li>`;
    }).join("");
  }

  function renderRunTracker() {
    const run = positionRunLastN(8);
    document.getElementById("run-tracker").innerHTML = ["QB", "RB", "WR", "TE"].map((pos) => {
      const c = run[pos];
      const pct = Math.round((c / 8) * 100);
      return `<div class="run-row">
        <span class="run-row__pos">${pos}</span>
        <span class="run-row__track"><span class="run-row__fill${c >= 3 ? " alert" : ""}" style="width:${pct}%"></span></span>
        <span class="run-row__count">${c}</span>
      </div>`;
    }).join("");
    const alertPos = ["QB", "RB", "WR", "TE"].find((p) => run[p] >= 3);
    document.getElementById("run-alert").innerHTML = alertPos
      ? `<p class="text-danger" style="margin:var(--space-2) 0 0; font-size:0.82rem;">${alertPos} run -- ${run[alertPos]} of the last 8 picks</p>`
      : "";
  }

  function renderPosFilter() {
    document.getElementById("pos-filter").innerHTML = POSES.map(
      (p) => `<button type="button" data-pos="${p}" class="${state.ui.posFilter === p ? "active" : ""}">${p}</button>`
    ).join("");
  }

  function tierBadgeClass(t) {
    return t === 1 ? "tier1" : t === 2 ? "tier2" : "neutral";
  }

  function renderBoard() {
    const q = state.ui.search.trim().toLowerCase();
    const rows = state.players
      .filter((p) => {
        if (state.ui.posFilter !== "ALL" && p.pos !== state.ui.posFilter) return false;
        if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
        if (state.ui.hideDrafted && isDrafted(p.id)) return false;
        return true;
      })
      .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

    const body = document.getElementById("board-body");
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="5"><div class="empty-state">No players match -- clear filters or import a fresh board.</div></td></tr>`;
      return;
    }

    body.innerHTML = rows.map((p) => {
      const drafted = isDrafted(p.id);
      const pk = drafted ? pickFor(p.id) : null;
      const flagsHtml = p.flags.map((f) => {
        const meta = FLAG_META[f] || ["neutral", f];
        return `<span class="badge ${meta[0]}">${meta[1]}</span>`;
      }).join(" ");

      let actionHtml;
      if (drafted) {
        actionHtml = `<span class="text-faint">${pk.owner === "me" ? "YOUR PICK" : "gone"}${pk.paid ? ` &middot; $${pk.paid}` : ""}</span>`;
      } else if (state.settings.draftType === "AUCTION") {
        actionHtml = `<span class="auction-bid">$<input type="number" min="1" max="${state.settings.auctionBudget}" value="1" data-bidfor="${p.id}">
          <button type="button" class="btn" data-act="mine-auction" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button></span>`;
      } else {
        actionHtml = `<button type="button" class="btn" data-act="mine" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button>`;
      }

      return `<tr${drafted ? ' style="opacity:0.4;"' : ""}>
        <td><span class="badge ${tierBadgeClass(p.tier)}">T${p.tier}</span></td>
        <td>${drafted ? `<s>${Util.escapeHtml(p.name)}</s>` : Util.escapeHtml(p.name)} <span class="text-faint">${p.pos}</span></td>
        <td>${Util.escapeHtml(p.team)}</td>
        <td>${flagsHtml}</td>
        <td style="text-align:right;">${actionHtml}</td>
      </tr>`;
    }).join("");
  }

  function findNextMine(seq, overall) {
    const next = seq.find((s) => s.overall >= overall);
    return next ? next.overall : null;
  }

  function renderMyDraft() {
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();
    const phase = draftPhase(round, rounds);
    document.getElementById("phase-banner").innerHTML = `<strong>R${Math.min(round, rounds)} — ${phase.label}.</strong> ${phase.text}`;

    document.getElementById("nudges").innerHTML = generateNudges().map(
      (n) => `<div class="banner ${n.level} tight">${n.text}</div>`
    ).join("");

    const seq = myPickSequence();
    const overall = currentOverall();
    const nextMine = findNextMine(seq, overall);
    document.getElementById("pick-list").innerHTML = seq.map((s) => {
      const cls = s.overall < overall ? "done" : s.overall === nextMine ? "next" : "";
      return `<span class="chip ${cls}">R${s.round} &middot; #${s.overall}</span>`;
    }).join("");

    document.getElementById("roster-board").innerHTML = computeMyRoster().map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const cls = pl ? "filled" : round >= rounds - 3 ? "urgent" : "";
      return `<div class="roster-slot ${cls}"><div class="roster-slot__type">${s.type}</div><div class="roster-slot__name">${pl ? Util.escapeHtml(pl.name) : "Open"}</div></div>`;
    }).join("");
  }

  function renderAuctionTab() {
    const spent = state.picks.filter((p) => p.owner === "me" && p.paid).reduce((a, p) => a + p.paid, 0);
    const budget = state.settings.auctionBudget;
    const remaining = budget - spent;
    const mySlots = computeMyRoster();
    const filled = mySlots.filter((s) => s.playerId).length;
    const slotsLeft = Math.max(1, mySlots.length - filled);
    const maxBid = Math.max(1, remaining - (slotsLeft - 1));
    document.getElementById("auction-stats").innerHTML =
      statCard("Budget", "$" + budget) +
      statCard("Spent", "$" + spent) +
      statCard("Remaining", "$" + remaining, "warn") +
      statCard("Max sensible bid", "$" + maxBid);
  }

  const STRATEGY_HTML = `
    <article>
      <h2>Round by round</h2>
      <p>Think of a draft in four phases, not twelve or sixteen individual picks. <strong>Foundation (rounds 1&ndash;3):</strong>
        take the best RB/WR/TE on your board &mdash; pure talent and volume, no position requirement.
        <strong>Build (rounds 4&ndash;8):</strong> lock starters, including your QB1 if you waited.
        <strong>Depth &amp; bench (rounds 9 to about four-from-the-end):</strong> handcuffs with real standalone
        value, a TE2 if your TE1 is boom/bust, high-upside bench pieces. <strong>Lottery tickets (final rounds):</strong>
        rookie stashes, comeback bets, and only then your DST/K.</p>
      <div class="pullquote">The single biggest mistake in fantasy drafts isn't one bad pick &mdash; it's panicking
        into position runs that were never yours to chase.</div>

      <h2>Don't draft a QB in round 1 (or usually before round 6)</h2>
      <p>In a 1-QB league, the position is absurdly deep. A dozen-plus quarterbacks finish as viable weekly starters,
        and several of them (Goff, Purdy, Lawrence, Herbert-type profiles) are available five or six rounds after
        the "elite" tier goes off the board. Spending a top-24 pick on a QB means passing on a bell-cow RB or true
        WR1 for positional value you could have had at half the cost. The math only flips in
        <strong>superflex/2-QB</strong> leagues, where QBs become legitimately scarce and early investment is correct.</p>

      <h2>Hero RB, Zero RB, or balanced?</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Build</th><th>Idea</th><th>Best case</th><th>Worst case</th></tr></thead>
          <tbody>
            <tr><td>Hero RB</td><td>One elite bell-cow early, then pivot hard to WR/TE for several rounds</td>
              <td>True RB1 production without punting the receiver corps</td>
              <td>Your one RB gets hurt and you're replacing a foundation piece, not a luxury</td></tr>
            <tr><td>Zero RB</td><td>Ignore RB early, stack elite WRs, mine RB value from rounds 8&ndash;13</td>
              <td>WRs are more likely to hold their draft-day value than RBs &mdash; you bank stability</td>
              <td>If your late-round RB bets whiff, you're starting waiver-wire backs at your flex all year</td></tr>
            <tr><td>Balanced / BPA</td><td>Fill RB and WR need as value dictates, no fixed plan</td>
              <td>Simple, adapts to how the room actually drafts</td>
              <td>No plan means no edge &mdash; you can drift into thin at both spots</td></tr>
          </tbody>
        </table>
      </div>
      <p>None of these is "correct" in the abstract &mdash; they're responses to how RBs get hurt and lose touches
        more than WRs do. Pick a lane based on what falls to you in rounds 1&ndash;2, don't force it.</p>

      <h2>Avoiding the sexy pick</h2>
      <p>ADP is a popularity contest as much as a talent ranking. A player's draft position often reflects
        <em>last year's</em> highlight reel more than this year's actual opportunity &mdash; rookies with a hot
        preseason, a name you recognize from a big game, a "buy low" narrative that's really just hope. The fix
        isn't to avoid these players entirely; it's to price them at their tier, not their name.</p>
      <div class="card">
        <p style="margin:0;"><strong>Watch for the flag:</strong> players tagged <span class="badge negative">&#9888; sexy pick</span>
          on the board carry real name-value but a track record of hype outrunning production &mdash; boom/bust
          rookies off one big preseason, or aging stars whose role has quietly shrunk. Draft them where their tier
          says to, not where the buzz says to.</p>
      </div>

      <h2>Roster construction rules that hold up</h2>
      <p>Don't handcuff your own RB1 in the double-digit rounds &mdash; a backup with no standalone value is a
        wasted pick nine times out of ten; spend that pick on a player who helps you even if nothing changes
        upstairs. Reinforce WR depth all draft: when a starting WR gets hurt, the vacated targets usually scatter
        across two or three teammates rather than consolidating into one obvious must-add, so bench WR depth
        matters more than bench RB depth. And build a roster that survives losing your best player for a month,
        not a roster that only wins if everything breaks right.</p>

      <h2>In-draft discipline</h2>
      <p>Value relative to ADP beats need on paper &mdash; but need wins ties. If two players grade out equally on
        your board and one fills an empty starting spot, take that one. And when three of the same position leave
        the board in five picks, don't assume you have to follow: check whether the run is actually about to reach
        your tier, or whether it's early panic from teams two picks ahead of the value cliff.</p>
    </article>
    <aside class="card">
      <h3>Quick reference</h3>
      <ul>
        <li>QB before round 6 in 1-QB leagues: almost never worth it.</li>
        <li>One elite RB early beats zero elite RBs &mdash; but two isn't automatically better than one plus a stacked WR corps.</li>
        <li>Handcuffs: skip unless the backup has standalone value.</li>
        <li>DST/K: last two picks, always. Stream DST off matchups all season.</li>
        <li>A "sexy pick" flag means check the tier before you reach, not skip the player.</li>
      </ul>
    </aside>
  `;

  const AUCTION_ARTICLE_HTML = `
    <article style="max-width:66ch;">
      <h2>Auction strategy, short version</h2>
      <p><strong>Stars &amp; scrubs</strong> vs <strong>balanced</strong> is the real fork in the road.
        Stars-and-scrubs spends 60%+ of your budget on two or three elite players and fills the rest with $1
        flyers; balanced spreads $15&ndash;30 across six or seven solid starters. Balanced is more forgiving of one
        bad pick; stars-and-scrubs has a higher ceiling but one bust tanks your team.</p>
      <p><strong>Nominate players you don't want.</strong> Throwing out a name you have no interest in, early,
        drains other teams' budgets on someone who isn't going to help you. Save your actual targets for the
        middle third of the auction, once budgets are already dented.</p>
      <p><strong>Price enforcement.</strong> If a player is going for less than they're worth, bid it up even if
        you don't plan to buy &mdash; it forces the eventual buyer to spend more of their budget, which helps you
        later. Stop before the price you'd actually pay.</p>
      <p><strong>The $1 reserve rule.</strong> Never let your remaining budget dip below $1 per remaining roster
        slot. The Max sensible bid tile above already backs that reserve out for you.</p>
    </article>
  `;

  function render() {
    renderScoreboard();
    renderSettingsForm();
    renderRosterList();
    renderRunTracker();
    renderPosFilter();
    renderBoard();
    renderMyDraft();
    renderAuctionTab();
    document.getElementById("strategy-layout").innerHTML = STRATEGY_HTML;
    document.getElementById("auction-article").innerHTML = AUCTION_ARTICLE_HTML;
    save();
  }

  /* ---------------- actions ---------------- */

  function draftPlayer(id, owner, paid) {
    if (isDrafted(id)) return;
    state.picks.push({ overall: currentOverall(), playerId: id, owner, paid: paid || null });
    render();
  }

  function undoLast() {
    if (state.picks.length === 0) return;
    state.picks.pop();
    render();
  }

  document.getElementById("board-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === "mine") draftPlayer(id, "me");
    else if (act === "gone") draftPlayer(id, "other");
    else if (act === "mine-auction") {
      const input = document.querySelector(`input[data-bidfor="${id}"]`);
      const amt = Math.max(1, parseInt(input && input.value, 10) || 1);
      draftPlayer(id, "me", amt);
    }
  });

  document.getElementById("pos-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]");
    if (!b) return;
    state.ui.posFilter = b.dataset.pos;
    renderPosFilter();
    renderBoard();
    save();
  });

  document.getElementById("search-box").addEventListener("input", (e) => {
    state.ui.search = e.target.value;
    renderBoard();
    save();
  });

  document.getElementById("hide-drafted").addEventListener("change", (e) => {
    state.ui.hideDrafted = e.target.checked;
    renderBoard();
    save();
  });

  document.getElementById("draft-type-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.settings.draftType = b.dataset.type;
    renderSettingsForm();
    renderBoard();
    save();
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const teams = parseInt(document.getElementById("cfg-teams").value, 10) || 12;
    let slot = parseInt(document.getElementById("cfg-slot").value, 10) || 1;
    if (slot > teams) slot = teams;
    state.settings.teams = teams;
    state.settings.mySlot = slot;
    state.settings.scoring = document.getElementById("cfg-scoring").value;
    state.settings.auctionBudget = parseInt(document.getElementById("cfg-budget").value, 10) || 200;
    document.querySelectorAll("#roster-inputs input").forEach((inp) => {
      state.settings.roster[inp.dataset.rk] = parseInt(inp.value, 10) || 0;
    });
    render();
  });

  document.getElementById("btn-reset-draft").addEventListener("click", () => {
    state.picks = [];
    render();
  });

  let fullResetArmed = false;
  const fullResetBtn = document.getElementById("btn-full-reset");
  fullResetBtn.addEventListener("click", () => {
    if (!fullResetArmed) {
      fullResetArmed = true;
      fullResetBtn.textContent = "Click again to confirm";
      setTimeout(() => { fullResetArmed = false; fullResetBtn.textContent = "Factory reset"; }, 4000);
      return;
    }
    state = defaultState();
    fullResetArmed = false;
    fullResetBtn.textContent = "Factory reset";
    render();
  });

  function parseCsv(text) {
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((parts) => parts.length >= 3 && parts[0] && parts[0].toLowerCase() !== "name")
      .map((parts) => ({
        id: slugify(parts[0] + "-" + (parts[2] || "") + "-" + (parts[1] || "")),
        name: parts[0],
        pos: (parts[1] || "").toUpperCase(),
        team: parts[2] || "",
        tier: parseInt(parts[3], 10) || 9,
        flags: parts[4] ? parts[4].split("|").map((s) => s.trim()).filter(Boolean) : [],
      }));
  }

  document.getElementById("btn-import").addEventListener("click", () => {
    const text = document.getElementById("import-box").value;
    const players = parseCsv(text);
    if (players.length === 0) return;
    state.players = players;
    render();
  });

  function currentBoardCsv() {
    const rows = ["name,pos,team,tier,flags,status,owner,paid"];
    state.players.forEach((p) => {
      const pk = pickFor(p.id);
      rows.push([p.name, p.pos, p.team, p.tier, p.flags.join("|"), pk ? "drafted" : "available", pk ? pk.owner : "", pk && pk.paid ? pk.paid : ""].join(","));
    });
    return rows.join("\n");
  }

  document.getElementById("btn-export-download").addEventListener("click", () => {
    const blob = new Blob([currentBoardCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft-board.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btn-export-show").addEventListener("click", () => {
    const box = document.getElementById("import-box");
    box.value = currentBoardCsv();
    box.focus();
    box.select();
  });

  document.getElementById("tab-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tab-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    ["board", "mydraft", "strategy", "auction"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === b.dataset.tab ? "" : "none";
    });
    state.ui.activeTab = b.dataset.tab;
    const p = new URLSearchParams(location.search);
    p.set("tab", b.dataset.tab);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    save();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undoLast();
    }
  });

  /* ---------------- init ---------------- */
  const initialTab = new URLSearchParams(location.search).get("tab") || state.ui.activeTab || "board";
  const initialBtn = document.querySelector(`#tab-toggle button[data-tab="${initialTab}"]`);
  if (initialBtn) initialBtn.click();

  render();
})();
