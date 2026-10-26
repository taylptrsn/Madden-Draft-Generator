import { PositionMapper } from './PositionMapper';
import { BaselinePlayer } from '../types/player';

/**
 * First-cut wAV -> Madden Overall transform. Per-position-group anchor tables
 * (career wAV -> OVR), piecewise-linearly interpolated. Seeded from known
 * career-wAV landmarks (HOF tier -> 90-99, solid starter -> 75-82, backup ->
 * 65-72, fringe -> 50-64). The full reconciliation engine (RatingCalculator +
 * OVRWeightsCalculator) replaces the attribute spread in a later task; this
 * gives a defensible Overall now. See draft-class-generator-project memory.
 */

type Anchor = [number, number]; // [wAV, OVR]

const ANCHORS: Record<string, Anchor[]> = {
  QB: [[5, 55], [15, 64], [30, 70], [50, 75], [80, 82], [120, 88], [160, 92], [200, 95], [260, 99]],
  RB: [[4, 55], [12, 64], [25, 71], [45, 78], [70, 84], [95, 89], [120, 93], [150, 99]],
  WR: [[4, 54], [12, 63], [25, 70], [45, 77], [75, 84], [110, 90], [150, 94], [220, 99]],
  TE: [[4, 54], [12, 63], [25, 71], [45, 79], [70, 85], [95, 90], [130, 99]],
  OL: [[8, 56], [20, 64], [40, 71], [70, 78], [100, 84], [130, 89], [160, 94], [200, 99]],
  EDGE: [[5, 55], [15, 64], [30, 71], [55, 79], [85, 85], [115, 90], [150, 95], [180, 99]],
  IDL: [[5, 55], [15, 64], [30, 72], [55, 80], [80, 86], [110, 91], [140, 99]],
  LB: [[5, 55], [15, 64], [30, 71], [55, 79], [85, 85], [120, 91], [160, 99]],
  CB: [[5, 55], [15, 64], [30, 72], [55, 79], [85, 86], [120, 92], [160, 99]],
  S: [[5, 55], [15, 64], [30, 72], [55, 80], [80, 86], [110, 91], [150, 99]],
  // Specialists start at the same floor as everyone else (a 60 floor put every
  // rookie K/P/LS above the real first-rounders of a class with no career data).
  // At equal wAV a specialist never out-rates a position player (their AV
  // accrues far slower, so a 3-wAV long snapper is a fringe rookie, not a starter).
  K: [[2, 50], [8, 57], [20, 68], [45, 78], [70, 84], [100, 90]],
  P: [[2, 50], [8, 57], [20, 68], [45, 78], [70, 84], [100, 90]],
  LS: [[0, 48], [3, 53], [6, 60], [9, 66]],
};

function interp(anchors: Anchor[], x: number): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return last[1];
}

function clamp(v: number, lo = 40, hi = 99): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// Realistic-rookie ceiling: no generated prospect exceeds MAX_OVERALL. Ratings
// at/below CAP_KNEE pass through unchanged; the elite tail (KNEE..99) is
// compressed into KNEE..MAX_OVERALL so ordering is preserved but the best
// rookie tops out at 84 (elite caliber shows up as a high dev trait instead).
const MAX_OVERALL = 85; // calibrated real-class peak (was 84, undershooting by one)
const CAP_KNEE = 78;
function capOverall(ovr: number): number {
  if (ovr <= CAP_KNEE) return ovr;
  return Math.round(CAP_KNEE + ((ovr - CAP_KNEE) * (MAX_OVERALL - CAP_KNEE)) / (99 - CAP_KNEE));
}

/** Expected career AV from draft slot (Chase Stuart power law ~100*p^-0.67),
 *  scaled ~0.85 toward wAV. Used when no actual wAV exists. */
function predictedWavFromSlot(round: number | null, pick: number | null): number {
  // `pick` is the OVERALL draft pick (e.g. 1, 40, 150). Use it directly; only
  // estimate from the round when the overall pick is missing.
  const overallPick = pick != null && pick > 0 ? pick : round != null ? (round - 1) * 32 + 16 : 260; // ~UDFA
  const expectedCareerAV = 100 * Math.pow(Math.max(1, overallPick), -0.67);
  return expectedCareerAV * 0.85;
}

/**
 * Career wAV reconstructed from the aggregates PFR does have (games started +
 * Pro Bowls + All-Pros + career length), calibrated to real 1965+ wAV (MAE ~4.4).
 * PFR only computes single-season AV from 1960 on, so pre-1960 stored wAV badly
 * undercounts stars (Alan Ameche: 4 Pro Bowls, but stored wAV 3) — this recovers
 * a realistic value. Mirrors how AV is driven: sustained starting + accolades.
 */
function careerWavEstimate(p: BaselinePlayer): number {
  const pb = p.proBowls ?? 0;
  const ap = p.allPro1 ?? 0;
  const len = p.careerFrom != null && p.careerTo != null && p.careerTo >= p.careerFrom ? p.careerTo - p.careerFrom + 1 : 0;
  // Games-started wasn't reliably recorded pre-1960 (Bucko Kilroy: 103 GS on PFR,
  // but blank in our data). Infer starter seasons when St is missing/undercounted:
  // every Pro Bowl / All-Pro is a starting season, and most of a known career was
  // spent starting. Math.max keeps this a NO-OP for well-populated 1965+ players
  // (their real St already exceeds these floors), so the 1965+ calibration holds.
  const impliedFromAccolades = pb + ap;
  const impliedFromLength = len ? Math.round(len * 0.6) : 0;
  const st = Math.max(p.seasonsStarted ?? 0, impliedFromAccolades, impliedFromLength);
  const nonStarter = Math.max(0, len - st);
  return calibrateWav(5.5 * st + 3 * pb + 4 * ap + nonStarter);
}

/**
 * Low-end calibration for the raw aggregate estimate above.
 *
 * Measured against the 14,149 players who have a real PFR wAV, the raw formula
 * ranks well (r = 0.91) but is badly miscalibrated in one direction only:
 *
 *     actual wAV   n      mean actual   mean estimate   bias
 *     < 5          5078       1.4           10.5        +9.0
 *     5-15         3266       8.8           19.2       +10.4
 *     15-30        2403      21.4           28.1        +6.8
 *     30-60        2398      42.2           42.0        -0.2
 *     60-100        855      73.7           69.8        -3.9
 *     100+          149     115.9          112.9        -2.9
 *
 * It is accurate from ~30 up and inflates journeymen by ~10 AV, which made
 * every long-but-unremarkable career read like a contributor. Refitting the
 * coefficients fixes the middle but wrecks the tail (least squares chases the
 * crowded low end, and st/pb/ap saturate, so a 12-Pro-Bowl career and an
 * all-time-great one are indistinguishable in the features). So instead this
 * maps the raw estimate onto observed means below the threshold and leaves it
 * untouched above -- the tail keeps exactly the behaviour it already had.
 *
 * Held out 25%: MAE 8.84 -> 6.17, overall bias +6.59 -> +0.96, low-end bias
 * +9.50 -> +2.62, stars and elite unchanged (-3.42 / -5.82). Monotone, so the
 * ranking the estimate is mostly used for is preserved.
 *
 * Knots are (raw estimate, mean actual wAV) from decile bins of the 10,819
 * labelled players below the threshold; regenerate with scripts/probes/probe-av.ts.
 */
const WAV_IDENTITY_ABOVE = 35;
const WAV_CALIBRATION: readonly (readonly [number, number])[] = [
  [5.5, 1.0], [6.23, 1.84], [7.99, 2.45], [12.0, 3.42], [12.87, 5.71],
  [16.17, 8.73], [20.57, 11.57], [24.32, 13.61], [27.55, 19.65],
  [31.51, 23.43], [WAV_IDENTITY_ABOVE, WAV_IDENTITY_ABOVE],
];

function calibrateWav(raw: number): number {
  if (raw >= WAV_IDENTITY_ABOVE) return raw;
  const [x0, y0] = WAV_CALIBRATION[0];
  if (raw <= x0) {
    const [x1, y1] = WAV_CALIBRATION[1];
    return Math.max(0, y0 + ((raw - x0) * (y1 - y0)) / (x1 - x0));
  }
  for (let i = 0; i < WAV_CALIBRATION.length - 1; i++) {
    const [xa, ya] = WAV_CALIBRATION[i];
    const [xb, yb] = WAV_CALIBRATION[i + 1];
    if (raw <= xb) return ya + ((raw - xa) * (yb - ya)) / (xb - xa);
  }
  return raw;
}

/** True when a player carries any career-quality signal (career span, starts, or
 *  accolades) — enough to estimate from aggregates rather than the draft slot. */
function hasCareerSignal(p: BaselinePlayer): boolean {
  return (p.careerFrom != null && p.careerTo != null) || (p.proBowls ?? 0) > 0 || (p.allPro1 ?? 0) > 0 || (p.seasonsStarted ?? 0) > 0;
}

/** Best wAV estimate when there's no reliable actual wAV: from career aggregates
 *  when any career signal exists, otherwise the draft-slot expectation. (No HOF
 *  floor: the source isHOF flag is name-matched and collides across same-named
 *  players — e.g. all three "Jim Brown"s read TRUE — so flooring by it would
 *  inflate scrubs. Real stars are lifted by the accolade/career backfill instead.) */
/** Seasons the career aggregates describe (0 when unknown). */
function careerSeasons(p: BaselinePlayer): number {
  return p.careerFrom != null && p.careerTo != null && p.careerTo >= p.careerFrom ? p.careerTo - p.careerFrom + 1 : 0;
}

/** Completed (or at least well-established) career: enough seasons, or accolades. */
function careerIsMature(p: BaselinePlayer): boolean {
  return careerSeasons(p) >= 3 || (p.proBowls ?? 0) > 0 || (p.allPro1 ?? 0) > 0 || (p.seasonsStarted ?? 0) >= 3;
}

function estimateWav(p: BaselinePlayer): number {
  const slot = predictedWavFromSlot(p.draftRound, p.draftPick);
  let est: number;
  if (!hasCareerSignal(p)) est = slot;
  else if (careerIsMature(p)) est = careerWavEstimate(p);
  else {
    // A one- or two-season career says little yet (a 2025 first-rounder has a
    // single season on file): blend toward the draft-slot expectation.
    const seasons = Math.max(careerSeasons(p), p.seasonsStarted ?? 0, 1);
    const w = seasons / (seasons + 3);
    est = w * careerWavEstimate(p) + (1 - w) * slot;
  }
  // isHOF is now trustworthy (resolved to the true owner in dedupSharedAssets, and
  // set from the '‡' marker in the loader), so a HOF floor is safe again: an
  // enshrined player never rates below a solid starter even when career/accolade
  // data is sparse (Warren Moon's wAV never scraped; thin pre-1960 All-Pro records).
  return p.isHOF ? Math.max(est, 55) : est;
}

const CURRENT_YEAR = new Date().getFullYear();

/** Career wAV under-counts players who are still active / early in their career
 *  (a 5-year All-Pro hasn't compiled HOF totals yet, so raw career wAV makes
 *  them look like a backup). Project short, still-active careers toward a fuller
 *  body of work so elite young players (e.g. Micah Parsons, Ja'Marr Chase) rate
 *  correctly. Completed/long careers are left alone. */
function careerLengthBoost(player: BaselinePlayer): number {
  const from = player.careerFrom ?? player.draftYear;
  const to = player.careerTo ?? player.draftYear;
  const seasons = Math.max(1, to - from + 1);
  const active = player.careerTo == null || player.careerTo >= CURRENT_YEAR - 1;
  if (!active || seasons >= 9) return 1.0;
  return Math.min(1.5, 9 / seasons); // up to 1.5x for the shortest still-active careers
}

export interface RatingResult {
  overall: number;
  devTrait: number; // 0 Normal, 1 Star, 2 Superstar, 3 X-Factor
  wavUsed: number;
  wavSource: 'actual' | 'predicted';
}

export const RatingService = {
  /** Compute an Overall + dev trait for a player given its wAV (or draft slot). */
  /** Uncapped wAV-derived caliber (40-99). This is the signal used to RANK
   *  players within a class before mapping to Madden's empirical OVR curve. */
  caliber(player: BaselinePlayer, m26PosId: number): number {
    const group = PositionMapper.groupFromId(m26PosId);
    const anchors = ANCHORS[group] ?? ANCHORS.WR;
    const hasActual = player.wavSource === 'actual' && player.wav != null;
    const wav = hasActual ? (player.wav as number) * careerLengthBoost(player) : estimateWav(player);
    let overall = interp(anchors, wav);
    if (hasActual) {
      const pb = Math.min(player.proBowls ?? 0, 4);
      const ap = Math.min((player.allPro1 ?? 0) * 2, 6);
      overall += Math.min(pb + ap, 8);
    }
    return clamp(overall);
  },

  /** Draft-day caliber: what the slot alone says (used by the hindsight blend). */
  slotCaliber(player: BaselinePlayer, m26PosId: number): number {
    const group = PositionMapper.groupFromId(m26PosId);
    const anchors = ANCHORS[group] ?? ANCHORS.WR;
    return clamp(interp(anchors, predictedWavFromSlot(player.draftRound, player.draftPick)));
  },

  /** Career wAV a draft slot is expected to produce (Chase Stuart power law). */
  slotExpectation(round: number | null, pick: number | null): number {
    return predictedWavFromSlot(round, pick);
  },

  /** wAV estimate for a player with no reliable actual wAV — shown with a "P" tag. */
  predictedWav(player: BaselinePlayer): number {
    return Math.round(estimateWav(player));
  },

  /** Standalone per-player rating (legacy). The class builder now uses
   *  caliber() + CalibrationService for the class-wide OVR curve & dev rates. */
  rate(player: BaselinePlayer, m26PosId: number): RatingResult {
    const rawOverall = this.caliber(player, m26PosId);
    const round = player.draftRound ?? 8;
    let dev = 0;
    if (rawOverall >= 90 && (player.allPro1 ?? 0) >= 3) dev = 3;
    else if (rawOverall >= 86) dev = 2;
    else if (rawOverall >= 80) dev = 1;
    const slotCap = round <= 1 ? 3 : round <= 3 ? 2 : round <= 5 ? 1 : rawOverall >= 82 ? 1 : 0;
    dev = Math.min(dev, slotCap);
    const hasActual = player.wavSource === 'actual' && player.wav != null;
    return { overall: capOverall(rawOverall), devTrait: dev, wavUsed: 0, wavSource: hasActual ? 'actual' : 'predicted' };
  },
};
