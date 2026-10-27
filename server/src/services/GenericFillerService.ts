import { BaselinePlayer } from '../types/player';
import { PlayerLookupService } from './PlayerLookupService';
import { CalibrationService } from './CalibrationService';
import { PositionMapper } from './PositionMapper';
import { SkinToneService } from './SkinToneService';
import { seededRng } from '../util/rng';

/**
 * Pads a draft class up to a full Madden-sized class with generated, undrafted
 * generic prospects — the way Madden fills out a draft pool. Fillers are low-rated
 * (undrafted -> low predicted caliber in RatingService), get race-appropriate
 * generic faces/portraits + era gear from the existing pipeline, and carry
 * realistic recombined names sampled from the historical name pool.
 *
 * Generation is deterministic per (year, index) so a class is reproducible.
 */

// A full Madden draft class fills all logical blocks (see DraftClassBuilder).
export const FULL_CLASS_SIZE = 402;

// Raw label to generate for each Madden position the class may be short of.
const FILL_LABEL: Record<string, string> = {
  QB: 'QB', HB: 'HB', FB: 'FB', WR: 'WR', TE: 'TE', LT: 'LT', LG: 'LG', C: 'C', RG: 'RG', RT: 'RT',
  LEDG: 'DE', REDG: 'DE', DT: 'DT', SAM: 'OLB', MIKE: 'MLB', WILL: 'OLB', CB: 'CB', FS: 'FS', SS: 'SS', K: 'K', P: 'P', LS: 'LS',
};

/** Deterministically return between 5 and 10 Long Snapper prospects for a class (Madden 27 LS roster requirement). */
export function targetLongSnapperCount(seedKey: string | number): number {
  let h = 2166136261;
  const s = String(seedKey);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 5 + ((h >>> 0) % 6); // 5, 6, 7, 8, 9, or 10
}

/** Madden's per-class count for each position (calibration perClass). */
function maddenTargets(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(FILL_LABEL)) {
    const prof = CalibrationService.positionProfile(name) as { perClass?: number };
    out[name] = prof.perClass ?? 10;
  }
  return out;
}

/** Positions for `need` fillers: repeatedly the position with the biggest shortfall
 *  against Madden's per-class count (ties by draft-board commonness), guaranteeing
 *  the dedicated Long Snapper quota first. */
function deficitPositions(
  existing: Array<{ position: string; firstName: string; lastName: string; weight?: number | null }>,
  need: number,
  targetLS = 0
): string[] {
  const have: Record<string, number> = {};
  for (const p of existing) {
    const name = PositionMapper.name(PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight ?? null));
    have[name] = (have[name] || 0) + 1;
  }
  const out: string[] = [];

  // Guarantee dedicated Long Snapper quota first
  const neededLS = Math.min(need, Math.max(0, targetLS - (have['LS'] || 0)));
  for (let i = 0; i < neededLS; i++) {
    have['LS'] = (have['LS'] || 0) + 1;
    out.push('LS');
  }

  const remainingNeed = need - neededLS;
  if (remainingNeed > 0) {
    const targets = maddenTargets();
    targets['LS'] = targetLS;
    const total = Object.values(targets).reduce((s, v) => s + v, 0) || 1;
    const scale = Math.max(1, (existing.length + need) / total);
    for (let i = 0; i < remainingNeed; i++) {
      let best = 'WR', bestGap = -Infinity;
      for (const [name, t] of Object.entries(targets)) {
        const gap = t * scale - (have[name] || 0);
        if (gap > bestGap) { best = name; bestGap = gap; }
      }
      have[best] = (have[best] || 0) + 1;
      out.push(FILL_LABEL[best]);
    }
  }
  return out;
}

export const GenericFillerService = {
  /** Generate `target - existingCount` undrafted generic prospects for a year,
   *  guaranteeing between 5 and 10 Long Snappers for Madden 27. */
  build(year: number, existing: BaselinePlayer[], target = FULL_CLASS_SIZE): BaselinePlayer[] {
    const targetLS = targetLongSnapperCount(year);
    const need = Math.max(0, target - existing.length);
    if (need === 0) return [];
    const positions = deficitPositions(existing, need, targetLS);
    const { first, last } = PlayerLookupService.namePool();
    const out: BaselinePlayer[] = [];
    for (let i = 0; i < need; i++) {
      const rand = seededRng(`filler|${year}|${i}`);
      const position = positions[i];
      // Filler is invented, so no real person is described wrongly here -- but a
      // 1940 class padded with black prospects is an anachronism on the board,
      // which is the same reason the enrichment pins real pre-1946 draftees
      // light. The NFL was segregated from 1934 to 1945.
      const race = year <= 1945
        ? 2
        : SkinToneService.defaultRaceForVaried(position, `filler|${year}|${i}|race`, year);
      const firstName = first[Math.floor(rand() * first.length)] || 'Draft';
      const lastName = last[Math.floor(rand() * last.length)] || 'Prospect';
      out.push({
        firstName,
        lastName,
        college: '',
        draftYear: year,
        draftRound: null, // undrafted -> low predicted caliber
        draftPick: null,
        position,
        jersey: null,
        league: 'NFL',
        isHOF: false,
        photoId: null,
        playerAssetsId: null, // no real asset -> generic face + generic portrait
        commId: null,
        plpo: null,
        heightInches: null, // filled from position norms in DraftClassBuilder
        weight: null,
        homeState: null,
        race,
        wikiImageUrl: null,
        pfrImageUrl: null,
        headshotUrl: null,
        careerFrom: null,
        careerTo: null,
        allPro1: null,
        proBowls: null,
        seasonsStarted: null,
        wav: null,
        wavSource: 'predicted',
        source: 'generated',
      });
    }
    return out;
  },
};
