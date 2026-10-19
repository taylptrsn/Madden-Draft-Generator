import type { GeneratedClass, ClassEdits, GearEdits, GearOption, LikenessStats, GameVersion, FaceScan, CatalogPlayer, BoardEntry, TeamFranchise, LikenessOverride, ToneFromPhoto, SaveFileInfo, RosterData, RosterDoc, RosterBuildResult, GeneratedRosterPlayer } from './types';

/** Generation options every class request carries (see App.DraftOpts). */
export interface ClassRequestOpts {
  source: 'year' | 'alltime' | 'decade' | 'picked' | 'team' | 'file' | 'freaks';
  decade?: number;
  /** An opened .mdc (source === 'file'). */
  fileId?: string;
  /** Franchise key (source === 'team'). */
  team?: string;
  strength: number;
  studs: number;
  generational: boolean;
  hindsight?: number;
  autoStrength?: boolean;
  variant?: number;
  include?: number[];
  /** Class Studio class (source === 'picked'): its board in pick order. */
  customId?: string;
  board?: BoardEntry[];
  keys?: string[];
  fill?: boolean;
  name?: string;
  freakMode?: boolean;
  freakPreset?: import('./types').FreakPreset;
  freakRate?: number;
  freakCap?: number;
  generationalShare?: number;
  hybridRate?: number;
  superFusionRate?: number;
  freakSeed?: number;
}

/** CAREERDRAFT-<SLUG> for a hand-picked class (mirrors the server's classSlug). */
export const classFileName = (name: string | undefined) =>
  `CAREERDRAFT-${(name ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16) || 'CUSTOM'}`;

let catalogCache: CatalogPlayer[] | null = null;

/** Backend-proxied image URL (avoids hotlink/CORS blocks on Wikipedia/PFR). */
export const imageUrl = (url: string) => `/api/image?url=${encodeURIComponent(url)}`;

interface PortraitRow {
  face?: string;
  draftYear?: number;
  photoUrl?: string | null;
  portrait?: string | null;
  gamePortrait?: string | null;
  firstName?: string;
  lastName?: string;
  position?: string;
}

/** Avatar sources, best first:
 *
 *   1. the player's OWN in-game portrait, when the game ships one for him
 *   2. his headshot off the Madden discs (2001-2017)
 *   3. a real photo from the web (NFL/ESPN/PFR/Wiki)
 *   4. the in-game menu portrait, which by this point is a generic head
 *
 *  Madden art comes before the web photo deliberately. The web sources are
 *  inconsistent for retirees — action shots, wrong-team jerseys, and scanned
 *  newspaper halftones — while every Madden headshot is the same studio crop on
 *  the same grey background, so a class rendered from them looks like one set.
 *  `gamePortrait` is separate from `portrait` because the latter silently falls
 *  back to a generic head keyed on skin tone, which is not a likeness and must
 *  stay last.
 *
 *  A source that errors — the proxy 404s dead NFL placeholder headshots, ESPN
 *  404s ids it never had — falls through to the next instead of a blank chip. */
export function displayPortraitChain(row: PortraitRow): string[] {
  const urls: string[] = [];
  if (row.gamePortrait) urls.push(row.gamePortrait);
  if (row.firstName && row.lastName) {
    // Position disambiguates same-name players from different eras: without it
    // the 1973 CB J.T. Thomas is served the 2011 LB's photo off a 2012 disc.
    // Position says what kind of player he was, the year says whether he was
    // playing when the disc shipped. The 1968 TE Steve Smith passes the position
    // check against the 2003 receiver -- both are REC -- and only the year
    // refuses him.
    const q = new URLSearchParams();
    if (row.position) q.set('position', row.position);
    if (row.draftYear != null) q.set('draftYear', String(row.draftYear));
    const qs = q.toString() ? `?${q}` : '';
    urls.push(`/api/portrait/retro/${encodeURIComponent(row.firstName)}/${encodeURIComponent(row.lastName)}${qs}`);
  }
  if (row.photoUrl) urls.push(imageUrl(row.photoUrl));
  if (row.portrait && row.portrait !== row.gamePortrait) urls.push(row.portrait);
  return urls;
}

/** First (best) avatar source; see displayPortraitChain. */
export function displayPortrait(row: PortraitRow): string | null {
  return displayPortraitChain(row)[0] ?? null;
}

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function jsend<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Identity of a real player for a likeness fix. */
export interface LikenessWho { firstName: string; lastName: string; draftYear: number }

export interface ArchetypeOption {
  id: number;
  name: string;
}

export interface PlayerSearchResult {
  firstName: string;
  lastName: string;
  draftYear: number;
  draftRound: number | null;
  draftPick: number | null;
  position: string;
  college: string;
  league: string;
}

/** A real NFL player whose in-game loadout can be copied onto a prospect. */
export interface RealGearPlayerSummary {
  id: number;
  name: string;
  team: string;
  position: string;
  jersey: number;
}
export interface RealGearPlayer extends RealGearPlayerSummary {
  gear: Record<string, string>; // slot -> M26 asset
}

/** One selectable M27 persona DNA trait. */
export interface PersonaTrait {
  id: number;
  name: string;
  label?: string; // the game's display name (Diva shows as "Particular")
  description?: string | null;
  icon?: string; // /api/portrait/dna-icon/<Name> (the game's art, else a drawn tile)
  hasIcon?: boolean;
}

/** One of the four M27 mindset-focus options (separate from the DNA traits). */
export interface PersonaFocusOption {
  id: number;
  name: string;
  label: string;
  description?: string | null;
}

export interface FranchiseInfo {
  name: string;
  sizeBytes: number;
  modified: number;
}

/** Result of writing an export straight into the Madden Saves folder. */
export interface SaveMdcResult {
  saved: boolean;
  path: string;
  filename: string;
  count: number;
  likeness: LikenessStats;
  /** M27 portrait pack written next to the export (null when off or empty). */
  portraitPack?: { dir: string; count: number; missing: number; errors: string[] } | null;
}

export interface CapResetOptions {
  clearDeadMoney: boolean;
  capRoomMode: 'off' | 'freed' | 'fixed';
  fixedCapRoomM?: number;
  rolloverFloorM?: number;
  salaryScale?: number | null;
}

interface CapState {
  deadMoneyM: number;
  nextDeadMoneyM: number;
  capRoomM: number;
  rolloverM: number;
}

export interface CapResetResult {
  input: string;
  output: string;
  teamsEdited: number;
  playersScaled: number;
  teams: { name: string; salaryM: number; before: CapState; after: CapState }[];
}

export interface PlayerEditOptions {
  healInjuries: boolean;
  setDev: { scope: 'all' | 'rookies'; tier: 'Normal' | 'Star' | 'Superstar' | 'XFactor' } | null;
}

export interface PlayerEditResult {
  input: string;
  output: string;
  playersConsidered: number;
  injuriesCleared: number;
  devSet: number;
}

export interface FranchisePlayer {
  id: number;
  firstName: string;
  lastName: string;
  position: string;
  teamIndex: number;
  team: string;
  overall: number;
  age: number;
  yearsPro: number;
  dev: string;
  jersey: number;
  status: string;
  ratings: Record<string, number>;
  bodyType: string;
  genericHead: string;
  helmet: string;
  facemask: string;
}

export interface FranchisePlayersResult {
  teams: { index: number; name: string }[];
  players: FranchisePlayer[];
}

export interface PlayerFieldEdit {
  overall?: number;
  age?: number;
  position?: string;
  dev?: string;
  jersey?: number;
  ratings?: Record<string, number>;
  bodyType?: string;
  genericHead?: string;
  gear?: Record<string, string>; // slot -> asset (helmet/facemask/…)
  // Roster-only fields (the Rosters view's profile card): see server/src/types/roster.ts.
  firstName?: string; lastName?: string;
  college?: number; heightInches?: number; weight?: number; archetype?: number;
  personaDNA?: number[]; focus?: number; faceAsset?: string; skinTone?: number;
}

export interface RgbColor { r: number; g: number; b: number; }

export interface TeamIdentity {
  teamIndex: number;
  displayName: string;
  nickName: string;
  city: string;
  abbreviation: string;
  prefix: string;
  logoId: number;
  hasSecondaryColor: boolean;
  primary: RgbColor;
  secondary: RgbColor;
  hub: RgbColor;
  locked: boolean;
}

export interface RelocateRebrandOptions {
  teamIndex: number;
  displayName?: string;
  nickName?: string;
  city?: string;
  abbreviation?: string;
  prefix?: string;
  primary?: RgbColor;
  secondary?: RgbColor;
  hub?: RgbColor;
  logoId?: number;
  setRelocatedFlag?: boolean;
}

export interface FieldChange { field: string; before: string | number; after: string | number; }

export interface RelocateRebrandResult {
  input: string;
  output: string;
  teamIndex: number;
  mode: 'REBRAND' | 'RELOCATE';
  teamName: string;
  wasLocked: boolean;
  changes: FieldChange[];
  skippedFields: string[];
}

export interface AdvanceRosterOptions {
  years?: number; retire?: boolean; regress?: boolean; devDowngrade?: boolean; includeUnsigned?: boolean; dryRun?: boolean; outputName?: string;
}
export interface AdvanceRosterResult {
  input: string; output: string; outputPath: string; dryRun: boolean; years: number;
  playersConsidered: number; aged: number; retired: number; regressed: number; devDowngraded: number;
  avgAgeBefore: number; avgAgeAfter: number; avgOvrBefore: number; avgOvrAfter: number;
  retirements: Array<{ name: string; position: string; team: string; age: number; overall: number }>;
  declines: Array<{ name: string; position: string; team: string; age: number; from: number; to: number }>;
}

export interface TraitRealismOptions {
  includeUnsigned?: boolean;
  xfactorCap?: number;
  superstarCap?: number;
  dryRun?: boolean;
}
export interface TraitTierCounts { Normal: number; Star: number; Superstar: number; XFactor: number; }
export interface TraitUpgrade {
  name: string; position: string; team: string; overall: number; age: number; from: string; to: string;
}
export interface TraitRealismResult {
  input: string; output: string; dryRun: boolean;
  playersConsidered: number; changed: number;
  before: TraitTierCounts; after: TraitTierCounts;
  byPosition: Record<string, TraitTierCounts>;
  notable: TraitUpgrade[];
}

export interface FaTrimOptions {
  ovrThreshold?: number;
  ageThreshold?: number;
  targetN?: number;
  dryRun?: boolean;
}
export interface FaTrimVictim { name: string; position: string; overall: number; age: number; }
export interface FaTrimResult {
  input: string; output: string; dryRun: boolean;
  freeAgentsBefore: number; trimmed: number; freeAgentsAfter: number;
  maxFreeAgents: number; victims: FaTrimVictim[];
}

export interface DraftPickResetOptions { dryRun?: boolean; }
export interface DraftPickRestore {
  round: number; pickNumber: number; yearOffset: number; fromTeam: string; toTeam: string;
}
export interface DraftPickResetResult {
  input: string; output: string; dryRun: boolean;
  poolRows: number; traded: number; restored: number; restores: DraftPickRestore[];
}

export interface EraRules {
  from: number; to: number; label: string; teams: number; conferences: number; divisionsPerConference: number;
  gamesPerTeam: number; regularSeasonWeeks: number;
  playoff: { teams: number; divisionWinners: number; wildCards: number; byes: number; rounds: string[] };
  rosterLimit: number; salaryCap: boolean; tradeDeadline: boolean; notes: string[];
}
export interface HistoricSeasonOption { year: number; era: EraRules | null; teams: number }
export interface TeamRecord { name: string; teamIndex: number; wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number }
export interface BracketSeed { seed: number; team: string; record: string; via: 'division' | 'wildcard'; division: string; bye: boolean }
export interface HistoricRule { key: string; label: string; wanted: string; current: string; status: 'matches' | 'differs' | 'unknown' | 'guidance' }
export interface HistoricPreview {
  input: string; year: number; era: EraRules;
  pack: { teams: number; games: number; rosterRows: number; rosterMatched: number; playoffGames: number };
  teamMap: { key: string; name: string; division: string; modernName: string; teamIndex: number | null; currentDivision: string | null }[];
  parked: { name: string; teamIndex: number | null }[];
  layout: { division: string; conference: string; teams: string[]; fits: boolean }[];
  saveLayout: { division: string; teams: string[] }[];
  schedule: { packWeeks: number; packGames: number; saveRegularWeeks: number; saveRegularGames: number; currentWeekType: string; currentWeek: number };
  rules: HistoricRule[];
  standings: TeamRecord[];
  bracket: { format: EraRules['playoff']; conferences: Record<string, BracketSeed[]>; games: { round: string; away: string; home: string }[]; notes: string[] };
  warnings: string[];
}

export interface ArmedRow { index: number; away: string; home: string; force: 'Home' | 'Away' | 'None'; reason: string; placeholder: boolean }
export interface ArmPlayoffsResult {
  input: string; output: string; outputPath: string; dryRun: boolean; year: number; mode: 'regular' | 'wildcard';
  field: Record<string, string[]>; rows: ArmedRow[]; notes: string[];
}

export interface ScheduleGame {
  away: string; home: string; played: boolean;
  awayScore: number; homeScore: number; status: string;
  day: string; time: string; timeMinutes: number; gameId: number;
}
export interface ScheduleWeek { stage: string; seasonWeek: number; label: string; games: ScheduleGame[]; }
export interface FranchiseScheduleResult {
  input: string; seasonYear: number; currentStage: string; currentWeek: number; weeks: ScheduleWeek[];
}

let franchiseGameVersion: GameVersion = 'm26';

export const api = {
  /** Deployment shape: a per-game desktop build pins gameVersion; Franchise
   *  Tools only show when the server enables them (DRAFT_TOOL_FRANCHISE=1). */
  appConfig: () => jget<{ gameVersion: GameVersion | null; franchise: boolean }>('/api/config'),
  years: () => jget<{ years: number[] }>('/api/draft/years').then((r) => r.years),

  archetypesByPosition: () =>
    jget<Record<string, ArchetypeOption[]>>('/api/lookups/archetypes-by-position'),

  equipmentOptions: (year: number, gameVersion: "m26" | "m27" = "m26") =>
    jget<Record<string, GearOption[]>>(`/api/lookups/equipment?year=${year}&gameVersion=${gameVersion}`),

  /** A Madden id/name lookup table (e.g. "college", "state") for editor dropdowns. */
  lookup: (name: string) => jget<{ id: number; name: string }[]>(`/api/lookups/${name}`),

  /** Generic draft-class head codes grouped by skin tone (1-8), for the face picker. */
  /** The overall Madden will compute (and the attributes the export will write) for an edited prospect. */
  recompute: (body: { gameVersion: GameVersion; positionId: number; archetype: number; overall: number; ratings: Record<string, number>; reconcile: boolean }) =>
    fetch('/api/draft/recompute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json() as Promise<{ gameOverall: number | null; gameArchetype?: number; beforeReconcile: number | null; reconciled: Record<string, number> | null }>),
  /** The game's overall for every edited prospect on the board (see /recompute). */
  recomputeBatch: (body: { gameVersion: GameVersion; items: { id: number; positionId: number; archetype: number; ratings: Record<string, number>; overall?: number }[] }) =>
    fetch('/api/draft/recompute-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json() as Promise<{ results: { id: number; overall: number | null; archetype: number }[] }>)
      .then((r) => r.results),
  genericHeads: (gameVersion: GameVersion = 'm26') => jget<Record<string, string[]>>(`/api/lookups/generic-heads?gameVersion=${gameVersion}`),

  /** Real face-scan catalog for the target game (M26 vs M27). */
  faceScans: (gameVersion: 'm26' | 'm27' = 'm26') =>
    jget<{ gameVersion: string; scans: FaceScan[] }>(
      `/api/lookups/face-scans?gameVersion=${gameVersion}`
    ).then((r) => r.scans),

  /** Selectable M27 persona DNA traits (id + name) for the persona editor. */
  personaDnaTraits: () => jget<{ traits: PersonaTrait[] }>('/api/lookups/persona-dna').then((r) => r.traits),
  /** Traits plus the four mindset-focus options, one request. */
  personaLookups: () => jget<{ traits: PersonaTrait[]; focus?: PersonaFocusOption[] }>('/api/lookups/persona-dna').then((r) => ({ traits: r.traits, focus: r.focus ?? [] })),

  /** The whole player pool for the class builder; fetched once per session. */
  /** The 32 franchises a "By team" class can be built for. */
  franchises: async (): Promise<TeamFranchise[]> => (await jget<{ franchises: TeamFranchise[] }>('/api/draft/franchises')).franchises,

  /** Open an existing draft class (.mdc) from a Saves folder or a file the browser read. */
  /** Madden 27 ROSTER saves (Rosters view): list, open, reopen, build. */
  rosterSaves: () => jget<{ gameVersion: 'm27'; dir: string; files: SaveFileInfo[] }>('/api/roster/saves'),
  rosterOpenSaved: (name: string) => jsend<RosterData>('POST', '/api/roster/open', { name }),
  rosterOpenFile: (name: string, dataBase64: string) => jsend<RosterData>('POST', '/api/roster/open', { name, dataBase64 }),
  rosterGet: (id: string) => jget<RosterData>(`/api/roster/${encodeURIComponent(id)}`),
  rosterBuild: (body: { baseName?: string; baseId?: string; name: string; moves: RosterDoc['moves']; edits: RosterDoc['edits']; adds: RosterDoc['adds']; fresh: boolean; mode?: RosterDoc['mode'] }) =>
    jsend<RosterBuildResult>('POST', '/api/roster/build', body),
  rosterPreviewAdd: (key: string, mode: RosterDoc['mode'] = 'retro') => jsend<GeneratedRosterPlayer>('POST', '/api/roster/preview-add', { key, mode }),
  openSavesList: (gameVersion: GameVersion) => jget<{ gameVersion: GameVersion; dir: string; files: SaveFileInfo[] }>(`/api/open/saves?gameVersion=${gameVersion}`),
  openFromSaves: (gameVersion: GameVersion, name: string) => jsend<GeneratedClass>('POST', '/api/open/saves', { gameVersion, name }),
  openFile: (name: string, dataBase64: string) => jsend<GeneratedClass>('POST', '/api/open/file', { name, dataBase64 }),
  openedClass: (id: string) => jget<GeneratedClass>(`/api/open/${encodeURIComponent(id)}`),

  /** Likeness fixes: recorded against the player, applied in every class. */
  likenessOverrides: () => jget<{ overrides: LikenessOverride[]; stamp: string }>('/api/likeness/overrides'),
  setLikenessOverride: (body: LikenessWho & { skinTone?: number; faceAsset?: string | null; bodyType?: string; note?: string }) =>
    jsend<{ override: LikenessOverride; stamp: string }>('PUT', '/api/likeness/overrides', body),
  removeLikenessOverride: (body: LikenessWho) => jsend<{ removed: boolean; stamp: string }>('DELETE', '/api/likeness/overrides', body),
  /** Read a skin tone (and the closest generic heads) off a photo. */
  toneFromPhoto: (body: { imageUrl?: string; imageBase64?: string; position?: string; draftYear?: number; gameVersion?: GameVersion }) =>
    jsend<ToneFromPhoto>('POST', '/api/likeness/tone-from-photo', body),

  async catalog(): Promise<CatalogPlayer[]> {
    return (await api.catalogSnapshot()).players;
  },
  async catalogSnapshot(): Promise<{ players: CatalogPlayer[]; degraded: boolean }> {
    if (catalogCache) return { players: catalogCache, degraded: false };
    const r = await jget<{ players: CatalogPlayer[]; degraded?: boolean }>('/api/players/catalog');
    if (!r.degraded) catalogCache = r.players;
    return { players: r.players, degraded: !!r.degraded };
  },

  playerSearch: (query: string, limit = 40) =>
    jget<{ results: PlayerSearchResult[] }>(
      `/api/players/search?q=${encodeURIComponent(query)}&limit=${limit}`
    ).then((r) => r.results),

  /** Search real NFL players whose in-game gear can be copied (Equipment Builder). */
  gearPlayerSearch: (query: string, limit = 12) =>
    jget<{ players: RealGearPlayerSummary[] }>(
      `/api/gear/players?q=${encodeURIComponent(query)}&limit=${limit}`
    ).then((r) => r.players),

  /** One donor player's full loadout, keyed by gear slot. */
  gearPlayer: (id: number) => jget<RealGearPlayer>(`/api/gear/players/${id}`),

  /** Inspect an uploaded photo (data URL) or image URL and return matched gear slots. */
  async gearFromPhoto(opts: {
    imageBase64?: string;
    imageUrl?: string;
    year: number;
    positionId: number;
    gameVersion?: GameVersion;
  }) {
    const res = await fetch('/api/gear/from-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{
      observed: {
        onField: boolean;
        gloves: boolean | null;
        gloveColor: string | null;
        visor: string | null;
        wristband: boolean | null;
        socks: string | null;
        eyeBlack: boolean | null;
      };
      slots: Record<string, string>;
    }>;
  },

  generated: (year: number, league: string, mode: string, gameVersion: GameVersion = 'm26') =>
    jget<GeneratedClass>(`/api/draft/${year}/generated?league=${league}&mode=${mode}&gameVersion=${gameVersion}`),

  /** Custom class: All-Time Greats / by-decade source and/or generation modifiers. */
  generatedCustom: (opts: Partial<ClassRequestOpts> & {
    source: 'year' | 'alltime' | 'decade' | 'picked' | 'team' | 'freaks';
    year?: number;
    league?: string;
    mode: string;
    gameVersion?: GameVersion;
  }) =>
    fetch('/api/draft/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json() as Promise<GeneratedClass>;
    }),

  /** Build the .mdc on the server (with any edits) and trigger a browser download. */
  async downloadMdc(
    year: number,
    league: string,
    edits?: ClassEdits,
    mode?: string,
    gearEdits?: GearEdits,
    draftOpts?: ClassRequestOpts,
    gameVersion: GameVersion = 'm26',
    portraitPack = false,
    portraitCdn = false
  ) {
    const res = await fetch('/api/export/mdc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, league, edits, mode, gearEdits, ...draftOpts, gameVersion, portraitPack, portraitCdn }),
    });
    if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Match Madden's own save naming (extensionless CAREERDRAFT-*) so the file
    // drops straight into the Saves folder and shows up in "Load Draft Class".
    a.download =
      draftOpts?.source === 'freaks' ? `CAREERDRAFT-OUTLIERS${draftOpts.freakSeed ?? 2027}` : draftOpts?.source === 'file' ? (draftOpts.name || 'CAREERDRAFT')
      : draftOpts?.source === 'picked' || draftOpts?.source === 'team' ? classFileName(draftOpts.name)
      : draftOpts?.source === 'alltime' ? 'CAREERDRAFT-ALLTIMEGREATS'
      : draftOpts?.source === 'decade' ? `CAREERDRAFT-${draftOpts.decade}sGREATS`
      : `CAREERDRAFT-${year}DRAFT`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const packDir = res.headers.get('X-Portrait-Pack-Dir');
    return {
      count: res.headers.get('X-Prospect-Count'),
      asset: res.headers.get('X-Likeness-Asset'),
      custom: res.headers.get('X-Likeness-CustomPortrait'),
      portraitPack: packDir ? { dir: decodeURIComponent(packDir), count: Number(res.headers.get('X-Portrait-Pack-Count') || 0), missing: Number(res.headers.get('X-Portrait-Pack-Missing') || 0) } : null,
    };
  },

  /** Build the .mdc on the server and write it straight into the Madden Saves folder. */
  async saveMdcToSaves(
    year: number,
    league: string,
    edits: ClassEdits | undefined,
    mode: string | undefined,
    gearEdits: GearEdits | undefined,
    draftOpts?: ClassRequestOpts,
    gameVersion: GameVersion = 'm26',
    portraitPack = false,
    portraitCdn = false
  ): Promise<SaveMdcResult> {
    const res = await fetch('/api/export/mdc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, league, edits, mode, gearEdits, ...draftOpts, saveToSaves: true, gameVersion, portraitPack, portraitCdn }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `export failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Write the full Madden 27 portrait pack (every portrait the game lacks). */
  buildFullPortraitPack: (force = false) =>
    fetch(`/api/export/portrait-pack/all${force ? '?force=1' : ''}`, { method: 'POST' }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ dir: string; count: number; skipped: number; otherMod: number; errors: string[] }>;
    }),

  buildPortraits: (year: number, league: string, limit?: number) =>
    fetch(`/api/export/portraits/${year}?league=${league}${limit ? `&limit=${limit}` : ''}`, {
      method: 'POST',
    }).then((r) => r.json()),

  /** Which game's Saves folder the franchise tools read/write (set from the top bar). */
  setFranchiseGameVersion(v: GameVersion) { franchiseGameVersion = v; },
  franchiseGameVersion: () => franchiseGameVersion,

  /** CAREER franchise saves found in the local Madden Saves directory. */
  franchiseList: () => jget<{ savesDir: string; gameVersion: GameVersion; franchises: FranchiseInfo[] }>(`/api/franchise/list?gameVersion=${franchiseGameVersion}`),

  /** Apply a salary-cap reset; writes a new CAREER-*-CAPRESET save (input untouched). */
  async franchiseCapReset(fileName: string, options: CapResetOptions): Promise<CapResetResult> {
    const res = await fetch('/api/franchise/cap-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Bulk player edits (heal injuries, set dev traits); writes a new CAREER-*-PLAYERS save. */
  async franchisePlayerEdit(fileName: string, options: PlayerEditOptions): Promise<PlayerEditResult> {
    const res = await fetch('/api/franchise/player-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Load all editable players from a franchise save (roster editor). */
  async franchisePlayers(fileName: string): Promise<FranchisePlayersResult> {
    const res = await fetch('/api/franchise/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Apply per-player roster edits; writes a new CAREER-*-ROSTER save. */
  async franchiseRosterApply(fileName: string, edits: Record<number, PlayerFieldEdit>): Promise<{ output: string; playersEdited: number }> {
    const res = await fetch('/api/franchise/roster-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, edits , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Baked historic seasons for the historic-season tool. */
  franchiseHistoricSeasons: () => jget<{ seasons: HistoricSeasonOption[] }>('/api/franchise/historic/seasons').then((r) => r.seasons),

  /** Read-only preview of a season pack against a save (team map, layout, rules, companion bracket). */
  async franchiseHistoricPreview(fileName: string, year: number): Promise<HistoricPreview> {
    const res = await fetch('/api/franchise/historic/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, year, gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Arm the era's playoff format in a save (dryRun previews; else writes CAREER-*-PLAYOFFS). */
  async franchiseArmPlayoffs(fileName: string, year: number, options: { dryRun?: boolean }): Promise<ArmPlayoffsResult> {
    const res = await fetch('/api/franchise/historic/arm-playoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, year, options, gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Read each team's current identity (name/city/abbr/colors/logo) for the rebrand tool. */
  async franchiseTeams(fileName: string): Promise<{ input: string; teams: TeamIdentity[] }> {
    const res = await fetch('/api/franchise/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Relocate/rebrand a team; writes a new CAREER-*-RELOCATE / -REBRAND save. */
  async franchiseRelocateRebrand(fileName: string, options: RelocateRebrandOptions): Promise<RelocateRebrandResult> {
    const res = await fetch('/api/franchise/relocate-rebrand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Realistic dev-trait pass. dryRun:true previews counts; else writes a new CAREER-*-TRAITS save. */
  async franchiseAdvanceRoster(fileName: string, options: AdvanceRosterOptions): Promise<AdvanceRosterResult> {
    const res = await fetch('/api/franchise/advance-roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options, gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async franchiseTraitRealism(fileName: string, options: TraitRealismOptions): Promise<TraitRealismResult> {
    const res = await fetch('/api/franchise/trait-realism', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Trim the FA pool by OVR/age. dryRun:true previews; else writes a new CAREER-*-FATRIM save. */
  async franchiseTrimFreeAgents(fileName: string, options: FaTrimOptions): Promise<FaTrimResult> {
    const res = await fetch('/api/franchise/trim-free-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Un-trade future draft picks. dryRun:true previews; else writes a new CAREER-*-DRAFTPICKS save. */
  async franchiseResetDraftPicks(fileName: string, options: DraftPickResetOptions): Promise<DraftPickResetResult> {
    const res = await fetch('/api/franchise/reset-draft-picks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, options , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Read the full season schedule grouped by week (read-only). */
  async franchiseSchedule(fileName: string): Promise<FranchiseScheduleResult> {
    const res = await fetch('/api/franchise/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName , gameVersion: franchiseGameVersion }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
};
