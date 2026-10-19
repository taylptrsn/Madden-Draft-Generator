export interface FreakMetadata {
  isFreak: boolean;
  tier: 'generational' | 'unicorn' | 'super_fusion' | 'hybrid' | 'standard';
  archetypeKey: string;
  archetypeLabel: string;
  emoji: string;
  summary: string;
  historicalComps: string[];
  combine40?: number;
  combineVert?: number;
  combineBench?: number;
}

export type FreakPreset = 'balanced' | 'freak_show' | 'super_fusions' | 'all_freaks';

export interface PlayerRow {
  id: number; // == pick (stable)
  pick: number;
  firstName: string;
  lastName: string;
  position: string; // M26 label
  positionId: number;
  overall: number;
  devTrait: number; // 0 Normal, 1 Star, 2 Superstar, 3 X-Factor
  archetype: number;
  archetypeName: string;
  draftYear: number; // the player's own draft year (all-time classes mix many)
  round: number | null;
  draftPick: number | null;
  /** Supplemental-draft selection: round, in-round ordinal, drafting club. */
  supplemental?: { round: number; pick: number | null; team?: TeamInfo | null } | null;
  wav: number | null;
  wavSource: string; // 'actual' | 'predicted' | 'preset'
  srcIdx?: number; // index in the year's source list (stable; used to include/exclude)
  twoWay?: { roles: string[]; source: 'curated' | 'era' | 'stats'; note?: string } | null; // secondary roles carried in the ratings
  face: 'asset' | 'generic' | 'photo';
  faceSource?: string | null; // real-head provenance: bundle | roster | legend-portrait | preset | lookup…
  skinTone?: number; // 1-8, for the face picker's per-tone pool
  genericHead?: string | null; // current generic head code (gen_*), null if a real asset
  /** Where the skin tone came from: override | curated | era | portrait | headshot | wiki | csv | prior. */
  toneSource?: string | null;
  /** The user recorded a likeness fix for this player (applies in every class). */
  likenessFixed?: boolean;
  college: string;
  age: number;
  heightInches: number;
  weight: number;
  jersey: number;
  bodyType: string; // Madden 26 build: Heavy / Muscular / Thin / Standard
  photoUrl: string | null;
  portrait?: string | null; // Madden menu-portrait URL (real or generic-by-skintone)
  gamePortrait?: string | null; // the player's OWN in-game portrait, null when he has none
  team?: TeamInfo; // drafting team (nflverse, 1980+), joined by overall pick
  combine?: CombineMeasurements | null; // NFL combine testing (nflverse, 2000+)
  persona?: string[]; // M27 persona DNA trait names (only present when gameVersion='m27')
  focus?: string; // M27 mindset focus enum name (LoveOfTheGame / Winning / PersonalAccolades / Financial)
  /** Why an LB-labeled source player landed at edge vs SAM/MIKE/WILL (null when not an LB source). */
  frontSeven?: FrontSevenInfo | null;
  gear?: Record<string, string>; // era-default equipment (editor slot -> asset) the export writes
  ratings: Record<string, number>; // full editable attribute set
  scouting?: string[]; // Madden's own draft notes for this position
  freak?: FreakMetadata | null;
}

export interface FrontSevenInfo {
  role: 'EDGE' | 'MIKE' | 'SAM' | 'WILL' | null;
  reason: string; // 'sacks' | '3-4 olb' | '3-4 ilb' | '3-4 build' | '4-3 blitzer' | 'coverage' | 'pff' | 'nflverse' | 'none'
  scheme: '3-4' | '4-3' | null; // drafting team's base front over the early career
  team: string | null;
  sackRate: number | null; // career sacks per starting season
}

/** NFL Combine testing numbers (nflverse). */
export interface CombineMeasurements {
  forty: number | null;
  bench: number | null;
  vertical: number | null;
  broad: number | null;
  cone: number | null;
  shuttle: number | null;
}

/** Drafting team, resolved server-side by overall draft pick. */
export interface TeamInfo {
  abbr: string; // display abbreviation (as of the draft season)
  name: string; // full franchise name
  logo: string | null; // ESPN or era-correct PFR historical logo
}

/** User edits keyed by player id (pick) -> { field: value }. Numeric for ratings/
 *  ids/measurements; string for name/hometown text fields. */
export type ClassEdits = Record<number, Record<string, number | string>>;

/** Gear edits keyed by player id (pick) -> { slot: assetName } (helmet/cleats/gloves/visor). */
export type GearEdits = Record<number, Record<string, string>>;

/** Real 3D face scan (game-version catalog). */
export interface FaceScan {
  id: string;
  name: string;
  asset: string;
  portraitPid?: number;
  image?: string;
}

/** One equipment option for the gear editor. */
export interface GearOption {
  value: string;
  label: string;
  year?: number;
  image?: string; // thumbnail URL
  compatibility?: string; // facemask helmet-family ('universal' | 'f7' | …)
}

export interface LikenessStats {
  asset: number;
  generic: number;
  withPortrait: number;
  customPortrait: number;
}

export interface GeneratedClass {
  year: number;
  league: string;
  gameVersion?: 'm26' | 'm27'; // target game for this class (default m26)
  rows: PlayerRow[];
  likeness: LikenessStats;
  count: number;
  generatedCount?: number; // filler generics added to pad to a full class
  degraded?: boolean; // built before the backend's data caches were ready (not cached client-side)
  dropped?: DroppedPlayer[]; // players that did not fit (years with more than 402 rows)
  included?: number[]; // source indexes forced in (DraftOpts.include echo)
  source?: 'year' | 'alltime' | 'decade' | 'picked' | 'team' | 'file' | 'freaks';
  name?: string; // hand-picked class name, the franchise name of a By-team class, or an opened file's name
  fileId?: string; // an opened .mdc (source === 'file'): server-side id for export and reload
  fileName?: string; // the opened file's name (CAREERDRAFT-1998DRAFT)
  missing?: string[]; // picked keys the data no longer has
  truncatedKeys?: boolean; // more than 402 keys were sent
  pickedCount?: number; // real (non-filler) players in a picked class
  launchCount?: number; // rows rated from EA's launch roster (Launch Day lens)
  fetchedAt?: number; // stamped client-side when pulled
  _v?: number; // cache schema/logic version (see cache.ts)
  _gen?: string; // backend generator fingerprint the class was built by (see cache.ts)
}

export type GameVersion = 'm26' | 'm27';

/** A saved hand-picked class (player keys are stable across data refreshes). */
/** A draft-class file in a game's Saves folder. */
export interface SaveFileInfo {
  name: string;
  sizeBytes: number;
  modified: number;
}

/** A likeness fix recorded against a real player (server-side, every class). */
export interface LikenessOverride {
  key: string;
  firstName: string;
  lastName: string;
  draftYear: number;
  skinTone?: number;
  faceAsset?: string | null;
  bodyType?: string;
  note?: string;
  updatedAt: number;
}

/** What a photo says about a player's skin tone. */
export interface ToneFromPhoto {
  tone: number; // 1-7, weighed against the position/era prior
  rawTone: number | null; // the photo's own reading
  ita: number | null;
  greyL: number | null;
  greyscale: boolean;
  heads: string[]; // this tone's generic heads that look most like the photo
}

/** One of today's 32 franchises (a "By team" all-time draft). */
export interface TeamFranchise {
  key: string; // nflverse abbreviation: DAL, GNB, KAN, ...
  name: string;
  logo: string | null;
}

/** A prospect who never existed, made in the Class Studio. The overall, dev
 *  trait and archetype are pinned; the app generates the attributes around them. */
export interface CustomPlayer {
  id: string;
  firstName: string;
  lastName: string;
  position: string; // Madden label: QB, HB, ..., LEDG, MIKE, SS, K, P, LS
  college: string;
  heightInches: number;
  weight: number;
  age: number;
  jersey?: number | null;
  overall: number; // 40-99
  devTrait: 0 | 1 | 2 | 3;
  archetype: number | null;
  skinTone: number; // 1-7
}
/** One board slot: a real player by lookup key, or a custom prospect. */
export type BoardEntry = { key: string } | { custom: CustomPlayer };

export interface CustomClass {
  id: string;
  name: string;
  /** Pick order: index = pick - 1. */
  board: BoardEntry[];
  /** Pre-1.3 shape (a list of keys); migrated to `board` on read. */
  keys?: string[];
  createdAt: number;
  updatedAt: number;
}

/** One row of the whole-pool catalog the class builder browses. */
export interface CatalogPlayer {
  key: string; first: string; last: string; pos: string; mpos: string; grp: string;
  year: number; league: string; round: number | null; pick: number | null; college: string;
  wav: number | null; cal: number; hof: boolean; pb: number; ap1: number;
  pid: number | null;
  /** The club that drafted him, when a source records it. */
  team?: TeamInfo | null;
}

/** A player the 402-slot class could not hold; `idx` is the stable source index. */
export interface DroppedPlayer {
  idx: number;
  firstName: string;
  lastName: string;
  position: string;
  round: number | null;
  pick: number | null;
  college: string;
  wav: number | null;
  score: number;
}

/** A Madden 27 ROSTER save as the server reads it. */
export interface RosterTeam { id: number; name: string; city: string; abbr: string }
export interface RosterPlayer {
  wav?: number | null;
  wavSource?: 'actual' | 'predicted';
  draftYear?: number;
  id: number;
  firstName: string;
  lastName: string;
  position: string;
  positionId: number;
  teamId: number;
  team: string | null;
  teamName: string | null;
  overall: number;
  age: number;
  heightInches: number;
  weight: number;
  jersey: number;
  yearsPro: number;
  devTrait: number;
  archetype: string | null;
  college: string | null;
  hometown: string | null;
  draftRound: number | null;
  draftPick: number | null;
  assetName: string | null;
  portrait: string | null;
  ratings: Record<string, number>;
  scouting?: string[]; // Madden's own draft notes for this position
  visuals: { bodyType: string; genericHead: string; helmet: string; facemask: string };
  archetypeId: number;
  collegeId: number;
  homeState: number;
  skinTone: number;
  personaDNA: number[];
  focus: number;
  face: 'asset' | 'generic';
}
export interface RosterData {
  id: string;
  name: string;
  gameVersion: 'm27';
  openedAt: number;
  count: number;
  teamCount: number;
  freeAgentTeamId: number;
  crc: number;
  sizeBytes: number;
  teams: RosterTeam[];
  players: RosterPlayer[];
}

export interface AddedPlayer { tempId: string; key: string; teamId: number; jersey?: number }

/** A pool player rated for a roster (the server's GeneratedRosterPlayer). */
export interface GeneratedRosterPlayer {
  degraded?: boolean;
  wav?: number | null;
  wavSource?: 'actual' | 'predicted';
  key: string; firstName: string; lastName: string; positionId: number; position: string;
  archetypeId: number; archetype: string | null; collegeId: number; college: string | null;
  hometown: string; homeStateId: number; age: number; yearsPro: number; heightInches: number; weight: number; jersey: number;
  overall: number; devTrait: number; draftYear: number; draftRound: number; draftPick: number;
  ratings: Record<string, number>; assetName: string; genericHead: string; skinTone: number; bodyType: string;
  gear: Record<string, string>; personaDNA: number[]; focus: number; commentaryId: number; portrait: string | null;
}

/** A roster the user is building: deltas against a base ROSTER file. */
export interface RosterDoc {
  mode?: 'retro' | 'madden';
  id: string;
  name: string;
  /** fromSaves: the base was picked from the saves folder (export can name it); false for a browsed file (export uses openedId). */
  base: { fileName: string; openedId: string; sizeBytes: number; crc: number; fromSaves: boolean };
  moves: Record<number, number>;
  adds: AddedPlayer[];
  edits: Record<string, import('./api').PlayerFieldEdit>;
  /** Built from scratch: the base file only lends its container; every base player is dropped on export. */
  fresh?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RosterBuildResult {
  moved: number; cut: number; edited: number; added: number; skipped: string[];
  input: string; output: string; outputPath: string;
}
