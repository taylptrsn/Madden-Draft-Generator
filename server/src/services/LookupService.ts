import fs from 'fs';
import path from 'path';
import { LOOKUPS_DIR } from '../config/paths';
import { parseCsvFile } from '../util/csv';

export interface LookupOption {
  id: number;
  name: string;
}

const FILES: Record<string, string> = {
  position: 'position_lookup.csv',
  college: 'college_lookup.csv',
  state: 'state_lookup.csv',
  archetype: 'archetype_lookup.csv',
};

const cache = new Map<string, LookupOption[]>();

// PFR/CSV college spellings -> exact college_lookup names (each target verified to
// exist in the lookup). The " St."->" State" / " Col."->" College" transforms in
// collegeId() handle the bulk; this table covers the irregular renames.
const COLLEGE_ALIASES: Record<string, string> = {
  mississippi: 'Ole Miss',
  'texas-el paso': 'UTEP',
  'texas el paso': 'UTEP',
  'bowling green': 'Bowling Green State',
  'southern california': 'USC',
  chattanooga: 'Tenn-Chattanooga',
  's.f. austin': 'Stephen F. Austin',
  'st. francis (pa)': 'St. Francis (PA)',
  'central florida': 'UCF',
  'texas christian': 'TCU',
  'brigham young': 'BYU',
  'louisiana state': 'LSU',
  'southern methodist': 'SMU',
  uconn: 'Connecticut',
  'middle tennessee': 'Middle Tennessee State',
  'southeastern louisiana': 'SE Louisiana',
  louisiana: 'UL Lafayette',
  'louisiana-monroe': 'UL Monroe',
  'western michigan': 'W. Michigan',
};

// 2-letter USPS -> full state name (the CSV hometown field mixes "City, GA" and
// "City, Georgia" forms). Keyed lowercase, periods stripped.
const STATE_ABBREV: Record<string, string> = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado',
  ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho',
  il: 'Illinois', in: 'Indiana', ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana',
  me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
  tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia',
};

/** Load a 2-column id,name lookup CSV into [{id,name}] (header-name agnostic). */
function loadLookup(name: string): LookupOption[] {
  if (cache.has(name)) return cache.get(name)!;
  const file = FILES[name];
  if (!file) throw new Error(`Unknown lookup: ${name}`);
  const full = path.join(LOOKUPS_DIR, file);
  const rows = parseCsvFile<Record<string, string>>(full);
  const opts: LookupOption[] = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;
    const id = parseInt(row[keys[0]], 10);
    const label = row[keys[1]];
    if (Number.isNaN(id) || label === undefined) continue;
    opts.push({ id, name: String(label).trim() });
  }
  cache.set(name, opts);
  return opts;
}

export const LookupService = {
  names(): string[] {
    return Object.keys(FILES);
  },

  get(name: string): LookupOption[] {
    return loadLookup(name);
  },

  /** name (case-insensitive) -> id for a given lookup. */
  nameToId(lookup: string, name: string): number | null {
    const opts = loadLookup(lookup);
    const n = name.trim().toLowerCase();
    const hit = opts.find((o) => o.name.toLowerCase() === n);
    return hit ? hit.id : null;
  },

  /**
   * College name -> Madden college id, resolving the PFR-style abbreviations in
   * ALL_PLAYER_LOOKUP ("Ohio St.", "Miami (FL)", "Mississippi") to the exact
   * college_lookup names. Only ever returns an id that EXISTS in the lookup — a
   * school Madden doesn't carry (NC State, South Florida, Marquette, …) resolves
   * to 0 (N/A) rather than a wrong-but-valid college. Raises match rate ~68% -> ~89%.
   */
  collegeId(name: string | null | undefined): number {
    if (!name) return 0;
    const raw = name.trim();
    const direct = this.nameToId('college', raw);
    if (direct != null) return direct;
    const low = raw.toLowerCase();
    // Miami (FL) vs Miami (OH) are different schools in the lookup.
    if (/^miami\s*\((fl|florida)\)$/.test(low)) return this.nameToId('college', 'Miami') ?? 0;
    if (/^miami\s*\((oh|ohio)\)$/.test(low)) return this.nameToId('college', 'Miami of Ohio') ?? 0;
    const alias = COLLEGE_ALIASES[low];
    if (alias) {
      const id = this.nameToId('college', alias);
      if (id != null) return id;
    }
    // "Ohio St." -> "Ohio State", "Boston Col." -> "Boston College", "Middle Tenn. St." -> "Middle Tennessee State".
    const t = raw
      .replace(/\bTenn\.(?=\s)/g, 'Tennessee')
      .replace(/\bSt\.\s*$/, 'State')
      .replace(/\bCol\.\s*$/, 'College')
      .replace(/\.$/, '')
      .trim();
    const tid = this.nameToId('college', t);
    if (tid != null) return tid;
    // Last resort: drop a trailing parenthetical qualifier.
    const stripped = this.nameToId('college', raw.replace(/\s*\([^)]*\)\s*$/, '').trim());
    return stripped ?? 0;
  },

  /** State name -> Madden state id, accepting full names and USPS abbreviations. */
  stateId(name: string | null | undefined): number | null {
    if (!name) return null;
    const n = name.trim();
    if (!n) return null;
    const direct = this.nameToId('state', n);
    if (direct != null) return direct;
    const ab = n.replace(/\./g, '').toLowerCase();
    return STATE_ABBREV[ab] ? this.nameToId('state', STATE_ABBREV[ab]) : null;
  },

  /** id -> name for a given lookup. */
  idToName(lookup: string, id: number): string | null {
    const hit = loadLookup(lookup).find((o) => o.id === id);
    return hit ? hit.name : null;
  },

  /** raw JSON lookup files (e.g. ovrweights.json) served to the client. */
  rawJson(file: string): unknown {
    const full = path.join(LOOKUPS_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`Lookup file not found: ${file}`);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  },
};
