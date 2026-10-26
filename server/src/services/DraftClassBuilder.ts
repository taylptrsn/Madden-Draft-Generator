import { MdcService, MdcProspect } from './MdcService';
import { CuratedGearService } from './CuratedGearService';
import { Mdc27Service } from './Mdc27Service';
import { assignM27Fields, commentaryIdFor, focusFor } from './M27Fields';
import { generateAttributes, reconcileToTarget, RATING_KEYS } from './AttributeModel';
import { M27RookieRatingsService, type EaRookie } from './M27RookieRatingsService';
import { genericHeadPid } from './M27Fields';
import { PortraitPackService, PackAssignment, MissingPortrait } from './PortraitPackService';
import { EraBioService } from './EraBioService';
import { PlayerLookupService } from './PlayerLookupService';
import { TwoWayService, TwoWayInfo } from './TwoWayService';
import { HometownService } from './HometownService';
export { RATING_KEYS } from './AttributeModel';
import { PersonaService } from './PersonaService';
import { LookupService } from './LookupService';
import { PositionMapper } from './PositionMapper';
import { RatingService } from './RatingService';
import { CalibrationService } from './CalibrationService';
import { ArchetypeService } from './ArchetypeService';
import { NflverseCareerService } from './NflverseCareerService';
import { OVRWeightsCalculator } from './OVRWeightsCalculator';
import { LikenessService, LikenessKind, headBuildCode, buildCompatibilityTier } from './LikenessService';
import { SkinToneService } from './SkinToneService';
import { EraGearService } from './EraGearService';
import { PhotoLookService } from './PhotoLookService';
import { PortraitSlotService } from './PortraitSlotService';
import { LaunchRatingsService, LaunchEntry } from './LaunchRatingsService';
import { AwardsService } from './AwardsService';
import { youngDev, YOUNG_SEASONS, YoungInput } from './DevTraitService';
import { BaselinePlayer, CombineMeasurements, ToneSource, nflversePick } from '../types/player';
import { SupplementalDraftService } from './SupplementalDraftService';
import { scoutingFor } from './ScoutingNotesService';
import { TeamInfo } from './TeamService';
import { PortraitService } from './PortraitService';
import { GEAR_SLOT_TYPES, slotOfElement, waistConflict } from './GearOptionsService';
import { seededRng } from '../util/rng';
import { MDC_BLOCK_SIZE, MDC_DATA_START } from '../config/paths';
import { targetLongSnapperCount } from './GenericFillerService';
import { ProspectVarianceService, type FreakMetadata, type FreakPreset } from './ProspectVarianceService';

/** Logical draft-class size the M26 template ships with (blocks 0..401). */
const LOGICAL_CAPACITY = 402;
/** Season arithmetic for young careers (completed seasons = last season - draft year + 1). */
const CURRENT_YEAR = new Date().getFullYear();

/** Rating mode: 'madden' = match Madden's realistic-rookie curve (default);
 *  'retro' = career-retrospective (OVR reflects how good they actually turned
 *  out, uncapped); 'launch' = the Realistic class, except every rookie the
 *  edition's launch roster names gets EA's release-day overall and attributes
 *  (LaunchRatingsService; years without a launch file are plain Realistic). */
export type GenMode = 'madden' | 'retro' | 'launch';

/** Query/body value -> GenMode (anything unrecognised is Realistic). */
export function parseGenMode(raw: unknown): GenMode {
  return raw === 'retro' ? 'retro' : raw === 'launch' ? 'launch' : 'madden';
}

/** Optional generation modifiers for custom draft classes (madden mode):
 *  - strength: scales the whole OVR curve (1 = normal; >1 stronger, allows >85).
 *  - studs: guarantee this many top prospects at first-round caliber (OVR>=80, dev>=SS).
 *  - generational: make the #1 prospect a can't-miss X-Factor (OVR>=90). */
export interface GenOptions {
  strength?: number;
  studs?: number;
  generational?: boolean;
  /** 0 = rate like draft day (by slot: the #1 pick leads, Brady is a 6th-rounder),
   *  1 = rate by career outcome (default). Dev traits always carry the outcome,
   *  so a hidden gem keeps his Superstar trait on a draft-day board. */
  hindsight?: number;
  /** Scale the class curve by how good the class actually was (top-32 caliber
   *  vs the 1970-2015 average), so 1983 tops out higher than 2013. */
  autoStrength?: boolean;
  /** Source-row indexes (see DroppedPlayer.idx) the user wants in the class even
   *  though the year has more players than the 402 slots: each takes the slot of
   *  the weakest remaining keeper, so everyone else's pick number is unchanged. */
  include?: number[];
  /** Player key -> M26 position id already settled elsewhere (a roster add carries
   *  the pool's balanced slot); these never move in the class-level balancing. */
  pinPositions?: Map<string, number>;
  /** M27: give retired players the game ships no portrait for a recycled portrait
   *  id and write the matching portrait pack (PortraitPackService). */
  portraitPack?: boolean;
  /** With portraitPack: also download NFL/ESPN headshots for players with no other picture. */
  portraitCdn?: boolean;
  /** Variant seed: 0 = the canonical class; any other value re-rolls every
   *  seeded choice (attribute noise, faces, gear, persona, builds) while the
   *  player list, order and overalls stay the same. */
  variant?: number;
  freakMode?: boolean;
  freakPreset?: FreakPreset;
  freakRate?: number;
  freakCap?: number;
  generationalShare?: number;
  hybridRate?: number;
  superFusionRate?: number;
  freakSeed?: number;
}

/** Reference: mean top-32 caliber of a draft class, 1970-2015 (lazily computed). */
let refTop32: number | null = null;
function referenceTop32(): number {
  if (refTop32 != null) return refTop32;
  const sums: number[] = [];
  for (let y = 1970; y <= 2015; y++) {
    const ps = PlayerLookupService.byYear(y, 'combined');
    if (ps.length < 100) continue;
    const cals = ps.map((p) => RatingService.caliber(p, PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight))).sort((a, b) => b - a).slice(0, 32);
    sums.push(cals.reduce((a, b) => a + b, 0) / cals.length);
  }
  refTop32 = sums.length ? sums.reduce((a, b) => a + b, 0) / sums.length : 80;
  return refTop32;
}

/** Elite = career wAV >= 90, or a Hall of Famer whose own career corroborates it
 *  → always X-Factor (dev 3). The source isHOF flag is name-matched and collides
 *  across same-named players (all three "Jim Brown"s read TRUE), so it's only
 *  trusted alongside real star production — otherwise an obscure same-named scrub
 *  would inherit an X-Factor trait. */
function isElite(player: BaselinePlayer): boolean {
  if ((player.wav ?? 0) >= 90) return true;
  const corroborated = (player.allPro1 ?? 0) >= 3 || (player.proBowls ?? 0) >= 5 || (player.wav ?? 0) >= 70;
  return player.isHOF === true && corroborated;
}

/** Dev trait from career caliber (used in retrospective mode). */
function devFromCaliber(caliber: number, player: BaselinePlayer): number {
  if (isElite(player)) return 3; // unconditional X-Factor (bypasses the slot cap)
  const round = player.draftRound ?? 8;
  let dev = 0;
  if (caliber >= 90 && (player.allPro1 ?? 0) >= 3) dev = 3;
  else if (caliber >= 86) dev = 2;
  else if (caliber >= 80) dev = 1;
  const slotCap = round <= 1 ? 3 : round <= 3 ? 2 : round <= 5 ? 1 : caliber >= 82 ? 1 : 0;
  return Math.min(dev, slotCap);
}

function withinRoundPick(overallPick: number | null): number {
  if (!overallPick || overallPick < 1) return 0;
  return ((overallPick - 1) % 32) + 1;
}

/** A player after the class-wide ranking pass: its final OVR (from Madden's
 *  empirical curve) and dev trait (from Madden's rates) have been assigned. */
interface RankedItem {
  player: BaselinePlayer;
  index: number;
  posId: number;
  caliber: number;
  overall: number;
  devTrait: number;
  /** EA's own Madden 27 launch entry (2026 rookies): overall, attributes, dev trait. */
  ea?: EaRookie;
  /** Launch Day lens: EA's release-day rating for this rookie (overall already applied). */
  launch?: LaunchEntry;
}

/** The class EA's Madden 27 launch ratings cover. */
const EA_LAUNCH_YEAR = 2026;
const EA_POS_ID: Record<string, number> = Object.fromEntries(Array.from({ length: 22 }, (_, id) => [PositionMapper.name(id), id]));

/** Rate the 2026 rookies exactly as Madden 27 ships them: EA's launch overall,
 *  position and dev trait (madden-school's list) replace the model's; the
 *  attributes follow in toProspect. Generated fillers and anyone EA does not
 *  list keep the model's numbers. */
function applyEaRookies(items: RankedItem[]): void {
  // Custom prospects (Class Studio) are pinned to the overall, dev trait and
  // position their author chose.
  for (const it of items) {
    const p = it.player;
    if (p.custom) {
      it.overall = p.custom.overall;
      it.devTrait = p.custom.devTrait;
      const posId = EA_POS_ID[p.position.toUpperCase()];
      if (posId != null) it.posId = posId;
    }
  }
  if (!M27RookieRatingsService.available) return;
  for (const it of items) {
    const p = it.player;
    if (p.source === 'generated' || p.draftYear !== EA_LAUNCH_YEAR) continue;
    const hit = M27RookieRatingsService.get(p.firstName, p.lastName, PositionMapper.groupFromId(it.posId));
    if (!hit) continue;
    it.ea = hit;
    it.overall = hit.ovr;
    if (hit.devTrait != null) it.devTrait = hit.devTrait;
    const posId = EA_POS_ID[hit.pos.toUpperCase()];
    if (posId != null) it.posId = posId;
  }
}

/** A custom prospect's chosen archetype, when it belongs to his position. */
function customArchetype(player: BaselinePlayer, posName: string): number | null {
  const id = player.custom?.archetype;
  if (id == null) return null;
  return (CalibrationService.archetypeOptions()[posName] ?? []).some((o) => o.id === id) ? id : null;
}

/** EA's archetype id (S_RunSupport, DE_SmallerSpeedRusher) -> the app's archetype
 *  number for this position, matched on the name with punctuation ignored. */
function eaArchetype(ea: EaRookie | undefined, posName: string): number | null {
  if (!ea?.archetype) return null;
  const want = ea.archetype.replace(/^[A-Za-z]+_/, '').toLowerCase().replace(/[^a-z]/g, '');
  const options = CalibrationService.archetypeOptions()[posName] ?? [];
  const hit = options.find((o) => o.name.toLowerCase().replace(/[^a-z]/g, '') === want);
  return hit ? hit.id : null;
}

/** Split the CSV "Home State" (really a "City, State" hometown) into a Madden
 *  state id + a city string. Falls back gracefully for state-only or city-only. */

// Position-appropriate jersey number pools (used only when no real number is known).
// Era matters: the NFL only standardised numbering in 1973 (before that receivers
// wore 20s-40s, linebackers 30s-80s), 90s went to defenders from the mid-80s, and
// 2021 opened single digits to skill players.
const JERSEY_POOLS: Record<string, Array<[number, number]>> = {
  QB: [[1, 19]], RB: [[20, 39]], WR: [[10, 19], [80, 89]], TE: [[80, 89]], OL: [[60, 79]],
  EDGE: [[90, 99], [50, 59]], IDL: [[90, 99], [70, 79]], LB: [[50, 59], [90, 99]], CB: [[20, 39]], S: [[20, 39]],
  K: [[1, 9]], P: [[1, 9]], LS: [[40, 49]],
};
const JERSEY_POOLS_PRE1973: Record<string, Array<[number, number]>> = {
  ...JERSEY_POOLS,
  WR: [[20, 49], [80, 89]], TE: [[80, 89], [40, 49]], EDGE: [[70, 89]], IDL: [[70, 79]], LB: [[50, 69], [30, 39]],
  RB: [[20, 49]], CB: [[20, 49]], S: [[20, 49]],
};
function jerseyFor(group: string, rand: () => number, year = 2000): number {
  const pools = year < 1973 ? JERSEY_POOLS_PRE1973 : year < 1986 && (group === 'EDGE' || group === 'IDL' || group === 'LB') ? JERSEY_POOLS_PRE1973 : JERSEY_POOLS;
  let ranges = pools[group] ?? [[1, 99]];
  if (year >= 2021 && (group === 'RB' || group === 'WR' || group === 'CB' || group === 'S' || group === 'LB')) ranges = [[1, 9], ...ranges];
  const total = ranges.reduce((s, [lo, hi]) => s + (hi - lo + 1), 0);
  let x = Math.floor(rand() * total);
  for (const [lo, hi] of ranges) {
    const n = hi - lo + 1;
    if (x < n) return lo + x;
    x -= n;
  }
  return ranges[0][0];
}

export type BodyType = 'Standard' | 'Thin' | 'Lean' | 'Muscular' | 'Heavy';

/** The editor's weight band per body type (Madden 27 Appearance screen). */
export const BODY_TYPE_BANDS: Record<BodyType, [number, number]> = {
  Lean: [160, 215], Standard: [175, 230], Thin: [180, 240], Muscular: [210, 285], Heavy: [280, 400],
};

/** Body type the way Madden assigns it. Two sources, combined:
 *   - the editor's weight bands (Lean 160-215, Standard 175-230, Thin 180-240,
 *     Muscular 210-285, Heavy 280+) decide what a weight can be;
 *   - the M27 career roster (3,129 real players, EA-assigned builds;
 *     scripts/probes/probe-roster-builds.ts) decides the mix inside an overlap and
 *     where EA itself ignores the band (edge rushers stay Muscular to 320 lb,
 *     tackles to 354; DBs are never Muscular; WR/CB/K use Lean when light).
 *  "Lean" is the Player table's `Freshman` (enum 4) / loadout item Lean_BodyType.
 *  `rand` (seeded) reproduces the mix so exports are stable. */
export function bodyTypeFor(posName: string, weight: number | null, rand: () => number): BodyType {
  return fitBand(posName, weight ?? 0, pickBodyType(posName, weight ?? 0, rand()));
}

/** Big men EA keeps Muscular well past the 285 band (roster: edge to 320, tackles to 354). */
const MUSCULAR_PAST_BAND = new Set(['LT', 'RT', 'LG', 'RG', 'C', 'LEDG', 'REDG', 'DT', 'FB']);

/** Pull a pick into its editor band (an out-of-band pick shows a pegged weight
 *  slider in the Appearance screen): too light steps down, too heavy steps up. */
function fitBand(posName: string, w: number, bt: BodyType): BodyType {
  const [lo, hi] = BODY_TYPE_BANDS[bt];
  if (w > hi) {
    if (bt === 'Muscular') return MUSCULAR_PAST_BAND.has(posName) ? bt : 'Heavy';
    if (bt === 'Heavy') return bt;
    return w >= 286 ? (MUSCULAR_PAST_BAND.has(posName) ? 'Muscular' : 'Heavy') : 'Muscular';
  }
  if (w < lo) {
    if (bt === 'Heavy') return 'Muscular';
    if (bt === 'Muscular') return w < 175 ? 'Lean' : 'Standard';
    return 'Lean';
  }
  return bt;
}

function pickBodyType(posName: string, w: number, r: number): BodyType {
  const pick = (a: BodyType, pa: number, b: BodyType): BodyType => (r < pa ? a : b);
  switch (posName) {
    case 'QB':
      if (w < 175) return 'Lean';
      if (w < 180) return 'Standard';
      if (w <= 230) return pick('Thin', 0.2, 'Standard');
      if (w <= 240) return 'Thin';
      return w >= 286 ? 'Heavy' : 'Muscular';
    case 'HB':
      if (w < 175) return 'Lean';
      if (w < 216) return 'Standard';
      if (w <= 240) return pick('Muscular', 0.75, 'Standard');
      return 'Muscular';
    case 'FB':
      return pick('Muscular', 0.9, 'Standard');
    case 'WR':
      if (w < 175) return 'Lean';
      if (w <= 190) return pick('Lean', 0.3, 'Standard');
      return w <= 230 ? 'Standard' : 'Muscular';
    case 'TE':
      if (w <= 230) return 'Standard';
      if (w <= 245) return pick('Standard', 0.5, 'Muscular');
      return w >= 286 ? 'Heavy' : 'Muscular';
    case 'LT': case 'RT':
      if (w < 280) return 'Muscular';
      if (w <= 300) return pick('Heavy', 0.5, 'Muscular');
      return pick('Heavy', 0.8, 'Muscular');
    case 'LG': case 'RG': case 'C':
      return w < 290 ? 'Muscular' : pick('Heavy', 0.95, 'Muscular');
    case 'LEDG': case 'REDG':
      return w >= 300 ? pick('Heavy', 0.1, 'Muscular') : 'Muscular';
    case 'DT':
      if (w < 280) return 'Muscular';
      if (w <= 300) return pick('Heavy', 0.5, 'Muscular');
      return pick('Heavy', 0.75, 'Muscular');
    case 'SAM': case 'MIKE': case 'WILL':
      if (w < 210) return 'Standard';
      if (w < 216) return pick('Muscular', 0.5, 'Standard');
      if (w <= 240) return pick('Muscular', 0.85, 'Standard');
      return 'Muscular';
    case 'CB': case 'FS': case 'SS':
      if (w < 175) return 'Lean';
      if (w <= 190) return r < 0.15 ? 'Lean' : r < 0.85 ? 'Standard' : 'Thin';
      if (w <= 215) return pick('Standard', 0.85, 'Thin');
      return w <= 230 ? 'Standard' : 'Muscular';
    case 'K': case 'P':
      if (w < 180) return 'Lean';
      if (w <= 215) return r < 0.8 ? 'Thin' : r < 0.95 ? 'Standard' : 'Lean';
      if (w <= 240) return pick('Thin', 0.85, 'Standard');
      return 'Muscular';
    case 'LS':
      // Long snappers range from normal (Standard) for lighter builds,
      // to Muscular for mid-weight builds, to lineman (Heavy) for 280+ lb builds.
      if (w < 175) return 'Lean';
      if (w <= 230) return 'Standard';
      if (w <= 240) return pick('Muscular', 0.75, 'Thin');
      if (w < 280) return 'Muscular';
      return 'Heavy';
    default:
      return w < 175 ? 'Lean' : w <= 230 ? 'Standard' : w < 286 ? 'Muscular' : 'Heavy';
  }
}

/** Convert a ranked player into an M26 prospect: attributes come from Madden's
 *  real per-position profile shifted to the assigned OVR (with small seeded
 *  per-player variance); bio from real data or Madden norms; plus likeness +
 *  era gear. */
function toProspect(it: RankedItem, portraitPid?: number, gameVersion: 'm26' | 'm27' = 'm26', mode: GenMode = 'madden', variant = 0): { prospect: MdcProspect; kind: LikenessKind } {
  const { player, index, posId, overall, devTrait } = it;
  const posName = PositionMapper.name(posId);
  const profile = CalibrationService.positionProfile(posName, gameVersion);
  const v = variant ? `|v${variant}` : '';
  const rand = seededRng(`${player.firstName}|${player.lastName}|${player.draftYear}|${index}${v}`);

  // Bio first (real measurements when we have them, else Madden per-position
  // norms) — the physical build decides the archetype, the way Madden does it.
  // Missing measurements come from the player's own era, not today's norms (a 1952
  // tackle is ~235 lb, not 318).
  const eraBuild = player.heightInches == null || player.weight == null ? EraBioService.sample(player.draftYear, PositionMapper.groupFromId(posId), rand, gameVersion) : null;
  const heightInches = it.ea?.heightInches ?? player.heightInches ?? eraBuild!.heightInches;
  const weight = Math.max(150, it.ea?.weight ?? player.weight ?? eraBuild!.weight);

  // Archetype from the real build (heavy back -> Power, lean end -> Speed Rusher),
  // then attributes from THAT archetype's profile so ratings match the role.
  // Archetype from career usage when we have it (Carter = Physical, not Slot),
  // else the closest Madden height/weight profile.
  const career = NflverseCareerService.get(player.firstName, player.lastName, player.draftYear, nflversePick(player));
  // A pre-combine quarterback with no career record has nothing to say he ran:
  // a pocket passer, not the Scrambler a lean build would suggest.
  const noRecordQb = posName === 'QB' && !career && player.combine?.forty == null && player.draftYear < 1980;
  const archetype = customArchetype(player, posName) ?? eaArchetype(it.ea, posName)
    ?? (noRecordQb ? 0 : ArchetypeService.assign(posName, heightInches, weight, career, player.combine));
  const { attrs, ovrMean } = CalibrationService.archetypeAttrs(posName, archetype, gameVersion);

  const prospect: MdcProspect = {};
  // Attributes from Madden's own per-position relationships (slope vs overall,
  // spread, range), combine testing scored within the position, then reconciled so
  // the game's on-import OVR recompute equals the OVR we intend (it ignores the
  // OVR byte). Career-retrospective mode is uncapped (legends can exceed the
  // rookie range).
  const generated = generateAttributes({
    posId, profile, archAttrs: attrs, archOvrMean: ovrMean, overall, rand,
    combine: player.combine, uncapped: mode === 'retro',
    career, draftYear: player.draftYear,
  });
  Object.assign(prospect, generated);
  prospect.archetype = archetype;
  // Two-way players: the other role lives in the ratings (Baugh punts, Blanda
  // kicks, a 1940s end covers), then the primary overall is re-solved around it.
  const twoWay = TwoWayService.rolesFor(player.firstName, player.lastName, player.draftYear, posId, nflversePick(player));
  if (twoWay) TwoWayService.apply(prospect as Record<string, number>, twoWay.roles, overall);
  // Launch Day lens: EA's own release-day attributes replace the generated ones
  // wherever the edition recorded them (older editions lack a few keys, which
  // keep the generated value); the reconcile then lands the game's recompute on
  // EA's launch overall under this archetype.
  if (it.launch) {
    for (const [k, v] of Object.entries(it.launch.attrs)) if (RATING_KEYS.includes(k)) (prospect as Record<string, number>)[k] = v;
  }
  reconcileToTarget(prospect as Record<string, number>, posId, archetype, overall, gameVersion);
  // EA's own launch attributes for a 2026 rookie replace the generated ones (all
  // but long snap, which the site does not publish); the reconcile then lands the
  // game's recompute on EA's launch overall under EA's archetype.
  if (it.ea) {
    for (const [k, v] of Object.entries(it.ea.attrs)) if (RATING_KEYS.includes(k)) (prospect as Record<string, number>)[k] = v;
    reconcileToTarget(prospect as Record<string, number>, posId, archetype, overall, gameVersion);
  }

  // Identity.
  prospect.firstName = player.firstName || 'Player';
  prospect.lastName = player.lastName || '';
  prospect.position = posId;
  prospect.college = LookupService.collegeId(player.college);
  const home = HometownService.resolve(player.homeState, player.draftYear, `${player.firstName}|${player.lastName}|${index}${v}`);
  prospect.homeState = home.state;
  prospect.homeTown = home.town;
  prospect.age = player.age ?? CalibrationService.sampleAge(rand, gameVersion);
  prospect.heightInches = heightInches;
  prospect.weight = weight;
  const group = PositionMapper.groupFromId(posId);
  prospect.jerseyNum = (it.ea?.jersey || null) ?? (player.jersey || null) ?? (career?.jersey || null) ?? jerseyFor(group, rand, player.draftYear); // 0 = unknown in the source
  prospect.bodyType = bodyTypeFor(posName, weight, rand); // the game's build mix for the position/weight
  prospect.draftable = 1;
  prospect.draftRound = player.draftRound ?? 63; // 63 = UDFA
  // A supplemental pick carries his round and in-round ordinal (0 when unknown).
  prospect.draftPick = player.supplemental ? (player.supplemental.pick ?? 0) : withinRoundPick(player.draftPick);
  prospect.overall = overall;
  prospect.devTrait = devTrait;

  // Likeness: the real head when the *target game* ships it (legend scans decoded
  // from the game's bundle tables, roster cranium heads, recent lookup ids), else a
  // generic. An asset the game lacks would render as the empty NFL-shield silhouette.
  if (player.likenessFix?.bodyType && (BODY_TYPES as readonly string[]).includes(player.likenessFix.bodyType)) {
    prospect.bodyType = player.likenessFix.bodyType as BodyType;
  }
  const playerWithBuild: BaselinePlayer = { ...player, weight, heightInches, position: posName };
  const real = LikenessService.realFace(playerWithBuild, gameVersion);
  let like = LikenessService.assign(playerWithBuild, variant ? index + variant * 1000 : index, gameVersion, String(prospect.bodyType || 'Standard'));
  // The user's likeness fix: a pinned generic head (its tone comes with it) or a
  // scan asset, applied the way a per-class face edit is. A class edit still
  // overrides this for its own class (applyEdits runs later).
  const fixAsset = player.likenessFix?.faceAsset;
  if (fixAsset) {
    const m = /^gen_(\d+)/i.exec(fixAsset);
    like = m
      ? { peps: fixAsset, kind: 'generic', skinTone: Number(m[1]) }
      : { peps: fixAsset, kind: 'asset', skinTone: like.skinTone };
  }
  prospect.PEPS = like.peps;
  // Menu portrait. M26: custom-portrait slot, else the generic head's PID, else the
  // real head's portrait id. M27: the real head's own portrait id (legends keep the
  // lookup PhotoID — the id space is shared between the games); generic heads get
  // their fixed PID here and in assignM27Fields (0x94 is a pure function of genericHeadName).
  // A real head whose portrait the game no longer ships (M27 dropped most retired
  // players' regular portraits) gets a tone-matched generic portrait, not the shield.
  const genericPortrait = () => {
    const g = like.kind === 'generic' ? like : LikenessService.generic(playerWithBuild, variant ? index + variant * 1000 : index, gameVersion, String(prospect.bodyType || 'Standard'));
    return gameVersion === 'm27' ? genericHeadPid(g.peps) : (LikenessService.genericPid(g.peps, 'm26') ?? 0);
  };
  // A generic-head legend (no renderable scan) still gets his legends portrait.
  // Legends portraits are keyed by name, so only the most accomplished player of
  // the name gets it (the 2003 CB Chris Johnson is not the 2008 Titans back).
  const legendPortrait = player.source !== 'generated' && like.kind === 'generic' && (player.draftYear ?? 0) < 2015 && PlayerLookupService.isMostNotable(player)
    ? LikenessService.legendPortraitPid(player.firstName, player.lastName, gameVersion) : 0;
  const realPid = real && !(real.portraitKind === 'legend' && !PlayerLookupService.isMostNotable(player)) ? real.portraitPid : 0;
  prospect.PID = gameVersion === 'm27'
    ? (real ? (realPid || genericPortrait()) : (legendPortrait || genericPortrait()))
    : (portraitPid ?? (like.kind === 'generic' ? (legendPortrait || genericPortrait()) : (realPid || player.photoId || genericPortrait())));
  if (gameVersion === 'm27' && !real && legendPortrait) prospect.pinPortrait = true;
  // Announcer name call: the game keys this by SURNAME (same id space in both games,
  // mined from the real files). The CSV CommID column is a different id space.
  prospect.commentaryId = commentaryIdFor(player.lastName);

  // Era-appropriate gear (vintage helmet/cleats/gloves, no visor pre-1990).
  // gameVersion selects the verified M27 equipment vocabulary for M27 exports.
  const vis: Record<string, unknown> = {
    loadouts: [EraGearService.loadout(player.draftYear, posId, `${player.firstName}|${player.lastName}|${index}${v}`, gameVersion, player.observedGear)],
  };
  // Madden 3D player models derive body/hand skin textures from genericHeadName.
  // Every prospect (real head scan or generic) must have a tone-matched genericHeadName.
  const genLikeness = (like.kind === 'generic' && /^gen_/i.test(like.peps))
    ? like
    : LikenessService.generic(playerWithBuild, variant ? index + variant * 1000 : index, gameVersion, String(prospect.bodyType || 'Standard'));
  vis.genericHeadName = genLikeness.peps;
  vis.skinTone = genLikeness.skinTone;
  prospect.visuals = vis;
  // Recorded equipment for this real player (player editor): sits on the era
  // loadout; a per-class gear edit applied later still wins.
  if (player.source !== 'custom' && player.source !== 'generated') {
    const curatedGear = CuratedGearService.get(player.firstName, player.lastName, player.draftYear);
    if (curatedGear) applyGearSlots(prospect, curatedGear);
  }

  return { prospect, kind: like.kind };
}

export interface LikenessStats {
  asset: number; // players given their real Madden face asset
  generic: number; // players given a race-appropriate generic face
  withPortrait: number; // players with a real menu portrait (PhotoID)
  customPortrait: number; // players pointed at a recycled slot for a Frosty photo
}

export interface BuildResult {
  buffer: Buffer;
  count: number;
  truncated: boolean;
  dropped: DroppedPlayer[];
  likeness: LikenessStats;
  /** M27 with opts.portraitPack: the prospects pointed at a pack portrait. */
  portraitPack?: PackAssignment[];
  /** M27 with opts.portraitPack: real players still without a picture. */
  portraitPackMissing?: MissingPortrait[];
}

/** User edits keyed by pick number -> { field: value } (overall, devTrait,
 *  position, archetype, or any rating key). Applied on top of the deterministic
 *  base class at export time so edits survive without storing the whole class. */
export type ClassEdits = Record<string, Record<string, number | string>>;

export interface PreviewRow {
  id: number; // == pick (stable; generation is deterministic)
  pick: number;
  firstName: string;
  lastName: string;
  position: string; // M26 label (e.g. "REDG")
  positionId: number;
  overall: number;
  devTrait: number;
  archetype: number;
  archetypeName: string;
  round: number | null;
  draftPick: number | null;
  /** Supplemental-draft selection: round, in-round ordinal, drafting club. */
  supplemental: { round: number; pick: number | null; team: TeamInfo | null } | null;
  wav: number | null;
  wavSource: string;
  /** Index of this player in the year's source list (stable; GenOptions.include uses it). */
  srcIdx: number;
  /** Secondary roles carried in the ratings (two-way players / the single-platoon era). */
  twoWay: TwoWayInfo | null;
  face: 'asset' | 'generic' | 'photo';
  /** Where a real head came from: 'bundle' (scan in the game files), 'roster',
   *  'legend-portrait', 'preset' (shader preset only — pending in-game check),
   *  'lookup'/'lookup-recent'/'m26-roster' (carried over, unverified). */
  faceSource: string | null;
  skinTone: number; // 1-8, for the face picker's per-tone pool
  genericHead: string | null; // current generic head code (gen_*), null if a real asset
  /** Where the skin tone came from; 'prior' and 'csv' are guesses worth a look. */
  toneSource: ToneSource | null;
  /** The user has pinned this player's likeness (LikenessOverrideService). */
  likenessFixed: boolean;
  college: string;
  age: number;
  heightInches: number;
  weight: number;
  jersey: number;
  bodyType: string; // Madden 26 build: Heavy / Muscular / Thin / Standard
  photoUrl: string | null;
  portrait?: string | null; // Madden menu-portrait URL (real or generic-by-skintone)
  team?: TeamInfo; // drafting team (from nflverse, 1980+), joined by overall pick
  combine?: CombineMeasurements | null; // NFL combine testing (nflverse, 2000+)
  persona?: string[]; // M27 persona DNA trait names (only set when gameVersion='m27')
  focus?: string; // M27 mindset focus enum name (LoveOfTheGame / Winning / PersonalAccolades / Financial)
  /** Why an LB-labeled player landed at edge vs SAM/MIKE/WILL (null for non-LB sources). */
  frontSeven?: { role: string | null; reason: string; scheme: string | null; team: string | null; sackRate: number | null } | null;
  /** The era-default equipment this prospect will export with (editor slot -> asset),
   *  so the UI can show what "Auto" means before the class is in the game. */
  gear?: Record<string, string>;
  ratings: Record<string, number>;
  /** Scout's read: Madden's draft notes for this position (ScoutingNotesService). */
  scouting?: string[];
  freak?: FreakMetadata | null;
}

/** Flatten a prospect's PlayerOnField loadout into editor slots (helmet, gloveLeft, ...). */
export function gearSlots(prospect: MdcProspect): Record<string, string> {
  const out: Record<string, string> = {};
  const vis = prospect.visuals as { loadouts?: Array<{ loadoutType?: string; loadoutElements?: Array<{ slotType?: string; itemAssetName: string; remove?: boolean }> }> } | undefined;
  const lo = vis?.loadouts?.find((l) => l.loadoutType === 'PlayerOnField');
  if (!lo?.loadoutElements) return out;
  for (const el of lo.loadoutElements) {
    if (el.remove || !el.itemAssetName) continue;
    if (!el.slotType && /^GearFaceMask_/i.test(el.itemAssetName)) { out.facemask = el.itemAssetName; continue; }
    const slot = slotOfElement(el.slotType, el.itemAssetName);
    if (slot) out[slot] = el.itemAssetName;
  }
  return out;
}

export interface PreviewResult {
  rows: PreviewRow[];
  likeness: LikenessStats;
  count: number;
  /** Players that did not fit the class (years with > 402 rows): the weakest by
   *  caliber + draft slot. `idx` is the stable source-row index used by
   *  GenOptions.include. */
  dropped: DroppedPlayer[];
  /** Source-row indexes that were forced in (echo of GenOptions.include). */
  included: number[];
  /** Rows rated from EA's launch roster (0 unless the Launch Day lens found data). */
  launchCount: number;
}

export interface DroppedPlayer {
  idx: number;
  firstName: string;
  lastName: string;
  position: string;
  round: number | null;
  pick: number | null;
  college: string;
  wav: number | null;
  /** Keep-score the cut was made on (caliber + slot expectation), for the panel's order. */
  score: number;
}

/**
 * Cut a year with more rows than the class holds down to capacity. The source is in
 * draft order, so a naive slice drops whoever happens to be last (1960: Bob Talamini
 * at index 428). Instead drop the lowest-caliber UNDRAFTED players first, then the
 * lowest-caliber late picks, and keep the survivors in their original order.
 * Long Snappers are protected up to the class target (5-10 for Madden 27).
 */
function fitToCapacity(players: BaselinePlayer[], include: number[] = []): { kept: BaselinePlayer[]; keptIdx: number[]; dropped: DroppedPlayer[]; included: number[] } {
  if (players.length <= LOGICAL_CAPACITY) return { kept: players, keptIdx: players.map((_, i) => i), dropped: [], included: [] };
  // Keep-score = career caliber + what the draft slot promised: a first-round bust
  // stays (he was a real prospect), a 17th-rounder who never played goes first,
  // and an undrafted star (Warner) outranks both of those.
  const score = (p: BaselinePlayer) => {
    const posId = PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight);
    const slot = p.draftRound != null ? RatingService.slotExpectation(p.draftRound, p.draftPick) : 0;
    return RatingService.caliber(p, posId) + slot;
  };
  const isLS = (p: BaselinePlayer) => PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight) === 21;
  const classYear = players[0]?.draftYear ?? 2026;
  const targetLS = targetLongSnapperCount(classYear);
  const totalLS = players.filter(isLS).length;
  const maxDropLS = Math.max(0, totalLS - targetLS);

  const scores = players.map(score);
  const order = players.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);

  const numToDrop = players.length - LOGICAL_CAPACITY;
  const drop = new Set<number>();
  let droppedLS = 0;
  for (const i of order) {
    if (drop.size >= numToDrop) break;
    if (isLS(players[i])) {
      if (droppedLS < maxDropLS) {
        drop.add(i);
        droppedLS++;
      }
    } else {
      drop.add(i);
    }
  }
  if (drop.size < numToDrop) {
    for (const i of order) {
      if (drop.size >= numToDrop) break;
      drop.add(i);
    }
  }

  // Baseline keep list in source order; pick numbers follow from it.
  const keptIdx = players.map((_, i) => i).filter((i) => !drop.has(i));
  // Forced inclusions swap into the slot of the weakest remaining keeper (never a
  // forced one), so every other prospect keeps its pick number and its edits.
  const forced = new Set(include.filter((i) => Number.isInteger(i) && i >= 0 && i < players.length && drop.has(i)));
  const included: number[] = [];
  for (const i of forced) {
    let victimPos = -1;
    for (let k = 0; k < keptIdx.length; k++) {
      const j = keptIdx[k];
      if (forced.has(j) || included.includes(j)) continue;
      // Protect LS from forced inclusion eviction if at or below targetLS
      const currentKeptLS = keptIdx.filter(idx => !drop.has(idx) && isLS(players[idx])).length;
      if (isLS(players[j]) && currentKeptLS <= targetLS) continue;
      if (victimPos < 0 || scores[j] < scores[keptIdx[victimPos]]) victimPos = k;
    }
    if (victimPos < 0) {
      for (let k = 0; k < keptIdx.length; k++) {
        const j = keptIdx[k];
        if (forced.has(j) || included.includes(j)) continue;
        if (victimPos < 0 || scores[j] < scores[keptIdx[victimPos]]) victimPos = k;
      }
    }
    if (victimPos < 0) break;
    drop.add(keptIdx[victimPos]);
    drop.delete(i);
    keptIdx[victimPos] = i;
    included.push(i);
  }
  const kept = keptIdx.map((i) => players[i]);
  const dropped: DroppedPlayer[] = [...drop].sort((a, b) => scores[b] - scores[a]).map((i) => {
    const p = players[i];
    return { idx: i, firstName: p.firstName, lastName: p.lastName, position: p.position, round: p.draftRound ?? null, pick: p.draftPick ?? null, college: p.college || '', wav: p.wav ?? null, score: Math.round(scores[i] * 10) / 10 };
  });
  return { kept, keptIdx, dropped, included };
}

/** Canonical capped draft positions, also used by the historical pool. */
export function draftPositions(players: BaselinePlayer[], opts: GenOptions = {}) {
  const { kept: capped, keptIdx, dropped, included } = fitToCapacity(players, opts.include ?? []);
  // Resolve each player's M26 position, then even out the two cohorts the source
  // data badly over-concentrates: edges (nearly all labeled "LE" -> LEDG, ~85/15)
  // and off-ball LBs (nearly all "MLB" -> MIKE, ~80-98%). Side/role is cosmetic
  // within each cohort (LEDG/REDG share the EDGE group; SAM/MIKE/WILL share LB),
  // so round-robin each to an even split — deterministic, so preview == export.
  // Offensive-line sides and safeties: the source lumps tackles as "T"/"OT" (-> LT)
  // and guards as "G" (-> LG), and pre-2001 safeties are split by build. Balance
  // toward Madden's own mix (LT 20 / RT 16, LG 13 / RG 13, FS 16 / SS 16 per
  // class) around the players whose slot came from real data (PositionMapper.balanceBoard).
  const pins = opts.pinPositions;
  const resolved = capped.map((p) => (p.key ? pins?.get(p.key) : undefined) ?? PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight));
  const posIds = PositionMapper.balanceBoard(resolved, capped, capped.map((p) => !!p.key && !!pins?.has(p.key)));

  // Ensure 5-10 Long Snappers for Madden 27
  const classYear = capped[0]?.draftYear ?? 2026;
  const targetLS = targetLongSnapperCount(classYear);
  const currentLS = posIds.filter((id) => id === 21).length;
  const candidates: number[] = [];
  if (currentLS < targetLS) {
    const needed = targetLS - currentLS;
    // First pass: lowest-risk fringe players (late round / UDFA, low wAV, no accolades)
    for (let i = capped.length - 1; i >= 0 && candidates.length < needed; i--) {
      const p = capped[i];
      if (pins?.has(p.key ?? '')) continue;
      if (included.includes(keptIdx[i])) continue;
      if (posIds[i] === 21 || posIds[i] === 19 || posIds[i] === 20) continue;
      if (p.isHOF || (p.proBowls ?? 0) > 0 || (p.allPro1 ?? 0) > 0) continue;
      if ((p.wav ?? 0) > 4) continue;
      if (p.draftRound != null && p.draftRound < 6) continue;
      candidates.push(i);
    }
    // Second pass: fallback if needed (preserve HOF and specialists)
    if (candidates.length < needed) {
      for (let i = capped.length - 1; i >= 0 && candidates.length < needed; i--) {
        if (candidates.includes(i)) continue;
        const p = capped[i];
        if (pins?.has(p.key ?? '')) continue;
        if (included.includes(keptIdx[i])) continue;
        if (posIds[i] === 21 || posIds[i] === 19 || posIds[i] === 20) continue;
        if (p.isHOF) continue;
        candidates.push(i);
      }
    }
    for (const idx of candidates) {
      posIds[idx] = 21;
      const prev = capped[idx];
      capped[idx] = {
        ...prev,
        position: 'LS',
        race: prev.source === 'generated'
          ? SkinToneService.fictionalRaceFor('LS', `${prev.firstName}|${prev.lastName}|${idx}|ls`)
          : prev.race,
      };
    }
  }

  // Ensure all Long Snappers (converted, filler, or historical) have realistic, diverse builds:
  // a mix of normal (~224-230 lbs -> Standard), muscular (~242-262 lbs -> Muscular),
  // and lineman (~280-292 lbs -> Heavy).
  const convertedSet = new Set<number>(candidates);
  const lsIndices = capped.map((_, i) => i).filter((i) => posIds[i] === 21);
  lsIndices.forEach((idx, ordinal) => {
    const p = capped[idx];
    const isConvertedOrFiller = convertedSet.has(idx) || p.source === 'generated';
    if (isConvertedOrFiller || p.weight == null || p.weight > 295 || p.weight < 215 || p.heightInches == null) {
      const rand = seededRng(`ls_build|${classYear}|${ordinal}`);
      // Mix: ordinal % 4 === 0 -> Heavy (lineman), 1 -> Standard (normal), otherwise -> Muscular
      const bucket = ordinal % 4;
      let targetWt: number;
      let targetHt: number;
      if (bucket === 1) {
        // Normal/stocky center build (~224-230 lbs -> Standard)
        targetWt = Math.round(224 + rand() * 6);
        targetHt = Math.round(71 + rand() * 3);
      } else if (bucket === 0) {
        // Lineman build (~280-292 lbs -> Heavy)
        targetWt = Math.round(280 + rand() * 12);
        targetHt = Math.round(74 + rand() * 3);
      } else {
        // Athletic/muscular build (~242-262 lbs -> Muscular)
        targetWt = Math.round(242 + rand() * 20);
        targetHt = Math.round(73 + rand() * 3);
      }
      capped[idx] = {
        ...p,
        position: 'LS',
        heightInches: isConvertedOrFiller ? targetHt : (p.heightInches ?? targetHt),
        weight: (!isConvertedOrFiller && p.weight != null && p.weight >= 215 && p.weight <= 295) ? p.weight : targetWt,
      };
    }
  });

  return { capped, keptIdx, dropped, included, posIds };
}

/** Valid Madden 26 body types (from the shipped template's visuals JSON). */
export const BODY_TYPES = ['Standard', 'Thin', 'Lean', 'Muscular', 'Heavy'];

// Per-field clamp ranges for non-rating numeric fields (everything else = 0-99).
const EDIT_CLAMP: Record<string, [number, number]> = {
  position: [0, 21], devTrait: [0, 3], archetype: [0, 67], college: [0, 493],
  homeState: [0, 50], heightInches: [60, 84], weight: [140, 400], age: [18, 45], jerseyNum: [0, 99],
};

/** Apply user edits (by pick) onto generated prospects, clamping to valid ranges.
 *  String fields (firstName/lastName/homeTown) are set as text; everything else is
 *  a number clamped to its field range (ratings 0-99). */
/** Edits that change Madden's OVR recompute (it recomputes from attributes on import,
 *  so a bare OVR/position/archetype change must reshape the skill attributes to match). */
const RECONCILE_TRIGGERS = new Set(['overall', 'position', 'archetype']);

export function applyEdits(prospects: MdcProspect[], edits?: ClassEdits, gameVersion: 'm26' | 'm27' = 'm26'): void {
  if (!edits) return;
  for (const [pickStr, patch] of Object.entries(edits)) {
    const p = prospects[Number(pickStr) - 1];
    if (!p || !patch) continue;
    for (const [k, raw] of Object.entries(patch)) {
      if (k === 'firstName' || k === 'lastName' || k === 'homeTown') {
        if (typeof raw === 'string') p[k] = raw.slice(0, k === 'lastName' ? 20 : 16);
        continue;
      }
      if (k === 'bodyType') {
        if (BODY_TYPES.includes(String(raw))) {
          const newBt = String(raw);
          p.bodyType = newBt;
          const peps = String(p.PEPS || '');
          if (/^gen_/i.test(peps) && !('genericHeadName' in patch) && !('faceAsset' in patch)) {
            if (buildCompatibilityTier(headBuildCode(peps), newBt) === 0) {
              const vis = ((p.visuals ??= {}) as { genericHeadName?: string; skinTone?: number });
              const tone = Number(vis.skinTone) || Number(( /^gen_(\d+)/i.exec(peps) ?? [])[1]) || 4;
              const posName = PositionMapper.name(Number(p.position) || 0);
              const g = LikenessService.generic(
                { firstName: String(p.firstName || ''), lastName: String(p.lastName || ''), race: tone, position: posName, weight: Number(p.weight) || 220 } as BaselinePlayer,
                0,
                gameVersion,
                newBt
              );
              p.PEPS = g.peps;
              vis.genericHeadName = g.peps;
              delete p.pinPortrait;
              p.PID = gameVersion === 'm27' ? genericHeadPid(g.peps) : (LikenessService.genericPid(g.peps, 'm26') ?? 0);
            }
          }
        }
        continue;
      }
      // Persona DNA edit (M27): comma-separated trait id string -> number[]
      // (validated against the DNA enum range, deduped, capped at the 5 slots
      // the draft binary holds). Set before buildMdc27's default assignment,
      // which skips players who already carry an explicit set.
      if (k === 'personaDNA') {
        const ids = String(raw)
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 63 && n !== 2); // 2 = WinAtAllCosts (game filters it from rookies)
        p.personaDNA = [...new Set(ids)].slice(0, 5);
        continue;
      }
      // Mindset focus edit (M27): one of the four PersonaFocus ids. Set before
      // assignM27Fields, which only samples a focus for players without one.
      if (k === 'focus') {
        const n = Number(raw);
        if ([0, 1, 2, 3].includes(n)) p.focus = n;
        continue;
      }
      // Face pick: a gen_* generic head code. Drive it via PEPS (M26Writer routes a
      // GEN_ PEPS into visuals.genericHeadName); mirror into visuals for safety.
      if (k === 'skinTone') {
        const t = Math.max(1, Math.min(8, Number(raw)));
        if (Number.isFinite(t)) {
          const vis = ((p.visuals ??= {}) as { genericHeadName?: string; skinTone?: number });
          vis.skinTone = t;
          if (!('genericHeadName' in patch) && (!vis.genericHeadName || !new RegExp(`^gen_${t}_`, 'i').test(vis.genericHeadName))) {
            const bt = String(p.bodyType || 'Standard');
            const posName = PositionMapper.name(Number(p.position) || 0);
            const g = LikenessService.generic(
              { firstName: String(p.firstName || ''), lastName: String(p.lastName || ''), race: t, position: posName, weight: Number(p.weight) || 220 } as BaselinePlayer,
              0,
              gameVersion,
              bt
            );
            vis.genericHeadName = g.peps;
            if (/^gen_/i.test(String(p.PEPS || '')) && !('faceAsset' in patch)) {
              p.PEPS = g.peps;
              delete p.pinPortrait;
              p.PID = gameVersion === 'm27' ? genericHeadPid(g.peps) : (LikenessService.genericPid(g.peps, 'm26') ?? 0);
            }
          }
        }
        continue;
      }
      if (k === 'faceAsset') {
        const asset = String(raw).trim();
        if (asset && !/^gen_/i.test(asset)) {
          p.PEPS = asset;
          const vis = ((p.visuals ??= {}) as { genericHeadName?: string; skinTone?: number });
          const patchTone = 'skinTone' in patch ? Math.max(1, Math.min(8, Number(patch.skinTone))) : 0;
          const tone = (Number.isFinite(patchTone) && patchTone > 0 ? patchTone : 0) || Number(vis.skinTone) || (Number(p.race) >= 1 && Number(p.race) <= 8 ? Number(p.race) : 7);
          if (!vis.genericHeadName || !new RegExp(`^gen_${tone}_`, 'i').test(vis.genericHeadName)) {
            const bt = String(p.bodyType || 'Standard');
            const posName = PositionMapper.name(Number(p.position) || 0);
            const g = LikenessService.generic(
              { firstName: String(p.firstName || ''), lastName: String(p.lastName || ''), race: tone, position: posName, weight: Number(p.weight) || 220 } as BaselinePlayer,
              0,
              gameVersion,
              bt
            );
            vis.genericHeadName = g.peps;
            vis.skinTone = tone;
          }
        }
        continue;
      }
      if (k === 'genericHeadName') {
        const code = String(raw);
        if (/^gen_\d/i.test(code)) {
          p.PEPS = code;
          const vis = ((p.visuals ??= {}) as { genericHeadName?: string; skinTone?: number });
          vis.genericHeadName = code;
          const m = code.match(/^gen_(\d+)/i);
          if (m) vis.skinTone = Number(m[1]);
          delete p.pinPortrait;
          p.PID = gameVersion === 'm27' ? genericHeadPid(code) : (LikenessService.genericPid(code, 'm26') ?? 0);
        }
        continue;
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      const [lo, hi] = EDIT_CLAMP[k] ?? [0, 99];
      p[k] = Math.max(lo, Math.min(hi, Math.round(v)));
    }
    // If the OVR/position/archetype changed, re-solve the skill attributes so Madden's
    // in-game recompute matches the edited OVR — then re-apply any explicit rating edits
    // from this patch so a hand-tuned rating still wins over the reconciliation.
    if (Object.keys(patch).some((k) => RECONCILE_TRIGGERS.has(k))) {
      reconcileToTarget(p as Record<string, number>, Number(p.position), Number(p.archetype), Number(p.overall), gameVersion);
      for (const [k, raw] of Object.entries(patch)) {
        if (!RATING_KEYS.includes(k)) continue;
        const v = Number(raw);
        if (Number.isFinite(v)) p[k] = Math.max(0, Math.min(99, Math.round(v)));
      }
    }
  }
}

/** Per-player gear overrides keyed by pick -> { slot: assetName } (slot is
 *  helmet/cleats/gloves/visor). Applied on top of the era-default loadout at
 *  export so the user's equipment-editor picks win. */
export type GearEdits = Record<string, Record<string, string>>;

/** Apply gear overrides onto each prospect's PlayerOnField loadout in place. */
export function applyGearEdits(prospects: MdcProspect[], gearEdits?: GearEdits): void {
  if (!gearEdits) return;
  for (const [pickStr, slots] of Object.entries(gearEdits)) {
    const p = prospects[Number(pickStr) - 1];
    if (!p || !slots) continue;
    applyGearSlots(p, slots);
  }
}

/** Write editor slots (helmet, gloveLeft, facemask, ...) into one prospect's PlayerOnField loadout. */
export function applyGearSlots(p: MdcProspect, slots: Record<string, string | undefined>): void {
  const visuals = (p.visuals ?? {}) as { loadouts?: Array<{ loadoutType?: string; loadoutElements?: Array<{ slotType?: string; itemAssetName: string }> }> };
  const loadout = visuals.loadouts?.[0];
  if (!loadout) return;
  const els = (loadout.loadoutElements ??= []);
  for (const [slot, asset] of Object.entries(slots)) {
    if (!asset || waistConflict(slots, slot)) continue;
    // Facemask is a SLOTLESS element (itemAssetName GearFaceMask_*, no slotType):
    // replace the existing prefix-matched element or push a new one.
    if (slot === 'facemask') {
      const existing = els.find((e) => !e.slotType && e.itemAssetName?.startsWith('GearFaceMask_'));
      if (existing) existing.itemAssetName = asset;
      else els.push({ itemAssetName: asset });
      continue;
    }
    for (const slotType of GEAR_SLOT_TYPES[slot] ?? []) {
      const existing = els.find((e) => e.slotType === slotType);
      if (existing) existing.itemAssetName = asset;
      else els.push({ slotType, itemAssetName: asset });
    }
  }
}

/** Zero a block's 200-byte attribute section so the game ignores it. */
export function neutralizeBlock(buf: Buffer, blockIndex: number): void {
  const attrStart = MDC_DATA_START + blockIndex * MDC_BLOCK_SIZE + 0x1000;
  if (attrStart + 200 > buf.length) return;
  buf.fill(0, attrStart, attrStart + 200);
}

export const DraftClassBuilder = {
  /** Build prospect objects for export (block i = pick i), honoring the cap. */
  buildProspects(
    players: BaselinePlayer[],
    mode: GenMode = 'madden',
    opts: GenOptions = {},
    gameVersion: 'm26' | 'm27' = 'm26'
  ): {
    prospects: MdcProspect[];
    sourceIndices: number[];
    truncated: boolean;
    dropped: DroppedPlayer[];
    included: number[];
    likeness: LikenessStats;
    /** Prospect indexes rated from EA's launch roster (Launch Day lens only). */
    launchIdx: number[];
    freakMap: Map<number, FreakMetadata>;
    capped?: BaselinePlayer[];
  } {
    const { capped, keptIdx, dropped, included, posIds } = draftPositions(players, opts);
    const portraitMap = gameVersion === 'm27' ? new Map<number, number>() : PortraitSlotService.pidMap(capped);

    const items: RankedItem[] = capped.map((player, index) => {
      const posId = posIds[index];
      return { player, index, posId, caliber: RatingService.caliber(player, posId), overall: 0, devTrait: 0 };
    });

    if (mode === 'retro') {
      // Career-retrospective: OVR reflects how good they actually turned out
      // (uncapped wAV caliber), dev from that caliber. NOT Madden-shaped.
      for (const it of items) {
        it.overall = it.caliber;
        it.devTrait = devFromCaliber(it.caliber, it.player);
      }
    } else {
      // Madden-realistic: rank by caliber, then map each rank to Madden's
      // empirical OVR curve + dev-trait rates (real Madden class shape).
      const N = items.length || 1;
      let strength = opts.strength && opts.strength > 0 ? opts.strength : 1;
      if (opts.autoStrength) {
        // How good was this class really? Top-32 caliber against the 1970-2015 norm,
        // damped to a +-15% curve multiplier.
        const top = [...items].map((it) => it.caliber).sort((a, b) => b - a).slice(0, 32);
        const mean = top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
        strength *= Math.max(0.85, Math.min(1.15, 1 + 0.6 * (mean / referenceTop32() - 1)));
      }
      const studs = Math.max(0, Math.round(opts.studs ?? 0));
      // A stronger class raises the ceiling above the usual realistic 85 cap.
      const capMax = Math.round(85 + Math.max(0, strength - 1) * 40);
      const hindsight = Math.max(0, Math.min(1, opts.hindsight ?? 1));
      // Dev traits always follow the true outcome (rank by caliber)...
      const outcomeRank = new Map<RankedItem, number>();
      [...items].sort((a, b) => b.caliber - a.caliber).forEach((it, rank) => outcomeRank.set(it, rank));
      // An elite career is promoted to X-Factor past whatever his draft slot
      // said -- but only the best few. Unbounded, the promotion stops being a
      // promotion: an all-time class is 335 elite players, so 83% of it came
      // out X-Factor and the Superstar tier emptied completely, because every
      // player in that band was also elite. A class is still a Madden class,
      // so the promotion gets a ceiling and the calibrated rates carry the rest.
      const eliteCap = Math.max(3, Math.round(N * 0.02));
      const promoted = new Set(
        items
          .filter((it) => isElite(it.player))
          .sort((a, b) => b.caliber - a.caliber)
          .slice(0, eliteCap)
      );
      // ...while the overall order blends outcome with what the draft slot said.
      const boardScore = (it: RankedItem) => hindsight * it.caliber + (1 - hindsight) * RatingService.slotCaliber(it.player, it.posId);
      const board = [...items].sort((a, b) => boardScore(b) - boardScore(a));
      board.forEach((it, rank) => {
        const topFrac = (rank + 0.5) / N; // 0 = best player on the board
        const outcomeFrac = ((outcomeRank.get(it) ?? rank) + 0.5) / N;
        const base = CalibrationService.ovrAtPercentile(1 - topFrac, gameVersion);
        it.overall = Math.min(capMax, Math.round(base * strength));
        it.devTrait = promoted.has(it) ? 3 : CalibrationService.devForTopFraction(outcomeFrac, gameVersion);
      });

      // Long Snappers in Madden 27 are dedicated specialists (mean ~70 OVR in EA template / launch rosters, range 64-76).
      // They sit at the bottom of the draft board as late picks / UDFAs, but their specialist OVR must not collapse to 53-56,
      // which would force their longSnap rating down into the 40s.
      const lsItems = board.filter((it) => it.posId === 21);
      if (lsItems.length > 0) {
        const sortedLs = [...lsItems].sort((a, b) => b.caliber - a.caliber);
        sortedLs.forEach((it, lsRank) => {
          const lsFrac = (lsRank + 0.5) / sortedLs.length;
          // Scale from 75 down to 65 across the class cohort
          const lsBase = Math.round(76 - lsFrac * 8);
          const careerBonus = Math.min(4, Math.round((it.player.wav ?? 0) / 3));
          const targetLsOvr = Math.min(capMax, Math.round((lsBase + careerBonus) * strength));
          it.overall = Math.max(64, Math.min(80, targetLsOvr));
        });
      }
      // Young careers (drafted within the last YOUNG_SEASONS completed seasons): two
      // seasons of wAV are not an outcome, so their dev traits come from AP awards,
      // All-Pro / Pro Bowl counts and wAV production pace instead of the ranking
      // above. X-Factor is earned by awards or wAV alone -- never by quota or slot.
      // Single-year classes only: in an all-time or hand-picked class a 2018 draftee
      // is ranked against whole careers, and the class keeps Madden's tier shape.
      const singleYear = new Set(items.map((it) => it.player.draftYear)).size === 1;
      const young = singleYear ? items.filter((it) => it.player.source !== 'generated' && it.player.draftYear >= CURRENT_YEAR - YOUNG_SEASONS) : [];
      if (young.length) {
        const inputs: YoungInput[] = young.map((it) => {
          const p = it.player;
          const grp = PositionMapper.groupFromId(it.posId);
          return {
            key: String(it.index), posGroup: grp, draftYear: p.draftYear, careerTo: p.careerTo,
            wav: p.wav, wavActual: p.wavSource === 'actual' && p.wav != null,
            ap1: p.allPro1 ?? 0, pb: p.proBowls ?? 0,
            awards: AwardsService.awardsFor(p.firstName, p.lastName, p.draftYear, grp, p.careerTo),
            round: p.draftRound, pick: p.draftPick, caliber: it.caliber, elite: isElite(p),
          };
        });
        // Quotas scale against the whole class, generated fillers included.
        const devs = youngDev(inputs, CURRENT_YEAR, N);
        for (const it of young) {
          const d = devs.get(String(it.index));
          if (d != null) it.devTrait = d;
        }
      }
      applyEaRookies(items);
      // The user's own modifiers have the last word.
      board.forEach((it, rank) => {
        if (rank < studs) {
          it.overall = Math.max(it.overall, 80); // guaranteed first-round caliber
          it.devTrait = Math.max(it.devTrait, 2);
        }
        if (opts.generational && rank === 0) {
          it.overall = Math.max(it.overall, 90); // a can't-miss #1
          it.devTrait = 3;
        }
      });
      applyEaRookies(items);
    }

    // Launch Day lens: EA's release-day overall for every rookie the edition's
    // launch roster names. The Realistic curve stands for everyone else, for the
    // generated fillers, and for whole years with no launch file. Dev traits are
    // untouched: the launch rosters do not record them.
    if (mode === 'launch') {
      for (const it of items) {
        if (it.player.source === 'generated') continue;
        const hit = LaunchRatingsService.get(it.player.firstName, it.player.lastName, it.player.draftYear, it.posId, it.player.college);
        if (hit) { it.overall = hit.ovr; it.launch = hit; }
      }
    }
    const launchIdx = items.filter((it) => it.launch).map((it) => it.index);

    const built = items.map((it) => toProspect(it, portraitMap.get(it.index), gameVersion, mode, opts.variant ?? 0));
    const prospects = built.map((b) => b.prospect);
    const freakMap = opts.freakMode
      ? ProspectVarianceService.applyVarianceAndFreaks(
          prospects,
          capped,
          {
            enabled: true,
            preset: opts.freakPreset,
            freakRate: opts.freakRate,
            freakCap: opts.freakCap,
            generationalShare: opts.generationalShare,
            hybridRate: opts.hybridRate,
            superFusionRate: opts.superFusionRate,
            seed: opts.freakSeed ?? (opts.variant ? opts.variant * 1000 + 2027 : 2027),
          },
          gameVersion
        )
      : new Map<number, FreakMetadata>();

    // Balance generic heads across the class and synchronize heads/portraits with
    // each prospect's final post-variance bodyType ('Heavy', 'Muscular', 'Standard', 'Thin', 'Lean').
    LikenessService.balanceClassGenericHeads(
      prospects as unknown as Array<Record<string, unknown>>,
      capped,
      gameVersion,
      opts.variant ?? 0
    );
    for (let i = 0; i < prospects.length; i++) {
      const p = prospects[i];
      const peps = String(p.PEPS || '');
      if (/^gen_/i.test(peps) && !p.pinPortrait) {
        const customPid = portraitMap.get(i);
        if (gameVersion === 'm27') {
          p.PID = genericHeadPid(peps);
        } else if (!customPid) {
          const legendPid = (capped[i]?.draftYear ?? 0) < 2015 && PlayerLookupService.isMostNotable(capped[i])
            ? LikenessService.legendPortraitPid(capped[i].firstName, capped[i].lastName, gameVersion)
            : 0;
          p.PID = legendPid || (LikenessService.genericPid(peps, 'm26') ?? 0);
        }
      }
    }

    const likeness: LikenessStats = {
      asset: built.filter((b) => b.kind === 'asset').length,
      generic: built.filter((b) => b.kind === 'generic').length,
      withPortrait: capped.filter((p) => p.photoId != null).length,
      customPortrait: portraitMap.size,
    };
    return { prospects, sourceIndices: keptIdx, truncated: dropped.length > 0, dropped, included, likeness, launchIdx, freakMap, capped };
  },

  /** Full JSON preview of the generated class for the UI: per-player bio, photo,
   *  and the complete editable attribute set (no .mdc written). When
   *  gameVersion='m27', each row also carries its persona DNA trait names. */
  preview(players: BaselinePlayer[], mode: GenMode = 'madden', opts: GenOptions = {}, gameVersion: 'm26' | 'm27' = 'm26'): PreviewResult {
    const { prospects, likeness, dropped, included, launchIdx, freakMap, capped: builtCapped } = this.buildProspects(players, mode, opts, gameVersion);
    const { kept: initialCapped, keptIdx } = fitToCapacity(players, opts.include ?? []);
    const capped = builtCapped ?? initialCapped;
    const portraitMap = gameVersion === 'm27' ? new Map<number, number>() : PortraitSlotService.pidMap(capped);
    const launched = new Set(launchIdx);
    const rows: PreviewRow[] = prospects.map((p, i) => {
      const peps = String(p.PEPS || '').toLowerCase();
      const face: 'asset' | 'generic' | 'photo' = portraitMap.has(i)
        ? 'photo'
        : (peps.startsWith('gen_') || capped[i]?.source === 'generated')
          ? 'generic'
          : 'asset';
      const base = capped[i];
      // The real head this game renders for him (null for a generic), once: it
      // names the face's provenance and, when the lookup has no PhotoID for him,
      // the portrait the game ships with that head (a roster rookie like the
      // 2023 Will Anderson Jr.).
      const real = face === 'asset' ? LikenessService.realFace(base, gameVersion) : null;
      const ratings: Record<string, number> = {};
      for (const k of RATING_KEYS) ratings[k] = Number(p[k]) || 0;
      // Same seed/group/OVR the M27 writer uses, so the UI shows the DNA that exports.
      const persona = gameVersion === 'm27'
        ? PersonaService.dnaFor(
            `${p.firstName}|${p.lastName}`,
            PositionMapper.groupFromId(Number(p.position) || 0),
            Number(p.overall) || 0,
            Number(p.devTrait) || 0
          ).map(PersonaService.name)
        : undefined;
      // Same seed the M27 writer hands assignM27Fields, so the card shows the focus that exports.
      const focus = gameVersion === 'm27'
        ? PersonaService.focusName(focusFor(`${p.firstName}|${p.lastName}|${i}${opts.variant ? `|v${opts.variant}` : ''}`))
        : undefined;
      return {
        id: i + 1,
        pick: i + 1,
        firstName: String(p.firstName ?? ''),
        lastName: String(p.lastName ?? ''),
        position: PositionMapper.name(Number(p.position)),
        positionId: Number(p.position),
        overall: Number(p.overall),
        devTrait: Number(p.devTrait),
        archetype: Number(p.archetype) || 0,
        archetypeName: LookupService.idToName('archetype', Number(p.archetype) || 0) || '',
        round: base.draftRound,
        draftPick: base.draftPick,
        supplemental: base.supplemental ? { round: base.supplemental.round, pick: base.supplemental.pick, team: SupplementalDraftService.teamInfo(base.supplemental.team, base.draftYear) } : null,
        // Predicted players (pre-1960 / missing wAV): show the draft-slot estimate
        // (matches what actually drives their OVR) instead of the raw/absent value.
        wav: base.wavSource === 'predicted' ? RatingService.predictedWav(base) : base.wav,
        // 'launch' = overall and attributes are EA's release-day numbers (Launch Day lens).
        wavSource: launched.has(i) ? 'launch' : base.wavSource,
        srcIdx: keptIdx[i],
        twoWay: TwoWayService.rolesFor(base.firstName, base.lastName, base.draftYear, Number(p.position) || 0, nflversePick(base)),
        face,
        faceSource: face === 'asset' ? (real?.source ?? 'lookup') : null,
        skinTone: (() => {
          const visTone = Number((p.visuals as { skinTone?: number } | undefined)?.skinTone);
          if (visTone >= 1 && visTone <= 8) return visTone;
          return Number(base.race) >= 1 && Number(base.race) <= 8 ? Number(base.race) : 4;
        })(),
        genericHead: peps.startsWith('gen_') ? String(p.PEPS) : null,
        toneSource: base.toneSource ?? null,
        likenessFixed: !!base.likenessFixed,
        college: base.college,
        age: Number(p.age) || 0,
        heightInches: Number(p.heightInches) || 0,
        weight: Number(p.weight) || 0,
        jersey: Number(p.jerseyNum) || 0,
        bodyType: String(p.bodyType || 'Standard'),
        // The row's OWN draft year, not the class year: an all-time or decade
        // class mixes players from many drafts, and the retro photo guard needs
        // to know when this man played.
        draftYear: base.draftYear,
        photoUrl: base.source === 'generated' ? null : (PhotoLookService.bestPhotoUrl(base) || null),
        portrait: (() => {
          const visTone = Number((p.visuals as { skinTone?: number } | undefined)?.skinTone) || base.race;
          const pid = Number(p.PID) || 0;
          let plpo = pid ? PortraitService.plpoForPid(pid) : null;
          if (!plpo) {
            plpo = PortraitService.plpoFor(
              pid,
              visTone,
              `${base.firstName}|${base.lastName}|${i}`,
              peps.startsWith('gen_') ? String(p.PEPS) : null,
              String(p.bodyType || 'Standard')
            );
          }
          return plpo ? `/api/portrait/plpo/${plpo}` : null;
        })(),
        // The player's OWN in-game portrait: the game ships one keyed to HIM.
        // Deliberately keyed on the lookup's PhotoID, not on p.PID -- the latter
        // is the slot the prospect will occupy, which is frequently a recycled
        // generic portrait, so resolving it would hand back a real-looking face
        // belonging to somebody else. `portrait` below has the same problem
        // (it falls back to a generic head by skin tone) and so stays last.
        gamePortrait: (() => {
          // A roster head's own portrait counts too (the lookup has no PhotoID
          // for a rookie matched by name), but never a legends portrait a
          // namesake owns -- portraitFor already refused that above.
          const pid = base.photoId || (real && real.portraitKind !== 'none' ? real.portraitPid : 0);
          const plpo = pid ? PortraitService.plpoForPid(pid) : null;
          return plpo ? `/api/portrait/plpo/${plpo}` : null;
        })(),
        combine: base.combine ?? null,
        persona,
        focus,
        frontSeven: base.frontSeven
          ? { role: base.frontSeven.role, reason: base.frontSeven.reason, scheme: base.frontSeven.scheme, team: base.frontSeven.team, sackRate: base.frontSeven.sackRate }
          : null,
        gear: gearSlots(p),
        ratings,
        scouting: (() => {
          const baseNotes = scoutingFor(i + 1, Number(p.position), ratings, gameVersion);
          const f = freakMap?.get(i);
          if (f && f.isFreak) {
            const compsStr = f.historicalComps?.length ? ` · Comps: ${f.historicalComps.join(', ')}` : '';
            return [`${f.emoji} ${f.archetypeLabel} (${f.tier.toUpperCase()}): ${f.summary}${compsStr}`, ...baseNotes];
          }
          return baseNotes;
        })(),
        freak: freakMap?.get(i) ?? null,
      };
    });
    return { rows, likeness, count: rows.length, dropped, included, launchCount: launched.size };
  },

  /** Build a complete, importable .mdc buffer from baseline players, applying
   *  any user edits (keyed by pick) on top of the deterministic base class. */
  buildMdc(players: BaselinePlayer[], edits?: ClassEdits, mode: GenMode = 'madden', gearEdits?: GearEdits, opts: GenOptions = {}): BuildResult {
    const { prospects, truncated, dropped, likeness } = this.buildProspects(players, mode, opts);
    applyEdits(prospects, edits);
    applyGearEdits(prospects, gearEdits);
    const template = MdcService.loadTemplate();
    const buffer = MdcService.write(prospects, template);
    // Neutralize unused logical blocks so leftover template prospects don't appear.
    for (let i = prospects.length; i < LOGICAL_CAPACITY; i++) {
      neutralizeBlock(buffer, i);
    }
    return { buffer, count: prospects.length, truncated, dropped, likeness };
  },

  /** Madden 27 variant: same prospects, but written with the 5876-byte M27 record
   *  layout (Mdc27Service) and persona DNA assigned per prospect (PersonaService).
   *  The M27 writer zeroes unused blocks itself, so no neutralize pass is needed. */
  buildMdc27(players: BaselinePlayer[], edits?: ClassEdits, mode: GenMode = 'madden', gearEdits?: GearEdits, opts: GenOptions = {}): BuildResult {
    const { prospects, truncated, dropped, likeness, capped: builtCapped } = this.buildProspects(players, mode, opts, 'm27');
    applyEdits(prospects, edits, 'm27');
    applyGearEdits(prospects, gearEdits);
    const capped = builtCapped ?? players.slice(0, LOGICAL_CAPACITY);
    // Pack portraits pin before assignM27Fields so a generic head keeps the id.
    const portraitPack = opts.portraitPack ? PortraitPackService.apply(prospects as Array<Record<string, unknown>>, capped, { cdn: opts.portraitCdn }) : undefined;
    const portraitPackMissing = portraitPack ? PortraitPackService.missing(prospects as Array<Record<string, unknown>>, capped, portraitPack) : undefined;
    prospects.forEach((p, i) => {
      const posId = Number(p.position) || 0;
      if (!p.personaDNA) {
        // explicit user edit wins
        p.personaDNA = PersonaService.dnaFor(`${p.firstName}|${p.lastName}${opts.variant ? `|v${opts.variant}` : ''}`, PositionMapper.groupFromId(posId), Number(p.overall) || 0, Number(p.devTrait) || 0);
      }
      // Birthdate, PersonalityRating, Focus, QB style, body-type enum, hidden bytes,
      // generic-head portrait PID — everything the game fills and reads back verbatim.
      const base = capped[i];
      const career = base ? NflverseCareerService.get(base.firstName, base.lastName, base.draftYear, nflversePick(base)) : null;
      assignM27Fields(p, { birthDate: career?.birthDate ?? null }, `${p.firstName}|${p.lastName}|${i}${opts.variant ? `|v${opts.variant}` : ''}`);
    });
    const template = Mdc27Service.loadTemplate();
    const buffer = Mdc27Service.write(prospects, template);
    return { buffer, count: prospects.length, truncated, dropped, likeness, portraitPack, portraitPackMissing };
  },
};
