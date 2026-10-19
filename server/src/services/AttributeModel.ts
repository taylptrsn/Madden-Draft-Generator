import { CombineMeasurements } from '../types/player';
import type { CareerBits } from './NflverseCareerService';
import { AttrStat, CalibrationService, PosProfile } from './CalibrationService';
import { CombineService } from './CombineService';
import { OVRWeightsCalculator } from './OVRWeightsCalculator';
import { PositionMapper } from './PositionMapper';

/**
 * Attribute generation calibrated on Madden's own draft classes.
 *
 * For each attribute the calibration records how it moves with overall INSIDE the
 * position (its slope), how much it scatters around that line (residStd) and the
 * observed range. A prospect's attribute is therefore
 *
 *     archetype mean + slope x (overall - archetype mean overall) + noise
 *
 * so awareness climbs steeply with overall, speed climbs gently, and injury /
 * toughness / stamina barely move - exactly the relationships the game's classes
 * show - instead of every non-physical attribute taking the same uniform shift.
 *
 * Real combine testing then overrides the athletic attributes, scored as a
 * percentile WITHIN the player's position group and placed on that position's
 * Madden distribution (a 5.2-second tackle is an average tackle, not a 41-speed
 * one), and the skill attributes are finally reconciled so the game's recomputed
 * overall equals the one we intend - to the exact point.
 */

/** Attributes that come from athleticism (combine + build), never from career
 *  caliber: the reconciler must not pump them to hit an overall. */
/** How far a career-rated legend's physical attributes may exceed the position's
 *  rookie ceiling (an 86-speed edge class allows an 89-speed legend). */
export const LEGEND_PHYSICAL_MARGIN = 3;

export const FIXED_ATTRS = new Set([
  'speed', 'acceleration', 'agility', 'changeOfDirection', 'jumping', 'strength', 'throwPower',
]);

export const RATING_KEYS = [
  'speed', 'acceleration', 'agility', 'strength', 'awareness', 'jumping', 'stamina',
  'changeOfDirection', 'toughness', 'injury', 'carrying', 'ballCarrierVision', 'breakTackle',
  'trucking', 'stiffArm', 'spinMove', 'jukeMove', 'catching', 'catchInTraffic', 'spectacularCatch',
  'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release', 'throwPower',
  'throwAccuracyShort', 'throwAccuracyMid', 'throwAccuracyDeep', 'throwOnTheRun', 'throwUnderPressure',
  'playAction', 'breakSack', 'passBlock', 'passBlockPower', 'passBlockFinesse', 'runBlock',
  'runBlockPower', 'runBlockFinesse', 'leadBlock', 'impactBlocking', 'tackle', 'hitPower',
  'powerMoves', 'finesseMoves', 'blockShedding', 'pursuit', 'playRecognition', 'manCoverage',
  'zoneCoverage', 'pressCoverage', 'kickPower', 'kickAccuracy', 'kickReturn', 'longSnap',
];

export function clampRating(v: number): number {
  return Math.max(1, Math.min(99, Math.round(v)));
}

/** Standard normal from a seeded uniform source (Box-Muller). */
export function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Inverse normal CDF (Acklam's approximation) for percentile -> z. */
export function probit(p: number): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (q < pl) {
    const t = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
  }
  if (q > 1 - pl) {
    const t = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
  }
  const t = q - 0.5;
  const r = t * t;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface GenerateInput {
  posId: number;
  profile: PosProfile; // position profile (carries attrStats)
  archAttrs: Record<string, number>; // chosen archetype's attribute means
  archOvrMean: number; // chosen archetype's mean overall
  overall: number; // target overall
  rand: () => number; // seeded
  combine?: CombineMeasurements | null;
  /** Career line (rushing) and draft year: a quarterback without a 40 gets his
   *  speed from how much he ran, not from the archetype's spread. */
  career?: CareerBits | null;
  draftYear?: number;
  /** Career-retrospective mode rates beyond Madden's rookie range: skill
   *  attributes run to 99; physicals get LEGEND_PHYSICAL_MARGIN over the observed max. */
  uncapped?: boolean;
}

/** Place a percentile on the position's Madden distribution for an attribute. */
function onDistribution(p: number, st: AttrStat | undefined, positionMean: number): number {
  const std = st ? Math.max(2, st.std) : 5;
  const v = positionMean + probit(p) * std;
  const lo = st ? st.min - 2 : 1;
  const hi = st ? st.max + 3 : 99;
  return clampRating(Math.max(lo, Math.min(hi, v)));
}

/**
 * Speed a 40 time earns on its own, whatever the position. The percentile
 * placement above compresses the fastest men in a fast group: among corners a
 * 4.26 is only the 99.7th percentile, and the group's rookie spread (std 2) puts
 * that at 95, while Madden's own rookies run 96-98 at that time (Woolen 4.26,
 * Thornton 4.28, Worthy 4.21 at 98). A 40 is an absolute measure, so the top
 * end gets an absolute floor; anything slower than 4.50 keeps the percentile
 * value alone. Piecewise-linear between the anchors.
 */
const FORTY_SPEED_FLOOR: Array<[number, number]> = [
  [4.20, 99], [4.24, 98], [4.28, 97], [4.32, 96], [4.36, 95], [4.40, 94], [4.45, 92], [4.50, 90],
];
export function fortySpeedFloor(forty: number): number | null {
  if (!Number.isFinite(forty) || forty > FORTY_SPEED_FLOOR[FORTY_SPEED_FLOOR.length - 1][0]) return null;
  if (forty <= FORTY_SPEED_FLOOR[0][0]) return FORTY_SPEED_FLOOR[0][1];
  for (let i = 1; i < FORTY_SPEED_FLOOR.length; i++) {
    const [t0, s0] = FORTY_SPEED_FLOOR[i - 1];
    const [t1, s1] = FORTY_SPEED_FLOOR[i];
    if (forty <= t1) return Math.round(s0 + ((forty - t0) / (t1 - t0)) * (s1 - s0));
  }
  return null;
}

/**
 * Quarterback speed from career rushing when there is no 40 time.
 *
 * Without testing, speed was archetype mean + noise with the QB residual (5.7),
 * and that residual is mostly the Scrambler / pocket split the archetype already
 * carries; Caleb Williams drew +11 and came out 96. Rushing yards per game is the
 * evidence the record keeps: quantiles of drafted quarterbacks with 16+ games,
 * per era because pre-2000 passers ran far less (Cunningham's 30.6 is the top of
 * his era, the 90th percentile of this one). Placed on the QB speed distribution
 * the way a 40 is: Daniels 48.7 -> 91, Williams 25.8 -> 85, Penix 5.8 -> 75,
 * Lamar Jackson 56.2 -> 96, against Madden's 91 / 84 / 79 / 96.
 */
const QB_RUSH_YPG_QUANTILES: Record<'modern' | 'classic', Array<[number, number]>> = {
  modern: [[0, 0.02], [2.2, 0.10], [4.9, 0.25], [9.4, 0.50], [15.6, 0.75], [27.2, 0.90], [36.9, 0.95], [42.7, 0.98], [56, 0.999]],
  classic: [[0, 0.02], [0.7, 0.10], [2.8, 0.25], [5.1, 0.50], [9.2, 0.75], [15.6, 0.90], [18.3, 0.95], [23.0, 0.98], [31, 0.999]],
};
export function qbRushPercentile(career: CareerBits | null | undefined, draftYear: number | undefined): number | null {
  if (!career || career.rushYards == null || !career.games || career.games < 8) return null;
  const ypg = Math.max(0, career.rushYards / career.games);
  const table = QB_RUSH_YPG_QUANTILES[(draftYear ?? 2000) >= 2000 ? 'modern' : 'classic'];
  if (ypg >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    const [y0, p0] = table[i - 1];
    const [y1, p1] = table[i];
    if (ypg <= y1) return p0 + ((ypg - y0) / (y1 - y0)) * (p1 - p0);
  }
  return null;
}

/** Athletic attributes from combine testing, scored within the position group. */
export function combineAttrs(posId: number, c: CombineMeasurements, profile: PosProfile): Record<string, number> {
  const group = PositionMapper.groupFromId(posId);
  const st = profile.attrStats ?? {};
  const mean = (k: string) => profile.attrs[k] ?? 60;
  const out: Record<string, number> = {};
  const pct = (drill: keyof CombineMeasurements) => {
    const v = c[drill];
    return v == null ? null : CombineService.drillPercentile(group, drill, v);
  };
  const p40 = pct('forty');
  if (p40 != null) {
    const floor = fortySpeedFloor(c.forty as number);
    out.speed = Math.max(onDistribution(p40, st.speed, mean('speed')), floor ?? 1);
    // Acceleration is short-area burst: blend the 40 with the explosion drills.
    const bursts = [pct('vertical'), pct('broad'), pct('shuttle'), pct('cone')].filter((x): x is number => x != null);
    const pAcc = bursts.length ? 0.55 * p40 + 0.45 * (bursts.reduce((s, x) => s + x, 0) / bursts.length) : p40;
    // A blazer's burst is never far behind his top speed.
    out.acceleration = Math.max(onDistribution(pAcc, st.acceleration, mean('acceleration')), floor != null ? floor - 3 : 1);
  }
  const pBench = pct('bench');
  if (pBench != null) out.strength = onDistribution(pBench, st.strength, mean('strength'));
  const pVert = pct('vertical') ?? pct('broad');
  if (pVert != null) out.jumping = onDistribution(pVert, st.jumping, mean('jumping'));
  const pCone = pct('cone');
  if (pCone != null) out.agility = onDistribution(pCone, st.agility, mean('agility'));
  const pShuttle = pct('shuttle') ?? pCone;
  if (pShuttle != null) out.changeOfDirection = onDistribution(pShuttle, st.changeOfDirection, mean('changeOfDirection'));
  return out;
}

/** Generate the full attribute set for a prospect (before user edits). */
export function generateAttributes(input: GenerateInput): Record<string, number> {
  const { posId, profile, archAttrs, archOvrMean, overall, rand } = input;
  const stats = profile.attrStats ?? {};
  const delta = overall - archOvrMean;
  const out: Record<string, number> = {};
  for (const k of RATING_KEYS) {
    const base = archAttrs[k] ?? profile.attrs[k] ?? 55;
    const st = stats[k];
    // No calibration for this attribute: fall back to the old uniform model.
    const slope = st ? st.slope : FIXED_ATTRS.has(k) ? 0 : 1;
    const noise = gauss(rand) * (st ? Math.max(1, st.residStd) * 0.85 : 2);
    let v = base + slope * delta + noise;
    if (st) {
      const lo = Math.max(1, st.min - 4);
      // Skill attributes may stretch past the observed range (the reconciler
      // needs the room); a physical attribute with no evidence behind it does
      // not go beyond what Madden's own classes show. A career-rated legend's
      // skills run to 99, but his athleticism stays near the position's ceiling:
      // a 99 overall 1964 end is not a 98-speed edge.
      const hi = FIXED_ATTRS.has(k)
        ? Math.min(99, st.max + (input.uncapped ? LEGEND_PHYSICAL_MARGIN : 0))
        : input.uncapped ? 99 : Math.min(99, st.max + 4);
      v = Math.max(lo, Math.min(hi, v));
    }
    out[k] = clampRating(v);
  }
  if (input.combine) Object.assign(out, combineAttrs(posId, input.combine, profile));
  if (PositionMapper.name(posId) === 'QB' && input.combine?.forty == null) {
    const p = qbRushPercentile(input.career, input.draftYear);
    if (p != null) out.speed = onDistribution(p, stats.speed, profile.attrs.speed ?? 78);
  }
  if (input.career) {
    applyCareerSkillSignature(posId, out, input.career, input.draftYear, input.uncapped);
  }
  return out;
}

/**
 * Shapes a prospect's non-physical skill profile using his real 1936-2026 NFL
 * career statistical signature (YPR, rec/game, TD rate, rush YPG/YPC, sacks/game,
 * INTs/game, QB pass/rush rates) before reconcileToTarget locks in the exact OVR.
 */
export function applyCareerSkillSignature(
  posId: number,
  out: Record<string, number>,
  c: CareerBits,
  draftYear?: number,
  uncapped?: boolean
): void {
  const games = Math.max(1, c.games ?? Math.round(Math.max(1, c.seasonsStarted ?? 0) * 14));
  if (games < 12) return;
  const group = PositionMapper.groupFromId(posId);
  const cap = uncapped ? 99 : 94;
  const nudge = (k: string, delta: number) => {
    if (out[k] == null) return;
    out[k] = clampRating(Math.min(cap, Math.max(25, out[k] + delta)));
  };

  const rec = c.receptions ?? 0;
  const recYds = c.recYards ?? 0;
  const recTds = c.recTds ?? 0;
  const rushAtt = c.rushAtts ?? 0;
  const rushYds = c.rushYards ?? 0;
  const sacks = c.defSacks ?? 0;
  const ints = c.defInts ?? 0;
  const passYds = c.passYards ?? 0;
  const wt = c.weight ?? 215;

  if (group === 'WR' || group === 'TE') {
    if (rec >= 35) {
      const ypr = recYds / rec;
      const rpg = rec / games;
      const tdRate = recTds / rec;
      // Vertical / deep-ball signature (Moss, Hayes, DeSean Jackson, Vernon Davis)
      if (ypr >= 16.5) {
        nudge('deepRouteRunning', 3);
        nudge('spectacularCatch', 3);
        nudge('release', 2);
      } else if (ypr <= 11.8 && rpg >= 3.8) {
        // High-volume underneath / slot technician
        nudge('shortRouteRunning', 3);
        nudge('catching', 2);
        nudge('catchInTraffic', 2);
      }
      if (rpg >= 4.8) {
        nudge('catching', 2);
        nudge('mediumRouteRunning', 2);
      }
      if (tdRate >= 0.11 || recTds >= 65) {
        nudge('spectacularCatch', 2);
        nudge('catchInTraffic', 2);
      }
    }
  } else if (group === 'RB') {
    if (rushAtt >= 100) {
      const ypc = rushYds / rushAtt;
      const rypg = rushYds / games;
      if (ypc >= 4.6 || rypg >= 68) {
        nudge('breakTackle', 3);
        nudge('ballCarrierVision', 3);
      }
      if (wt >= 228) {
        nudge('trucking', 4);
        nudge('stiffArm', 3);
      } else if (wt <= 206) {
        nudge('jukeMove', 3);
        nudge('spinMove', 2);
      }
    }
    if (rec / games >= 2.5) {
      nudge('catching', 4);
      nudge('shortRouteRunning', 4);
    }
  } else if (group === 'QB') {
    const pRush = qbRushPercentile(c, draftYear);
    if (pRush != null && pRush >= 0.82) {
      const boost = pRush >= 0.95 ? 4 : 2;
      nudge('breakSack', boost);
      nudge('throwOnTheRun', boost);
      nudge('jukeMove', boost);
      nudge('carrying', 2);
    }
    if (passYds / games >= ((draftYear ?? 2000) >= 2000 ? 225 : 175)) {
      nudge('throwAccuracyShort', 2);
      nudge('throwAccuracyMid', 2);
      nudge('throwAccuracyDeep', 2);
      nudge('throwUnderPressure', 2);
    }
  } else if (group === 'EDGE' || group === 'IDL' || group === 'LB') {
    const spg = sacks / games;
    if (sacks >= 15 && spg >= 0.42) {
      const boost = spg >= 0.65 ? 4 : 2;
      nudge('powerMoves', boost);
      nudge('finesseMoves', boost);
      nudge('pursuit', 2);
      nudge('blockShedding', 2);
    }
    if (group === 'LB' && ints >= 8 && ints / games >= 0.08) {
      nudge('zoneCoverage', 3);
      nudge('manCoverage', 2);
      nudge('catching', 3);
      nudge('playRecognition', 2);
    }
  } else if (group === 'CB' || group === 'S') {
    const ipg = ints / games;
    if (ints >= 10 && ipg >= 0.18) {
      const boost = ipg >= 0.30 ? 4 : 2;
      nudge('catching', boost + 2);
      nudge('zoneCoverage', boost);
      nudge('playRecognition', boost);
    }
  }
}

/**
 * Madden recomputes a prospect's overall from its archetype-weighted attributes on
 * import (it discards the OVR byte). Shift the skill attributes so the recompute
 * lands exactly on `target`, leaving physicals (FIXED_ATTRS) untouched: first a
 * weighted shift, then single-point nudges on the heaviest movable attribute.
 */
export function reconcileToTarget(attrs: Record<string, number>, posId: number, archetype: number, target: number, version: 'm26' | 'm27' = 'm26'): void {
  reconcileArchetype(attrs, posId, archetype, target, version);
  // Madden does not trust the archetype byte either: it scores the attributes under
  // every archetype valid for the position and keeps the highest. A rival formula
  // scoring above the target lifts the overall on import (Kevin Williams 2003: 85 as
  // a Speed Rusher, 89 as a Power Rusher — the game showed 89). Lower the attributes
  // each rival weights more than ours until none beats the target, then re-solve.
  const rivals = eligibleArchetypes(posId, version).filter((a) => a !== archetype);
  for (let round = 0; round < 6 && rivals.length; round++) {
    let moved = false;
    for (const rival of rivals) {
      const score = OVRWeightsCalculator.computeOverall(posId, rival, attrs, version);
      if (score == null || score <= target) continue;
      capRival(attrs, posId, archetype, rival, target, version);
      moved = true;
    }
    if (!moved) break;
    reconcileArchetype(attrs, posId, archetype, target, version, rivals);
  }
}

/** The overall Madden will show: the best score over every archetype valid for
 *  the position (the game re-derives the archetype from the attributes). */
export function gameOverall(attrs: Record<string, number>, posId: number, archetype: number, version: 'm26' | 'm27' = 'm26'): { overall: number | null; archetype: number } {
  let best = OVRWeightsCalculator.computeOverall(posId, archetype, attrs, version);
  let bestArch = archetype;
  for (const a of eligibleArchetypes(posId, version)) {
    if (a === archetype) continue;
    const o = OVRWeightsCalculator.computeOverall(posId, a, attrs, version);
    if (o != null && (best == null || o > best)) { best = o; bestArch = a; }
  }
  return { overall: best, archetype: bestArch };
}

/** Archetype ids the game considers for a position: the ones its own generated
 *  classes use (calibration archetypeDist). Ovrweights carries DE-style rushers for
 *  OLB too, but the game never assigns those to a SAM/WILL. */
function eligibleArchetypes(posId: number, version: 'm26' | 'm27'): number[] {
  const prof = CalibrationService.positionProfile(PositionMapper.name(posId), version);
  return Object.keys(prof?.archetypeDist ?? {}).map(Number).filter((n) => Number.isFinite(n));
}

/** Bring `rival`'s recompute down to `target` by lowering the skill attributes it
 *  weights more heavily than `archetype` does (so our own score moves least). */
function capRival(attrs: Record<string, number>, posId: number, archetype: number, rival: number, target: number, version: 'm26' | 'm27'): void {
  const re = OVRWeightsCalculator.ovrEntryFor(posId, rival, version);
  const own = OVRWeightsCalculator.ovrEntryFor(posId, archetype, version);
  if (!re || !re.sumWeight) return;
  const ownW = own?.weights ?? {};
  const lean = (a: string) => re.weights[a] - (ownW[a] ?? 0);
  let movable = Object.keys(re.weights).filter((a) => !FIXED_ATTRS.has(a) && lean(a) > 0);
  if (!movable.length) movable = Object.keys(re.weights).filter((a) => !FIXED_ATTRS.has(a));
  if (!movable.length) return;
  const score = () => OVRWeightsCalculator.computeOverall(posId, rival, attrs, version) ?? target;
  // Weighted shift to just under the rounding edge of target+1.
  const requiredSum = (re.desiredLow + ((target + 0.45) / 99) * (re.desiredHigh - re.desiredLow)) * re.sumWeight;
  for (let iter = 0; iter < 4 && score() > target; iter++) {
    let sum = 0;
    for (const [a, w] of Object.entries(re.weights)) sum += (Number(attrs[a]) || 0) * w;
    const deficit = requiredSum - sum; // negative: we must come down
    if (deficit >= 0) break;
    const live = movable.filter((a) => (Number(attrs[a]) || 0) > 1);
    const movableW = live.reduce((s, a) => s + re.weights[a], 0);
    if (!movableW) break;
    const shift = deficit / movableW;
    for (const a of live) attrs[a] = clampRating((Number(attrs[a]) || 0) + shift);
  }
  // Integer pass on the attribute that hurts our own score least per rival point.
  const byLean = [...movable].sort((a, b) => lean(b) - lean(a));
  for (let i = 0; i < 40 && score() > target; i++) {
    const pick = byLean.find((a) => attrs[a] > 1);
    if (!pick) break;
    attrs[pick] -= 1;
  }
}

function reconcileArchetype(attrs: Record<string, number>, posId: number, archetype: number, target: number, version: 'm26' | 'm27', rivals: number[] = []): void {
  const entry = OVRWeightsCalculator.ovrEntryFor(posId, archetype, version);
  if (!entry || !entry.sumWeight) return;
  const { desiredLow: DL, desiredHigh: DH, sumWeight, weights } = entry;
  const free = Object.keys(weights).filter((a) => !FIXED_ATTRS.has(a));
  if (!free.length) return;
  const current = () => OVRWeightsCalculator.computeOverall(posId, archetype, attrs, version) ?? target;

  const requiredSum = (DL + (target / 99) * (DH - DL)) * sumWeight;
  for (let iter = 0; iter < 8; iter++) {
    if (current() === target) break;
    let sum = 0;
    for (const [a, w] of Object.entries(weights)) sum += (Number(attrs[a]) || 0) * w;
    const deficit = requiredSum - sum;
    let movableW = 0;
    for (const a of free) {
      const v = Number(attrs[a]) || 0;
      if (deficit > 0 ? v < 99 : v > 1) movableW += weights[a];
    }
    if (movableW === 0) break;
    const shift = deficit / movableW;
    for (const a of free) {
      const v = Number(attrs[a]) || 0;
      if (deficit > 0 ? v >= 99 : v <= 1) continue;
      attrs[a] = clampRating(v + shift);
    }
  }

  // Integer pass: rounding leaves ~20% of prospects one point off; nudge the
  // heaviest free attribute that can still move until the recompute is exact.
  // When raising, skip a nudge that would push a rival archetype above the target
  // (the game would then re-rate the prospect up under that archetype).
  const byWeight = [...free].sort((a, b) => weights[b] - weights[a]);
  const rivalOver = () => rivals.some((r) => (OVRWeightsCalculator.computeOverall(posId, r, attrs, version) ?? -1) > target);
  for (let i = 0; i < 40; i++) {
    const cur = current();
    if (cur === target) break;
    const up = cur < target;
    let done = false;
    for (const a of byWeight) {
      if (up ? attrs[a] >= 99 : attrs[a] <= 1) continue;
      attrs[a] += up ? 1 : -1;
      if (up && rivals.length && rivalOver()) { attrs[a] -= 1; continue; }
      done = true;
      break;
    }
    if (!done) break;
  }
}

