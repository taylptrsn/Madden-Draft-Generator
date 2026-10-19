import { PositionMapper } from './PositionMapper';

/**
 * Position-weighted skin-tone (a.k.a. "Race": 1=lightest … 7=darkest) for players
 * whose real ethnicity is unknown or untrusted. The source Race column in the Madden
 * roster export is a near-universal hard-coded 7 (~95% of rows), so it can't be
 * trusted — a generic-face rookie needs a demographically-plausible tone instead of
 * everyone rendering Black. Deterministic per player so a class is reproducible.
 *
 * This ONLY affects players who fall back to a generic face; a real face asset
 * overrides skin tone entirely.
 */

// Approximate per-position-group skin-tone mix, leaning on the well-populated tones
// in the generic-face set (tone 7 has the most faces, then 2/5/6). Light tones (1-3)
// read as White, 4-5 medium/Hispanic, 6-7 Black. QB/OL/specialists skew lighter;
// the skill positions and front seven skew darker — matching NFL demographics.
const GROUP_TONE_WEIGHTS: Record<string, Array<[number, number]>> = {
  QB: [[2, 58], [1, 22], [3, 8], [7, 9], [6, 3]],
  RB: [[7, 72], [6, 14], [2, 8], [4, 4], [1, 2]],
  WR: [[7, 76], [6, 12], [2, 7], [4, 3], [1, 2]],
  CB: [[7, 80], [6, 12], [2, 5], [4, 2], [1, 1]],
  S: [[7, 72], [6, 12], [2, 11], [4, 3], [1, 2]],
  LB: [[7, 66], [6, 12], [2, 16], [4, 3], [1, 3]],
  EDGE: [[7, 68], [6, 12], [2, 14], [4, 3], [1, 3]],
  IDL: [[7, 66], [6, 12], [2, 16], [4, 3], [1, 3]],
  OL: [[2, 42], [1, 12], [7, 32], [6, 8], [4, 6]],
  TE: [[7, 44], [6, 10], [2, 34], [1, 8], [4, 4]],
  K: [[2, 66], [1, 24], [3, 4], [7, 4], [5, 2]],
  P: [[2, 66], [1, 24], [3, 4], [7, 4], [5, 2]],
  LS: [[2, 62], [1, 20], [3, 4], [7, 10], [6, 4]],
};

/** Full 7-tone position mix for purely fictional generated classes, calibrated to
 *  both NFL positional demographics and M27 generic-head catalog capacity across tones 1..7. */
const FICTIONAL_GROUP_TONE_WEIGHTS: Record<string, Array<[number, number]>> = {
  QB: [[2, 44], [1, 16], [3, 12], [4, 6], [5, 6], [7, 10], [6, 6]],
  RB: [[7, 48], [6, 26], [5, 7], [4, 6], [2, 7], [3, 3], [1, 3]],
  WR: [[7, 50], [6, 26], [5, 6], [4, 6], [2, 6], [3, 3], [1, 3]],
  CB: [[7, 54], [6, 28], [5, 5], [4, 4], [2, 4], [3, 3], [1, 2]],
  S: [[7, 46], [6, 26], [2, 10], [4, 6], [5, 6], [3, 3], [1, 3]],
  LB: [[7, 42], [6, 24], [2, 14], [3, 6], [4, 5], [5, 5], [1, 4]],
  EDGE: [[7, 44], [6, 24], [2, 12], [3, 6], [4, 5], [5, 5], [1, 4]],
  IDL: [[7, 42], [6, 24], [2, 14], [4, 6], [5, 6], [3, 4], [1, 4]],
  OL: [[2, 32], [7, 24], [6, 14], [1, 10], [3, 8], [4, 6], [5, 6]],
  TE: [[7, 32], [2, 28], [6, 16], [1, 8], [3, 6], [4, 5], [5, 5]],
  K: [[2, 52], [1, 18], [3, 10], [4, 6], [5, 6], [7, 5], [6, 3]],
  P: [[2, 52], [1, 18], [3, 10], [4, 6], [5, 6], [7, 5], [6, 3]],
  LS: [[2, 48], [1, 18], [3, 10], [4, 6], [5, 4], [7, 9], [6, 5]],
};

/** Deterministic [0,1) from a string key (FNV-1a). */
function hashUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function weightedTone(weights: Array<[number, number]>, roll: number): number {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let x = roll * total;
  for (const [tone, w] of weights) if ((x -= w) < 0) return tone;
  return weights[weights.length - 1][0];
}

/** Share of Black players in the league by era. The NFL was segregated 1934-45,
 *  re-integrated in 1946 and reached roughly 10% by the mid-50s, 20% by 1960,
 *  a third by 1970, half by 1980 and two-thirds by the 1990s, where it has stayed. */
const ERA_DARK_SHARE: Array<[number, number]> = [
  [1933, 0.01], [1945, 0.01], [1950, 0.06], [1955, 0.10], [1960, 0.18], [1965, 0.27], [1970, 0.34],
  [1975, 0.42], [1980, 0.50], [1985, 0.55], [1990, 0.62], [1995, 0.66], [2005, 0.68], [2030, 0.68],
];
/** Modern-era dark share the position table above was written against. */
const MODERN_DARK_SHARE = 0.66;

export function eraDarkShare(year: number): number {
  if (year <= ERA_DARK_SHARE[0][0]) return ERA_DARK_SHARE[0][1];
  for (let i = 1; i < ERA_DARK_SHARE.length; i++) {
    const [x2, y2] = ERA_DARK_SHARE[i];
    if (year <= x2) {
      const [x1, y1] = ERA_DARK_SHARE[i - 1];
      return y1 + ((y2 - y1) * (year - x1)) / (x2 - x1);
    }
  }
  return ERA_DARK_SHARE[ERA_DARK_SHARE.length - 1][1];
}

/** The position's tone mix rescaled to an era: dark tones (6-7) shrink or grow with
 *  the era's dark share; the light tones absorb the difference in proportion. */
function eraWeights(group: string, year: number): Array<[number, number]> {
  const base = GROUP_TONE_WEIGHTS[group] ?? GROUP_TONE_WEIGHTS.LB;
  const total = base.reduce((s, [, w]) => s + w, 0);
  const darkBase = base.filter(([t]) => t >= 6).reduce((s, [, w]) => s + w, 0) / total;
  const factor = eraDarkShare(year) / MODERN_DARK_SHARE;
  const darkEra = Math.max(0.005, Math.min(0.95, darkBase * factor));
  const lightBase = 1 - darkBase;
  const out: Array<[number, number]> = base.map(([t, w]) => {
    const share = w / total;
    const scaled = t >= 6 ? (share / Math.max(1e-9, darkBase)) * darkEra : (share / Math.max(1e-9, lightBase)) * (1 - darkEra);
    return [t, Math.round(scaled * 1000)];
  });
  return out.sort((a, b) => b[1] - a[1]);
}

/** Modal (most common) skin tone for a position in a given era - used when we have
 *  no portrait/wiki signal. A random draw here is how Charles Rogers (Black WR)
 *  was assigned tone 2 ~7% of the time. Variety belongs on the generic *head*,
 *  not the tone, for named historical players. */
export function defaultRaceFor(label: string | null | undefined, _key?: string, year = 2015): number {
  const group = PositionMapper.groupFromId(PositionMapper.toM26Id(label ?? ''));
  return eraWeights(group, year)[0][0];
}

/** Weighted random tone - for generated UDFA fillers so a class is not a clone army. */
export function defaultRaceForVaried(label: string | null | undefined, key: string, year = 2015): number {
  const group = PositionMapper.groupFromId(PositionMapper.toM26Id(label ?? ''));
  return weightedTone(eraWeights(group, year), hashUnit(key));
}

/** P(tone) for a position label in an era — the prior the portrait evidence is
 *  weighed against (tones the table never lists get a small floor). */
export function toneDistribution(label: string | null | undefined, year = 2015): Record<number, number> {
  const group = PositionMapper.groupFromId(PositionMapper.toM26Id(label ?? ''));
  const w = eraWeights(group, year);
  const total = w.reduce((s, [, x]) => s + x, 0) || 1;
  const out: Record<number, number> = { 1: 0.01, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.01, 6: 0.01, 7: 0.01 };
  for (const [t, x] of w) out[t] = Math.max(0.01, x / total);
  return out;
}

/** Full 7-tone deterministic draw for fictional generated prospects. */
export function fictionalRaceFor(label: string | null | undefined, key: string): number {
  const group = PositionMapper.groupFromId(PositionMapper.toM26Id(label ?? ''));
  const weights = FICTIONAL_GROUP_TONE_WEIGHTS[group] ?? FICTIONAL_GROUP_TONE_WEIGHTS.LB;
  return weightedTone(weights, hashUnit(key));
}

export const SkinToneService = { defaultRaceFor, defaultRaceForVaried, fictionalRaceFor, eraDarkShare, toneDistribution };
