import fs from 'fs';
import path from 'path';
import { CACHE_DIR } from '../config/paths';
import { parseCsvFile } from '../util/csv';

/**
 * Career usage totals for EVERY player since 1999 — drafted or not — from the
 * nflverse weekly player stats (offense: player_stats.csv; defense:
 * player_stats_def.csv). draft_picks only knows draftees, which is why Taysom Hill
 * (undrafted 2017: 448 carries, 104 catches, 304 pass attempts) looked like a
 * camp-arm quarterback. Identity is by gsis_id, resolved from players.csv by
 * name + draft year (or rookie season for the undrafted), so namesakes in other
 * years never collide; two same-name players in one year are reported ambiguous.
 *
 * Aggregated once into cache/nflverse_usage.json (career + best single season).
 */
export interface UsageTotals {
  gsis: string;
  seasons: number;
  attempts: number;      // pass attempts
  carries: number;
  receptions: number;
  recYards: number;
  rushYards: number;
  passYards: number;
  defInts: number;
  defSacks: number;
  defTackles: number;
  /** Best single season for each usage, for "was this ever a real role" checks. */
  maxSeason: { attempts: number; carries: number; receptions: number; defInts: number };
}

const USAGE_CACHE = path.join(CACHE_DIR, 'nflverse_usage.json');
const OFF = path.join(CACHE_DIR, 'nflverse_player_stats.csv');
const DEF = path.join(CACHE_DIR, 'nflverse_player_stats_def.csv');
const PLAYERS = path.join(CACHE_DIR, 'nflverse_players.csv');

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };

let byGsis: Map<string, UsageTotals> | null = null;
let byNameYear: Map<string, string[]> | null = null; // "first last|year" -> gsis ids

function build(): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  const perSeason = new Map<string, Record<string, number>>(); // gsis|season -> sums
  const bump = (g: string, season: string, k: string, v: number) => {
    const key = `${g}|${season}`;
    const rec = perSeason.get(key) ?? {};
    rec[k] = (rec[k] ?? 0) + v;
    perSeason.set(key, rec);
  };
  if (fs.existsSync(OFF)) {
    for (const r of parseCsvFile<Record<string, string>>(OFF)) {
      if ((r.season_type || 'REG') !== 'REG') continue;
      const g = (r.player_id || '').trim();
      if (!g) continue;
      bump(g, r.season, 'attempts', num(r.attempts));
      bump(g, r.season, 'carries', num(r.carries));
      bump(g, r.season, 'receptions', num(r.receptions));
      bump(g, r.season, 'recYards', num(r.receiving_yards));
      bump(g, r.season, 'rushYards', num(r.rushing_yards));
      bump(g, r.season, 'passYards', num(r.passing_yards));
    }
  }
  if (fs.existsSync(DEF)) {
    for (const r of parseCsvFile<Record<string, string>>(DEF)) {
      if ((r.season_type || 'REG') !== 'REG') continue;
      const g = (r.player_id || '').trim();
      if (!g) continue;
      bump(g, r.season, 'defInts', num(r.def_interceptions));
      bump(g, r.season, 'defSacks', num(r.def_sacks));
      bump(g, r.season, 'defTackles', num(r.def_tackles));
    }
  }
  for (const [key, rec] of perSeason) {
    const g = key.split('|')[0];
    const t = out.get(g) ?? { gsis: g, seasons: 0, attempts: 0, carries: 0, receptions: 0, recYards: 0, rushYards: 0, passYards: 0, defInts: 0, defSacks: 0, defTackles: 0, maxSeason: { attempts: 0, carries: 0, receptions: 0, defInts: 0 } };
    t.seasons++;
    for (const k of ['attempts', 'carries', 'receptions', 'recYards', 'rushYards', 'passYards', 'defInts', 'defSacks', 'defTackles'] as const) t[k] += rec[k] ?? 0;
    for (const k of ['attempts', 'carries', 'receptions', 'defInts'] as const) t.maxSeason[k] = Math.max(t.maxSeason[k], rec[k] ?? 0);
    out.set(g, t);
  }
  if (out.size > 0) {
    try { fs.writeFileSync(USAGE_CACHE, JSON.stringify([...out.values()])); } catch { /* read-only cache dir */ }
  }
  return out;
}

function load(): Map<string, UsageTotals> {
  if (byGsis) return byGsis;
  byGsis = new Map();
  try {
    const sources = [OFF, DEF].filter(fs.existsSync);
    const hasCache = fs.existsSync(USAGE_CACHE) && fs.statSync(USAGE_CACHE).size > 2;
    const fresh = hasCache && sources.every((f) => fs.statSync(USAGE_CACHE).mtimeMs >= fs.statSync(f).mtimeMs);
    if (fresh) for (const t of JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8')) as UsageTotals[]) byGsis.set(t.gsis, t);
    else if (sources.length > 0) byGsis = build();
  } catch { byGsis = build(); }
  return byGsis;
}

function loadNames(): Map<string, string[]> {
  if (byNameYear) return byNameYear;
  byNameYear = new Map();
  try {
    for (const r of parseCsvFile<Record<string, string>>(PLAYERS)) {
      const g = (r.gsis_id || '').trim();
      if (!g) continue;
      const year = parseInt(r.draft_year || '', 10) || parseInt(r.rookie_season || '', 10);
      if (!year) continue;
      const names = new Set<string>();
      const first = (r.first_name || r.common_first_name || '').trim();
      const last = (r.last_name || '').trim();
      if (first && last) names.add(norm(`${first} ${last}`));
      if (r.display_name) names.add(norm(r.display_name));
      for (const n of names) {
        const k = `${n}|${year}`;
        const list = byNameYear.get(k) ?? [];
        if (!list.includes(g)) list.push(g);
        byNameYear.set(k, list);
      }
    }
  } catch { /* players.csv absent */ }
  return byNameYear;
}

export const NflverseStatsService = {
  /** Career usage for a player identified by name + draft year (rookie season for
   *  the undrafted). null when unknown or when two players of that name entered
   *  the league the same year (never guess between them). */
  usage(first: string, last: string, draftYear: number): UsageTotals | null {
    const ids = loadNames().get(`${norm(`${first} ${last}`)}|${draftYear}`);
    if (!ids || ids.length !== 1) return null;
    return load().get(ids[0]) ?? null;
  },
  ambiguous(first: string, last: string, draftYear: number): boolean {
    return (loadNames().get(`${norm(`${first} ${last}`)}|${draftYear}`)?.length ?? 0) > 1;
  },
  get available(): boolean {
    return fs.existsSync(OFF);
  },
};
