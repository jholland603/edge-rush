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
})();
