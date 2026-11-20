// Token Launch Radar — the model (radar-ember-3).
//
// One sealed DefiLlama snapshot in, one ranked board of pre-token protocols out.
//
// The board covers every slug on the snapshot's watchlist (the floor, never the ceiling) and adds
// every other pre-token protocol that passes the same product screen the house applied to the
// watchlist: a candidate records no token and is not an exchange, a bridge, a liquid (re)staking
// product, a versioned pool of another protocol, or a name carrying wrapped/staked/staking.
// Earlier editions of this board also set aside screen-passing protocols above the $50M floor
// that the watchlist did not name; this edition carries them — they record no token and pass the
// stated screen, so the board says so rather than silently dropping the largest finds.
//
// Implied value is FITTED, not hand-set. The snapshot's own traded protocols — the ones whose
// tokens already trade at a real (positive) market cap — are the training set, once the same
// product screen is applied to them. On those rows a ridge regression learns
//
//   log10(market cap) = intercept
//                     + b1 x z(log10 TVL)
//                     + b2 x z(asinh(7-day growth / 20))
//                     + b3 x z(log1p(age in years))
//                     + b4 x z(log2(chain count))
//                     + a shrunk effect per category,
//
// with continuous features standardised (z) on the training rows and one ridge penalty, picked
// by five-fold cross-validation from a fixed grid, on every coefficient but the intercept.
// A pre-token row's implied value is 10 raised to its fitted log10 market cap, and its P10–P90
// band is that estimate shifted by the 10th and 90th percentiles of the out-of-fold residuals:
// the range the fitted model actually missed by, on protocols whose true caps are known.
//
// The cross-validation also scores the previous edition's model (radar-ember-2: TVL x a
// category's median live multiple, shrunk toward the global median, x hand-set growth, maturity
// and reach factors) on the same folds, so the dashboard can state honestly what the fit buys:
// a far smaller typical error, at a rank correlation that is a wash within the noise of 88 rows.
// Every figure comes from the snapshot itself. No protocol name is ever special-cased; one
// function scores every row, and the dashboard shows each row's own fitted arithmetic.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'radar-ember-3';

/** Total ranked rows: the whole watchlist plus the strongest screened candidates beyond it. */
export const BOARD_ROWS = 240;

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The v2 baseline's constants, kept because the fit report scores that model on the same folds. */
export const MODEL = {
  multiple_floor: 0.05,
  multiple_cap: 3.0,
  min_peers: 3,
  shrink_prior: 3,
  growth_weight: 0.3,
  growth_floor: -40,
  growth_cap: 80,
  maturity_floor: 0.75,
  maturity_range: 0.25,
  maturity_days: 1460,
  unknown_age_days: 365,
  reach_per_chain: 0.02,
  reach_max_chains: 5,
};

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A small deterministic hash of a slug: fold assignment and stable wording variants. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

// ------------------------------------------------------------------ the v2 baseline model
//
// radar-ember-2, kept intact: the fit report scores it out-of-fold on the same folds and the
// dashboard shows its peer-multiple table as the baseline's evidence.

/** One category's live-peer evidence, as the dashboard's methodology panel states it. */
export interface PeerStat {
  category: string;
  peers: number;
  /** The multiple rows are scored with: the category median shrunk toward the global median. */
  multiple: number;
  /** The category's own median before shrinkage (equal to `multiple` on the global row). */
  raw_multiple: number;
  source: 'category' | 'global';
}

/** The peer multiples: one per category with enough live evidence, over one global fallback. */
export function peerMultiples(snapshot: Snapshot): { byCategory: Map<string, PeerStat>; global: PeerStat } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    if (p.category !== null) {
      const list = ratios.get(p.category) ?? [];
      list.push(ratio);
      ratios.set(p.category, list);
    }
  }
  const clamp = (v: number) => Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, v));
  const globalMedian = median(all);
  const global: PeerStat = { category: '(all categories)', peers: all.length, multiple: clamp(globalMedian), raw_multiple: clamp(globalMedian), source: 'global' };
  const byCategory = new Map<string, PeerStat>();
  for (const [category, list] of ratios) {
    if (list.length >= MODEL.min_peers) {
      const raw = median(list);
      // Shrinkage: a category's own median, pulled toward the global median by a prior of
      // shrink_prior phantom peers, so thin categories borrow strength from the whole market.
      const blended = (list.length * raw + MODEL.shrink_prior * globalMedian) / (list.length + MODEL.shrink_prior);
      byCategory.set(category, { category, peers: list.length, multiple: clamp(blended), raw_multiple: clamp(raw), source: 'category' });
    }
  }
  return { byCategory, global };
}

/** The multiple one protocol is scored with, and where it came from. */
export function multipleFor(p: SnapshotProtocol, peers: { byCategory: Map<string, PeerStat>; global: PeerStat }): PeerStat {
  if (p.category !== null) {
    const stat = peers.byCategory.get(p.category);
    if (stat !== undefined) return stat;
  }
  return peers.global;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitfinex|Gemini)\b/;

/**
 * The product screen, shared by the board and the fit's training set: not a wrapped, staked or
 * bridged product of a traded token, not an exchange, not a versioned pool of another protocol.
 * Cross Chain Bridge stands with the other bridge categories — a bridge by name and by product.
 */
export function passesProductScreen(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || PRODUCT_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/**
 * The early-candidate screen, mirroring the house's watchlist rule: pre-token and through the
 * product screen. The screen no longer sets a protocol aside for sitting above the floor.
 */
export function isEarlyCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  return passesProductScreen(p);
}

/** The four multipliers and the implied value one protocol gets under the v2 baseline. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  stat: PeerStat,
): { implied: number; base: number; growthMult: number; maturityMult: number; reachMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const reachMult = 1 + MODEL.reach_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.reach_max_chains);
  const base = p.tvl_usd * stat.multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * reachMult));
  return { implied, base, growthMult, maturityMult, reachMult, age };
}

// ------------------------------------------------------------------ the fitted model (v3)

/** The ridge penalties the cross-validation picks from, weakest to strongest. */
export const LAMBDA_GRID = [0.1, 0.3, 1, 3, 10, 30, 100, 300];

/** Cross-validation folds; a protocol's fold is slugHash(slug) % FIT_FOLDS — no randomness. */
export const FIT_FOLDS = 5;

/**
 * The fit's training set: the snapshot's traded protocols with a real market cap — the field is
 * present and positive (a 0 or -1 in it is a placeholder, not a price) — TVL above zero, through
 * the same product screen the board applies.
 */
export function trainingSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && passesProductScreen(p),
  );
}

/** The four continuous features, before standardisation, exactly as the methodology states them. */
function rawFeatures(p: SnapshotProtocol, asOf: string): [number, number, number, number] {
  const growthPct = Math.min(400, Math.max(-90, finite(p.change_7d, 0)));
  const age = ageDays(asOf, p.listed_at);
  const years = (age ?? MODEL.unknown_age_days) / 365.25;
  return [
    Math.log10(Math.max(p.tvl_usd, 1)),
    Math.asinh(growthPct / 20),
    Math.log1p(years),
    Math.log2(Math.max(1, p.chains.length)),
  ];
}

/** Training means and population standard deviations of the four continuous features. */
function featureStats(rows: SnapshotProtocol[], asOf: string): { mu: number[]; sd: number[] } {
  const raws = rows.map((p) => rawFeatures(p, asOf));
  const mu = [0, 1, 2, 3].map((j) => raws.reduce((s, r) => s + r[j]!, 0) / raws.length);
  const sd = [0, 1, 2, 3].map((j) => {
    const m = mu[j]!;
    const d = Math.sqrt(raws.reduce((s, r) => s + (r[j]! - m) ** 2, 0) / raws.length);
    return d === 0 ? 1 : d;
  });
  return { mu, sd };
}

/** One design row: intercept, the four standardised features, then one dummy per category. */
function designRow(p: SnapshotProtocol, asOf: string, cats: string[], mu: number[], sd: number[]): number[] {
  const f = rawFeatures(p, asOf);
  const row = [1, (f[0] - mu[0]!) / sd[0]!, (f[1] - mu[1]!) / sd[1]!, (f[2] - mu[2]!) / sd[2]!, (f[3] - mu[3]!) / sd[3]!];
  for (const c of cats) row.push(p.category === c ? 1 : 0);
  return row;
}

/** Solve a x = b by Gaussian elimination with partial pivoting. */
function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row, i) => [...row, bIn[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (piv !== col) {
      const t = a[col]!;
      a[col] = a[piv]!;
      a[piv] = t;
    }
    const d = a[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * x[c]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

/** Ridge fit: (X'X + lambda I) beta = X'y, the intercept's diagonal left unpenalised. */
function ridgeFit(x: number[][], y: number[], lambda: number): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    for (let j = 0; j < n; j++) {
      b[j] = b[j]! + row[j]! * y[i]!;
      for (let k = j; k < n; k++) a[j]![k] = a[j]![k]! + row[j]! * row[k]!;
    }
  }
  for (let j = 0; j < n; j++) for (let k = 0; k < j; k++) a[j]![k] = a[k]![j]!;
  for (let j = 1; j < n; j++) a[j]![j] = a[j]![j]! + lambda;
  return solveLinear(a, b);
}

/** Ranks with ties averaged, for Spearman's correlation. */
function ranksOf(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rank correlation between two equal-length series. */
function spearman(xs: number[], ys: number[]): number {
  const rx = ranksOf(xs);
  const ry = ranksOf(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length;
  const my = ry.reduce((s, v) => s + v, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

/** The q-th quantile of a sorted series, linearly interpolated (the type-7 rule). */
function quantileOf(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Out-of-fold accuracy of one model, in log10 space, as the dashboard states it. */
export interface CvMetrics {
  median_abs_log10: number;
  bias_log10: number;
  spearman: number;
  /** 10 to the median absolute error: the typical miss, as a multiple. */
  typical_factor: number;
}

function metricsOf(pred: number[], actual: number[]): CvMetrics {
  const errs = pred.map((v, i) => v - actual[i]!);
  const med = median(errs.map((e) => Math.abs(e)));
  return {
    median_abs_log10: med,
    bias_log10: errs.reduce((s, e) => s + e, 0) / errs.length,
    spearman: spearman(pred, actual),
    typical_factor: 10 ** med,
  };
}

/** One category's fitted effect: how the fit reprices it against the average traded protocol. */
export interface CategoryEffect {
  category: string;
  /** Traded protocols of this category in the training set. */
  peers: number;
  effect_log10: number;
  /** 10 to the effect: the multiplier the effect applies, all else equal. */
  effect_mult: number;
}

/** Everything the dashboard's Fit & validation panel states, computed at build time. */
export interface FitReport {
  training_count: number;
  /** Protocols carrying a market-cap field at all. */
  traded_listed: number;
  /** Of those, the ones carrying a real (positive) cap, before the product screen. */
  traded_real: number;
  folds: number;
  lambda: number;
  lambda_grid: number[];
  /** The fitted level for the average traded protocol with no category effect, in log10. */
  base_log10: number;
  base_usd: number;
  /** The TVL slope per log10 unit, and the multiple it gives a tenfold TVL difference. */
  tvl_slope_per_log10: number;
  tvl_mult_per_10x: number;
  /** What moving 7-day growth from 0% to +10% does to the estimate, as a multiple. */
  growth_mult_0_to_10pct: number;
  /** What being tracked 5 years rather than 1 does to the estimate, as a multiple. */
  age_mult_1_to_5yr: number;
  /** What each doubling of the chain count does to the estimate, as a multiple. */
  chains_mult_per_doubling: number;
  category_effects: CategoryEffect[];
  cv_fitted: CvMetrics;
  cv_baseline_v2: CvMetrics;
  resid_q10_log10: number;
  resid_q90_log10: number;
}

/** A fitted prediction for one protocol, split into the terms the detail view shows. */
export interface FittedPrediction {
  pred_log10: number;
  base_log10: number;
  term_tvl: number;
  term_growth: number;
  term_age: number;
  term_chains: number;
  term_category: number;
  /** The category's fitted effect, or null when the category has no traded peers in the fit. */
  category_effect: CategoryEffect | null;
}

/**
 * Fit the v3 model on the snapshot: cross-validate the ridge penalty, score the v2 baseline on
 * the same folds, fit on every training row, and return the report plus the scoring function.
 */
export function fitModel(snapshot: Snapshot): { report: FitReport; predict: (p: SnapshotProtocol) => FittedPrediction } {
  const asOf = snapshot.as_of;
  const train = trainingSet(snapshot);
  const cats = [...new Set(train.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  const y = train.map((p) => Math.log10(p.mcap_usd!));
  const foldOf = (slug: string) => slugHash(slug) % FIT_FOLDS;

  // Out-of-fold predictions for one penalty: each fold is scored by a fit on the other four,
  // standardised on those four — the row's own cap is never in its own fit.
  const oofFor = (lambda: number): number[] => {
    const pred = new Array<number>(train.length);
    for (let f = 0; f < FIT_FOLDS; f++) {
      const fitRows = train.filter((p) => foldOf(p.slug) !== f);
      const { mu, sd } = featureStats(fitRows, asOf);
      const beta = ridgeFit(
        fitRows.map((p) => designRow(p, asOf, cats, mu, sd)),
        fitRows.map((p) => Math.log10(p.mcap_usd!)),
        lambda,
      );
      train.forEach((p, i) => {
        if (foldOf(p.slug) !== f) return;
        const row = designRow(p, asOf, cats, mu, sd);
        pred[i] = row.reduce((s, v, j) => s + v * beta[j]!, 0);
      });
    }
    return pred;
  };

  // The penalty is the grid point with the lowest out-of-fold median absolute log10 error.
  let lambda = LAMBDA_GRID[0]!;
  let oof = oofFor(lambda);
  let bestMed = metricsOf(oof, y).median_abs_log10;
  for (const candidate of LAMBDA_GRID.slice(1)) {
    const candidateOof = oofFor(candidate);
    const med = metricsOf(candidateOof, y).median_abs_log10;
    if (med < bestMed) {
      bestMed = med;
      lambda = candidate;
      oof = candidateOof;
    }
  }
  const cvFitted = metricsOf(oof, y);
  const residuals = oof.map((v, i) => v - y[i]!).sort((a, b) => a - b);
  const residQ10 = quantileOf(residuals, 0.1);
  const residQ90 = quantileOf(residuals, 0.9);

  // The v2 baseline on the same folds: each fold's rows are scored by peer multiples learned
  // from every protocol outside the fold, exactly the evidence v2 uses in production.
  const baselinePred = new Array<number>(train.length);
  for (let f = 0; f < FIT_FOLDS; f++) {
    const outside: Snapshot = { ...snapshot, protocols: snapshot.protocols.filter((q) => foldOf(q.slug) !== f) };
    const peers = peerMultiples(outside);
    train.forEach((p, i) => {
      if (foldOf(p.slug) !== f) return;
      baselinePred[i] = Math.log10(Math.max(1, impliedValue(p, asOf, multipleFor(p, peers)).implied));
    });
  }
  const cvBaseline = metricsOf(baselinePred, y);

  // The shipped fit: every training row, at the cross-validated penalty.
  const { mu, sd } = featureStats(train, asOf);
  const beta = ridgeFit(
    train.map((p) => designRow(p, asOf, cats, mu, sd)),
    y,
    lambda,
  );
  const peerCount = new Map<string, number>();
  for (const p of train) if (p.category !== null) peerCount.set(p.category, (peerCount.get(p.category) ?? 0) + 1);
  const effects = new Map<string, CategoryEffect>();
  cats.forEach((c, i) => {
    const effect = beta[5 + i]!;
    effects.set(c, { category: c, peers: peerCount.get(c) ?? 0, effect_log10: effect, effect_mult: 10 ** effect });
  });

  const report: FitReport = {
    training_count: train.length,
    traded_listed: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    traded_real: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
    folds: FIT_FOLDS,
    lambda,
    lambda_grid: [...LAMBDA_GRID],
    base_log10: beta[0]!,
    base_usd: Math.round(10 ** beta[0]!),
    tvl_slope_per_log10: beta[1]! / sd[0]!,
    tvl_mult_per_10x: 10 ** (beta[1]! / sd[0]!),
    growth_mult_0_to_10pct: 10 ** ((beta[2]! / sd[1]!) * Math.asinh(0.5)),
    age_mult_1_to_5yr: 10 ** ((beta[3]! / sd[2]!) * (Math.log1p(5) - Math.log1p(1))),
    chains_mult_per_doubling: 10 ** (beta[4]! / sd[3]!),
    category_effects: [...effects.values()].sort((a, b) => b.effect_log10 - a.effect_log10),
    cv_fitted: cvFitted,
    cv_baseline_v2: cvBaseline,
    resid_q10_log10: residQ10,
    resid_q90_log10: residQ90,
  };

  const predict = (p: SnapshotProtocol): FittedPrediction => {
    const row = designRow(p, asOf, cats, mu, sd);
    const effect = p.category !== null ? (effects.get(p.category) ?? null) : null;
    return {
      pred_log10: row.reduce((s, v, j) => s + v * beta[j]!, 0),
      base_log10: beta[0]!,
      term_tvl: row[1]! * beta[1]!,
      term_growth: row[2]! * beta[2]!,
      term_age: row[3]! * beta[3]!,
      term_chains: row[4]! * beta[4]!,
      term_category: effect === null ? 0 : effect.effect_log10,
      category_effect: effect,
    };
  };
  return { report, predict };
}


/** Gas and effort character of a chain, for farm plans: cheap L2s and Solana versus Ethereum mainnet. `rank` orders chains by typical cost, cheapest first. */
const CHAIN_COST: Record<string, { gas: string; note: string; rank: number }> = {
  Ethereum: { gas: '$2–$15 in gas per transaction at typical fees', note: 'Ethereum mainnet', rank: 10 },
  Arbitrum: { gas: '$0.05–$0.30 in gas per transaction', note: 'Arbitrum One', rank: 3 },
  Base: { gas: '$0.02–$0.20 in gas per transaction', note: 'Base', rank: 2 },
  Optimism: { gas: '$0.05–$0.30 in gas per transaction', note: 'OP Mainnet', rank: 3 },
  Solana: { gas: 'under $0.05 in fees per transaction', note: 'Solana', rank: 1 },
  BSC: { gas: '$0.05–$0.30 in gas per transaction', note: 'BNB Chain', rank: 2 },
  Polygon: { gas: '$0.01–$0.10 in gas per transaction', note: 'Polygon', rank: 2 },
  Avalanche: { gas: '$0.05–$0.40 in gas per transaction', note: 'Avalanche C-Chain', rank: 3 },
  zkSync: { gas: '$0.05–$0.30 in gas per transaction', note: 'zkSync Era', rank: 3 },
  Linea: { gas: '$0.05–$0.30 in gas per transaction', note: 'Linea', rank: 3 },
  Scroll: { gas: '$0.05–$0.30 in gas per transaction', note: 'Scroll', rank: 3 },
  Mantle: { gas: '$0.02–$0.20 in gas per transaction', note: 'Mantle', rank: 2 },
  Blast: { gas: '$0.02–$0.20 in gas per transaction', note: 'Blast', rank: 2 },
  Sui: { gas: 'under $0.05 in fees per transaction', note: 'Sui', rank: 1 },
  Aptos: { gas: 'under $0.05 in fees per transaction', note: 'Aptos', rank: 1 },
  Bitcoin: { gas: '$0.50–$5 in miner fees per transaction', note: 'Bitcoin', rank: 8 },
};

function chainCost(chain: string): { gas: string; note: string; rank: number } {
  return CHAIN_COST[chain] ?? { gas: '$0.10–$1 in gas per transaction', note: chain, rank: 5 };
}

/** The cheapest of a protocol's chains to farm on, by the cost table's rank; ties keep list order. */
function cheapestChain(chains: string[]): string {
  let best = chains[0] ?? 'Ethereum';
  for (const chain of chains) {
    if (chainCost(chain).rank < chainCost(best).rank) best = chain;
  }
  return best;
}

/** A position size tier that fits the protocol's depth, so a farm plan is concrete about capital. */
function sizeTier(tvl: number): string {
  if (tvl >= 1_000_000_000) return '$5,000–$25,000';
  if (tvl >= 250_000_000) return '$2,000–$10,000';
  if (tvl >= 50_000_000) return '$500–$5,000';
  if (tvl >= 10_000_000) return '$250–$2,000';
  return '$100–$1,000';
}


/** Pick one of `variants` for this slug, deterministically — the same protocol always reads the same. */
function variant<T>(slug: string, variants: readonly T[]): T {
  return variants[slugHash(slug) % variants.length]!;
}

/**
 * The farm plan: seven concrete steps per protocol, written from its category playbook and its own
 * figures. The first step verifies the premise — official channels only, and the protocol still
 * records no token — and the last step sets the safety and exit rules; both rotate through several
 * phrasings so no two protocols read as the same template. The two middle steps carry the category's
 * real mechanics: a lending loop is not a bridge run is not a vault hold. Then one step written from
 * the protocol's own record, the weekly rhythm, and the activity log. Steps name costs and time
 * because a plan without them is a slogan.
 */
export function farmSteps(p: SnapshotProtocol, onWatchlist: boolean, asOf: string): string[] {
  const home = cheapestChain(p.chains);
  const cost = chainCost(home);
  const size = sizeTier(p.tvl_usd);
  const where = p.chains.length > 1 ? `${cost.note} — the cheapest of its ${p.chains.length} chains to farm on` : cost.note;
  const cat = p.category ?? 'DeFi';

  // Step 1 — verify the premise before any funds move. Four phrasings, one per protocol.
  const verify = variant(p.slug, [
    `Before any funds move, verify ${p.name} through its official channels only — the site linked from its DefiLlama page and its linked socials — and confirm it still records no token: no contract address, no claim page, no trading pair. The check takes about 10 minutes and is what keeps a fake claim site from taking the whole position.`,
    `Start with verification, not a deposit: reach ${p.name} only via its official site and the socials it links to, and double-check that it records no token yet — if a "claim" page asks for a fee or a signature today, it is not ${p.name}. Budget about 10 minutes for this before connecting any wallet.`,
    `Confirm the premise first: open ${p.name} from a source you trust, never a search ad or a DM link, and verify no token exists — no listed contract, no pair, no claim portal. This board ranks it precisely because it records no token; spend 10 minutes proving that is still true before acting.`,
    `Do the counterfeit check first: find ${p.name}'s official site and socials independently, confirm the addresses match across both, and confirm it still records no token. Impostor claim sites are the main way pre-token farmers lose money, and the check takes about 10 minutes.`,
  ]);
  const track = `Keep a dated log of every ${p.name} action — deposits, trades, votes — with transaction hashes; if a snapshot is ever announced, a 15-minute weekly log is what proves consistent use.`;
  const habit = `Return on a weekly rhythm for at least 8–12 weeks rather than one large visit: most points and airdrop criteria weight repeated weeks of activity over a single deposit. Budget about 20 minutes a week.`;
  // One step written from this protocol's own record: momentum, decline, longevity or reach.
  const age = ageDays(asOf, p.listed_at);
  let signal: string;
  if (p.change_7d !== null && p.change_7d >= 5) {
    signal = `Ride its current momentum deliberately: ${p.name}'s TVL grew ${p.change_7d.toFixed(1)}% in the seven days to the snapshot, so start the position this week while activity is rising — and re-check the trend monthly, because momentum entries decay if growth stalls.`;
  } else if (p.change_7d !== null && p.change_7d <= -10) {
    signal = `Size for a shrinking protocol: ${p.name}'s TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the seven days to the snapshot, so begin at half the usual size, review weekly, and be ready to withdraw if the decline runs a second month.`;
  } else if (age !== null && age >= 730) {
    signal = `Play the long wait: ${p.name} has been tracked for ${(age / 365.25).toFixed(1)} years with no token, and launches after waits this long are the ones that historically reward early, consistent users most — prioritise never missing a week over position size.`;
  } else if (p.chains.length >= 4) {
    signal = `Concentrate, do not scatter: ${p.name} runs on ${p.chains.length} chains, but a launch can only snapshot attributable history — farm it on ${cost.note} alone, where the same activity costs the least (${cost.gas}).`;
  } else {
    signal = `Build depth on one chain: keep every ${p.name} action on ${cost.note} for the whole season, so the wallet's history is deep in one place instead of thin across several — depth is what a snapshot can measure.`;
  }
  const byCategory: Record<string, string[]> = {
    Lending: [
      `Supply ${size} of collateral on ${p.name} — a dollar stablecoin for a steady rate, or ETH if you also want the price exposure — on ${where}; one transaction at ${cost.gas}. Then borrow against it and re-supply the borrowed asset once: a single, deliberate loop, not leverage for its own sake.`,
      `Work the position weekly for 8–12 weeks: keep the health factor above 2.0 — at that buffer the collateral can fall by roughly half before liquidation threatens — and track the net APY, the supply rate minus the borrow cost on the looped part. If the net runs negative for two straight weeks, unwind the loop; repay in full at least once mid-season and re-borrow, so the record shows completed borrow cycles. Each adjustment costs ${cost.gas}.`,
    ],
    Dexs: [
      `Generate genuine volume on ${p.name}: swap ${size} in total across its main pairs in 6–10 separate trades over the first two weeks, on ${where} at ${cost.gas} per swap. Never wash trade — no round-trips or self-matched trades placed only to inflate volume; DEX launches screen for exactly that, and it can void a wallet's whole history. Every trade should move you between assets you actually want to hold.`,
      `Split the flow between maker and taker: rest limit orders where ${p.name} supports them — maker fees typically run a fraction of taker fees — and take liquidity only for real rebalancing. Then add ${size} of two-sided liquidity to a top-three pool and leave it at least a month: LP depth held over time is the deepest usage signal a DEX records.`,
    ],
    Derivatives: [
      `Trade small perpetuals on ${p.name}: a few trades a week for at least a month, ${size} of margin in total, on ${where} at ${cost.gas} per order. Prefer maker orders where offered — maker fees run well below taker fees — and hedge directional trades with an offsetting spot position, so the flow is genuine hedging rather than volume for its own sake. Never wash trade: self-matched volume is screened out and can disqualify the wallet outright.`,
      `Respect the funding rate: before holding a position overnight, check whether longs or shorts are paying funding on ${p.name} and avoid sitting on the paying side for days. Keep leverage under 3x, close positions before funding compounds, and cap the whole experiment's loss at 5% of the margin — over 8–12 weeks the prize is a long, ordinary trading history, not profit.`,
    ],
    Yield: [
      `Deposit ${size} into ${p.name}'s flagship vault on ${where} — one transaction at ${cost.gas}. Before depositing, name the vault's yield source in your log: lending interest, trading fees, or emissions. Yield paid from real revenue can survive to a launch; yield promised from a token that does not exist yet is a hope, and should be sized like one.`,
      `Track the share token, not the balance: record the vault shares received and the share price weekly for 8–12 weeks — share-price growth is the vault's true return, since the share count never changes. Mid-season, test the exit with a small withdrawal and time it: withdrawal queues and cooldowns lengthen exactly when everyone leaves, and knowing yours in advance is part of the position.`,
    ],
    'Yield Aggregator': [
      `Deposit ${size} into ${p.name}'s main auto-compounding vault on ${where} at ${cost.gas}. An aggregator routes deposits across underlying farms, so read which strategies the vault currently runs and where its APY is sourced before the deposit — you are farming the aggregator's choices as much as your own.`,
      `Let it compound untouched for at least 8 weeks: the unbroken, compounding balance is the record a launch would snapshot. Check monthly that the vault has not rotated into a strategy you would not pick yourself, and make one small test withdrawal mid-season to learn its exit timing and fees while nothing is urgent.`,
    ],
    'Risk Curators': [
      `Deposit ${size} into a ${p.name}-curated vault on ${where} — one transaction at ${cost.gas}. Curators allocate other people's money across lending markets, so choose the vault by its stated risk framework — which collateral it accepts, its loan-to-value caps — rather than by the highest APY on the page.`,
      `Monitor the curation, not just the yield: a curator can reallocate between markets and loosen or tighten risk parameters at any time, so re-read the vault's allocations monthly across the 8–12 week season. If it moves into collateral you would not hold directly, withdraw — the curator's track record is only worth farming while its risk stays inside yours.`,
    ],
    'Onchain Capital Allocator': [
      `Allocate ${size} through ${p.name}'s main vault or strategy on ${where} at ${cost.gas}. Allocators route capital across on-chain opportunities under a stated mandate, so read the current allocation breakdown first: which protocols hold the money, in what proportions, and what the strategy may change without asking.`,
      `Hold the allocation for a full 8–12 week season and follow the rebalances: log each time ${p.name} shifts capital between strategies, and claim or compound distributions on the protocol's own schedule. A season of continuously held, rebalanced allocation is exactly the history an allocator's launch can measure.`,
    ],
    'Basis Trading': [
      `Run a small delta-neutral basis position through ${p.name} with ${size}: pair a spot holding against an offsetting short (or the reverse) to harvest funding and spread, on ${where} at ${cost.gas} per leg. Confirm both legs are live before sizing up — an unpaired leg is a directional bet wearing a basis trade's clothes.`,
      `Check the carry weekly for 8–12 weeks: funding flips sign, so log the net carry after all fees each week and close the position if it stays negative for two straight weeks. Keep margin buffers wide on both legs — a basis trade's real risk is one leg liquidating in a fast move, not the spread closing.`,
    ],
    CDP: [
      `Open a collateralised position on ${p.name}: deposit ${size} of ETH or a liquid staking token on ${where} and mint its stablecoin at a collateral ratio of 200% or higher — one transaction at ${cost.gas}. The wide buffer is deliberate: at 200%, the collateral can fall by half before liquidation threatens the position.`,
      `Hold the minted position open at least 8 weeks and service it monthly — top up collateral after sharp drops, or repay a little — while watching the stability fee, which accrues against the debt continuously. The position's net cost is that fee minus whatever the minted stablecoin earns where you park it; a maintained vault, not a drive-by mint, is the record that counts.`,
    ],
    Bridge: [
      `Move real funds through ${p.name}: bridge ${size} to a chain you genuinely use, carrying your own working balances on trips you would make anyway, at its stated fee plus ${cost.gas} per transfer. Never bridge funds back and forth just to manufacture volume — bridge analytics flag round-trip patterns, and flagged flow is worth less than none.`,
      `Diversify the routes over 8–12 weeks: use at least three different source-and-destination pairs ${p.name} supports, and cap the all-in cost of each transfer at roughly 0.5% of the amount moved — if a route quotes more, wait for a cheaper window. Route diversity with a real purpose behind it is the history a bridge launch can reward.`,
    ],
    'Liquid Staking': [
      `Stake ${size} of the chain's native asset through ${p.name} on ${where} at ${cost.gas}, and hold the liquid staking token you receive. Note the exchange rate at deposit in your log: the rate, not the token count, carries the staking yield, and an unbroken hold is what a duration-weighted record rewards.`,
      `Hold the staking token for at least 8–12 weeks; put a portion to work as collateral or in a liquidity pool if you want the composability these tokens exist for. Before adding size, run one small unstake and time it end to end — staking exit queues run from days to weeks, and that wait is part of the position's real cost.`,
    ],
    Restaking: [
      `Restake ${size} of an already-staked asset through ${p.name} on ${where} at ${cost.gas}: you keep the base staking yield and add the restaking layer's record on top. First read exactly which services the restaked capital secures — that list, and its slashing conditions, is the extra risk being accepted.`,
      `Hold the restaked position for a full season of at least 8–12 weeks, tracking base staking yield and restaking incentives as separate lines in your log. Test a small exit mid-season and time it: restaking withdrawal queues can run a week or more, and an exit you have rehearsed is worth more than a yield point.`,
    ],
    Chain: [
      `Be an early citizen of the ${p.name} chain rather than a passer-by: bridge ${size} in through its official route and keep it on-chain for the season. A pre-token chain can only reward wallets that were genuinely there, and bridged-and-used beats bridged-and-idle; the bridge-in costs the bridge's fee plus ${cost.gas}.`,
      `Use the chain weekly for 8–12 weeks — ordinary transfers, its first-party apps, a small permanent balance left on-chain. If a validator or staking programme exists, stake a portion: on a chain with no token yet, transacting and staking are the two histories a genesis allocation can actually measure.`,
    ],
    'Staking Pool': [
      `Stake ${size} through ${p.name}'s pool on ${where} at ${cost.gas} and hold the staking receipt: pooled staking is the whole product, so the record that matters is stake duration and continuity, not trading activity around it.`,
      `Leave the stake untouched for at least 8–12 weeks, compounding rewards back in monthly where the pool allows it. Learn the unbonding period before you need it — pooled stakes can take days to weeks to release, and that queue is a real cost of the position, not a detail.`,
    ],
    'Liquidity Manager': [
      `Deposit ${size} into ${p.name}'s managed liquidity position on ${where} at ${cost.gas}. The manager sets and rebalances the price range for you, so read its stated range strategy and recent fee history first: you are farming the manager's competence as much as the pool's volume.`,
      `Hold at least 8 weeks while the manager works: log each rebalance and the fees earned net of impermanent loss. If the position sits out of range for two straight weeks with no rebalance, withdraw — a managed position nobody manages earns nothing and still carries the pool's risk.`,
    ],
    CeDeFi: [
      `Onboard with ${p.name} before depositing anything: account setup, identity checks and terms can take several days, and CeDeFi yields are generated through centralised or off-chain venues — read how returns are produced and what custody you are accepting, then place ${size} in its main product at ${cost.gas} per action.`,
      `Keep the position for one full product term (typically 4–12 weeks) and withdraw once at maturity to prove the exit works end to end. Size this as the riskiest slice of the whole farm: the counterparty is the protocol itself, and no on-chain record diversifies that away.`,
    ],
    'Anchor BTC': [
      `Bring ${size} of bitcoin exposure to ${p.name} through its stated route on ${where}: BTC-anchored products take deposits of BTC or a BTC derivative, so confirm exactly which asset it accepts and what receipt asset you get back — the receipt is your real position. Any wrap or bridge fee sits on top of ${cost.gas}.`,
      `Hold for at least 8–12 weeks and check the backing monthly wherever ${p.name} publishes reserves or mint-and-burn records. BTC products live or die on redemption: test a small withdrawal mid-season and time it, because an exit that takes days changes what the position is actually worth.`,
    ],
    'Leveraged Farming': [
      `Open a modest leveraged farm on ${p.name} with ${size} of equity on ${where}: borrow against the deposit to farm a larger position, but keep leverage at or under 2x — the liquidation threshold, not the headline APY, decides whether the position survives an 8–12 week season. Opening or adjusting costs ${cost.gas} each.`,
      `Check the position's health weekly and after any 10% market move. Leveraged farming accrues borrow cost continuously, so compute the net APY — farm yield minus borrow rate — monthly and deleverage if it turns negative; a completed season that was never liquidated is the record worth having.`,
    ],
    'Dual-Token Stablecoin': [
      `Take the stability side of ${p.name}'s system with ${size} on ${where} at ${cost.gas}: mint or acquire its stablecoin through the protocol's own route and hold or deposit it where the system directs. In a dual-token design the second token absorbs volatility — understand which side of that bargain you are on before depositing.`,
      `Watch the peg weekly for 8–12 weeks and set the exit rule now: leave if the coin trades 2% or more off its peg for over 48 hours. Track what backs the coin and how losses are socialised; a stablecoin farm's yield is small and steady, and its risk is neither — size accordingly.`,
    ],
    'Stablecoin Wrapper': [
      `Wrap ${size} of a yield-bearing stablecoin through ${p.name} on ${where} at ${cost.gas}, and record the exchange rate you receive: wrapper shares appreciate as the underlying yield accrues, so the share price — not the share count — is where your return will show up.`,
      `Hold the wrapped position at least 8–12 weeks, checking monthly that the wrapper's share price tracks the underlying asset's yield as it should. Test a small unwrap mid-season: redemption timing and any exit fee are a wrapper's real costs, and they only become visible at the exit.`,
    ],
    'Collateral Markets': [
      `Supply ${size} of collateral through ${p.name} on ${where} at ${cost.gas}. Collateral markets let networks draw shared security from deposited assets, so read which networks your collateral would secure and exactly what slashing conditions apply before the deposit — that underwriting is the product.`,
      `Hold the collateral for a full 8–12 week season and re-check the network list monthly: every network added changes the risk your deposit underwrites. Keep the position in an asset you would hold anyway; the yield here is compensation for slashing risk, not a free return.`,
    ],
    'Governance Incentives': [
      `Work ${p.name}'s incentive programme by its own rulebook: read which actions earn, over what epochs, and what rewards are paid in, then complete the qualifying actions exactly as specified with ${size} on ${where} — enrolment actions cost ${cost.gas} each. Programmes reward rule-exact participation, not approximations of it.`,
      `Complete every epoch rather than dipping into one: incentive programmes snapshot participation per epoch, so a full run of epochs across 8–12 weeks outweighs one large week. Claim each epoch's reward as it lands — unclaimed epoch rewards are the most common way these farms quietly pay zero.`,
    ],
    'Crypto Card Issuer': [
      `Activate ${p.name}'s card and load it with ${size} for spending you would do anyway. A card issuer's launch record is genuine payment volume, so route ordinary weekly purchases through the card rather than manufacturing spend that teaches the issuer nothing about you as a customer.`,
      `Keep the card active at least 8–12 weeks with regular small transactions and a balance held in the linked account between spends. If a cashback or rewards tier exists, reach it through normal spending only — returned purchases and self-payments are precisely the patterns card issuers exclude from rewards.`,
    ],
    'Uncollateralized Lending': [
      `Lend ${size} through ${p.name} on ${where} at ${cost.gas}. Uncollateralised lending means borrowers are vetted by underwriting or reputation rather than by locked collateral, so read who borrows, what stands behind them, and what happens on default before choosing a pool — the borrower's quality is the product.`,
      `Spread the position across at least two pools or borrowers if ${p.name} allows it, and hold each loan to its stated term, typically 30–90 days. Default risk is this product's real price: a single default can erase a year of interest, so size the position as if one loan in five might fail.`,
    ],
    'Prediction Market': [
      `Trade ${size} across ${p.name}'s markets on ${where} at ${cost.gas} per trade, taking positions on events you genuinely have a view on. Prediction markets record resolved, honestly-held positions; a history of settled trades across several markets is the usage a launch can count.`,
      `Let positions settle rather than always selling out early — settlement is the on-chain event that completes the record. Spread activity across at least 8 weeks and several unrelated markets; one day of concentrated volume on a single market reads as farming, not forecasting.`,
    ],
    'Interest Rate Derivatives': [
      `Take a small interest-rate position on ${p.name} with ${size} on ${where} at ${cost.gas}: fix or float a rate against an underlying lending market you already understand, and note the maturity date in your log — rate positions expire, so the record here is a series of completed terms, not one open position.`,
      `Roll at each maturity for at least two full terms (typically 4–12 weeks each), holding a consistent view. Keep total margin and premiums under 2% of your farming budget: in rate markets, longevity of participation is what distinguishes a user from a tourist.`,
    ],
    Launchpad: [
      `Register on ${p.name} and complete one small participation of ${size} in a live sale, following its stated allocation rules exactly; a completed, rule-abiding entry is the record that matters if access later becomes token-gated.`,
      `Repeat for each new sale over the next two months — roughly one decision a fortnight at ${cost.gas} per entry — rather than concentrating the whole budget in a single launch.`,
    ],
    Aggregator: [
      `Route your ordinary swaps through ${p.name} instead of a direct DEX for the next two months: 2–3 swaps a week at ${cost.gas} each builds the routed-volume history aggregators can measure.`,
      `Once a month, compare ${p.name}'s quote against a direct route on a ${size} trade and keep the better one; staying active without overpaying keeps the habit sustainable for a full season.`,
    ],
    Indexes: [
      `Buy and hold ${size} of ${p.name}'s main index product for at least 8 weeks; index launches reward holding duration, and an early exit resets the clock that matters.`,
      `Rebalance or top up once a month with a small addition — one transaction at ${cost.gas} — so the position's history shows continuing conviction rather than a single forgotten purchase.`,
    ],
    'NFT Lending': [
      `Lend ${size} against floor-price collections on ${p.name} at conservative loan-to-value under 50%, so the position survives a floor dip without liquidation.`,
      `Roll each loan at maturity instead of withdrawing — one action per loan at ${cost.gas} — to build a continuous lending record across at least two full loan cycles.`,
    ],
    RWA: [
      `Complete ${p.name}'s onboarding and identity checks first — allow a full week for verification — then make a first position of ${size} in its shortest-duration offering.`,
      `Hold to the first maturity or coupon date rather than exiting early: real-world-asset launches can only reward completed holding periods, and early exits usually record nothing.`,
    ],
    Payments: [
      `Use ${p.name} for a real payment you already owe — a transfer or a bill of ${size} or less — once a month for three months; genuine payment history is the usage a payments launch can verify.`,
      `Keep the receiving side inside ${p.name} as well where you can (request payment to your ${p.name} address), so both halves of each transfer land in its own records.`,
    ],
    Gaming: [
      `Play ${p.name}'s core loop for 20–30 minutes twice a week for a month, completing its free progression first before spending anything; time-in-game is the cheapest signal to build honestly.`,
      `If you spend, cap it at ${size} total across the season on items that stay in your account; sunk cosmetic spending is the part of a gaming farm that never comes back.`,
    ],
    Options: [
      `Buy one small, short-dated option on ${p.name} with premium inside ${size} each fortnight for two months; a series of completed option cycles is the activity an options launch can count.`,
      `Let each option settle rather than rolling early — settlement is the on-chain event that closes the record — and keep total premiums under 2% of your farming budget.`,
    ],
    Insurance: [
      `Buy cover on ${p.name} for a position you actually hold elsewhere, sized inside ${size} of premium for a 90-day term; a real, held-to-term policy is the record an insurance launch rewards.`,
      `Alternatively stake ${size} in its underwriting pool for a full quarter, accepting the stated lock; underwriting stake is the deepest commitment signal the protocol records.`,
    ],
    Privacy: [
      `Make one compliant deposit of ${size} into ${p.name} and leave it at least 30 days before withdrawing to a fresh address of your own, following its published compliance guidance exactly.`,
      `Keep impeccable records of source and destination for your own files — privacy tooling draws regulatory attention, and a clean paper trail is part of farming it safely.`,
    ],
    Services: [
      `Use ${p.name}'s core service once end-to-end with a real task — budget ${size} for the service itself plus ${cost.gas} — and keep the receipt; a completed job is the usage record that counts.`,
      `Repeat monthly for a quarter, varying the task size, so the account shows a returning customer pattern rather than a single trial.`,
    ],
    Farm: [
      `Deposit ${size} into ${p.name}'s longest-running pool and stake the receipt token in the same session; the stake, not the deposit alone, is what its accounting tracks.`,
      `Harvest or compound weekly — one transaction at ${cost.gas} — for at least 8 weeks, so the wallet accumulates the repeated-action history farm launches snapshot.`,
    ],
  };
  // Aliases: playbooks shared by the category strings the snapshot actually uses for the same mechanics.
  byCategory['Perps'] = byCategory['Derivatives']!;
  byCategory['CDP Manager'] = byCategory['CDP']!;
  byCategory['Canonical Bridge'] = byCategory['Bridge']!;
  byCategory['Cross Chain Bridge'] = byCategory['Bridge']!;
  byCategory['Liquid Restaking'] = byCategory['Restaking']!;
  byCategory['Decentralized BTC'] = byCategory['Anchor BTC']!;
  byCategory['Algo-Stables'] = byCategory['Dual-Token Stablecoin']!;
  byCategory['Stablecoin Issuer'] = byCategory['Dual-Token Stablecoin']!;
  byCategory['Options Vault'] = byCategory['Options']!;
  const middle = byCategory[cat] ?? [
    `Put ${size} to work in ${p.name}'s main ${cat.toLowerCase()} product — its highest-TVL offering — on ${where}, and leave it in place at least 8 weeks; a held position is the record a launch snapshots, and each action costs ${cost.gas}.`,
    `Make one small additional action every two weeks (a deposit top-up, a claim, or a rebalance) at ${cost.gas} each, so the wallet reads as an active ${cat.toLowerCase()} user across the whole season rather than a single visit.`,
  ];

  // Step 7 — the safety and exit rules, in four phrasings; the tail differs for watchlist rows.
  const tail = onWatchlist
    ? `It sits on the DefiLlama watchlist of large tokenless protocols, so check for a token announcement weekly — and if one lands, claim only through the official channels verified in step one, inside the first week.`
    : `If its TVL falls for three straight months, move the capital to a higher-ranked board row instead; if a token is announced, claim only through the official channels verified in step one.`;
  const exit = variant(p.slug, [
    `Set the exit rules now, while nothing is at stake: cap the total at risk in ${p.name} at the ${size} band, review the position monthly, and withdraw in full if the protocol is exploited, goes silent for a full quarter, or its TVL halves from here. ${tail}`,
    `Write the exit down before you need it: leave ${p.name} if its TVL halves, if an exploit or a damning audit surfaces, or if a claim ever demands approvals beyond the claim itself. Never chase a falling position with fresh capital. ${tail}`,
    `Keep the position survivable: never let ${p.name} hold more than you could lose entirely, keep the farming wallet's seed phrase offline, and re-verify the official channels before every withdrawal — phishing peaks exactly when a launch is announced. ${tail}`,
    `Plan the whole arc, not just the entry: farm ${p.name} for one season of 8–12 weeks, then reassess against the board — deepen, hold, or rotate out. An exit rehearsed in advance (a small test withdrawal mid-season) is an exit that works under pressure. ${tail}`,
  ]);
  return [verify, middle[0]!, middle[1]!, signal, habit, track, exit];
}



/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  category_rank: number;
  category_size: number;
  implied_value_usd: number;
  model: {
    /** The fitted log10 market cap, split into the terms the detail view shows. */
    pred_log10: number;
    base_log10: number;
    term_tvl: number;
    term_growth: number;
    term_age: number;
    term_chains: number;
    term_category: number;
    /** Whether the row's category has traded peers in the fit, and how many. */
    category_in_fit: boolean;
    category_peers: number;
    /** The P10–P90 band: the estimate shifted by the out-of-fold residual quantiles. */
    band_low_usd: number;
    band_high_usd: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  category_rank: number;
  category_size: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  pred_log10: number;
  base_log10: number;
  term_tvl: number;
  term_growth: number;
  term_age: number;
  term_chains: number;
  term_category: number;
  /** The category effect as a multiple, or null when the category is not in the fit. */
  category_effect_mult: number | null;
  category_peers: number;
  farm_steps: string[];
}

/** Everything the dashboard needs: the board, the live set, the fit report and the baseline's peer table. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  fit: FitReport;
  total_protocols: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  board_implied_total: number;
  board_median_implied: number;
  watchlist_implied_total: number;
  peer_global: PeerStat;
  peer_stats: PeerStat[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Parse and validate the sealed snapshot; throws SnapshotError on a shape this model cannot score. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not valid JSON');
  }
  const doc = raw as Partial<Snapshot>;
  if (typeof doc.as_of !== 'string' || !Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist) || typeof doc.floor_usd !== 'number') {
    throw new SnapshotError('snapshot is missing as_of, floor_usd, protocols or watchlist');
  }
  return doc as Snapshot;
}

/** Score, select and rank the board, and assemble the dashboard's data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const peers = peerMultiples(snapshot);
  const fitted = fitModel(snapshot);
  const q10 = fitted.report.resid_q10_log10;
  const q90 = fitted.report.resid_q90_log10;
  const watch = new Set(snapshot.watchlist);
  const scored: {
    p: SnapshotProtocol;
    pr: FittedPrediction;
    implied: number;
    bandLow: number;
    bandHigh: number;
  }[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const onWatchlist = watch.has(p.slug);
    if (!onWatchlist && !isEarlyCandidate(p)) continue;
    const pr = fitted.predict(p);
    const implied = Math.max(1, Math.round(10 ** pr.pred_log10));
    // The band is the estimate moved by the out-of-fold residual quantiles, kept enclosing it.
    const bandLow = Math.max(1, Math.min(implied, Math.round(10 ** (pr.pred_log10 + q10))));
    const bandHigh = Math.max(implied, Math.round(10 ** (pr.pred_log10 + q90)));
    scored.push({ p, pr, implied, bandLow, bandHigh });
  }
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const watchlistRows = scored.filter((s) => watch.has(s.p.slug));
  const earlyRows = scored.filter((s) => !watch.has(s.p.slug));
  const picked = [...watchlistRows, ...earlyRows.slice(0, Math.max(0, BOARD_ROWS - watchlistRows.length))];
  picked.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  // Standing within the category: the board is already in implied-value order, so a running
  // counter per category gives each row its category rank and the category's board size.
  const catSeen = new Map<string, number>();
  const catRank = picked.map((s) => {
    const key = s.p.category ?? '(none)';
    const n = (catSeen.get(key) ?? 0) + 1;
    catSeen.set(key, n);
    return n;
  });

  const board: BoardRow[] = picked.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watch.has(s.p.slug),
    age_days: ageDays(snapshot.as_of, s.p.listed_at),
    category_rank: catRank[i]!,
    category_size: catSeen.get(s.p.category ?? '(none)') ?? 0,
    implied_value_usd: s.implied,
    model: {
      pred_log10: s.pr.pred_log10,
      base_log10: s.pr.base_log10,
      term_tvl: s.pr.term_tvl,
      term_growth: s.pr.term_growth,
      term_age: s.pr.term_age,
      term_chains: s.pr.term_chains,
      term_category: s.pr.term_category,
      category_in_fit: s.pr.category_effect !== null,
      category_peers: s.pr.category_effect?.peers ?? 0,
      band_low_usd: s.bandLow,
      band_high_usd: s.bandHigh,
    },
    farm_steps: farmSteps(s.p, watch.has(s.p.slug), snapshot.as_of),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.tvl_usd > 0 && p.mcap_usd !== null ? p.mcap_usd / p.tvl_usd : null,
    }));

  const peerStats = [...peers.byCategory.values()].sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    fit: fitted.report,
    total_protocols: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    board_implied_total: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    board_median_implied: board.length === 0 ? 0 : board[Math.floor(board.length / 2)]!.implied_value_usd,
    watchlist_implied_total: board.filter((r) => r.watchlist).reduce((sum, r) => sum + r.implied_value_usd, 0),
    peer_global: peers.global,
    peer_stats: peerStats,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      category_rank: r.category_rank,
      category_size: r.category_size,
      implied_value_usd: r.implied_value_usd,
      band_low_usd: r.model.band_low_usd,
      band_high_usd: r.model.band_high_usd,
      pred_log10: r.model.pred_log10,
      base_log10: r.model.base_log10,
      term_tvl: r.model.term_tvl,
      term_growth: r.model.term_growth,
      term_age: r.model.term_age,
      term_chains: r.model.term_chains,
      term_category: r.model.term_category,
      category_effect_mult: r.model.category_in_fit ? 10 ** r.model.term_category : null,
      category_peers: r.model.category_peers,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The data.js the dashboard loads: the radar data as one window global. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** The first reason the gate would refuse this board, or null when it passes the board checks. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  for (const [i, row] of board.entries()) {
    if (row.rank !== i + 1) return `row ${row.slug} carries rank ${row.rank}, expected ${i + 1}`;
    if (!slugs.has(row.slug)) return `row ${row.slug} is not one of the snapshot's protocols`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (!(row.implied_value_usd > 0) || row.implied_value_usd > 100_000_000_000_000) return `row ${row.slug} has implied value ${row.implied_value_usd}`;
    if (row.implied_value_usd > prev) return `implied value rises at rank ${row.rank}`;
    prev = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}
