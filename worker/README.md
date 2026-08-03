# edge-rush-api

Cloudflare Worker that serves the site's games/teams/players/compare pages
from the D1 database (`edge-rush`, id `b3234230-248f-49fa-bf7e-965ab93cea3a`)
instead of the static `data/*.json` tree. See `site/assets/js/data.js` for
what calls this, and `HANDOFF.md` for the full backstory.

Not covered: `model/*.json` and `log/picks_log.json` (Phase 2/3 data --
predictions and the picks log were never migrated into D1). The home page and
picks page still read those static files directly.

## Deploy

One-time setup (skip if you already did this for the D1 import):

```powershell
npm install -g wrangler
wrangler login
```

Deploy the worker:

```powershell
cd C:\Users\jeffr\Documents\edge-rush\worker
wrangler deploy
```

Wrangler will print a URL that looks like:

```
https://edge-rush-api.<your-subdomain>.workers.dev
```

Copy that URL into `site/assets/js/data.js` -- replace the placeholder in:

```js
const API_BASE = "https://edge-rush-api.YOUR-SUBDOMAIN.workers.dev";
```

Then commit/push the site as usual for GitHub Pages to pick it up.

## Re-deploying after a code change

Same command, no flags needed:

```powershell
cd C:\Users\jeffr\Documents\edge-rush\worker
wrangler deploy
```

The URL doesn't change between deploys, so `data.js` doesn't need updating
again unless you rename the worker (`name` in `wrangler.toml`).

## Testing it directly

Once deployed, sanity-check a few routes straight in the browser or via curl:

```
https://edge-rush-api.<your-subdomain>.workers.dev/
https://edge-rush-api.<your-subdomain>.workers.dev/index
https://edge-rush-api.<your-subdomain>.workers.dev/games/2024
https://edge-rush-api.<your-subdomain>.workers.dev/players/career/00-0033873
https://edge-rush-api.<your-subdomain>.workers.dev/players/career/00-0033873?from=2020&to=2022
```

`/index` is the biggest response (every player in the dimension table, ~11k
entries) -- expect it to take noticeably longer than the others.

## CORS

Wide open (`Access-Control-Allow-Origin: *`). This only ever serves public,
read-only NFL stats with no auth and no per-user data, so there's nothing
sensitive to restrict access to. If that ever changes, lock it down in
`src/index.js` (`CORS_HEADERS`).

## Local dev

```powershell
cd C:\Users\jeffr\Documents\edge-rush\worker
wrangler dev --remote
```

`--remote` is important -- without it, `wrangler dev` binds to a local
throwaway D1 copy, not the real database (same gotcha as the D1 import
scripts).
