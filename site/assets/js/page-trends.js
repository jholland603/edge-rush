(async function () {
  const homeDogsWrap = document.getElementById("home-dogs-wrap");
  const restEdgeWrap = document.getElementById("rest-edge-wrap");
  const divisionalWrap = document.getElementById("divisional-wrap");

  function renderHomeDogs(rows) {
    if (!rows.length) {
      Util.showEmpty(homeDogsWrap, "No data.");
      return;
    }
    const body = rows
      .map(
        (r) => `
        <tr>
          <td>${Util.escapeHtml(r.bucket)}</td>
          <td class="num">${r.n}</td>
          <td class="num">${r.home_covers}</td>
          <td class="num">${r.away_covers}</td>
          <td class="num">${r.pushes}</td>
          <td class="num">${r.home_cover_pct === null ? "-" : `${r.home_cover_pct}%`}</td>
        </tr>`
      )
      .join("");
    homeDogsWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Bucket</th><th class="num">Games</th><th class="num">Home Covers</th>
            <th class="num">Away Covers</th><th class="num">Pushes</th><th class="num">Home Cover %</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function renderRestEdge(rows) {
    if (!rows.length) {
      Util.showEmpty(restEdgeWrap, "No data.");
      return;
    }
    const body = rows
      .map(
        (r) => `
        <tr>
          <td>${Util.escapeHtml(r.bucket)}</td>
          <td class="num">${r.n}</td>
          <td class="num">${r.home_covers}</td>
          <td class="num">${r.away_covers}</td>
          <td class="num">${r.home_cover_pct === null ? "-" : `${r.home_cover_pct}%`}</td>
        </tr>`
      )
      .join("");
    restEdgeWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Bucket</th><th class="num">Games</th><th class="num">Home Covers</th>
            <th class="num">Away Covers</th><th class="num">Home Cover %</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function renderDivisional(rows) {
    if (!rows.length) {
      Util.showEmpty(divisionalWrap, "No data.");
      return;
    }
    const body = rows
      .map(
        (r) => `
        <tr>
          <td>${Util.escapeHtml(r.bucket)}</td>
          <td class="num">${r.n}</td>
          <td class="num">${r.home_cover_pct === null ? "-" : `${r.home_cover_pct}%`}</td>
          <td class="num">${Util.signed(r.avg_ou_margin, 2)}</td>
          <td class="num">${r.overs}</td>
          <td class="num">${r.unders}</td>
        </tr>`
      )
      .join("");
    divisionalWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Bucket</th><th class="num">Games</th><th class="num">Home Cover %</th>
            <th class="num">Avg O/U Margin</th><th class="num">Overs</th><th class="num">Unders</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  try {
    const trends = await Data.getTrends();
    renderHomeDogs(trends.home_dogs_by_size || []);
    renderRestEdge(trends.rest_edge || []);
    renderDivisional(trends.divisional || []);
  } catch (err) {
    Util.showError(homeDogsWrap, err);
    Util.showError(restEdgeWrap, err);
    Util.showError(divisionalWrap, err);
  }

  // ---------------------------------------------------------------------
  // Build-your-own-query section -- free-form ATS backtest against
  // /trends/query. Renders a one-row result summary (n / covers /
  // non-covers / pushes / cover %) plus a plain-English restatement of the
  // filters that were actually applied, and flags small samples the same
  // way the project's own "be skeptical of good results" rule would --
  // a handful of games proves nothing, thousands is worth a look.
  // ---------------------------------------------------------------------
  const queryForm = document.getElementById("query-form");
  const queryResultWrap = document.getElementById("query-result-wrap");

  const MONTH_NAMES = {
    1: "January", 2: "February", 9: "September", 10: "October", 11: "November", 12: "December",
  };

  function describeFilters(f) {
    const parts = [];
    parts.push(f.role === "any" ? "Home or away teams" : `${f.role === "home" ? "Home" : "Away"} teams`);
    if (f.side !== "any") parts.push(f.side === "favorite" ? "as favorites" : "as underdogs");
    if (f.min_points !== null || f.max_points !== null) {
      if (f.min_points !== null && f.max_points !== null) parts.push(`getting/giving ${f.min_points}-${f.max_points} pts`);
      else if (f.min_points !== null) parts.push(`by at least ${f.min_points} pts`);
      else parts.push(`by at most ${f.max_points} pts`);
    }
    if (f.divisional !== "any") parts.push(f.divisional === "yes" ? "in divisional games" : "in non-divisional games");
    if (f.month !== null) parts.push(`in ${MONTH_NAMES[f.month] || f.month}`);
    if (f.prior_result !== "any") {
      const marginPart = f.prior_min_margin ? ` by ${f.prior_min_margin}+ pts` : "";
      parts.push(`coming off a ${f.prior_result}${marginPart}`);
    }
    parts.push(`${f.season_from}–${f.season_to}`);
    return parts.join(", ");
  }

  function renderQueryResult(result) {
    const small = result.n > 0 && result.n < 100;
    queryResultWrap.innerHTML = `
      <p class="text-faint">${Util.escapeHtml(describeFilters(result.filters))}</p>
      <table>
        <thead>
          <tr>
            <th class="num">Games (n)</th><th class="num">Covers</th><th class="num">Non-covers</th>
            <th class="num">Pushes</th><th class="num">Cover %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="num">${result.n}</td>
            <td class="num">${result.covers}</td>
            <td class="num">${result.non_covers}</td>
            <td class="num">${result.pushes}</td>
            <td class="num">${result.cover_pct === null ? "-" : `${result.cover_pct}%`}</td>
          </tr>
        </tbody>
      </table>
      ${
        result.n === 0
          ? `<p class="text-faint">No games matched these filters.</p>`
          : small
          ? `<p class="text-faint">Only ${result.n} games match &mdash; too small a sample to draw a conclusion from (the project's own rule of thumb: results from a handful of games are noise, not signal).</p>`
          : `<p class="text-faint">Breakeven at standard -110 odds is ~52.4% cover rate.</p>`
      }
    `;
  }

  queryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    queryResultWrap.innerHTML = `<div class="loading">Loading&hellip;</div>`;
    const filters = {
      role: document.getElementById("q-role").value,
      side: document.getElementById("q-side").value,
      min_points: document.getElementById("q-min-points").value,
      max_points: document.getElementById("q-max-points").value,
      divisional: document.getElementById("q-divisional").value,
      month: document.getElementById("q-month").value,
      season_from: document.getElementById("q-season-from").value,
      season_to: document.getElementById("q-season-to").value,
      prior_result: document.getElementById("q-prior-result").value,
      prior_min_margin: document.getElementById("q-prior-margin").value,
    };
    try {
      const result = await Data.getTrendsQuery(filters);
      renderQueryResult(result);
    } catch (err) {
      Util.showError(queryResultWrap, err);
    }
  });
})();
