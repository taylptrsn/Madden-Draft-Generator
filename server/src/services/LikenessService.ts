import fs from 'fs';
import { firstNameVariants } from './PlayerLookupService';
import path from 'path';
import { LOOKUPS_DIR, CACHE_DIR } from '../config/paths';
import { BaselinePlayer } from '../types/player';
import { FaceFeatures, faceDistance } from './FaceFeatures';
import { parseCsvFile, normalizeName } from '../util/csv';

/**
 * Player likeness assignment. Each generated prospect gets, in priority order:
 *   1. their real Madden face asset (PEPS, e.g. "jacksonBo_9877") when the
 *      lookup has one  -> the player's actual in-game 3D head + portrait;
 *   2. otherwise a race-appropriate generic draft-class face (gen_<tone>_...),
 *      so at least skin tone matches.
 * Generic faces come from generic-face-DRAFTCLASS-FINAL.json (the set Madden
 * itself uses for draft-class prospects). See draft-class-generator-project.
 */

interface FaceEntry {
  genericCode: string;
  skinTone: number;
  isTrueGeneric: boolean;
  assetName: string;
  pid?: number;
}

let byTone: Map<number, string[]> | null = null;
let pidByCode: Map<string, number> | null = null;

/** Per-game real-face catalogs (data/lookups/face-assets-by-game.json, built by
 *  scripts/build-face-catalogs.ts): every head asset the installed game can render —
 *  unique scans decoded from the game's own bundle tables (this is where legends
 *  like polamaluTroy_16548 live) plus the career roster's cranium heads — with the
 *  asset name in the game's casing and its menu-portrait id. */
export interface RealFace { assetName: string; portraitPid: number; genericHead: string | null; first: string | null; last: string | null; source: string; draftYear?: number; portraitKind?: 'legend' | 'roster' | 'player' | 'none' }
interface FaceCatalog { assets: Map<string, RealFace>; byName: Map<string, string>; byNameTight: Map<string, string>; legendPortraits: Set<string>; legendPids: Map<string, number>; playerPortraits: Set<string>; headAccessory: Set<string> }
const catalogs: Partial<Record<'m26' | 'm27', FaceCatalog>> = {};
/** Measured appearance features, baked by scripts/build-face-features.ts.
 *  Absent files simply disable matching and the stride fallback takes over. */
let headFeatMem: Record<string, Record<string, FaceFeatures>> | null = null;
let playerFeatMem: Record<string, FaceFeatures> | null = null;

interface ExtraFictionalHead {
  assetName: string;
  portraitPid: number;
  tone: number;
  bodyType: string;
  name: string;
}

interface GenericPortraitEntry {
  pid: number;
  plpo: string;
  tone: number;
  build: string;
  neckRatio: number;
  isModern: boolean;
}

let fictionalExtraHeadsMem: ExtraFictionalHead[] | null = null;
let genericPortraitCatalogMem: GenericPortraitEntry[] | null = null;

export function fictionalExtraHeads(): ExtraFictionalHead[] {
  if (!fictionalExtraHeadsMem) {
    try {
      const p = path.join(LOOKUPS_DIR, 'fictional-extra-3d-heads.json');
      fictionalExtraHeadsMem = JSON.parse(fs.readFileSync(p, 'utf8')).heads ?? [];
    } catch {
      fictionalExtraHeadsMem = [];
    }
  }
  return fictionalExtraHeadsMem!;
}

export function genericPortraitCatalog(): GenericPortraitEntry[] {
  if (!genericPortraitCatalogMem) {
    try {
      const p = path.join(LOOKUPS_DIR, 'm27-generic-portrait-catalog.json');
      genericPortraitCatalogMem = JSON.parse(fs.readFileSync(p, 'utf8')).portraits ?? [];
    } catch {
      genericPortraitCatalogMem = [];
    }
  }
  return genericPortraitCatalogMem!;
}

function headFeatures(): Record<string, Record<string, FaceFeatures>> {
  if (!headFeatMem) {
    try {
      headFeatMem = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'generic-head-features.json'), 'utf8'));
    } catch { headFeatMem = {}; }
  }
  return headFeatMem!;
}

function playerFeatures(): Record<string, FaceFeatures> {
  if (!playerFeatMem) {
    try {
      playerFeatMem = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'player-face-features.json'), 'utf8'));
    } catch { playerFeatMem = {}; }
  }
  return playerFeatMem!;
}

function catalogFor(version: 'm26' | 'm27'): FaceCatalog {
  const hit = catalogs[version];
  if (hit) return hit;
  const cat: FaceCatalog = { assets: new Map(), byName: new Map(), byNameTight: new Map(), legendPortraits: new Set(), legendPids: new Map(), playerPortraits: new Set(), headAccessory: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'face-assets-by-game.json'), 'utf8'));
    const v = raw?.[version] ?? {};
    for (const [k, e] of Object.entries(v.assets ?? {})) cat.assets.set(k, e as RealFace);
    for (const [k, a] of Object.entries(v.byName ?? {})) {
      // Register the key as written and in suffix-free m27Key form, so "will
      // anderson jr" is also found as "will anderson" (what the lookup asks for).
      const nk = normKey(k);
      for (const key of new Set([k, nk])) {
        if (cat.byName.has(key) && cat.byName.get(key) !== a) continue; // two catalog names collapsed: keep the first
        cat.byName.set(key, a as string);
      }
      const t = nk.replace(/[^a-z]/g, '');
      if (cat.byNameTight.has(t) && cat.byNameTight.get(t) !== a) cat.byNameTight.set(t, '');
      else cat.byNameTight.set(t, a as string);
    }
    for (const k of (v.legendPortraits ?? []) as string[]) cat.legendPortraits.add(k);
    for (const [k, pid] of Object.entries(v.legendPids ?? {})) cat.legendPids.set(k, Number(pid));
    for (const [gameKey, ours] of Object.entries(LEGEND_KEY_ALIASES)) {
      const pid = cat.legendPids.get(gameKey);
      if (pid != null) for (const k of ours) if (!cat.legendPids.has(k)) cat.legendPids.set(k, pid);
    }
    for (const k of (v.playerPortraits ?? []) as string[]) cat.playerPortraits.add(k);
    for (const k of (v.genericHeadAccessory ?? []) as string[]) cat.headAccessory.add(k.toLowerCase());
  } catch { /* catalog absent — M27 falls back to the save-only map, M26 to the lookup */ }
  if (version === 'm27' && cat.assets.size === 0) {
    // Older data file: the save-only extract (current players, no legends).
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'm27-face-assets.json'), 'utf8'));
      for (const [name, v] of Object.entries(raw.players ?? {})) {
        const e = v as { assetName: string; portraitPid: number; genericHead: string | null };
        const [first, ...rest] = name.split(' ');
        cat.assets.set(e.assetName.toLowerCase(), { ...e, first, last: rest.join(' '), source: 'roster' });
        cat.byName.set(name, e.assetName.toLowerCase());
        const tight = name.toLowerCase().replace(/[^a-z]/g, '');
        if (cat.byNameTight.has(tight) && cat.byNameTight.get(tight) !== e.assetName.toLowerCase()) cat.byNameTight.set(tight, '');
        else cat.byNameTight.set(tight, e.assetName.toLowerCase());
      }
    } catch { /* nothing */ }
  }
  catalogs[version] = cat;
  return cat;
}
/** Lookup assets newer than this are accepted for M27 even when absent from the
 *  catalog: the catalog's roster half comes from an advanced franchise save that
 *  has already cut players, and current players' heads carry over between the two
 *  games (their portrait ids match 1,044 of 1,055 times). */
const M27_TRUST_LOOKUP_FROM = 2019;
/** How many of the nearest-matching heads a player may be spread across. Too
 *  low and a class collapses onto a handful of faces; too high and the match
 *  stops resembling him. 6 keeps every candidate a close match while bounding
 *  reuse near the even-spread figure. */
const GENERIC_MATCH_CANDIDATES = 6;
/** Skull caps / do-rags under the helmet became common in the late 1990s. */
const HEADWEAR_FROM = 1995;
/** ~280 legacy scan dirs (baughsammy, williamskevin, suggsterrell_16524) hold only
 *  shader presets, no head bundle. In-game (M27, 22 Aug 2026) they render as the
 *  default head, so they are generics unless MADDEN_PRESET_HEADS=1. */
const ACCEPT_PRESET_HEADS = process.env.MADDEN_PRESET_HEADS === '1';
/** Retired pre-2019 players with an EA id but no scan (AmukamaraPrince_10766): M26
 *  still ships their portraits, M27 dropped them from disk, so their heads may be
 *  gone too. Off by default for M27 (generic head); MADDEN27_TRUST_M26_HEADS=1 to
 *  try them in-game. */
const M27_TRUST_ALL_M26_HEADS = process.env.MADDEN27_TRUST_M26_HEADS === '1';
/**
 * The game's legend-portrait keys that no lookup name reaches as written: the
 * artists' spellings ("Erick Dickerson", "Napolean Kaufman", "Jimmey Smith"),
 * suffixes and tags ("Kellen Winslow Sr", "Mark Clayton Dolphins", "Mike Ditka
 * Player"), and nicknames the lookup writes differently. Keys are surname+first
 * with everything but letters removed; the value lists the lookup's key(s). 24
 * of M27's 523 legend keys were unreached; these cover the ones that are players
 * in the lookup (Rich Eisen, Fritz Pollard, Red Grange and the undrafted Frank
 * Minnifield / Kyle Eckel are not; "lt" is ambiguous).
 */
const LEGEND_KEY_ALIASES: Record<string, string[]> = {
  jonesedtootall: ['jonestootall', 'jonesed'],
  markclaytondolphins: ['claytonmark'],
  newmanterrance: ['newmanterence'],
  hintonsrchris: ['hintonchris'],
  smithjimmey: ['smithjimmy'],
  jimcovert: ['covertjimbo', 'covertjim'],
  wakecam: ['wakecameron'],
  vickmike: ['vickmichael'],
  dicklane: ['lanenighttrain', 'lanedick'],
  kellenwinslowsr: ['winslowkellen'],
  dickersonerick: ['dickersoneric'],
  formanchuck: ['foremanchuck'],
  ditkamikeplayer: ['ditkamike'],
  maddenjohnplayer: ['maddenjohn'],
  deanperrymichael: ['perrymichaeldean', 'perrymichael'],
  ismailraghib: ['ismailrocket'],
  kaufmannapolean: ['kaufmannapoleon'],
};

/** The legends-portrait PID under any spelling of the first name, or undefined. */
function legendPidFor(cat: FaceCatalog, firstName: string, lastName: string): number | undefined {
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  for (const first of firstNameVariants(firstName)) {
    const f = first.replace(/[^a-z]/g, '');
    const pid = cat.legendPids.get(l + f) ?? cat.legendPids.get(f + l);
    if (pid != null) return pid;
  }
  return undefined;
}

/** Write lookup ids for legends that only have a legends portrait (no scan) on M27. */
const M27_TRUST_LEGEND_IDS = process.env.MADDEN27_TRUST_LEGEND_IDS === '1';
let m26Scans: Array<{ id: string; name: string; asset: string; portraitPid?: number; image?: string }> | null = null;
/** Generational suffixes are not part of who a man is. The game's catalog writes
 *  "Will Anderson Jr" (asset AndersonJrWill_22702, 149 roster players carry a
 *  Jr/Sr/II/III/IV) while the lookup writes "Will Anderson", and the two never
 *  met -- the 2023 #3 pick was getting a generic head with his own scan sitting
 *  in the pack. Both sides of every name match drop the suffix first. */
const stripSuffix = (s: string) => s.replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, ' ');
const m27Key = (first: string, last: string) =>
  stripSuffix(`${first} ${last}`.toLowerCase()).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
/** A catalog byName key (as written by build-face-catalogs) in m27Key form. */
const normKey = (k: string) => stripSuffix(k.toLowerCase()).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
/** The same name with the spaces gone too. m27Key keeps them, so a player the
 *  lookup writes "T. J. Parker" keys as "t j parker" while the game's catalog
 *  writes "t.j. parker" and keys as "tj parker" -- the two never meet, and five
 *  of the 2026 rookies had a scan sitting unused because of a full stop. This is
 *  a LAST resort: it is looser, so everything found through it goes through the
 *  same era guard as the exact key. */
const m27KeyTight = (first: string, last: string) => stripSuffix(`${first} ${last}`.toLowerCase()).replace(/[^a-z]/g, '');

/** Individually verified pool-name -> catalog-asset matches, scoped to entry
 *  year. These are not general nickname substitutions: another Michael or
 *  Gregory must not inherit a current player's head. The target game's catalog
 *  must still contain the asset. Sources: docs/likeness/ decade batch ledgers. */
const REVIEWED_HEAD_ALIASES: Record<string, string> = {
  'gregoryrousseau|2021': 'rousseaugreg_21517',
  'michaeldanna|2020': 'dannamike_21231',
  'delmarglaze|2024': 'glazedj_14731',
  'dariusslay|2013': 'slayjrdarius_1426',
  'goldentate|2010': 'tateiiigolden_9755',
  'toddgurley|2015': 'gurleyiitodd_2399',
  'mattjudon|2016': 'judonmatthew_17728',
  'johnelway|1983': 'elwayjohn_11420',
};

/** Named scan bundles whose portrait metadata was missing from the catalog.
 *  PIDs come from PID_Portrait_Mapping.csv; each portrait must also exist in
 *  the target game's inventory. A head bundle alone does not prove that its
 *  retired player's menu portrait still ships (Tate/Gurley on M27). */
const REVIEWED_BUNDLE_PORTRAITS: Record<string, { key: string; pid: number }> = {
  slayjrdarius_1426: { key: 'slayjrdarius', pid: 6273 },
  tateiiigolden_9755: { key: 'tateiiigolden', pid: 2909 },
  gurleyiitodd_2399: { key: 'gurleyiitodd', pid: 7155 },
};

/** nflverse draft year by the same name key as the M27 face map. */
let draftYearByKey: Map<string, number> | null = null;
function loadDraftYears(): Map<string, number> {
  if (draftYearByKey) return draftYearByKey;
  draftYearByKey = new Map();
  try {
    const rows = parseCsvFile<Record<string, string>>(path.join(CACHE_DIR, 'nflverse_players.csv'));
    for (const r of rows) {
      const year = parseInt(r.draft_year || '', 10);
      if (!year) continue;
      const display = (r.display_name || '').trim();
      if (display) {
        const k = display.toLowerCase().replace(/[^a-z ]/g, '');
        // M27 scans belong to CURRENT players, so among same-name rows the face's
        // owner is the most recently drafted one (not the first row in the file).
        if (k && (!draftYearByKey.has(k) || year > (draftYearByKey.get(k) ?? 0))) draftYearByKey.set(k, year);
      }
      const first = (r.first_name || r.common_first_name || '').trim();
      const last = (r.last_name || '').trim();
      if (first && last) {
        const k = m27Key(first, last);
        if (k && (!draftYearByKey.has(k) || year > (draftYearByKey.get(k) ?? 0))) draftYearByKey.set(k, year);
      }
    }
  } catch { /* nflverse cache absent — year guard degrades to the 2015 cutoff */ }
  return draftYearByKey;
}

function load(): void {
  if (byTone) return;
  byTone = new Map();
  pidByCode = new Map();
  const file = path.join(LOOKUPS_DIR, 'generic-face-DRAFTCLASS-FINAL.json');
  const arr: FaceEntry[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Prefer true generics; fall back to any validated draft-class face per tone.
  const trueGen = new Map<number, string[]>();
  for (const e of arr) {
    const code = e.genericCode;
    if (!code || !/^gen_\d/i.test(code)) continue;
    if (typeof e.pid === 'number') pidByCode.set(code, e.pid);
    // Bucket by the gen_N prefix, NOT the JSON skinTone field — M26Writer derives the
    // exported skin tone from that prefix, and 48 entries disagree with their field, so
    // a field-bucketed pick would write a tone that mismatches the player's race.
    const tone = toneFromCode(code);
    if (!byTone.has(tone)) byTone.set(tone, []);
    byTone.get(tone)!.push(code);
    if (e.isTrueGeneric) {
      if (!trueGen.has(tone)) trueGen.set(tone, []);
      trueGen.get(tone)!.push(code);
    }
  }
  // Where a tone has true generics, prefer them (avoids reusing a named scan).
  for (const [tone, codes] of trueGen) {
    if (codes.length >= 3) byTone.set(tone, codes);
  }
  // Madden 26 and 27 have different generic-head sets. Each game's own random
  // classes are the authority for which gen_* heads it assigns AND the menu
  // portrait it pairs with each (the validated lookup's pid column disagreed with
  // the game on every head it shared). Pools are kept per game; the portrait
  // table only backs up heads the game never showed us.
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'generic-heads-by-game.json'), 'utf8')) as { m26: Record<string, number>; m27: Record<string, number> };
    const plpoPid = new Map<string, number>();
    for (const r of parseCsvFile<Record<string, string>>(path.join(LOOKUPS_DIR, 'PID_Portrait_Mapping.csv'))) {
      const name = (r.Portrait || '').trim();
      const pid = parseInt(r.PID, 10);
      if (name && !Number.isNaN(pid)) {
        if (!plpoPid.has(name)) plpoPid.set(name, pid);
        if (!pidToPlpoMap.has(pid)) pidToPlpoMap.set(pid, name);
      }
    }
    // Madden 27's own head items (data/lookups/m27-generic-head-items.json, the
    // game's FootballCharacterHeadItem assets) list every generic head it ships
    // with its menu-portrait PID: 262 heads, 69 more than its random classes ever
    // assigned. They join the M27 pools; the random-class PIDs agree with the item
    // data on every shared head.
    let m27Items: Record<string, { pid: number }> = {};
    try { m27Items = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'm27-generic-head-items.json'), 'utf8')).heads ?? {}; } catch { /* optional */ }
    for (const version of ['m26', 'm27'] as const) {
      const heads: Record<string, number> = { ...(catalog[version] ?? {}) };
      if (version === 'm27') for (const [code, it] of Object.entries(m27Items)) if (!(code in heads) && it.pid) heads[code] = it.pid;
      const pools = new Map<number, string[]>();
      const pids = new Map<string, number>();
      for (const [code, pid] of Object.entries(heads)) {
        if (!/^gen_\d/i.test(code)) continue;
        const tone = toneFromCode(code);
        if (!pools.has(tone)) pools.set(tone, []);
        pools.get(tone)!.push(code);
        pids.set(code, pid || plpoPid.get(`plpo_generic_${code.slice(4)}`) || 0);
      }
      // Tones the game showed too few heads for keep the validated lookup's pool.
      for (const [tone, codes] of byTone!) if (!pools.has(tone) || pools.get(tone)!.length < 8) pools.set(tone, codes);
      for (const codes of pools.values()) codes.sort();
      byToneByVersion.set(version, pools);
      pidByVersion.set(version, pids);
    }
  } catch { /* optional: both games fall back to the validated lookup pools */ }
}

const byToneByVersion = new Map<'m26' | 'm27', Map<number, string[]>>();
const pidByVersion = new Map<'m26' | 'm27', Map<string, number>>();
const pidToPlpoMap = new Map<number, string>();
function poolsFor(version: 'm26' | 'm27'): Map<number, string[]> {
  load();
  return byToneByVersion.get(version) ?? byTone!;
}

/**
 * Visual face-fullness overrides for generic heads/portraits whose actual sculpted
 * cheek/jaw/neck thickness in Madden 27 disagrees with EA's filename build token.
 * Keyed by lowercase suffix after `gen_` or `plpo_generic_`.
 */
export const VISUAL_HEAD_BUILD_OVERRIDES: Record<string, string> = {
  // Visibly chubby / heavy / double-chin faces mislabeled under _B_ / _BM_ / _BMH_ / _BHTM_
  '1_b_n_007': 'H',
  '1_b_n_01': 'H',
  '1_b_s_002': 'H',
  '2_b_bd_03': 'H',
  '2_b_n_0018': 'H',
  '2_b_s_007': 'H',
  '2_bmh_s_010': 'H',
  '3_b_b_01': 'H',
  '3_b_b_001': 'H',
  '4_b_ms_02': 'H',
  '4_b_n_01': 'H',
  '5_b_bd_03': 'H',
  '5_b_ms_02': 'H',
  '5_bhtm_gs_001': 'H',
  '6_bm_n_009': 'H',
  '6_b_g_06': 'H',
  '6_b_n_0011': 'H',
  '6_b_n_004': 'H',
  '6_b_n_006': 'H',
  '7_b_g_008': 'H',
  '7_b_n_0012': 'H',
  '7_b_n_014': 'H',
  '7_b_n_09': 'H',
  '7_b_s_005': 'H',

  // Visibly lean / normal athletic faces mislabeled under _H_
  '1_h_bd_02': 'B',
  '2_h_bd_03': 'M',
  '2_h_b_010': 'M',
  '2_h_n_007': 'M',
  '3_h_s_001': 'B',
  '4_h_n_002': 'M',
  '5_h_n_01': 'B',
  '5_h_s_010': 'B',
};

/** Extract the effective build token ('H', 'M', 'B', 'T', 'BM', 'BMH', 'BMT', etc.) from a
 *  generic head (`gen_<tone>_<build>_...`) or portrait (`plpo_generic_<tone>_<build>_...`),
 *  applying visual face-fullness overrides before falling back to the filename token. */
export function headBuildCode(code: string | null | undefined): string {
  if (!code) return '';
  const trimmed = code.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('gen_')) {
    const ov = VISUAL_HEAD_BUILD_OVERRIDES[lower.slice(4)];
    if (ov) return ov;
  } else if (lower.startsWith('plpo_generic_')) {
    const ov = VISUAL_HEAD_BUILD_OVERRIDES[lower.slice('plpo_generic_'.length)];
    if (ov) return ov;
  }
  const m = /^(?:gen|plpo_generic)_\d+_([A-Za-z]+)_/i.exec(trimmed);
  return m ? m[1].toUpperCase() : '';
}

/** Style group classification for generic 3D heads and portraits */
export type HeadStyleGroup = 'bald' | 'clean' | 'beard' | 'goatee_stubble' | 'unknown';

/** Extract the style token ('B', 'BD', 'BM', 'G', 'N', 'S', etc.) from a generic head or portrait */
export function headStyleCode(code: string | null | undefined): string {
  if (!code) return '';
  const parts = code.trim().split('_');
  if (parts.length >= 4 && /^gen$/i.test(parts[0])) {
    return parts[3].toUpperCase();
  }
  if (parts.length >= 6 && /^plpo_generic$/i.test(parts[0] + '_' + parts[1])) {
    if (!parts[4].match(/^\d+$/)) {
      return parts[4].toUpperCase();
    }
  }
  return '';
}

/** Classifies a head or portrait style code into visual hairstyle & facial hair compatibility groups */
export function headStyleGroup(code: string | null | undefined): HeadStyleGroup {
  const s = headStyleCode(code) || (code ? code.trim().toUpperCase() : '');
  if (s === 'B') return 'bald';
  if (s === 'N') return 'clean';
  if (['BD', 'BM', 'BMS', 'MB'].includes(s)) return 'beard';
  if (['G', 'GM', 'GS', 'M', 'MG', 'MS', 'S'].includes(s)) return 'goatee_stubble';
  return 'unknown';
}


/** Infer a player's effective face-matching bodyType. Heavy linemen (285+ lbs or 275+ lb OL/DT)
 *  always receive Heavy-tier faces even if their body mesh rolled Muscular, and non-linemen under
 *  265 lbs never receive Heavy-tier chubby faces. */
export function inferPlayerBodyType(player: BaselinePlayer, explicitBodyType?: string | null): string {
  const pos = (player.position || '').toUpperCase().trim();
  const w = Number(player.weight) || 0;
  const isLinemanPos = ['OT', 'LT', 'RT', 'T', 'OG', 'LG', 'RG', 'G', 'C', 'OL', 'DT', 'NT', 'IDL'].includes(pos);
  if (w >= 285 || (isLinemanPos && (w === 0 || w >= 275))) {
    return 'Heavy';
  }
  const candidate = (explicitBodyType && ['Heavy', 'Muscular', 'Standard', 'Thin', 'Lean'].includes(explicitBodyType))
    ? explicitBodyType
    : (player.likenessFix?.bodyType && ['Heavy', 'Muscular', 'Standard', 'Thin', 'Lean'].includes(player.likenessFix.bodyType))
      ? player.likenessFix.bodyType
      : '';
  if (candidate) {
    if (candidate === 'Heavy' && w > 0 && w < 265 && !isLinemanPos) {
      return w >= 230 ? 'Muscular' : 'Standard';
    }
    return candidate;
  }
  if (['DE', 'LE', 'RE', 'LEDG', 'REDG', 'EDGE', 'LB', 'MLB', 'ILB', 'OLB', 'LOLB', 'ROLB', 'SAM', 'WILL', 'MIKE', 'TE', 'FB'].includes(pos) || w >= 235) {
    return 'Muscular';
  }
  if (['WR', 'CB', 'K', 'P'].includes(pos) && w > 0 && w < 192) {
    return 'Thin';
  }
  return 'Standard';
}

/** Compatibility tier (1 = ideal build match, 2 = acceptable fallback build, 0 = incompatible)
 *  between an effective head/portrait build token and a Madden bodyType. */
export function buildCompatibilityTier(build: string, bodyType: string): 0 | 1 | 2 {
  if (!build) return 2; // Legacy M26 code without build token
  const bt = bodyType || 'Standard';
  if (bt === 'Heavy') {
    // Only true Heavy ('H') heads/portraits match Heavy players; composite codes
    // ('BMH', 'BHM', 'BHTM', 'BMTH') have lean/athletic face geometry.
    return build === 'H' ? 1 : 0;
  }
  if (bt === 'Muscular') {
    if (build === 'M' || build === 'BM' || build === 'BMH' || build === 'BHM') return 1;
    if (build === 'B') return 2;
    return 0;
  }
  if (bt === 'Thin' || bt === 'Lean') {
    if (build === 'T' || build === 'BMT' || build === 'BTM') return 1;
    if (build === 'B') return 2;
    return 0;
  }
  // Standard
  if (build === 'B' || build === 'BM' || build === 'BMT' || build === 'BTM' || build === 'BMH' || build === 'BHM' || build === 'BHTM' || build === 'BMTH') return 1;
  if (build === 'M' || build === 'T') return 2;
  return 0;
}

/** Evaluates a generic head code against a bodyType, checking both the 3D head build token
 *  and its mapped 2D portrait build token so neither the 3D head nor the menu portrait conflicts. */
function headTierForBodyType(code: string, bodyType: string, version: 'm26' | 'm27'): 0 | 1 | 2 {
  const headTier = buildCompatibilityTier(headBuildCode(code), bodyType);
  if (headTier === 0) return 0;
  const pid = pidByVersion.get(version)?.get(code) ?? pidByCode?.get(code) ?? 0;
  const plpo = pid ? pidToPlpoMap.get(pid) : undefined;
  if (plpo && plpo.startsWith('plpo_generic_')) {
    const plpoBuild = headBuildCode(plpo);
    if (plpoBuild) {
      const plpoTier = buildCompatibilityTier(plpoBuild, bodyType);
      if (plpoTier === 0) return 0;
      const plpoTone = toneFromCode('gen_' + plpo.slice('plpo_generic_'.length));
      if (plpoTone !== toneFromCode(code)) return 0;
      return Math.max(headTier, plpoTier) as 1 | 2;
    }
  }
  return headTier;
}

/** Filters a tone's generic head pool to heads whose build matches `bodyType`. */
function filterPoolByBodyType(pool: string[], bodyType: string, version: 'm26' | 'm27'): { tier1: string[]; tier2: string[]; all: string[] } {
  const tier1: string[] = [];
  const tier2: string[] = [];
  for (const code of pool) {
    const t = headTierForBodyType(code, bodyType, version);
    if (t === 1) tier1.push(code);
    else if (t === 2) tier2.push(code);
  }
  const all = tier1.length + tier2.length > 0 ? [...tier1, ...tier2] : pool;
  return { tier1: tier1.length > 0 ? tier1 : all, tier2, all };
}

function toneFromCode(code: string): number {
  const m = code.match(/^gen_(\d+)/i);
  return m ? parseInt(m[1], 10) : 4;
}

/** Deterministic 32-bit hash for reproducible per-player face selection. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function raceToSkinTone(race: number | null): number {
  if (race != null && race >= 1 && race <= 8) return race;
  return 4; // unknown -> mid tone
}

export type LikenessKind = 'asset' | 'generic';

export interface Likeness {
  peps: string; // real asset name OR a gen_ generic code
  kind: LikenessKind;
  skinTone: number;
}

export const LikenessService = {
  /** Generic heads available for a skin tone in a game (that game's own usage). */
  headsForTone(tone: number, version: 'm26' | 'm27' = 'm26'): string[] {
    return [...(poolsFor(version).get(tone) ?? [])];
  },

  /** Generic draft-class face codes grouped by skin tone (1-8), for the face picker. */
  genericHeadsByTone(version: 'm26' | 'm27' = 'm26'): Record<number, string[]> {
    const out: Record<number, string[]> = {};
    for (const [tone, codes] of poolsFor(version)) out[tone] = [...codes].sort();
    return out;
  },

  /** Portrait PID for a gen_* generic face code (for head previews), else null. */
  genericPid(code: string, version: 'm26' | 'm27' = 'm26'): number | null {
    load();
    const fromGame = pidByVersion.get(version)?.get(code);
    if (fromGame) return fromGame;
    // Not in this game's catalog: the other game's pairing, then the validated lookup.
    const other = pidByVersion.get(version === 'm26' ? 'm27' : 'm26')?.get(code);
    return other || pidByCode!.get(code) || null;
  },

  /** The real head this player gets in `version`, or null for a generic.
   *   1. the lookup's asset id, when that game ships it (scan bundle or roster);
   *   2. a roster player of the same name whose draft year matches within a year
   *      (covers players the lookup has no asset for — rookies, name variants);
   *   3. M27 only: a recent lookup asset (>= 2019) the advanced autosave no longer
   *      lists — heads carry over between games;
   *   4. M26 only: any lookup asset (the lookup was built from M26's own files). */
  realFace(player: Pick<BaselinePlayer, 'firstName' | 'lastName' | 'draftYear' | 'playerAssetsId' | 'photoId'> & { source?: BaselinePlayer['source'] }, version: 'm26' | 'm27'): RealFace | null {
    if (player.source === 'generated') return null;
    const head = this.resolveHead(player, version);
    if (!head) return null;
    return { ...head, ...this.portraitFor(player, head, version) };
  },

  /** Menu portrait for a real head. The games key portraits by PID; a PID the game
   *  has no image for shows the blank NFL shield. M27 dropped most retired players'
   *  regular portraits (plpo_<name>, 7,956 in M26 -> 3,339) but keeps the legends set
   *  (plpo_legends_<name>, its own PID: Polamalu 4829, not the regular 63), so
   *  legends first, then the roster's PID, then the regular portrait when shipped. */
  portraitFor(player: Pick<BaselinePlayer, 'firstName' | 'lastName' | 'photoId'>, head: RealFace, version: 'm26' | 'm27'): { portraitPid: number; portraitKind: 'legend' | 'roster' | 'player' | 'none' } {
    const cat = catalogFor(version);
    const f = player.firstName.toLowerCase().replace(/[^a-z]/g, '');
    const l = player.lastName.toLowerCase().replace(/[^a-z]/g, '');
    const legend = legendPidFor(cat, player.firstName, player.lastName);
    const roster = /roster/.test(head.source) ? head.portraitPid : 0;
    const reviewed = REVIEWED_BUNDLE_PORTRAITS[head.assetName.toLowerCase()];
    const regular = reviewed
      ? (cat.playerPortraits.has(reviewed.key) ? reviewed.pid : 0)
      : (cat.playerPortraits.has(l + f) || cat.playerPortraits.has(f + l) ? (player.photoId || head.portraitPid || 0) : 0);
    if (version === 'm26') {
      if (regular) return { portraitPid: regular, portraitKind: 'player' };
      if (roster) return { portraitPid: roster, portraitKind: 'roster' };
      if (legend) return { portraitPid: legend, portraitKind: 'legend' };
      return { portraitPid: player.photoId || head.portraitPid || 0, portraitKind: player.photoId || head.portraitPid ? 'player' : 'none' };
    }
    if (legend) return { portraitPid: legend, portraitKind: 'legend' };
    if (roster) return { portraitPid: roster, portraitKind: 'roster' };
    if (regular) return { portraitPid: regular, portraitKind: 'player' };
    return { portraitPid: 0, portraitKind: 'none' };
  },

  /** A manually selected scan's own verified menu portrait, never the old player's. */
  portraitPidForAsset(asset: string, version: 'm26' | 'm27'): number {
    const head = catalogFor(version).assets.get(asset.toLowerCase());
    if (!head) return 0;
    return this.portraitFor({ firstName: head.first ?? '', lastName: head.last ?? '', photoId: head.portraitPid }, head, version).portraitPid;
  },

  /** The head asset only (see realFace for the portrait). */
  resolveHead(player: Pick<BaselinePlayer, 'firstName' | 'lastName' | 'draftYear' | 'playerAssetsId' | 'photoId'> & { source?: string }, version: 'm26' | 'm27'): RealFace | null {
    if (player.source === 'generated') return null;
    const cat = catalogFor(version);
    const asset = (player.playerAssetsId || '').trim();
    const hasAsset = !!asset && !/^gen_/i.test(asset);
    const key = m27Key(player.firstName, player.lastName);
    if (hasAsset) {
      const hit = cat.assets.get(asset.toLowerCase());
      if (hit) {
        // (portraitPid stays the catalog's own value here — 0 when the roster PID was a
        // generic portrait; portraitFor decides what to show.)
        // A roster head belongs to a CURRENT player. The lookup pairs some old rows
        // with a namesake's id (1989 DJ Johnson -> JohnsonDJ_22983): same name,
        // wrong person — only accept it when the draft years agree.
        // (A scan-backed id with no nflverse year for the name — Gates, undrafted — is fine.)
        if (/roster/.test(hit.source) && !this.sameEra(key, player.draftYear, /bundle/.test(hit.source))) return null;
        if (ACCEPT_PRESET_HEADS || !/preset/.test(hit.source)) {
          return { ...hit, assetName: hit.assetName || asset };
        }
      }
    }
    const byName = cat.byName.get(key);
    if (byName) {
      const face = cat.assets.get(byName);
      // A catalog entry that knows its owner's draft year (lookup-matched scans)
      // is checked against it directly; roster heads fall back to nflverse.
      const same = face?.draftYear
        ? player.draftYear == null || Math.abs(player.draftYear - face.draftYear) <= 1
        : this.sameEra(key, player.draftYear);
      if (face && same && (ACCEPT_PRESET_HEADS || !/preset/.test(face.source))) return face;
    }
    // Same lookup with punctuation and spacing ignored, for "T. J." against
    // "t.j.". Deliberately after the exact key and behind the identical era
    // check: the loose key is what would otherwise hand the 2026 pick 149 named
    // Justin Jefferson the 2020 receiver's face. An empty value means two
    // catalog names collapsed to this key, which is not a match but an
    // ambiguity, so it is skipped.
    const tight = cat.byNameTight.get(m27KeyTight(player.firstName, player.lastName));
    if (tight) {
      const face = cat.assets.get(tight);
      const same = face?.draftYear
        ? player.draftYear == null || Math.abs(player.draftYear - face.draftYear) <= 1
        : this.sameEra(key, player.draftYear);
      if (face && same && (ACCEPT_PRESET_HEADS || !/preset/.test(face.source))) return face;
    }
    const reviewedAsset = REVIEWED_HEAD_ALIASES[`${m27KeyTight(player.firstName, player.lastName)}|${player.draftYear}`];
    const reviewedHead = reviewedAsset ? cat.assets.get(reviewedAsset) : undefined;
    if (reviewedHead && (ACCEPT_PRESET_HEADS || !/preset/.test(reviewedHead.source))) return reviewedHead;
    if (hasAsset) {
      const own = { assetName: asset, portraitPid: player.photoId || 0, genericHead: null, first: player.firstName, last: player.lastName };
      // MUT legends added since the cranium pipeline have no scan bundle, only a
      // legends portrait. In-game (M27) a legends portrait did NOT guarantee a head
      // (Suggs rendered as the default head), so on M27 the portrait is used on its
      // own over a generic head unless MADDEN27_TRUST_LEGEND_IDS=1; M26 keeps the id.
      if (this.hasLegendPortrait(player.firstName, player.lastName, version) && (version === 'm26' || M27_TRUST_LEGEND_IDS)) return { ...own, source: 'legend-portrait' };
      // M26: the lookup was built from M26's own files, so keep the id — unless a
      // modern namesake exists and the draft years disagree (that id is his).
      if (version === 'm26' && this.sameEra(key, player.draftYear, true)) return { ...own, source: 'lookup' };
      // M27 kept 1,275 of M26's 1,276 scan bundles, so heads carry over between
      // the games: a head on the M26 roster (a 2025 player, now maybe retired
      // and gone from the advanced M27 autosave) is still in M27.
      if (version === 'm27') {
        const prev = catalogFor('m26').assets.get(asset.toLowerCase());
        if (prev && /roster/.test(prev.source) && this.sameEra(key, player.draftYear, true)) return { ...own, portraitPid: prev.portraitPid || own.portraitPid, source: 'm26-roster' };
      }
      if ((player.draftYear ?? 0) >= M27_TRUST_LOOKUP_FROM) return { ...own, source: 'lookup-recent' };
      if (version === 'm27' && M27_TRUST_ALL_M26_HEADS && this.sameEra(key, player.draftYear, true)) return { ...own, source: 'm26-lookup' };
    }
    return null;
  },

  /** The legends-portrait PID for this player in `version`, or 0. Works without a
   *  head: a generic-head prospect can still show the real menu portrait. */
  legendPortraitPid(firstName: string, lastName: string, version: 'm26' | 'm27'): number {
    return legendPidFor(catalogFor(version), firstName, lastName) ?? 0;
  },

  /** Does the game ship a legends portrait for this player (plpo_legends_<name>)? */
  hasLegendPortrait(firstName: string, lastName: string, version: 'm26' | 'm27'): boolean {
    const lp = catalogFor(version).legendPortraits;
    if (!lp.size) return false;
    const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
    const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
    return lp.has(l + f) || lp.has(f + l);
  },

  /** A roster scan belongs to a CURRENT player; a 1987 Cornelius Bennett must not
   *  receive a current Bennett's head. Same name + draft year within 1 = same person. */
  sameEra(nameKey: string, draftYear?: number, unknownOk = false): boolean {
    const ownerYear = loadDraftYears().get(nameKey);
    if (draftYear != null && ownerYear != null) return Math.abs(draftYear - ownerYear) <= 1;
    if (unknownOk) return true;
    if (draftYear != null && draftYear < 2015) return false;
    return true;
  },

  /** @deprecated use realFace(player, 'm27') */
  m27FaceFor(firstName: string, lastName: string, draftYear?: number): { assetName: string; portraitPid: number; genericHead: string | null } | null {
    return this.realFace({ firstName, lastName, draftYear: draftYear ?? 0, playerAssetsId: null, photoId: null }, 'm27');
  },

  /** Real 3D face-scan catalog for the target game (M26 lookup assets vs M27 save extract). */
  faceScans(gameVersion: 'm26' | 'm27'): Array<{ id: string; name: string; asset: string; portraitPid?: number; image?: string }> {
    const title = (s: string) => s.replace(/\w/g, (c) => c.toUpperCase());
    if (gameVersion === 'm27') {
      return [...catalogFor('m27').assets.values()]
        .filter((v) => v.first && v.last)
        .map((v) => ({
          id: v.assetName,
          name: `${v.first} ${v.last}`,
          asset: v.assetName,
          portraitPid: v.portraitPid || undefined,
          image: v.portraitPid ? `/api/portrait/pid/${v.portraitPid}` : undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!m26Scans) {
      m26Scans = [];
      try {
        const rows = parseCsvFile<Record<string, string>>(path.join(LOOKUPS_DIR, 'ALL_PLAYER_LOOKUP.csv'));
        const seen = new Set<string>();
        for (const r of rows) {
          const asset = (r['Player Assets ID'] || '').trim();
          if (!asset || /^gen_/i.test(asset) || seen.has(asset)) continue;
          seen.add(asset);
          const first = (r['First Name'] || '').trim();
          const last = (r['Last Name'] || '').trim();
          const pid = parseInt(r.PhotoID || '', 10);
          m26Scans.push({
            id: asset,
            name: `${first} ${last}`.trim() || asset,
            asset,
            portraitPid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
            image: Number.isFinite(pid) && pid > 0 ? `/api/portrait/pid/${pid}` : undefined,
          });
        }
        m26Scans.sort((a, b) => a.name.localeCompare(b.name));
      } catch { /* lookup missing */ }
    }
    return m26Scans;
  },

  /** Assign a face for a player. `index` keeps generic picks reproducible.
   *  A real head only when the target game can render it (see realFace); an asset
   *  the game lacks would show as the empty NFL-shield silhouette. */
  /** The generic heads of `tone` that look most like measured face features
   *  (hair vs skin, hair coverage, facial hair), nearest first, at most `k`.
   *  Empty when the game's heads have no measured features. */
  rankHeads(features: FaceFeatures, tone: number, gameVersion: 'm26' | 'm27' = 'm26', k = 6): string[] {
    load();
    const pool = poolsFor(gameVersion).get(tone) ?? [];
    const heads = headFeatures()[gameVersion];
    if (!heads) return pool.slice(0, k);
    return pool
      .filter((c) => heads[c])
      .map((c) => ({ c, d: faceDistance(features, heads[c]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .map((x) => x.c);
  },

  assign(player: BaselinePlayer, index: number, gameVersion: 'm26' | 'm27' = 'm26', bodyType?: string): Likeness {
    load();
    const tone = raceToSkinTone(player.race);
    const real = this.realFace(player, gameVersion);
    if (real) return { peps: real.assetName, kind: 'asset', skinTone: tone };
    return this.generic(player, index, gameVersion, bodyType);
  },

  /** The generic head this player would get (reproducible by `index` and matched to `bodyType`). */
  generic(player: BaselinePlayer, index: number, gameVersion: 'm26' | 'm27' = 'm26', bodyType?: string): Likeness {
    load();
    const tone = raceToSkinTone(player.race);
    const pools = poolsFor(gameVersion);
    let pool = pools.get(tone);
    // Heads with built-in headwear (skull cap / do-rag — a `headaccessory` part in
    // the game files) are a 2000s look; keep them off players drafted before 1995
    // when the tone still has enough plain heads to choose from.
    if (pool && (player.draftYear ?? 2026) < HEADWEAR_FROM) {
      const acc = catalogFor(gameVersion).headAccessory;
      const plain = pool.filter((h) => !acc.has(h.toLowerCase()));
      if (plain.length >= 3) pool = plain;
    }
    if (!pool || pool.length === 0) {
      // Nearest available tone, then any.
      for (let d = 1; d <= 7 && (!pool || pool.length === 0); d++) {
        pool = pools.get(tone - d) || pools.get(tone + d);
      }
      pool = pool && pool.length ? pool : [...pools.values()][0];
    }
    const targetBodyType = inferPlayerBodyType(player, bodyType);
    const filtered = filterPoolByBodyType(pool, targetBodyType, gameVersion);
    // Use Tier 1 (strict build match) when it has at least 4 heads; otherwise include Tier 2 compatible builds.
    pool = filtered.tier1.length >= 4 ? filtered.tier1 : filtered.all;

    const mine = playerFeatures()[`${normalizeName(player.firstName)}_${normalizeName(player.lastName)}`];
    const heads = headFeatures()[gameVersion];
    if (mine && heads) {
      const ranked = pool
        .filter((c) => heads[c])
        .map((c) => ({ c, d: faceDistance(mine, heads[c]) }))
        .sort((a, b) => a.d - b.d);
      if (ranked.length) {
        const k = Math.min(ranked.length, GENERIC_MATCH_CANDIDATES);
        return { peps: ranked[index % k].c, kind: 'generic', skinTone: tone };
      }
    }
    return { peps: pool[index % pool.length], kind: 'generic', skinTone: tone };
  },

  /**
   * Class-wide generic head balancer & body-type synchronizer.
   * Ensures:
   * 1. Every generic-faced prospect's 3D head (`PEPS`) and 2D portrait (`PID`) strictly
   *    match their final post-variance `bodyType` (`Heavy`, `Muscular`, `Standard`, `Thin`, `Lean`).
   * 2. Generic heads are assigned across the 402-player class with minimum repetition
   *    (least-used first), prioritizing `Heavy` and `Thin` builds first so composite
   *    heads (`BMH`, `BMT`) aren't monopolized by `Standard`/`Muscular` players.
   * 3. For fictional/generated players (`source === 'generated'`), when a `(skinTone, bodyType)`
   *    pool is saturated (all Tier-1 heads already used once in the class), allows shifting
   *    to an unused Tier-1 head in an adjacent skin tone within the same demographic group
   *    (`{1,2,3}`, `{4,5}`, `{6,7}`) so all 262 generic heads/portraits can be utilized.
   */
  balanceClassGenericHeads(
    prospects: Array<Record<string, unknown>>,
    players: BaselinePlayer[],
    gameVersion: 'm26' | 'm27' = 'm26',
    variant = 0
  ): void {
    load();
    const pools = poolsFor(gameVersion);
    const acc = catalogFor(gameVersion).headAccessory;
    const headsFeat = headFeatures()[gameVersion];
    const pFeat = playerFeatures();
    const usage = new Map<string, number>();
    const pidUsage = new Map<number, number>();
    const pidForHead = (h: string): number => pidByVersion.get(gameVersion)?.get(h) ?? pidByCode?.get(h) ?? 0;

    const buildOrder: Record<string, number> = {
      Heavy: 0,
      Thin: 1,
      Lean: 1,
      Muscular: 2,
      Standard: 3,
    };

    const extra3d = fictionalExtraHeads();
    const portCatalog = genericPortraitCatalog();

    // Group extra 3D heads by (tone, bodyType)
    const extra3dByBucket = new Map<string, ExtraFictionalHead[]>();
    for (const h of extra3d) {
      const key = `${h.tone}|${h.bodyType}`;
      if (!extra3dByBucket.has(key)) extra3dByBucket.set(key, []);
      extra3dByBucket.get(key)!.push(h);
    }

    // Group cataloged portraits by (tone, bodyType tier, styleGroup) and (tone, bodyType tier, exactStyle)
    // Only modern portraits (carrying verified Madden style codes) are used for style borrowing.
    const portByStyleGroup = new Map<string, GenericPortraitEntry[]>();
    const portByExactStyle = new Map<string, GenericPortraitEntry[]>();
    for (const port of portCatalog) {
      if (!port.isModern) continue;
      const tone = port.tone;
      const sGroup = headStyleGroup(port.plpo);
      const sCode = headStyleCode(port.plpo);
      if (!sCode || sGroup === 'unknown') continue;

      const effectivePortBuild = headBuildCode(port.plpo) || port.build;
      for (const bt of ['Heavy', 'Muscular', 'Standard', 'Thin', 'Lean']) {
        const tier = buildCompatibilityTier(effectivePortBuild, bt);
        if (tier > 0) {
          const groupKey = `${tone}|${bt}|${tier}|${sGroup}`;
          if (!portByStyleGroup.has(groupKey)) portByStyleGroup.set(groupKey, []);
          portByStyleGroup.get(groupKey)!.push(port);

          const exactKey = `${tone}|${bt}|${tier}|${sCode}`;
          if (!portByExactStyle.has(exactKey)) portByExactStyle.set(exactKey, []);
          portByExactStyle.get(exactKey)!.push(port);
        }
      }
    }

    const isLongHairHead = (h: string): boolean => (headsFeat?.[h]?.hairCoverage ?? 1.0) < 0.95;
    const isLongHairPort = (entry: GenericPortraitEntry): boolean => {
      const genHead = 'gen_' + entry.plpo.slice('plpo_generic_'.length);
      if (isLongHairHead(genHead)) return true;
      return (entry.neckRatio ?? 1.5) < 0.90;
    };

    const indices: number[] = [];
    for (let i = 0; i < prospects.length; i++) {
      const p = prospects[i];
      const base = players[i];
      if (!p || !base) continue;
      if (base.likenessFix?.faceAsset) {
        const peps = String(p.PEPS || '');
        if (/^gen_/i.test(peps)) usage.set(peps, (usage.get(peps) ?? 0) + 1);
        continue;
      }
      const peps = String(p.PEPS || '');
      if (/^gen_/i.test(peps) || base.source === 'generated') {
        indices.push(i);
      }
    }

    const effectiveBodyTypeFor = (idx: number): string => {
      const pr = prospects[idx];
      const pl = players[idx];
      const merged: BaselinePlayer = {
        ...pl,
        weight: Number(pr?.weight) || pl.weight,
        position: String(pr?.position || pl.position),
      };
      return inferPlayerBodyType(merged, String(pr?.bodyType || ''));
    };

    indices.sort((a, b) => {
      const btA = effectiveBodyTypeFor(a);
      const btB = effectiveBodyTypeFor(b);
      const ordA = buildOrder[btA] ?? 3;
      const ordB = buildOrder[btB] ?? 3;
      if (ordA !== ordB) return ordA - ordB;
      return a - b;
    });

    const getToneCandidates = (tone: number, draftYear: number, bodyType: string) => {
      let raw = pools.get(tone) ?? [];
      // Filter out female bun / hair models
      raw = raw.filter((h) => !/^gen_7_b_[ng]_001[01]/i.test(h));
      if (draftYear < HEADWEAR_FROM) {
        const plain = raw.filter((h) => !acc.has(h.toLowerCase()));
        if (plain.length >= 3) raw = plain;
      }
      return filterPoolByBodyType(raw, bodyType, gameVersion);
    };

    const adjacentTones = (tone: number): number[] => {
      if (tone <= 3) return [1, 2, 3, 4].filter((t) => t !== tone);
      if (tone <= 5) return [4, 5, 3, 6].filter((t) => t !== tone);
      return [6, 7, 5, 4].filter((t) => t !== tone);
    };

    for (const i of indices) {
      const p = prospects[i];
      const base = players[i];
      const bodyType = effectiveBodyTypeFor(i);
      const draftYear = base.draftYear ?? 2026;
      let tone = raceToSkinTone(base.race);
      let { tier1, tier2, all } = getToneCandidates(tone, draftYear, bodyType);

      const isGenerated = base.source === 'generated';

      // For fictional generated players, check if we should assign an unused obscure 3D head scan
      // when generic heads in this tone start repeating or based on cross-year seed rotation
      let assignedExtraHead: ExtraFictionalHead | null = null;
      if (isGenerated && gameVersion === 'm27') {
        const extraBucket = extra3dByBucket.get(`${tone}|${bodyType}`) ?? [];
        const unusedExtra = extraBucket.filter((h) => (usage.get(h.assetName) ?? 0) === 0);
        const hasUnusedGen = tier1.some((h) => (usage.get(h) ?? 0) === 0);
        
        // Only fall back to extra 3D scans if every generic head in this tone AND adjacent tones is already used
        const hasUnusedAdjGen = adjacentTones(tone).some((adjTone) =>
          getToneCandidates(adjTone, draftYear, bodyType).tier1.some((h) => (usage.get(h) ?? 0) === 0)
        );
        const seedVal = hash(`${base.firstName}|${base.lastName}|${i}|${variant}|3d`);
        if (unusedExtra.length > 0 && !hasUnusedGen && !hasUnusedAdjGen) {
          assignedExtraHead = unusedExtra[seedVal % unusedExtra.length];
        }
      }

      if (assignedExtraHead) {
        const headAsset = assignedExtraHead.assetName;
        usage.set(headAsset, (usage.get(headAsset) ?? 0) + 1);
        p.PEPS = headAsset;
        const resolvedTone = assignedExtraHead.tone;

        const vis = (p.visuals ?? {}) as Record<string, unknown>;
        vis.skinTone = resolvedTone;
        const extraCands = getToneCandidates(resolvedTone, draftYear, bodyType);
        const fallbackPool = extraCands.tier1.length > 0 ? extraCands.tier1 : extraCands.all;
        let genHead = '';
        if (fallbackPool.length > 0) {
          genHead = fallbackPool[hash(`${base.firstName}|${base.lastName}|${i}|gen`) % fallbackPool.length];
          vis.genericHeadName = genHead;
        }
        p.visuals = vis;
        base.race = resolvedTone;

        // Constrain borrowed portrait to the genHead style group and hair silhouette
        const targetGroup = headStyleGroup(genHead);
        const headStyle = headStyleCode(genHead);
        const headIsLong = isLongHairHead(genHead);

        const filterCandidate = (entry: GenericPortraitEntry) => {
          if ((pidUsage.get(entry.pid) ?? 0) > 0) return false;
          return headIsLong ? isLongHairPort(entry) : !isLongHairPort(entry);
        };

        let candidates = (portByExactStyle.get(`${resolvedTone}|${bodyType}|1|${headStyle}`) ?? []).filter(filterCandidate);
        if (candidates.length === 0) {
          candidates = (portByExactStyle.get(`${resolvedTone}|${bodyType}|2|${headStyle}`) ?? []).filter(filterCandidate);
        }
        if (candidates.length === 0) {
          candidates = (portByStyleGroup.get(`${resolvedTone}|${bodyType}|1|${targetGroup}`) ?? []).filter(filterCandidate);
        }
        if (candidates.length === 0) {
          candidates = (portByStyleGroup.get(`${resolvedTone}|${bodyType}|2|${targetGroup}`) ?? []).filter(filterCandidate);
        }

        let chosenPid = 0;
        if (candidates.length > 0) {
          const picked = candidates[hash(`${base.firstName}|${base.lastName}|${i}|port`) % candidates.length];
          chosenPid = picked.pid;
          p.pinPortrait = true;
        } else if (genHead) {
          chosenPid = pidForHead(genHead);
        }

        p.PID = chosenPid;
        if (chosenPid) pidUsage.set(chosenPid, (pidUsage.get(chosenPid) ?? 0) + 1);
        continue;
      }

      // If every Tier-1 generic head in `tone` has already been assigned at least once,
      // check adjacent tones in the same demographic band for an unused Tier-1 head
      if (isGenerated) {
        const hasUnusedTier1 = tier1.some((h) => (usage.get(h) ?? 0) === 0);
        if (!hasUnusedTier1) {
          for (const adjTone of adjacentTones(tone)) {
            const adj = getToneCandidates(adjTone, draftYear, bodyType);
            const unusedAdj = adj.tier1.filter((h) => (usage.get(h) ?? 0) === 0);
            if (unusedAdj.length > 0) {
              tone = adjTone;
              tier1 = adj.tier1;
              tier2 = adj.tier2;
              all = adj.all;
              break;
            }
          }
        }
      }

      const mine = !isGenerated
        ? pFeat[`${normalizeName(base.firstName)}_${normalizeName(base.lastName)}`]
        : undefined;

      let candidatePool = tier1.length > 0 ? tier1 : all;
      if (tier1.every((h) => (usage.get(h) ?? 0) > 0) && tier2.some((h) => (usage.get(h) ?? 0) === 0)) {
        candidatePool = [...tier1, ...tier2];
      }

      if (mine && headsFeat) {
        const ranked = candidatePool
          .filter((c) => headsFeat[c])
          .map((c) => ({ c, d: faceDistance(mine, headsFeat[c]) }))
          .sort((a, b) => a.d - b.d);
        if (ranked.length > 0) {
          const k = Math.min(ranked.length, Math.max(GENERIC_MATCH_CANDIDATES, 8));
          candidatePool = ranked.slice(0, k).map((x) => x.c);
        }
      }

      const seedStride = hash(`${base.firstName}|${base.lastName}|${i}|${variant}`);
      let bestHead = candidatePool[seedStride % candidatePool.length];
      let bestScore = Infinity;

      for (let j = 0; j < candidatePool.length; j++) {
        const idx = (seedStride + j) % candidatePool.length;
        const h = candidatePool[idx];
        const count = usage.get(h) ?? 0;
        const pId = pidForHead(h);
        const pCount = pId ? (pidUsage.get(pId) ?? 0) : 0;
        const tierPenalty = tier1.includes(h) ? 0 : 0.35;
        const score = count + pCount * 0.5 + tierPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestHead = h;
          if (score === 0) break;
        }
      }

      if (bestHead) {
        usage.set(bestHead, (usage.get(bestHead) ?? 0) + 1);
        let chosenPid = pidForHead(bestHead);
        const resolvedTone = toneFromCode(bestHead);
        p.PEPS = bestHead;

        // Option 2: If chosenPid has already been used by another prospect in this class,
        // borrow an unused portrait strictly constrained to the SAME hairstyle, facial hair, and hair length
        if (isGenerated && (pidUsage.get(chosenPid) ?? 0) > 0) {
          const headStyle = headStyleCode(bestHead);
          const targetGroup = headStyleGroup(bestHead);
          const headIsLong = isLongHairHead(bestHead);

          const filterCandidate = (entry: GenericPortraitEntry) => {
            if ((pidUsage.get(entry.pid) ?? 0) > 0) return false;
            return headIsLong ? isLongHairPort(entry) : !isLongHairPort(entry);
          };

          let candidates = (portByExactStyle.get(`${resolvedTone}|${bodyType}|1|${headStyle}`) ?? []).filter(filterCandidate);
          if (candidates.length === 0) {
            candidates = (portByExactStyle.get(`${resolvedTone}|${bodyType}|2|${headStyle}`) ?? []).filter(filterCandidate);
          }
          if (candidates.length === 0) {
            candidates = (portByStyleGroup.get(`${resolvedTone}|${bodyType}|1|${targetGroup}`) ?? []).filter(filterCandidate);
          }
          if (candidates.length === 0) {
            candidates = (portByStyleGroup.get(`${resolvedTone}|${bodyType}|2|${targetGroup}`) ?? []).filter(filterCandidate);
          }

          if (candidates.length > 0) {
            const picked = candidates[hash(`${base.firstName}|${base.lastName}|${i}|port`) % candidates.length];
            chosenPid = picked.pid;
            p.pinPortrait = true;
          }
          // If no style-compatible unused portrait exists in this tone/build, chosenPid remains
          // pidForHead(bestHead) (the authentic 1:1 portrait), preserving 100% hair & facial hair fidelity.
        }

        p.PID = chosenPid;
        if (chosenPid) pidUsage.set(chosenPid, (pidUsage.get(chosenPid) ?? 0) + 1);

        const vis = (p.visuals ?? {}) as Record<string, unknown>;
        vis.genericHeadName = bestHead;
        vis.skinTone = resolvedTone;
        p.visuals = vis;
        if (isGenerated) {
          base.race = resolvedTone;
        }
      }
    }
  },
};
