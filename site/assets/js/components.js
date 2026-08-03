/**
 * Shared header/footer, implemented as native Web Components (no build step,
 * no framework). Each page includes <site-header active="teams"></site-header>
 * and <site-footer></site-footer> once; markup and nav-highlighting logic
 * lives here so every page stays in sync automatically.
 */

const NAV_LINKS = [
  { key: "home", label: "Home", href: "index.html" },
  { key: "teams", label: "Teams", href: "teams.html" },
  { key: "players", label: "Players", href: "players.html" },
  { key: "games", label: "Games", href: "games.html" },
  { key: "picks", label: "Model Picks", href: "picks.html" },
  { key: "trends", label: "Trends", href: "trends.html" },
];

class SiteHeader extends HTMLElement {
  connectedCallback() {
    const active = this.getAttribute("active") || "";
    const navHtml = NAV_LINKS.map(
      (link) => `<a href="${link.href}"${link.key === active ? ' aria-current="page"' : ""}>${link.label}</a>`
    ).join("");

    this.innerHTML = `
      <div class="site-header__bar">
        <a href="index.html" class="site-header__brand" style="text-decoration:none;">
          NFL<span>Model</span>
        </a>
        <nav class="site-header__nav" aria-label="Main navigation">
          ${navHtml}
        </nav>
      </div>
    `;
  }
}

class SiteFooter extends HTMLElement {
  connectedCallback() {
    const year = new Date().getFullYear();
    this.innerHTML = `
      <div class="site-footer__bar">
        <div>&copy; ${year} &middot; Personal handicapping model &middot; not for public distribution</div>
        <div class="site-footer__links">
          <a href="picks.html">Model picks</a>
          <a href="games.html">Games</a>
          <a href="teams.html">Teams</a>
          <a href="players.html">Players</a>
          <a href="trends.html">Trends</a>
        </div>
      </div>
    `;
  }
}

customElements.define("site-header", SiteHeader);
customElements.define("site-footer", SiteFooter);
