import fs from 'fs';
import path from 'path';
import { LOOKUPS_DIR } from '../config/paths';
import { seededRng } from '../util/rng';
import { PositionMapper } from './PositionMapper';
import { LikenessService } from './LikenessService';

/**
 * The M27 attribute-section fields the game fills on every generated prospect and
 * copies verbatim into the franchise (decoded 2026-08-22 from the game's own
 * CAREERDRAFT-TEST* files and the M27 career save; distributions live in
 * data/lookups/m27-field-stats.json, rebuilt by scripts/build-m27-field-stats.ts).
 */

/** PLYR_BIRTHDATE packing used by the franchise Player table and copied verbatim
 *  from the draft file: (day << 11) | ((month - 1) << 7) | (year - 1940). */
export function encodeBirthdate(year: number, month: number, day: number): number {
  const y = Math.max(1940, Math.min(1940 + 127, Math.round(year)));
  const m = Math.max(1, Math.min(12, Math.round(month)));
  const d = Math.max(1, Math.min(31, Math.round(day)));
  return ((d << 11) | ((m - 1) << 7) | (y - 1940)) & 0xffff;
}

export function decodeBirthdate(v: number): { year: number; month: number; day: number } {
  return { year: (v & 0x7f) + 1940, month: ((v >> 7) & 0xf) + 1, day: v >> 11 };
}

/** visuals.bodyType string -> byte at 0x91 (from the game's generated classes). */
export const BODY_TYPE_ID: Record<string, number> = { Standard: 0, Thin: 1, Muscular: 2, Heavy: 3, Lean: 4 /* Player-table enum `Freshman` */ };

/** Rookies are drafted into the franchise's current season, not the historical
 *  draft year, so a 1965 class imported today is born ~2004. The game's own rookies
 *  carry ages 21-24; the birth year follows from the age on this reference season. */
export const ROOKIE_REFERENCE_SEASON = Number(process.env.MADDEN_SEASON || 2026);

interface FieldStats {
  surnameCommentary: Record<string, number>;
  headPid: Record<string, number>;
  personality: Record<string, { mean: number; std: number; n: number; slopeVsOvr: number }>;
  focus: Record<string, number>;
  qbStyle: Record<string, number>;
  hidden87: Record<string, number>;
  hidden9c: Record<string, number>;
}

let stats: FieldStats | null = null;
function load(): FieldStats {
  if (stats) return stats;
  stats = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'm27-field-stats.json'), 'utf8'));
  return stats!;
}

let supplement: Record<string, number> | null = null;
/** Announcer ids for surnames the generated table lacks (data/lookups/m27-commentary-supplement.json,
 *  built by scripts/build-commentary-supplement.ts from MyFranchise's map). Missing file -> empty. */
function loadSupplement(): Record<string, number> {
  if (supplement) return supplement;
  try {
    supplement = JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'm27-commentary-supplement.json'), 'utf8')).surnameCommentary ?? {};
  } catch {
    supplement = {};
  }
  return supplement!;
}

const surnameKey = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** Weighted pick from a { value: count } histogram. */
function sampleHistogram(h: Record<string, number>, rand: () => number): number {
  const entries = Object.entries(h);
  const total = entries.reduce((s, [, c]) => s + c, 0) || 1;
  let x = rand() * total;
  for (const [v, c] of entries) {
    x -= c;
    if (x <= 0) return parseInt(v, 10);
  }
  return parseInt(entries[entries.length - 1]?.[0] ?? '0', 10);
}

/** Approximate gaussian from a seeded uniform source (Box-Muller). */
function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Average rookie overall in the game's classes — the slope pivots around it. */
const CLASS_MEAN_OVR = 66;

/** Announcer id for a surname (both games share the id space), or 0 when the game
 *  has no audio for it (the game's own classes write 0 too). Our verified table first,
 *  then the MyFranchise-derived supplement. */
export function commentaryIdFor(lastName: string): number {
  const key = surnameKey(lastName);
  return load().surnameCommentary[key] ?? loadSupplement()[key] ?? 0;
}

/** Menu-portrait PID for a generic head name. The M27 classes showed 196 heads
 *  directly; for the rest the M26 portrait table applies (the two games share the
 *  PID for every head they both use). 0 when neither knows the head. */
export function genericHeadPid(genericHeadName: string | null | undefined): number {
  if (!genericHeadName) return 0;
  return load().headPid[genericHeadName] ?? LikenessService.genericPid(genericHeadName, 'm27') ?? 0;
}

export interface M27PlayerBits {
  birthDate?: string | null; // 'YYYY-MM-DD' when nflverse knows the real birthday
}

/**
 * Fill the M27-only binary fields on a prospect (in place). Deterministic per seed
 * so the preview and the export agree. Leaves any value the caller already set
 * (e.g. a real M27 face's portrait PID, or a user edit) untouched.
 */
/** The mindset focus (0-3) assignM27Fields will draw for `seedKey` when the prospect
 *  has no explicit focus: same seeded stream, same draws in the same order (the
 *  personality gaussian is consumed first unless a rating was preset). */
export function focusFor(seedKey: string, personalityPreset = false): number {
  const rand = seededRng(`m27|${seedKey}`);
  if (!personalityPreset) gauss(rand);
  return sampleHistogram(load().focus, rand);
}

export function assignM27Fields(prospect: Record<string, unknown>, bits: M27PlayerBits, seedKey: string): void {
  const rand = seededRng(`m27|${seedKey}`);
  const s = load();
  const posId = Number(prospect.position) || 0;
  const posName = PositionMapper.name(posId);
  const overall = Number(prospect.overall) || CLASS_MEAN_OVR;

  // Portrait: generic heads map to a fixed PID; real scans keep the PID the builder set.
  const visuals = (prospect.visuals ?? {}) as { genericHeadName?: string };
  const peps = typeof prospect.PEPS === 'string' ? prospect.PEPS : '';
  const isRealScan = !!peps && !/^gen_/i.test(peps);
  const head = visuals.genericHeadName || (/^gen_/i.test(peps) ? peps : null);
  // pinPortrait: the builder set a legends portrait on a generic head — keep it.
  if (!isRealScan && head && !prospect.pinPortrait) prospect.PID = genericHeadPid(head);
  else if (prospect.PID == null) prospect.PID = 0;
  delete prospect.pinPortrait;

  prospect.commentaryId = commentaryIdFor(String(prospect.lastName ?? ''));
  prospect.bodyTypeId = BODY_TYPE_ID[String(prospect.bodyType ?? 'Standard')] ?? 0;

  if (prospect.personalityRating == null) {
    const ps = s.personality[posName] ?? s.personality.WR ?? { mean: 52, std: 14, slopeVsOvr: 1.5 };
    const v = ps.mean + ps.slopeVsOvr * (overall - CLASS_MEAN_OVR) + gauss(rand) * ps.std * 0.7;
    prospect.personalityRating = Math.max(10, Math.min(98, Math.round(v)));
  }
  if (prospect.focus == null) prospect.focus = sampleHistogram(s.focus, rand);
  if (prospect.qbStyle == null) prospect.qbStyle = posId === 0 ? sampleHistogram(s.qbStyle, rand) : 0;
  if (prospect.hidden87 == null) prospect.hidden87 = sampleHistogram(s.hidden87, rand);
  if (prospect.hidden9c == null) prospect.hidden9c = sampleHistogram(s.hidden9c, rand);

  if (prospect.birthdate == null) {
    const age = Number(prospect.age) || 22;
    const year = ROOKIE_REFERENCE_SEASON - age;
    const real = /^(\d{4})-(\d{2})-(\d{2})/.exec(bits.birthDate ?? '');
    const month = real ? parseInt(real[2], 10) : 1 + Math.floor(rand() * 12);
    const day = real ? parseInt(real[3], 10) : 1 + Math.floor(rand() * 28);
    prospect.birthdate = encodeBirthdate(year, month, day);
  }
}
