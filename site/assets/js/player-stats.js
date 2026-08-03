/**
 * Shared player-stat domain logic: position grouping, which stats to show
 * per group, and derived stats (passer rating, FG%, etc.) that aren't
 * directly in the source data. Used by both the player detail page and the
 * player comparison page so the two never drift out of sync.
 */

// The source data (nflverse's stats_player_week) tracks specific positions
// (DE, OLB, CB, FS, ...), not the broader group. Map down to a group so we
// can pick one sensible stat layout per group instead of dozens of cases.
const POSITION_TO_GROUP = {
  QB: "QB",
  RB: "RB", FB: "RB",
  WR: "WR",
  TE: "TE",
  OT: "OL", OG: "OL", T: "OL", G: "OL", C: "OL", OL: "OL",
  DE: "DL", DT: "DL", NT: "DL", DL: "DL",
  OLB: "LB", ILB: "LB", MLB: "LB", LB: "LB",
  CB: "DB", S: "DB", FS: "DB", SS: "DB", SAF: "DB", DB: "DB", NB: "DB",
  K: "K",
  P: "P",
  LS: "LS",
};
function groupFor(position) {
  return POSITION_TO_GROUP[position] || "OTHER";
}

// NFL passer rating. Not present in the source data -- derived here from
// completions/attempts/yards/TDs/INTs, which works identically whether fed
// a single game's numbers or career totals (that's how "career passer
// rating" is officially computed too: from aggregate totals, not an
// average of per-game ratings).
function passerRating(cmp, att, yds, td, int) {
  if (!att) return null;
  const clamp = (v) => Math.max(0, Math.min(2.375, v));
  const a = clamp((cmp / att - 0.3) * 5);
  const b = clamp((yds / att - 3) * 0.25);
  const c = clamp((td / att) * 20);
  const d = clamp(2.375 - (int / att) * 25);
  return ((a + b + c + d) / 6) * 100;
}

// ---- career total stat cards, per position group ----
// {key} pulls straight from career_totals; {compute} derives a value (e.g.
// FG% -- the source data's own fg_pct field is a naive sum-of-percentages
// across games, not a real career rate, so it's computed correctly here).
const CAREER_STAT_GROUPS = {
  QB: [
    { key: "attempts", label: "Attempts" },
    { key: "completions", label: "Completions" },
    { compute: (t) => (t.attempts ? (100 * t.completions) / t.attempts : null), label: "Cmp %", decimals: 1 },
    { key: "passing_yards", label: "Pass Yds" },
    { compute: (t) => (t.attempts ? t.passing_yards / t.attempts : null), label: "Yds/Att", decimals: 1 },
    { key: "passing_tds", label: "Pass TD" },
    { key: "passing_interceptions", label: "INT" },
    { key: "sacks_suffered", label: "Sacks Taken" },
    { compute: (t) => passerRating(t.completions, t.attempts, t.passing_yards, t.passing_tds, t.passing_interceptions), label: "Passer Rating", decimals: 1 },
    { key: "passing_epa", label: "Pass EPA", signed: true, decimals: 1 },
    { key: "rushing_yards", label: "Rush Yds" },
    { key: "rushing_tds", label: "Rush TD" },
  ],
  RB: [
    { key: "carries", label: "Carries" },
    { key: "rushing_yards", label: "Rush Yds" },
    { compute: (t) => (t.carries ? t.rushing_yards / t.carries : null), label: "Yds/Carry", decimals: 1 },
    { key: "rushing_tds", label: "Rush TD" },
    { key: "receptions", label: "Rec" },
    { key: "receiving_yards", label: "Rec Yds" },
    { key: "receiving_tds", label: "Rec TD" },
    { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
  ],
  WR: [
    { key: "receptions", label: "Rec" },
    { key: "targets", label: "Targets" },
    { compute: (t) => (t.targets ? (100 * t.receptions) / t.targets : null), label: "Catch %", decimals: 1 },
    { key: "receiving_yards", label: "Rec Yds" },
    { compute: (t) => (t.receptions ? t.receiving_yards / t.receptions : null), label: "Yds/Rec", decimals: 1 },
    { key: "receiving_tds", label: "Rec TD" },
    { key: "rushing_yards", label: "Rush Yds" },
    { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
  ],
  TE: [
    { key: "receptions", label: "Rec" },
    { key: "targets", label: "Targets" },
    { compute: (t) => (t.targets ? (100 * t.receptions) / t.targets : null), label: "Catch %", decimals: 1 },
    { key: "receiving_yards", label: "Rec Yds" },
    { compute: (t) => (t.receptions ? t.receiving_yards / t.receptions : null), label: "Yds/Rec", decimals: 1 },
    { key: "receiving_tds", label: "Rec TD" },
    { key: "fantasy_points_ppr", label: "Fantasy Pts (PPR)", decimals: 1 },
  ],
  DL: [
    { key: "def_sacks", label: "Sacks", decimals: 1 },
    { key: "def_tackles_solo", label: "Solo Tackles" },
    { key: "def_tackles_for_loss", label: "TFL" },
    { key: "def_qb_hits", label: "QB Hits" },
    { key: "def_fumbles_forced", label: "Forced Fumbles" },
  ],
  LB: [
    { key: "def_tackles_solo", label: "Solo Tackles" },
    { key: "def_tackle_assists", label: "Assisted Tackles" },
    { key: "def_sacks", label: "Sacks", decimals: 1 },
    { key: "def_interceptions", label: "INT" },
    { key: "def_pass_defended", label: "Passes Defended" },
  ],
  DB: [
    { key: "def_interceptions", label: "INT" },
    { key: "def_pass_defended", label: "Passes Defended" },
    { key: "def_tackles_solo", label: "Solo Tackles" },
    { key: "def_tds", label: "Def TD" },
    { key: "def_fumbles_forced", label: "Forced Fumbles" },
  ],
  K: [
    { key: "fg_made", label: "FG Made" },
    { key: "fg_att", label: "FG Att" },
    { compute: (t) => (t.fg_att ? (100 * t.fg_made) / t.fg_att : null), label: "FG %", decimals: 1 },
    { key: "pat_made", label: "XP Made" },
    { key: "gwfg_made", label: "Game-Winning FGs" },
  ],
  P: [
    { key: "pt_att", label: "Punts" },
    { key: "pt_yards", label: "Punt Yards" },
    { compute: (t) => (t.pt_att ? t.pt_net_yards / t.pt_att : null), label: "Net Avg", decimals: 1 },
    { key: "pt_inside_20", label: "Inside 20" },
  ],
};

function statCardValue(totals, spec) {
  const raw = spec.compute ? spec.compute(totals) : totals[spec.key];
  if (raw === undefined || raw === null || Number.isNaN(raw)) return null;
  if (spec.signed) return Util.signed(raw, spec.decimals ?? 1);
  if (spec.decimals) return Number(raw).toFixed(spec.decimals);
  return Math.round(raw).toLocaleString();
}

// ---- weekly season-log table columns, per position group ----
const OFFENSE_WEEK_COLUMNS = [
  { label: "Cmp/Att", render: (w) => `${w.completions ?? 0}/${w.attempts ?? 0}` },
  { label: "Pass Yds", render: (w) => w.passing_yards ?? 0 },
  { label: "Pass TD", render: (w) => w.passing_tds ?? 0 },
  { label: "INT", render: (w) => w.passing_interceptions ?? 0 },
  { label: "Car", render: (w) => w.carries ?? 0 },
  { label: "Rush Yds", render: (w) => w.rushing_yards ?? 0 },
  { label: "Y/C", render: (w) => Util.num(w.carries ? w.rushing_yards / w.carries : null, 1) },
  { label: "Rush TD", render: (w) => w.rushing_tds ?? 0 },
  { label: "Rec/Tgt", render: (w) => `${w.receptions ?? 0}/${w.targets ?? 0}` },
  { label: "Rec Yds", render: (w) => w.receiving_yards ?? 0 },
  { label: "Y/R", render: (w) => Util.num(w.receptions ? w.receiving_yards / w.receptions : null, 1) },
  { label: "Rec TD", render: (w) => w.receiving_tds ?? 0 },
  { label: "Fantasy (PPR)", render: (w) => Util.num(w.fantasy_points_ppr, 1) },
];
const QB_WEEK_COLUMNS = [
  { label: "Cmp/Att", render: (w) => `${w.completions ?? 0}/${w.attempts ?? 0}` },
  { label: "Pass Yds", render: (w) => w.passing_yards ?? 0 },
  { label: "Y/A", render: (w) => Util.num(w.attempts ? w.passing_yards / w.attempts : null, 1) },
  { label: "Pass TD", render: (w) => w.passing_tds ?? 0 },
  { label: "INT", render: (w) => w.passing_interceptions ?? 0 },
  { label: "Sacks", render: (w) => w.sacks_suffered ?? 0 },
  { label: "Rating", render: (w) => Util.num(passerRating(w.completions, w.attempts, w.passing_yards, w.passing_tds, w.passing_interceptions), 1) },
  { label: "Rush Yds", render: (w) => w.rushing_yards ?? 0 },
  { label: "Rush TD", render: (w) => w.rushing_tds ?? 0 },
  { label: "Fantasy (PPR)", render: (w) => Util.num(w.fantasy_points_ppr, 1) },
];
const WEEK_COLUMNS = {
  QB: QB_WEEK_COLUMNS,
  RB: OFFENSE_WEEK_COLUMNS,
  WR: OFFENSE_WEEK_COLUMNS,
  TE: OFFENSE_WEEK_COLUMNS,
  DL: [
    { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
    { label: "TFL", render: (w) => w.def_tackles_for_loss ?? 0 },
    { label: "Sacks", render: (w) => Util.num(w.def_sacks, 1) },
    { label: "QB Hits", render: (w) => w.def_qb_hits ?? 0 },
    { label: "FF", render: (w) => w.def_fumbles_forced ?? 0 },
  ],
  LB: [
    { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
    { label: "Sacks", render: (w) => Util.num(w.def_sacks, 1) },
    { label: "INT", render: (w) => w.def_interceptions ?? 0 },
    { label: "PD", render: (w) => w.def_pass_defended ?? 0 },
  ],
  DB: [
    { label: "INT", render: (w) => w.def_interceptions ?? 0 },
    { label: "PD", render: (w) => w.def_pass_defended ?? 0 },
    { label: "Tackles (Ast)", render: (w) => `${w.def_tackles_solo ?? 0} (${w.def_tackle_assists ?? 0})` },
    { label: "Def TD", render: (w) => w.def_tds ?? 0 },
  ],
  K: [
    { label: "FG", render: (w) => `${w.fg_made ?? 0}/${w.fg_att ?? 0}` },
    { label: "Long", render: (w) => w.fg_long ?? "-" },
    { label: "XP", render: (w) => `${w.pat_made ?? 0}/${w.pat_att ?? 0}` },
  ],
  P: [
    { label: "Punts", render: (w) => w.pt_att ?? 0 },
    { label: "Yards", render: (w) => w.pt_yards ?? 0 },
    { label: "Net Yds", render: (w) => w.pt_net_yards ?? 0 },
    { label: "In 20", render: (w) => w.pt_inside_20 ?? 0 },
    { label: "TB", render: (w) => w.pt_touchback ?? 0 },
  ],
};
const FALLBACK_WEEK_COLUMNS = [
  { label: "Penalties", render: (w) => w.penalties ?? 0 },
  { label: "Penalty Yds", render: (w) => w.penalty_yards ?? 0 },
];

window.PlayerStats = {
  groupFor,
  passerRating,
  CAREER_STAT_GROUPS,
  statCardValue,
  WEEK_COLUMNS,
  FALLBACK_WEEK_COLUMNS,
};
