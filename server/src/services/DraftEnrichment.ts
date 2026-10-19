import { PlayerLookupService } from './PlayerLookupService';
import { TeamService, PickEnrichment } from './TeamService';
import { GenericFillerService, FULL_CLASS_SIZE, targetLongSnapperCount } from './GenericFillerService';
import { CombineService } from './CombineService';
import { PositionMapper } from './PositionMapper';
import { SkinToneService } from './SkinToneService';
import { DerivedSkinToneService } from './DerivedSkinToneService';
import { WikiSkinToneService } from './WikiSkinToneService';
import { toneFromEvidence } from './SkinToneClassify';
import { NflverseCareerService } from './NflverseCareerService';
import { RetroItaService } from './RetroItaService';
import { CuratedSkinToneService } from './CuratedSkinToneService';
import { PhotoLookService } from './PhotoLookService';
import { TeamDraftService } from './TeamDraftService';
import { LikenessOverrideService } from './LikenessOverrideService';
import type { ToneSource } from '../types/player';
import { BaselinePlayer, nflversePick } from '../types/player';
import { SupplementalDraftService } from './SupplementalDraftService';
import { positionLabelFor } from './PositionLabel';
import { DbPositionService } from './DbPositionService';

/** Rating and position inputs shared by every catalog, draft and roster path. */
export async function enrichRatingInputs(p: BaselinePlayer, e?: PickEnrichment): Promise<BaselinePlayer> {
  // The position steps shared with the pool listing (PositionLabel.ts): curated DB
  // entry, front-seven classifier, pre-2001 corner/safety split, heavy-end sack rule.
  // Combine (2000+): official measured height/weight + testing numbers for ratings.
  const c = await CombineService.get(p.firstName, p.lastName, p.draftYear, p.draftPick);
  const pos = positionLabelFor(p, e?.positionLabel, e?.team?.abbr, c?.weight ?? e?.weight ?? null);
  const label = pos.label !== p.position ? pos.label : null;
  const positionLocked = pos.locked;
  const f7 = pos.frontSeven ? { frontSeven: pos.frontSeven } : null;

  const nv = NflverseCareerService.get(p.firstName, p.lastName, p.draftYear, nflversePick(p));

  // Accuracy priority — height/weight: combine (measured) > pick-join > nflverse name > CSV.
  const height = c?.heightInches ?? e?.heightInches ?? nv?.heightInches ?? null;
  const weight = c?.weight ?? e?.weight ?? nv?.weight ?? null;
  const age = e?.age ?? nv?.age ?? null;
  const out: BaselinePlayer = { ...p };
  if (label) out.position = label;
  if (positionLocked) out.positionLocked = true;
  if (f7?.frontSeven) out.frontSeven = f7.frontSeven;
  if (c) out.combine = { forty: c.forty, bench: c.bench, vertical: c.vertical, broad: c.broad, cone: c.cone, shuttle: c.shuttle };
  if (height != null) out.heightInches = height;
  if (weight != null) out.weight = weight;
  if (age != null) out.age = age;
  if (nv) {
    // A current-year rookie's nflverse w_av is one season (or a 0 placeholder):
    // not a career signal. Leave those on the draft-slot estimate.
    const currentRookie = p.draftYear >= new Date().getFullYear() - 1;
    if (out.wav == null && nv.wav != null && !currentRookie) {
      out.wav = nv.wav;
      out.wavSource = 'actual';
    }
    if (!(out.proBowls) && nv.proBowls) out.proBowls = nv.proBowls;
    if (!(out.allPro1) && nv.allPro1) out.allPro1 = nv.allPro1;
    if (!(out.seasonsStarted) && nv.seasonsStarted) out.seasonsStarted = nv.seasonsStarted;
    if (out.careerTo == null && nv.careerTo != null) out.careerTo = nv.careerTo;
    if (!out.isHOF && nv.isHOF) out.isHOF = true;
    if (!out.headshotUrl && nv.headshotUrl) out.headshotUrl = nv.headshotUrl;
    // The draft table files fullbacks under HB -- Kyle Juszczyk (2013) is "HB"
    // there and FB everywhere else -- and Madden has a separate FB with its own
    // ratings and archetypes, so the label decides what kind of player he
    // becomes. Only this one pair is corrected: the other disagreements
    // (HB/RB, CB/DB, LE/DE) are the same position under two names, and
    // PositionMapper already folds those together.
    if (out.position === 'HB' && nv.position === 'FB') out.position = 'FB';
  }
  // Undrafted players are absent from draft_picks and carry no career columns of
  // their own, so without this they keep the ~2 AV draft-slot default however
  // long they actually played. nflverse has a rookie/last season for them; the
  // span alone is enough for the wAV estimate to treat a ten-year starter as one.
  if (out.draftRound == null) {
    const ud = NflverseCareerService.getUndrafted(out.firstName, out.lastName, out.draftYear);
    if (ud) {
      if (out.careerFrom == null && ud.careerFrom != null) out.careerFrom = ud.careerFrom;
      if (out.careerTo == null && ud.careerTo != null) out.careerTo = ud.careerTo;
      if (out.heightInches == null && ud.heightInches != null) out.heightInches = ud.heightInches;
      if (out.weight == null && ud.weight != null) out.weight = ud.weight;
      if (!out.headshotUrl && ud.headshotUrl) out.headshotUrl = ud.headshotUrl;
    }
  }
  return out;
}

async function enrichOne(p: BaselinePlayer, e?: PickEnrichment): Promise<BaselinePlayer> {
  const sourcePosition = p.position;
  p = await enrichRatingInputs(p, e);
  // Skin tone for generic faces (and the generic portrait of a scan with no
  // portrait left): calibrated portrait evidence weighed against the position/era
  // prior — SkinToneClassify.toneFromEvidence. A legends portrait (vintage photo,
  // Namath reads as dark) is tempered; a Wikipedia tone and an explicit CSV race
  // are weak extra evidence. No more "ignore a light reading at a dark position"
  // (that made Keith Brooking tone 7).
  const prior = SkinToneService.toneDistribution(p.position, p.draftYear);
  const portrait = DerivedSkinToneService.itaForPid(p.photoId);
  // A player with no in-game portrait has only his Wikipedia photo to go on, and
  // the prior does the rest -- which made the 1991 WR Mike Pritchard tone 2 off a
  // wiki reading of 3. His Madden disc headshot reads ITA -37.5 (tone 7). Those
  // headshots are studio crops framed like the portraits the ITA model was built
  // on, so when we have one it is the better skin sample; the in-game portrait
  // still wins when it exists.
  const retroIta = portrait?.ita == null ? RetroItaService.itaFor(p.firstName, p.lastName, sourcePosition, p.draftYear) : null;
  // The wiki tone was read from the row's Wikipedia photo; if that photo was
  // sanitized away (icon, or another same-named player's picture) the tone goes too.
  // Two men of one name in one draft (2005: Alex Smith QB/Utah and Alex Smith TE/Stanford)
  // share every name-keyed reading, so neither the wiki tone nor the CSV race can say
  // which man it describes: both go quiet and the portrait + prior decide.
  const ambiguous = PlayerLookupService.namesakes(p.firstName, p.lastName, p.draftYear) > 1;
  const wiki = !ambiguous && p.wikiImageUrl ? WikiSkinToneService.toneFor(p.firstName, p.lastName, p.draftYear) : null;
  const trusted = !ambiguous && p.race != null && p.race !== 7 ? p.race : null;
  // A recorded tone wins outright. It exists for players the evidence cannot
  // reach or reads wrong, and inference has nothing to add to a known answer.
  const curatedTone = CuratedSkinToneService.toneFor(p.firstName, p.lastName, p.draftYear, p.college);
  // The NFL was segregated from 1934 to 1945, and no black player was drafted
  // until 1949. For a player drafted in that window a dark tone is not an
  // unlikely guess, it is an impossible one -- so this overrides the portrait
  // too, which is where all eight of the current cases come from: a dim vintage
  // photograph measuring dark exactly as Paul Krause's does. 1945 rather than
  // 1948 because Marion Motley signed in 1946 and the lookup carries him as a
  // 1946 draftee.
  const segregationEra = p.draftYear <= 1945 ? 2 : null;
  // The user's own fix beats everything: he looked at the man and said so.
  const fix = p.source === 'custom' || p.source === 'generated' ? null : LikenessOverrideService.get(p.firstName, p.lastName, p.draftYear);
  const fixTone = fix?.skinTone ?? null;
  const race = fixTone ?? curatedTone ?? segregationEra ?? toneFromEvidence({ ita: portrait?.ita ?? retroIta, greyL: portrait?.greyL ?? null, legendPortrait: portrait?.legend, wikiTone: wiki, trustedCsv: trusted, prior });
  const toneSource: ToneSource = fixTone != null ? 'override'
    : curatedTone != null ? 'curated'
    : segregationEra != null ? 'era'
    : portrait?.ita != null || portrait?.greyL != null ? 'portrait'
    : retroIta != null ? 'headshot'
    : wiki != null ? 'wiki'
    : trusted != null ? 'csv'
    : 'prior';

  const out: BaselinePlayer = { ...p, race, toneSource, likenessFixed: !!fix, likenessFix: fix ? { faceAsset: fix.faceAsset, bodyType: fix.bodyType } : null };
  // Same rule here: read what is known, queue what is not. Observing gear means
  // downloading the photograph itself, which is the second half of the wait.
  const { url: photo, unknown } = PhotoLookService.cachedPhoto(out);
  if (unknown) PhotoLookService.warmLater({ name: [out.firstName, out.lastName] });
  if (photo && !out.headshotUrl && !out.pfrImageUrl && !out.wikiImageUrl) {
    out.wikiImageUrl = photo;
  }
  if (photo) {
    const gear = PhotoLookService.cachedGear(photo);
    if (gear) out.observedGear = gear;
    else PhotoLookService.warmLater({ url: photo });
  }
  return out;
}

/**
 * Baseline players for a draft year with DB positions corrected BEFORE generation
 * (curated pre-2001 list > nflverse depth-chart/roster), plus the per-pick team
 * enrichment map. Shared by the preview (/generated) and export (/mdc) routes so
 * the exported .mdc matches exactly what the UI shows.
 */
export async function enrichedClass(
  year: number,
  league: string,
  opts: { fill?: boolean } = {}
): Promise<{ players: BaselinePlayer[]; enrich: Map<number, PickEnrichment>; generatedCount: number; positionsReady: boolean }> {
  const baseline = PlayerLookupService.byYear(year, league);
  const enrich = await TeamService.byYear(year);
  const positionsReady = DbPositionService.isReady();
  const real = await Promise.all(
    baseline.map((p) => enrichOne(p, enrich.size && p.draftPick != null ? enrich.get(p.draftPick) : supplementalEnrichment(p)))
  );
  // Pad to a full Madden-sized class with generated undrafted generics.
  const fillers = opts.fill ? GenericFillerService.build(year, real) : [];
  return { players: [...real, ...fillers], enrich, generatedCount: fillers.length, positionsReady };
}

/** A "greats" class: the best players in history (by career greatness), enriched the
 *  same way as a year class but without a per-year team map. An optional draft-year
 *  `range` scopes it to a decade/era (the greatest players of that span). */
export async function allTimeGreatsClass(range?: { from: number; to: number }): Promise<{ players: BaselinePlayer[]; generatedCount: number }> {
  const targetLS = targetLongSnapperCount(range ? `${range.from}-${range.to}` : 'all-time');
  const allGreats = PlayerLookupService.allTimeGreats(FULL_CLASS_SIZE, range);
  const existingLS = allGreats.filter((p) => PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight ?? null) === 21);
  if (existingLS.length < targetLS) {
    const needed = targetLS - existingLS.length;
    let allHistorical = [...PlayerLookupService.years()].flatMap((y) => PlayerLookupService.byYear(y, 'combined'));
    if (range) allHistorical = allHistorical.filter((p) => p.draftYear >= range.from && p.draftYear <= range.to);
    const lsPool = allHistorical.filter((p) => PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight ?? null) === 21);
    const score = (p: BaselinePlayer) => (p.wav ?? 0) + 4 * (p.allPro1 ?? 0) + 2 * (p.proBowls ?? 0) + (p.isHOF ? 40 : 0);
    lsPool.sort((a, b) => score(b) - score(a));
    const toAdd = lsPool.slice(0, needed);
    const kept = allGreats.slice(0, FULL_CLASS_SIZE - toAdd.length);
    const players = await enrichAcrossYears([...kept, ...toAdd]);
    return { players, generatedCount: 0 };
  }
  const players = await enrichAcrossYears(allGreats);
  return { players, generatedCount: 0 };
}

/**
 * Enrich players drawn from many draft years (All-Time, decade, team, Studio
 * boards) with the same per-pick nflverse data a year class gets: depth-chart
 * DB positions (Polamalu is a strong safety, not a corner), the drafting team's
 * scheme for linebackers, and measured height/weight. One lookup per year.
 */
export async function enrichAcrossYears(players: BaselinePlayer[], ratingsOnly = false): Promise<BaselinePlayer[]> {
  const years = [...new Set(players.map((p) => p.draftYear))];
  const byYear = new Map(await Promise.all(years.map(async (y) => [y, await TeamService.byYear(y)] as const)));
  return Promise.all(players.map((p) => (ratingsOnly ? enrichRatingInputs : enrichOne)(p, p.draftPick != null ? byYear.get(p.draftYear)?.get(p.draftPick) : supplementalEnrichment(p))));
}

/** A supplemental pick has no overall pick to join the team table on; his club
 *  comes from the supplemental table and nothing else is joined. */
function supplementalEnrichment(p: BaselinePlayer): PickEnrichment | undefined {
  const team = p.supplemental ? SupplementalDraftService.teamInfo(p.supplemental.team, p.draftYear) : null;
  return team ? { team, positionLabel: null, age: null, heightInches: null, weight: null } : undefined;
}

/** Greatness score the All-Time class ranks by (wAV + accolades + HOF bonus). */
const greatness = (p: BaselinePlayer) => (p.wav ?? 0) + 4 * (p.allPro1 ?? 0) + 2 * (p.proBowls ?? 0) + (p.isHOF ? 40 : 0);

/**
 * A hand-picked class: the players behind `keys` (unknown keys reported, at most
 * 402 kept), ordered best-first by career greatness so pick 1 is the best player
 * chosen, enriched like any other class, and - when `fill` - padded to a full
 * class with generics from the era of the picks (their median draft year).
 */
export async function pickedClass(
  keys: string[],
  opts: { fill?: boolean } = {}
): Promise<{ players: BaselinePlayer[]; generatedCount: number; missing: string[]; truncatedKeys: boolean }> {
  return boardClass(keys.map((key) => ({ key })), opts);
}

/**
 * A franchise's all-time draft: the best players it ever drafted (under every
 * name and city it played as), ranked by the All-Time greatness score, 402 deep.
 * A young franchise with fewer draftees is padded with era-matched prospects.
 */
export async function teamGreatsClass(franchise: string): Promise<{ players: BaselinePlayer[]; generatedCount: number }> {
  const drafted = await TeamDraftService.draftedBy(franchise);
  const picked = [...drafted].sort((a, b) => greatness(b) - greatness(a)).slice(0, FULL_CLASS_SIZE);
  const real = await enrichAcrossYears(picked);
  let fillers: BaselinePlayer[] = [];
  if (real.length < FULL_CLASS_SIZE && real.length > 0) {
    const years = real.map((p) => p.draftYear).sort((a, b) => a - b);
    fillers = GenericFillerService.build(years[Math.floor(years.length / 2)], real);
  }
  return { players: [...real, ...fillers], generatedCount: fillers.length };
}

/** Class Studio board entries from a request body: `{ key }` or `{ custom: {...} }`;
 *  anything else is dropped. Null when the body has no board at all. */
export function parseBoard(raw: unknown): BoardEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BoardEntry[] = [];
  for (const e of raw.slice(0, FULL_CLASS_SIZE)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as { key?: unknown; custom?: unknown };
    if (typeof o.key === 'string' && o.key) out.push({ key: o.key });
    else if (o.custom && typeof o.custom === 'object') out.push({ custom: o.custom as CustomPlayerSpec });
  }
  return out;
}

/** A custom prospect as the Class Studio describes him. */
export interface CustomPlayerSpec {
  id?: string;
  firstName: string;
  lastName: string;
  position: string; // Madden label: QB, HB, ..., LEDG, MIKE, SS, K, P, LS
  college: string;
  heightInches: number;
  weight: number;
  age: number;
  jersey?: number | null;
  overall: number; // 40-99
  devTrait: number; // 0 Normal, 1 Star, 2 Superstar, 3 X-Factor
  archetype: number | null;
  skinTone: number; // 1-7
}
export type BoardEntry = { key: string } | { custom: CustomPlayerSpec };

const MADDEN_POSITIONS = new Set(Array.from({ length: 22 }, (_, id) => PositionMapper.name(id)));

/** Why a custom player cannot be built, or null when he is fine. */
export function validateCustomPlayer(c: Partial<CustomPlayerSpec> | null | undefined): string | null {
  if (!c || typeof c !== 'object') return 'custom player missing';
  if (!String(c.firstName ?? '').trim() || !String(c.lastName ?? '').trim()) return 'a custom player needs a first and last name';
  if (!MADDEN_POSITIONS.has(String(c.position ?? '').toUpperCase())) return `unknown position "${c.position}"`;
  const ovr = Number(c.overall);
  if (!Number.isFinite(ovr) || ovr < 40 || ovr > 99) return 'overall must be 40-99';
  const dev = Number(c.devTrait);
  if (![0, 1, 2, 3].includes(dev)) return 'dev trait must be 0-3';
  const h = Number(c.heightInches), w = Number(c.weight), age = Number(c.age);
  if (!Number.isFinite(h) || h < 60 || h > 84) return 'height must be 60-84 inches';
  if (!Number.isFinite(w) || w < 140 || w > 400) return 'weight must be 140-400 lb';
  if (!Number.isFinite(age) || age < 18 || age > 45) return 'age must be 18-45';
  return null;
}

/** The BaselinePlayer for a custom prospect, dated to the class he sits in. */
export function customBaseline(c: CustomPlayerSpec, draftYear: number): BaselinePlayer {
  const tone = Math.max(1, Math.min(7, Math.round(Number(c.skinTone) || 4)));
  const first = String(c.firstName).trim().slice(0, 20);
  const last = String(c.lastName).trim().slice(0, 20);
  return {
    firstName: first, lastName: last, college: String(c.college ?? '').trim().slice(0, 40), draftYear,
    draftRound: null, draftPick: null, position: String(c.position).toUpperCase(),
    jersey: c.jersey != null && Number.isFinite(Number(c.jersey)) ? Math.max(0, Math.min(99, Math.round(Number(c.jersey)))) : null,
    league: 'NFL', isHOF: false, photoId: null, playerAssetsId: null, commId: null, plpo: null,
    heightInches: Math.round(Number(c.heightInches)), weight: Math.round(Number(c.weight)), age: Math.round(Number(c.age)),
    homeState: null, race: tone, wikiImageUrl: null, pfrImageUrl: null, headshotUrl: null,
    careerFrom: null, careerTo: null, allPro1: null, proBowls: null, seasonsStarted: null,
    wav: null, wavSource: 'predicted', source: 'custom',
    key: `custom:${c.id ?? `${first}-${last}`.toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
    custom: { overall: Math.round(Number(c.overall)), devTrait: Number(c.devTrait), archetype: c.archetype == null ? null : Number(c.archetype) },
  };
}

/**
 * A Class Studio board: real players by lookup key and custom prospects, in the
 * order given, which is the pick order the class is built in. Real players are
 * enriched as usual; custom ones are built as described. A short board is padded
 * with era-matched generated prospects when `fill` is on.
 */
export async function boardClass(
  board: BoardEntry[],
  opts: { fill?: boolean } = {}
): Promise<{ players: BaselinePlayer[]; generatedCount: number; missing: string[]; truncatedKeys: boolean }> {
  const keys = board.flatMap((e) => ('key' in e ? [e.key] : []));
  const { players: found, missing } = PlayerLookupService.byKeys(keys);
  const byKey = new Map(found.map((p) => [p.key ?? '', p]));
  const realYears = found.map((p) => p.draftYear).sort((a, b) => a - b);
  const classYear = realYears.length ? realYears[Math.floor(realYears.length / 2)] : new Date().getFullYear();
  const ordered: BaselinePlayer[] = [];
  for (const e of board) {
    if ('key' in e) { const p = byKey.get(e.key); if (p) ordered.push(p); }
    else ordered.push(customBaseline(e.custom, classYear));
  }
  const truncatedKeys = ordered.length > FULL_CLASS_SIZE;
  const picked = ordered.slice(0, FULL_CLASS_SIZE);
  const enriched = await enrichAcrossYears(picked.filter((p) => !p.custom));
  const enrichedByKey = new Map(enriched.map((p) => [p.key ?? '', p]));
  const real = picked.map((p) => (p.custom ? p : enrichedByKey.get(p.key ?? '') ?? p));
  let fillers: BaselinePlayer[] = [];
  if (opts.fill !== false && real.length < FULL_CLASS_SIZE && real.length > 0) {
    fillers = GenericFillerService.build(classYear, real);
  }
  return { players: [...real, ...fillers], generatedCount: fillers.length, missing, truncatedKeys };
}
