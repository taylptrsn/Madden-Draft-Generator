import type { BaselinePlayer, CombineMeasurements } from '../types/player';

import { nflversePick } from '../types/player';

import type { MdcProspect } from './MdcService';

import { PlayerLookupService } from './PlayerLookupService';

import { NflverseCareerService } from './NflverseCareerService';

import { CalibrationService } from './CalibrationService';

import { PositionMapper } from './PositionMapper';

import { SkinToneService } from './SkinToneService';

import { RatingService } from './RatingService';

import { ArchetypeService } from './ArchetypeService';

import { generateAttributes, reconcileToTarget, gameOverall, RATING_KEYS, clampRating } from './AttributeModel';

import { OVRWeightsCalculator } from './OVRWeightsCalculator';

import { bodyTypeFor } from './DraftClassBuilder';



export type FreakPreset = 'balanced' | 'freak_show' | 'super_fusions' | 'all_freaks';



export interface FreakSettings {

  enabled?: boolean;

  preset?: FreakPreset;

  freakRate?: number;

  freakCap?: number;

  generationalShare?: number;

  hybridRate?: number;

  superFusionRate?: number;

  seed?: number;

}



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



export interface ExemplarRef {

  firstName: string;

  lastName: string;

  year: number;

}



export interface FreakArchetypeSpec {

  key: string;

  label: string;

  emoji: string;

  summary: string;

  positions: string[];

  minHeightIn?: number;

  maxHeightIn?: number;

  minWeightLbs?: number;

  maxWeightLbs?: number;

  floors: Record<string, number>;

  ovrBonusRange: [number, number];

  combine40Range: [number, number];

  combineVertRange: [number, number];

  combineBenchRange: [number, number];

  combineBroadRange: [number, number];

  combineConeRange: [number, number];

  combineShuttleRange: [number, number];

  exemplars: ExemplarRef[];

}



export interface PositionalHistoricalTail {

  posGroup: string;

  sampleCount: number;

  htP95: number;

  htP99: number;

  wtP95: number;

  wtP99: number;

  wavP95: number;

  wavP99: number;

}



class SeededRng {

  private s: number;

  constructor(seed: number) {

    this.s = (seed >>> 0) || 0x1337beef;

  }

  next(): number {

    this.s = (this.s + 0x6D2B79F5) | 0;

    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;

  }

  randint(min: number, max: number): number {

    if (max <= min) return min;

    return min + Math.floor(this.next() * (max - min + 1));

  }

  uniform(min: number, max: number): number {

    return min + this.next() * (max - min);

  }

  gauss(mean = 0, std = 1): number {

    const u1 = Math.max(1e-9, this.next());

    const u2 = this.next();

    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

    return mean + z0 * std;

  }

  choice<T>(arr: readonly T[]): T {

    return arr[Math.floor(this.next() * arr.length)]!;

  }

}



// 6x6 Physical Correlation Matrix: [height, weight, speed, agility, strength, jumping]

const CORR_MATRIX: number[][] = [

  [ 1.00,  0.55, -0.25, -0.35,  0.40,  0.05], // Height

  [ 0.55,  1.00, -0.60, -0.65,  0.75, -0.45], // Weight

  [-0.25, -0.60,  1.00,  0.75, -0.30,  0.65], // Speed

  [-0.35, -0.65,  0.75,  1.00, -0.40,  0.60], // Agility

  [ 0.40,  0.75, -0.30, -0.40,  1.00, -0.10], // Strength

  [ 0.05, -0.45,  0.65,  0.60, -0.10,  1.00], // Jumping

];



function computeCholesky6x6(matrix: number[][]): number[][] {

  const n = matrix.length;

  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {

    for (let j = 0; j <= i; j++) {

      let sum = 0;

      for (let k = 0; k < j; k++) sum += L[i]![k]! * L[j]![k]!;

      if (i === j) {

        L[i]![j] = Math.sqrt(Math.max(1e-9, matrix[i]![i]! - sum));

      } else {

        L[i]![j] = (matrix[i]![j]! - sum) / L[j]![j]!;

      }

    }

  }

  return L;

}



const CHOLESKY_L = computeCholesky6x6(CORR_MATRIX);



interface PosGeometryBaseline {

  hMean: number; hStd: number; hMin: number; hMax: number;

  wMean: number; wStd: number; wMin: number; wMax: number;

}



const POS_GEOMETRY: Record<string, PosGeometryBaseline> = {

  QB:   { hMean: 74.5, hStd: 1.5, hMin: 69, hMax: 80, wMean: 222, wStd: 12, wMin: 185, wMax: 265 },

  HB:   { hMean: 70.5, hStd: 1.5, hMin: 66, hMax: 76, wMean: 214, wStd: 13, wMin: 175, wMax: 260 },

  FB:   { hMean: 72.5, hStd: 1.2, hMin: 69, hMax: 76, wMean: 245, wStd: 10, wMin: 225, wMax: 275 },

  WR:   { hMean: 72.5, hStd: 2.0, hMin: 66, hMax: 78, wMean: 202, wStd: 14, wMin: 165, wMax: 245 },

  TE:   { hMean: 76.5, hStd: 1.3, hMin: 73, hMax: 81, wMean: 252, wStd: 11, wMin: 230, wMax: 285 },

  LT:   { hMean: 77.5, hStd: 1.2, hMin: 74, hMax: 82, wMean: 314, wStd: 13, wMin: 285, wMax: 375 },

  LG:   { hMean: 76.0, hStd: 1.1, hMin: 73, hMax: 80, wMean: 315, wStd: 12, wMin: 290, wMax: 365 },

  C:    { hMean: 75.5, hStd: 1.0, hMin: 72, hMax: 79, wMean: 305, wStd: 10, wMin: 285, wMax: 345 },

  RG:   { hMean: 76.0, hStd: 1.1, hMin: 73, hMax: 80, wMean: 315, wStd: 12, wMin: 290, wMax: 365 },

  RT:   { hMean: 77.5, hStd: 1.2, hMin: 74, hMax: 82, wMean: 318, wStd: 14, wMin: 285, wMax: 380 },

  LEDG: { hMean: 76.0, hStd: 1.4, hMin: 72, hMax: 81, wMean: 268, wStd: 14, wMin: 238, wMax: 305 },

  REDG: { hMean: 76.0, hStd: 1.4, hMin: 72, hMax: 81, wMean: 264, wStd: 14, wMin: 235, wMax: 300 },

  DT:   { hMean: 75.0, hStd: 1.3, hMin: 71, hMax: 80, wMean: 306, wStd: 16, wMin: 275, wMax: 365 },

  SAM:  { hMean: 74.5, hStd: 1.3, hMin: 71, hMax: 79, wMean: 244, wStd: 12, wMin: 220, wMax: 275 },

  MIKE: { hMean: 74.0, hStd: 1.3, hMin: 70, hMax: 78, wMean: 240, wStd: 10, wMin: 218, wMax: 268 },

  WILL: { hMean: 74.0, hStd: 1.3, hMin: 70, hMax: 78, wMean: 236, wStd: 11, wMin: 215, wMax: 265 },

  CB:   { hMean: 71.8, hStd: 1.6, hMin: 68, hMax: 77, wMean: 194, wStd: 10, wMin: 170, wMax: 225 },

  FS:   { hMean: 72.5, hStd: 1.4, hMin: 69, hMax: 77, wMean: 205, wStd: 10, wMin: 182, wMax: 235 },

  SS:   { hMean: 73.0, hStd: 1.5, hMin: 69, hMax: 78, wMean: 212, wStd: 11, wMin: 188, wMax: 242 },

  K:    { hMean: 72.0, hStd: 1.5, hMin: 68, hMax: 77, wMean: 200, wStd: 12, wMin: 170, wMax: 235 },

  P:    { hMean: 74.0, hStd: 1.5, hMin: 70, hMax: 78, wMean: 214, wStd: 12, wMin: 185, wMax: 245 },

  LS:   { hMean: 74.5, hStd: 1.2, hMin: 71, hMax: 78, wMean: 242, wStd: 10, wMin: 220, wMax: 265 },

};



export const FREAK_ARCHETYPES: Record<string, FreakArchetypeSpec> = {

  megatron: {

    key: 'megatron',

    label: "The Megatron (Alien Receiver)",

    emoji: '🤖',

    summary: "Massive frame (6'5\"–6'7\", 235–250 lbs) with 4.34–4.40s speed, 94–98 vertical leap, and dominant catch radius (Calvin Johnson)",

    positions: ['WR', 'TE'],

    minHeightIn: 77, maxHeightIn: 79,

    minWeightLbs: 235, maxWeightLbs: 250,

    floors: { speed: 95, acceleration: 94, jumping: 96, agility: 90, spectacularCatch: 94, catchInTraffic: 88, strength: 80, release: 86 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.34, 4.40], combineVertRange: [41.5, 45.0], combineBenchRange: [19, 25],

    combineBroadRange: [132, 141], combineConeRange: [6.75, 6.95], combineShuttleRange: [4.08, 4.22],

    exemplars: [

      { firstName: 'Calvin', lastName: 'Johnson', year: 2007 },

      { firstName: 'Randy', lastName: 'Moss', year: 1998 },

      { firstName: 'Julio', lastName: 'Jones', year: 2011 },

    ],

  },

  goliath_qb: {

    key: 'goliath_qb',

    label: "The Goliath Dual-Threat",

    emoji: '🦖',

    summary: "Towering mobile powerhouse (6'4\"–6'6\", 238–255 lbs) with 4.54–4.62s speed, 88–94 arm strength, and tackle-breaking power (Cam Newton)",

    positions: ['QB'],

    minHeightIn: 76, maxHeightIn: 78,

    minWeightLbs: 238, maxWeightLbs: 255,

    floors: { throwPower: 94, speed: 86, acceleration: 89, strength: 84, trucking: 82, breakSack: 90, throwOnTheRun: 88, stiffArm: 82 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.54, 4.62], combineVertRange: [36.5, 41.0], combineBenchRange: [21, 27],

    combineBroadRange: [124, 132], combineConeRange: [6.85, 7.05], combineShuttleRange: [4.15, 4.30],

    exemplars: [

      { firstName: 'Cam', lastName: 'Newton', year: 2011 },

      { firstName: 'Daunte', lastName: 'Culpepper', year: 1999 },

      { firstName: 'Josh', lastName: 'Allen', year: 2018 },

      { firstName: 'Anthony', lastName: 'Richardson', year: 2023 },

    ],

  },

  heavyweight_back: {

    key: 'heavyweight_back',

    label: "The Heavyweight Speedster",

    emoji: '🚂',

    summary: "235–265 lb bruising back sprinting a decoupled 4.46–4.56s with elite break tackle (Brandon Jacobs, Derrick Henry)",

    positions: ['HB', 'FB'],

    minHeightIn: 73, maxHeightIn: 76,

    minWeightLbs: 235, maxWeightLbs: 265,

    floors: { speed: 91, acceleration: 90, strength: 88, trucking: 93, stiffArm: 94, breakTackle: 91, carrying: 86 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.46, 4.56], combineVertRange: [37.0, 41.5], combineBenchRange: [25, 32],

    combineBroadRange: [126, 134], combineConeRange: [6.88, 7.08], combineShuttleRange: [4.15, 4.32],

    exemplars: [

      { firstName: 'Derrick', lastName: 'Henry', year: 2016 },

      { firstName: 'Bo', lastName: 'Jackson', year: 1986 },

      { firstName: 'Christian', lastName: 'Okoye', year: 1987 },

      { firstName: 'Brandon', lastName: 'Jacobs', year: 2005 },

    ],

  },

  turbo_lineman: {

    key: 'turbo_lineman',

    label: "The Space-Eating Turbo Lineman",

    emoji: '🐆',

    summary: "325–350 lb road-grading offensive lineman or interior defensive force sprinting a sub-5.00s forty (4.75–5.05s) (Trent Williams, Jordan Davis)",

    positions: ['C', 'LG', 'RG', 'LT', 'RT', 'DT'],

    minHeightIn: 76, maxHeightIn: 79,

    minWeightLbs: 325, maxWeightLbs: 350,

    floors: { speed: 80, acceleration: 86, agility: 78, strength: 93, impactBlocking: 90, leadBlock: 88 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.75, 5.02], combineVertRange: [33.0, 37.5], combineBenchRange: [32, 42],

    combineBroadRange: [114, 123], combineConeRange: [7.18, 7.42], combineShuttleRange: [4.35, 4.55],

    exemplars: [

      { firstName: 'Larry', lastName: 'Allen', year: 1994 },

      { firstName: 'Trent', lastName: 'Williams', year: 2010 },

      { firstName: 'Lane', lastName: 'Johnson', year: 2013 },

      { firstName: 'Jordan', lastName: 'Davis', year: 2022 },

    ],

  },

  sub_4_3_demon: {

    key: 'sub_4_3_demon',

    label: "The Sub-4.3 Speed Demon",

    emoji: '⚡',

    summary: "Historic combine track speed (4.22–4.29s) with maximum 98–99 speed and 94–98 agility (Chris Johnson, Tyreek Hill)",

    positions: ['WR', 'CB', 'HB', 'FS', 'SS'],

    minHeightIn: 69, maxHeightIn: 72,

    minWeightLbs: 172, maxWeightLbs: 188,

    floors: { speed: 98, acceleration: 98, agility: 95, changeOfDirection: 95, stamina: 92, jukeMove: 90 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.22, 4.29], combineVertRange: [39.5, 44.0], combineBenchRange: [14, 21],

    combineBroadRange: [130, 138], combineConeRange: [6.55, 6.78], combineShuttleRange: [3.98, 4.12],

    exemplars: [

      { firstName: 'Chris', lastName: 'Johnson', year: 2008 },

      { firstName: 'Tyreek', lastName: 'Hill', year: 2016 },

      { firstName: 'Darrell', lastName: 'Green', year: 1983 },

      { firstName: 'Deion', lastName: 'Sanders', year: 1989 },

    ],

  },

  apex_edge: {

    key: 'apex_edge',

    label: "The Apex Edge Bender",

    emoji: '🦈',

    summary: "Elite twitch pass-rusher (6'3\"–6'5\", 252–272 lb) with 4.48–4.56s speed, 90–96 agility, and relentless burst (Myles Garrett, Von Miller)",

    positions: ['LEDG', 'REDG', 'SAM', 'WILL', 'MIKE'],

    minHeightIn: 75, maxHeightIn: 77,

    minWeightLbs: 252, maxWeightLbs: 272,

    floors: { speed: 89, acceleration: 93, agility: 90, jumping: 88, strength: 88, powerMoves: 86, finesseMoves: 88, blockShedding: 84, pursuit: 90 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.48, 4.56], combineVertRange: [38.5, 42.5], combineBenchRange: [28, 36],

    combineBroadRange: [126, 135], combineConeRange: [6.75, 6.98], combineShuttleRange: [4.10, 4.26],

    exemplars: [

      { firstName: 'Myles', lastName: 'Garrett', year: 2017 },

      { firstName: 'Von', lastName: 'Miller', year: 2011 },

      { firstName: 'Lawrence', lastName: 'Taylor', year: 1981 },

      { firstName: 'Jadeveon', lastName: 'Clowney', year: 2014 },

    ],

  },

  lockdown_tower: {

    key: 'lockdown_tower',

    label: "The Ballhawk Lockdown Tower",

    emoji: '🗼',

    summary: "6'2\"–6'4\", 200–214 lb perimeter length-and-technique eraser with 4.38–4.46s speed, 94–98 jump, and suffocating coverage radius (Sauce Gardner, Patrick Surtain II)",

    positions: ['CB', 'FS', 'SS'],

    minHeightIn: 74, maxHeightIn: 76,

    minWeightLbs: 200, maxWeightLbs: 214,

    floors: { speed: 93, acceleration: 93, agility: 90, jumping: 95, pressCoverage: 90, manCoverage: 86, zoneCoverage: 86 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.38, 4.46], combineVertRange: [39.5, 43.5], combineBenchRange: [16, 23],

    combineBroadRange: [129, 137], combineConeRange: [6.68, 6.88], combineShuttleRange: [4.04, 4.18],

    exemplars: [

      { firstName: 'Richard', lastName: 'Sherman', year: 2011 },

      { firstName: 'Sauce', lastName: 'Gardner', year: 2022 },

      { firstName: 'Patrick', lastName: 'Peterson', year: 2011 },

      { firstName: 'Nnamdi', lastName: 'Asomugha', year: 2003 },

    ],

  },

  pocket_rocket: {

    key: 'pocket_rocket',

    label: "The Pocket Rocket / Human Joystick",

    emoji: '🕹️',

    summary: "Sub-5'8\", 182–198 lb compact dynamo with 97–99 agility, 4.34–4.40s forty, and elusive pinball balance (Darren Sproles, Tarik Cohen)",

    positions: ['HB', 'WR'],

    minHeightIn: 66, maxHeightIn: 68,

    minWeightLbs: 182, maxWeightLbs: 198,

    floors: { speed: 95, acceleration: 96, agility: 98, changeOfDirection: 98, jumping: 88, jukeMove: 95, spinMove: 93, breakTackle: 86, kickReturn: 95 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.34, 4.40], combineVertRange: [39.0, 43.0], combineBenchRange: [15, 22],

    combineBroadRange: [127, 134], combineConeRange: [6.48, 6.68], combineShuttleRange: [3.92, 4.06],

    exemplars: [

      { firstName: 'Barry', lastName: 'Sanders', year: 1989 },

      { firstName: 'Dante', lastName: 'Hall', year: 2000 },

      { firstName: 'Darren', lastName: 'Sproles', year: 2005 },

      { firstName: 'Devin', lastName: 'Hester', year: 2006 },

    ],

  },

  immovable_mountain: {

    key: 'immovable_mountain',

    label: "The Immovable Mountain",

    emoji: '🏔️',

    summary: "330–375 lb mammoth nose tackle with 96–99 anchoring strength, impenetrable gap integrity, and pure run denial (Vince Wilfork, Ted Washington)",

    positions: ['DT', 'LT', 'LG', 'C', 'RG', 'RT'],

    minHeightIn: 74, maxHeightIn: 79,

    minWeightLbs: 330, maxWeightLbs: 375,

    floors: { strength: 98, blockShedding: 88, powerMoves: 86, tackle: 86, passBlockPower: 88, runBlockPower: 90, impactBlocking: 90, toughness: 92, injury: 90 },

    ovrBonusRange: [1, 3],

    combine40Range: [5.25, 5.50], combineVertRange: [29.0, 33.5], combineBenchRange: [38, 47],

    combineBroadRange: [106, 115], combineConeRange: [7.45, 7.75], combineShuttleRange: [4.50, 4.72],

    exemplars: [

      { firstName: 'Vince', lastName: 'Wilfork', year: 2004 },

      { firstName: 'Ted', lastName: 'Washington', year: 1991 },

      { firstName: 'Casey', lastName: 'Hampton', year: 2001 },

      { firstName: 'Vita', lastName: 'Vea', year: 2018 },

    ],

  },

  cannon_slinger: {

    key: 'cannon_slinger',

    label: "The Deep-Ball Cannon Slinger",

    emoji: '🚀',

    summary: "Gunslinger with 95–99 historic pass arm strength, fearless downfield aggressiveness, and high-velocity window fitting (Brett Favre, Josh Allen)",

    positions: ['QB'],

    minHeightIn: 74, maxHeightIn: 77,

    minWeightLbs: 220, maxWeightLbs: 235,

    floors: { throwPower: 98, throwAccuracyDeep: 86, throwAccuracyMid: 84, throwUnderPressure: 86, throwOnTheRun: 86, playAction: 84 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.88, 5.10], combineVertRange: [33.5, 37.5], combineBenchRange: [18, 24],

    combineBroadRange: [118, 126], combineConeRange: [6.88, 7.08], combineShuttleRange: [4.18, 4.34],

    exemplars: [

      { firstName: 'Dan', lastName: 'Marino', year: 1983 },

      { firstName: 'John', lastName: 'Elway', year: 1983 },

      { firstName: 'Brett', lastName: 'Favre', year: 1991 },

      { firstName: 'Patrick', lastName: 'Mahomes', year: 2017 },

    ],

  },

  enforcer_thumper: {

    key: 'enforcer_thumper',

    label: "The Defensive Enforcer",

    emoji: '💥',

    summary: "6'2\"–6'4\", 224–238 lb secondary or linebacker enforcer with bone-jarring hit power and relentless run support (Sean Taylor, Kam Chancellor, Brian Urlacher)",

    positions: ['SS', 'FS', 'MIKE', 'SAM', 'WILL'],

    minHeightIn: 74, maxHeightIn: 76,

    minWeightLbs: 224, maxWeightLbs: 238,

    floors: { hitPower: 96, tackle: 88, pursuit: 91, speed: 90, acceleration: 92, strength: 84, blockShedding: 83 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.45, 4.52], combineVertRange: [38.0, 42.0], combineBenchRange: [24, 31],

    combineBroadRange: [125, 133], combineConeRange: [6.75, 6.95], combineShuttleRange: [4.08, 4.24],

    exemplars: [

      { firstName: 'Ray', lastName: 'Lewis', year: 1996 },

      { firstName: 'Sean', lastName: 'Taylor', year: 2004 },

      { firstName: 'Brian', lastName: 'Urlacher', year: 2000 },

      { firstName: 'Kam', lastName: 'Chancellor', year: 2010 },

    ],

  },

  seam_buster_te: {

    key: 'seam_buster_te',

    label: "The Seam-Busting Move Tight End",

    emoji: '🦄',

    summary: "230–255 lb sculpted matchup nightmare sprinting a decoupled 4.42–4.48s with wide-receiver route separation (Shannon Sharpe, Vernon Davis)",

    positions: ['TE'],

    minHeightIn: 74, maxHeightIn: 76,

    minWeightLbs: 230, maxWeightLbs: 255,

    floors: { speed: 92, acceleration: 93, jumping: 91, agility: 88, catching: 86, catchInTraffic: 85, spectacularCatch: 88, mediumRouteRunning: 84 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.42, 4.48], combineVertRange: [38.5, 42.5], combineBenchRange: [22, 29],

    combineBroadRange: [126, 134], combineConeRange: [6.78, 6.98], combineShuttleRange: [4.12, 4.26],

    exemplars: [

      { firstName: 'Vernon', lastName: 'Davis', year: 2006 },

      { firstName: 'Rob', lastName: 'Gronkowski', year: 2010 },

      { firstName: 'Kyle', lastName: 'Pitts', year: 2021 },

      { firstName: 'Shannon', lastName: 'Sharpe', year: 1990 },

    ],

  },

  golden_leg: {

    key: 'golden_leg',

    label: "The Golden Leg Specialist",

    emoji: '🦵',

    summary: "185–255 lb rare specialist with 96–99 kick power capable of 60+ yard field goals (Justin Tucker, Sebastian Janikowski)",

    positions: ['K', 'P'],

    minHeightIn: 72, maxHeightIn: 75,

    minWeightLbs: 185, maxWeightLbs: 255,

    floors: { kickPower: 98, kickAccuracy: 84 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.68, 4.92], combineVertRange: [32.0, 36.0], combineBenchRange: [14, 22],

    combineBroadRange: [114, 122], combineConeRange: [7.05, 7.25], combineShuttleRange: [4.25, 4.42],

    exemplars: [

      { firstName: 'Sebastian', lastName: 'Janikowski', year: 2000 },

      { firstName: 'Justin', lastName: 'Tucker', year: 2012 },

      { firstName: 'Shane', lastName: 'Lechler', year: 2000 },

    ],

  },

  slash_weapon: {

    key: 'slash_weapon',

    label: "The Dual-Threat Offensive Weapon",

    emoji: '🃏',

    summary: "218–232 lb offensive weapon with 4.42–4.48s speed, tackle-breaking power, and multi-position flex versatility (Deebo Samuel, Cordarrelle Patterson, Aaron Hernandez)",

    positions: ['WR', 'HB', 'TE'],

    minHeightIn: 71, maxHeightIn: 74,

    minWeightLbs: 218, maxWeightLbs: 232,

    floors: { speed: 92, acceleration: 93, agility: 89, catching: 82, carrying: 84, jukeMove: 88, breakTackle: 86, trucking: 82, shortRouteRunning: 80 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.42, 4.48], combineVertRange: [38.0, 42.0], combineBenchRange: [18, 24],

    combineBroadRange: [125, 132], combineConeRange: [6.68, 6.88], combineShuttleRange: [4.05, 4.20],

    exemplars: [

      { firstName: 'Deebo', lastName: 'Samuel', year: 2019 },

      { firstName: 'Cordarrelle', lastName: 'Patterson', year: 2013 },

      { firstName: 'Percy', lastName: 'Harvin', year: 2009 },

    ],

  },

  electric_dual_threat: {

    key: 'electric_dual_threat',

    label: "The Electric Dual-Threat",

    emoji: '☄️',

    summary: "5'11\"–6'3\" electric scrambler with 4.34–4.45s track speed, 94–98 agility, dynamic escape burst, and live arm (Michael Vick, Lamar Jackson)",

    positions: ['QB'],

    minHeightIn: 71, maxHeightIn: 75,

    minWeightLbs: 204, maxWeightLbs: 218,

    floors: { speed: 95, acceleration: 96, agility: 96, changeOfDirection: 96, jukeMove: 94, spinMove: 92, breakSack: 92, throwPower: 93, throwOnTheRun: 90 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.34, 4.45], combineVertRange: [39.5, 43.0], combineBenchRange: [16, 22],

    combineBroadRange: [128, 136], combineConeRange: [6.55, 6.75], combineShuttleRange: [3.96, 4.10],

    exemplars: [

      { firstName: 'Michael', lastName: 'Vick', year: 2001 },

      { firstName: 'Lamar', lastName: 'Jackson', year: 2018 },

      { firstName: 'Randall', lastName: 'Cunningham', year: 1985 },

    ],

  },

  alpha_prototype_wr: {

    key: 'alpha_prototype_wr',

    label: "The Alpha Prototype Receiver",

    emoji: '🦍',

    summary: "6'1\"–6'4\", 216–230 lb physical marvel sprinting a 4.36–4.42s forty with 92–96 agility, explosive vertical, and tackle-shedding power (Julio Jones, Andre Johnson)",

    positions: ['WR'],

    minHeightIn: 73, maxHeightIn: 76,

    minWeightLbs: 216, maxWeightLbs: 230,

    floors: { speed: 94, acceleration: 94, agility: 93, jumping: 93, strength: 82, stiffArm: 86, breakTackle: 82, release: 86, deepRouteRunning: 84 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.36, 4.42], combineVertRange: [40.0, 43.5], combineBenchRange: [20, 27],

    combineBroadRange: [130, 138], combineConeRange: [6.72, 6.95], combineShuttleRange: [4.06, 4.22],

    exemplars: [

      { firstName: 'Julio', lastName: 'Jones', year: 2011 },

      { firstName: 'Andre', lastName: 'Johnson', year: 2003 },

      { firstName: 'Terrell', lastName: 'Owens', year: 1996 },

    ],

  },

  trench_dominator: {

    key: 'trench_dominator',

    label: "The Power-and-Length Trench Monster",

    emoji: '🦬',

    summary: "282–305 lb inside-outside disruptor with 94+ strength, violent hand leverage, 4.62–4.72s speed, and relentless motor (J.J. Watt, Calais Campbell)",

    positions: ['LEDG', 'REDG', 'DT'],

    minHeightIn: 75, maxHeightIn: 78,

    minWeightLbs: 282, maxWeightLbs: 305,

    floors: { speed: 84, acceleration: 90, agility: 82, strength: 95, powerMoves: 90, finesseMoves: 86, blockShedding: 88, tackle: 86 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.62, 4.72], combineVertRange: [35.0, 39.5], combineBenchRange: [34, 42],

    combineBroadRange: [118, 126], combineConeRange: [6.95, 7.15], combineShuttleRange: [4.22, 4.38],

    exemplars: [

      { firstName: 'J.J.', lastName: 'Watt', year: 2011 },

      { firstName: 'Reggie', lastName: 'White', year: 1984 },

      { firstName: 'Aaron', lastName: 'Donald', year: 2014 },

      { firstName: 'Warren', lastName: 'Sapp', year: 1995 },

    ],

  },

  basketball_convert_te: {

    key: 'basketball_convert_te',

    label: "The Basketball-Convert Tight End",

    emoji: '🏀',

    summary: "6'4\"–6'7\", 252–268 lb box-out mismatch weapon with 96–99 vertical leap, massive catch radius, and acrobatic high-pointing (Antonio Gates, Jimmy Graham)",

    positions: ['TE'],

    minHeightIn: 76, maxHeightIn: 79,

    minWeightLbs: 252, maxWeightLbs: 268,

    floors: { jumping: 97, spectacularCatch: 94, catchInTraffic: 88, catching: 86, agility: 83, speed: 86, acceleration: 89, release: 85 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.64, 4.74], combineVertRange: [39.5, 43.5], combineBenchRange: [21, 27],

    combineBroadRange: [125, 133], combineConeRange: [6.82, 7.02], combineShuttleRange: [4.14, 4.28],

    exemplars: [

      { firstName: 'Tony', lastName: 'Gonzalez', year: 1997 },

      { firstName: 'Antonio', lastName: 'Gates', year: 2003 },

      { firstName: 'Jimmy', lastName: 'Graham', year: 2010 },

    ],

  },

  positionless_hybrid: {

    key: 'positionless_hybrid',

    label: "The Positionless Hybrid Defender",

    emoji: '🛸',

    summary: "6'2\"–6'4\", 228–245 lb positionless weapon with 4.42–4.50s speed, 88–94 agility, and Swiss Army coverage/rush versatility (Micah Parsons, Derwin James)",

    positions: ['SS', 'FS', 'SAM', 'WILL', 'MIKE', 'LEDG', 'REDG'],

    minHeightIn: 74, maxHeightIn: 76,

    minWeightLbs: 228, maxWeightLbs: 245,

    floors: { speed: 92, acceleration: 94, agility: 90, jumping: 88, hitPower: 90, manCoverage: 82, zoneCoverage: 85, finesseMoves: 84, blockShedding: 82, pursuit: 91 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.42, 4.50], combineVertRange: [39.0, 42.5], combineBenchRange: [22, 28],

    combineBroadRange: [127, 135], combineConeRange: [6.68, 6.88], combineShuttleRange: [4.05, 4.18],

    exemplars: [

      { firstName: 'Micah', lastName: 'Parsons', year: 2021 },

      { firstName: 'Troy', lastName: 'Polamalu', year: 2003 },

      { firstName: 'Isaiah', lastName: 'Simmons', year: 2020 },

      { firstName: 'Kyle', lastName: 'Hamilton', year: 2022 },

    ],

  },

  fluid_acrobat: {

    key: 'fluid_acrobat',

    label: "The Fluid Coordinated Acrobat",

    emoji: '🩰',

    summary: "6'3\"–6'4\" aerial acrobat with 95–98 elite agility, 94–97 vertical leap, 4.46–4.52s forty, and acrobatic sideline body control (A.J. Green, Larry Fitzgerald)",

    positions: ['WR'],

    minHeightIn: 75, maxHeightIn: 76,

    minWeightLbs: 205, maxWeightLbs: 216,

    floors: { agility: 96, changeOfDirection: 96, jumping: 95, speed: 90, acceleration: 92, catching: 88, spectacularCatch: 94, shortRouteRunning: 86, mediumRouteRunning: 86 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.46, 4.52], combineVertRange: [40.0, 43.5], combineBenchRange: [16, 22],

    combineBroadRange: [128, 136], combineConeRange: [6.52, 6.72], combineShuttleRange: [3.96, 4.10],

    exemplars: [

      { firstName: 'Larry', lastName: 'Fitzgerald', year: 2004 },

      { firstName: 'A.J.', lastName: 'Green', year: 2011 },

      { firstName: 'Justin', lastName: 'Jefferson', year: 2020 },

      { firstName: 'Lynn', lastName: 'Swann', year: 1974 },

    ],

  },

  linear_burner: {

    key: 'linear_burner',

    label: "The Linear Vertical Burner",

    emoji: '🏎️',

    summary: "6'2\"–6'4\", 218–228 lb long-striding physical burner with 4.36–4.44s deep speed, heavy build, and straight-line power (Martavis Bryant, DK Metcalf)",

    positions: ['WR'],

    minHeightIn: 74, maxHeightIn: 76,

    minWeightLbs: 218, maxWeightLbs: 228,

    floors: { speed: 95, acceleration: 95, jumping: 90, deepRouteRunning: 86, release: 86, spectacularCatch: 88 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.36, 4.44], combineVertRange: [39.5, 43.0], combineBenchRange: [18, 25],

    combineBroadRange: [129, 137], combineConeRange: [6.78, 7.00], combineShuttleRange: [4.08, 4.24],

    exemplars: [

      { firstName: 'D.K.', lastName: 'Metcalf', year: 2019 },

      { firstName: 'Bob', lastName: 'Hayes', year: 1964 },

      { firstName: 'Martavis', lastName: 'Bryant', year: 2014 },

    ],

  },

  contested_bully: {

    key: 'contested_bully',

    label: "The Contested-Catch Power Bully",

    emoji: '🥊',

    summary: "6'1\"–6'3\", 222–228 lb physical monster with 85–90 break tackle, 4.50–4.58s speed, and dominant traffic catch power (Dez Bryant, Anquan Boldin)",

    positions: ['WR'],

    minHeightIn: 73, maxHeightIn: 75,

    minWeightLbs: 222, maxWeightLbs: 228,

    floors: { catchInTraffic: 90, catching: 88, jumping: 93, strength: 82, stiffArm: 88, breakTackle: 88, release: 86, trucking: 82 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.50, 4.58], combineVertRange: [38.0, 41.5], combineBenchRange: [21, 27],

    combineBroadRange: [124, 131], combineConeRange: [6.78, 6.98], combineShuttleRange: [4.10, 4.25],

    exemplars: [

      { firstName: 'Anquan', lastName: 'Boldin', year: 2003 },

      { firstName: 'Dez', lastName: 'Bryant', year: 2010 },

      { firstName: 'Michael', lastName: 'Irvin', year: 1988 },

    ],

  },

  elusive_featured_back: {

    key: 'elusive_featured_back',

    label: "The Elusive Featured Back",

    emoji: '🐎',

    summary: "5'10\"–6'0\", 205–225 lb dynamic back with 4.38–4.45s speed, 93–97 agility, explosive jump-cuts, and elite contact balance (Barry Sanders, Saquon Barkley)",

    positions: ['HB'],

    minHeightIn: 70, maxHeightIn: 72,

    minWeightLbs: 205, maxWeightLbs: 225,

    floors: { speed: 94, acceleration: 95, agility: 95, changeOfDirection: 94, jumping: 91, breakTackle: 91, carrying: 86, ballCarrierVision: 88, stiffArm: 86, jukeMove: 93 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.38, 4.45], combineVertRange: [39.5, 43.0], combineBenchRange: [23, 30],

    combineBroadRange: [128, 136], combineConeRange: [6.68, 6.86], combineShuttleRange: [4.04, 4.18],

    exemplars: [

      { firstName: 'Adrian', lastName: 'Peterson', year: 2007 },

      { firstName: 'LaDainian', lastName: 'Tomlinson', year: 2001 },

      { firstName: 'Saquon', lastName: 'Barkley', year: 2018 },

      { firstName: 'Barry', lastName: 'Sanders', year: 1989 },

    ],

  },

  speed_ballhawk: {

    key: 'speed_ballhawk',

    label: "The Speed Ballhawk",

    emoji: '🦅',

    summary: "5'9\"–6'1\", 188–204 lb Olympic speed boundary eraser with 4.25–4.34s track speed, 94–98 agility, and elite ball-tracking instincts (Deion Sanders, Darrell Green)",

    positions: ['CB', 'FS'],

    minHeightIn: 69, maxHeightIn: 73,

    minWeightLbs: 188, maxWeightLbs: 204,

    floors: { speed: 97, acceleration: 97, agility: 96, jumping: 93, zoneCoverage: 88, playRecognition: 86, catching: 86, pursuit: 90 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.25, 4.34], combineVertRange: [40.0, 43.5], combineBenchRange: [16, 22],

    combineBroadRange: [129, 137], combineConeRange: [6.62, 6.82], combineShuttleRange: [4.00, 4.14],

    exemplars: [

      { firstName: 'Deion', lastName: 'Sanders', year: 1989 },

      { firstName: 'Ed', lastName: 'Reed', year: 2002 },

      { firstName: 'Earl', lastName: 'Thomas', year: 2010 },

    ],

  },

  mobile_mass_nose: {

    key: 'mobile_mass_nose',

    label: "The Mobile Mass Nose Tackle",

    emoji: '🐻',

    summary: "335–358 lb mammoth interior anchor moving with rare agility, 4.88–5.02s forty, and immovable strength (Vita Vea, Haloti Ngata, Dontari Poe)",

    positions: ['DT'],

    minHeightIn: 74, maxHeightIn: 77,

    minWeightLbs: 335, maxWeightLbs: 358,

    floors: { strength: 96, speed: 78, acceleration: 86, agility: 72, powerMoves: 88, blockShedding: 88, tackle: 86 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.88, 5.02], combineVertRange: [32.0, 36.0], combineBenchRange: [36, 45],

    combineBroadRange: [112, 120], combineConeRange: [7.28, 7.50], combineShuttleRange: [4.40, 4.58],

    exemplars: [

      { firstName: 'Haloti', lastName: 'Ngata', year: 2006 },

      { firstName: 'Dexter', lastName: 'Lawrence', year: 2019 },

      { firstName: 'Vita', lastName: 'Vea', year: 2018 },

    ],

  },

  range_coverage_lb: {

    key: 'range_coverage_lb',

    label: "The Sideline-to-Sideline Range Linebacker",

    emoji: '🐝',

    summary: "6'1\"–6'3\", 232–245 lb eraser with 4.46–4.54s speed, 88–94 agility, instincts, and suffocating zone-coverage range (Luke Kuechly, Fred Warner)",

    positions: ['MIKE', 'SAM', 'WILL', 'SS'],

    minHeightIn: 73, maxHeightIn: 75,

    minWeightLbs: 232, maxWeightLbs: 245,

    floors: { speed: 90, acceleration: 92, agility: 91, jumping: 89, zoneCoverage: 86, manCoverage: 80, pursuit: 92, tackle: 88, playRecognition: 86 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.46, 4.54], combineVertRange: [38.5, 42.0], combineBenchRange: [24, 30],

    combineBroadRange: [126, 134], combineConeRange: [6.72, 6.92], combineShuttleRange: [4.06, 4.20],

    exemplars: [

      { firstName: 'Luke', lastName: 'Kuechly', year: 2012 },

      { firstName: 'Patrick', lastName: 'Willis', year: 2007 },

      { firstName: 'Derrick', lastName: 'Brooks', year: 1995 },

      { firstName: 'Fred', lastName: 'Warner', year: 2018 },

    ],

  },

  tower_burner_cb: {

    key: 'tower_burner_cb',

    label: "The Tower-Burner Cornerback",

    emoji: '🦒',

    summary: "6'3\"–6'5\", 205–215 lb unicorn cornerback pairing towering length with historic 4.24–4.30s Olympic track speed (Tariq Woolen)",

    positions: ['CB', 'FS'],

    minHeightIn: 75, maxHeightIn: 77,

    minWeightLbs: 205, maxWeightLbs: 215,

    floors: { speed: 98, acceleration: 97, agility: 94, jumping: 96, pressCoverage: 88, manCoverage: 84, zoneCoverage: 84 },

    ovrBonusRange: [1, 3],

    combine40Range: [4.24, 4.30], combineVertRange: [41.0, 44.0], combineBenchRange: [16, 22],

    combineBroadRange: [131, 139], combineConeRange: [6.68, 6.86], combineShuttleRange: [4.04, 4.18],

    exemplars: [

      { firstName: 'Riq', lastName: 'Woolen', year: 2022 },

      { firstName: 'Champ', lastName: 'Bailey', year: 1999 },

      { firstName: 'Darrelle', lastName: 'Revis', year: 2007 },

    ],

  },

  giant_edge_titan: {

    key: 'giant_edge_titan',

    label: "The Colossal Edge Titan",

    emoji: '🗿',

    summary: "6'5\"–6'7\", 278–295 lb massive edge giant running mid-4.6s with overwhelming power, massive wingspan, and relentless motor (Reggie White, Julius Peppers)",

    positions: ['LEDG', 'REDG'],

    minHeightIn: 77, maxHeightIn: 79,

    minWeightLbs: 278, maxWeightLbs: 295,

    floors: { strength: 94, speed: 86, acceleration: 90, agility: 82, jumping: 84, powerMoves: 90, blockShedding: 88, tackle: 86 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.60, 4.68], combineVertRange: [36.0, 40.0], combineBenchRange: [31, 39],

    combineBroadRange: [122, 130], combineConeRange: [6.92, 7.12], combineShuttleRange: [4.20, 4.36],

    exemplars: [

      { firstName: 'Julius', lastName: 'Peppers', year: 2002 },

      { firstName: 'Reggie', lastName: 'White', year: 1984 },

      { firstName: 'Calais', lastName: 'Campbell', year: 2008 },

      { firstName: 'Mario', lastName: 'Williams', year: 2006 },

    ],

  },

  explosive_leverage_dt: {

    key: 'explosive_leverage_dt',

    label: "The Undersized Explosive Leverage DT",

    emoji: '⚙️',

    summary: "6'0\"–6'2\", 275–298 lb compact interior wrecking ball pairing low-center leverage, 94+ strength, and linebacker quickness (4.65–4.74s) (Aaron Donald, Geno Atkins)",

    positions: ['DT'],

    minHeightIn: 72, maxHeightIn: 74,

    minWeightLbs: 275, maxWeightLbs: 298,

    floors: { acceleration: 92, agility: 86, strength: 94, finesseMoves: 90, powerMoves: 88, blockShedding: 88, pursuit: 90 },

    ovrBonusRange: [2, 4],

    combine40Range: [4.65, 4.74], combineVertRange: [35.0, 39.0], combineBenchRange: [33, 41],

    combineBroadRange: [118, 126], combineConeRange: [6.95, 7.12], combineShuttleRange: [4.20, 4.35],

    exemplars: [

      { firstName: 'Aaron', lastName: 'Donald', year: 2014 },

      { firstName: 'John', lastName: 'Randle', year: 1990 },

      { firstName: 'Geno', lastName: 'Atkins', year: 2010 },

    ],

  },

};



export interface SuperFusionRecipe {

  key: string;

  label: string;

  emoji: string;

  components: [string, string, string];

  positions: string[];

  summary: string;

}



/**

 * The 7 hand-curated mythical 3-Way Super-Fusions from the 2K engine,

 * formed as complete 3-clique triangles with 100% position coverage.

 */

export const SUPER_FUSIONS: SuperFusionRecipe[] = [

  {

    key: 'super_fusion_qb',

    label: "The Cybernetic Apex QB",

    emoji: '🌌',

    components: ['goliath_qb', 'cannon_slinger', 'electric_dual_threat'],

    positions: ['QB'],

    summary: "3-Way Super-Fusion (Cam Newton × Josh Allen × Michael Vick): towering cannon arm with electric scramble wheels",

  },

  {

    key: 'super_fusion_rb',

    label: "The Mythical Apex Back",

    emoji: '🐉',

    components: ['heavyweight_back', 'elusive_featured_back', 'sub_4_3_demon'],

    positions: ['HB'],

    summary: "3-Way Super-Fusion (Bo Jackson × Derrick Henry × Chris Johnson): heavyweight freight train with sub-4.35 burst and jump-cut agility",

  },

  {

    key: 'super_fusion_wr',

    label: "The Mythical Alien Wideout",

    emoji: '☄️',

    components: ['megatron', 'sub_4_3_demon', 'contested_bully'],

    positions: ['WR'],

    summary: "3-Way Super-Fusion (Calvin Johnson × Tyreek Hill × Dez Bryant): 6'4\"+ boundary alien with track speed and vise-grip traffic power",

  },

  {

    key: 'super_fusion_te',

    label: "The Mythical Move/Y-Mismatch TE",

    emoji: '🔱',

    components: ['megatron', 'seam_buster_te', 'basketball_convert_te'],

    positions: ['TE'],

    summary: "3-Way Super-Fusion (Antonio Gates × Shannon Sharpe × Calvin Johnson): 6'6\" 250+ lb seam-splitting box-out nightmare",

  },

  {

    key: 'super_fusion_edge',

    label: "The Mythical Trench Titan",

    emoji: '👹',

    components: ['giant_edge_titan', 'trench_dominator', 'apex_edge'],

    positions: ['LEDG', 'REDG'],

    summary: "3-Way Super-Fusion (Reggie White × Myles Garrett × Julius Peppers): colossal wingspan power paired with elite edge bend",

  },

  {

    key: 'super_fusion_db',

    label: "The Mythical 6'4\" Cover-Zero Ballhawk",

    emoji: '🦅',

    components: ['tower_burner_cb', 'lockdown_tower', 'speed_ballhawk'],

    positions: ['CB', 'FS'],

    summary: "3-Way Super-Fusion (Tariq Woolen × Sauce Gardner × Deion Sanders): 6'3\"+ perimeter eraser with Olympic recovery speed and ball-tracking",

  },

  {

    key: 'super_fusion_lb',

    label: "The Mythical Omnipresent Eraser",

    emoji: '👁️',

    components: ['positionless_hybrid', 'range_coverage_lb', 'enforcer_thumper'],

    positions: ['MIKE', 'SAM', 'WILL', 'SS'],

    summary: "3-Way Super-Fusion (Micah Parsons × Luke Kuechly × Sean Taylor): sideline-to-sideline range, pass-rush juice, and bone-jarring hit power",

  },

];



// Symmetric Natural & Stretch Hybrid Compatibility Graphs from 2K implementation

const NATURAL_PAIRS: ReadonlyArray<[string, string]> = [

  // QB

  ['cannon_slinger', 'electric_dual_threat'],

  ['cannon_slinger', 'goliath_qb'],

  ['goliath_qb', 'electric_dual_threat'],

  // HB

  ['heavyweight_back', 'elusive_featured_back'],

  ['elusive_featured_back', 'pocket_rocket'],

  ['pocket_rocket', 'slash_weapon'],

  ['heavyweight_back', 'slash_weapon'],

  // WR

  ['alpha_prototype_wr', 'contested_bully'],

  ['alpha_prototype_wr', 'fluid_acrobat'],

  ['linear_burner', 'contested_bully'],

  ['megatron', 'contested_bully'],

  ['megatron', 'sub_4_3_demon'],

  ['sub_4_3_demon', 'fluid_acrobat'],

  // TE

  ['basketball_convert_te', 'seam_buster_te'],

  // DL / Edge

  ['explosive_leverage_dt', 'trench_dominator'],

  ['trench_dominator', 'mobile_mass_nose'],

  ['trench_dominator', 'apex_edge'],

  ['apex_edge', 'giant_edge_titan'],

  ['giant_edge_titan', 'trench_dominator'],

  // LB / Hybrid

  ['range_coverage_lb', 'positionless_hybrid'],

  ['apex_edge', 'positionless_hybrid'],

  ['positionless_hybrid', 'enforcer_thumper'],

  // Secondary

  ['tower_burner_cb', 'lockdown_tower'],

  ['lockdown_tower', 'enforcer_thumper'],

  ['speed_ballhawk', 'enforcer_thumper'],

  ['lockdown_tower', 'speed_ballhawk'],

];



const STRETCH_PAIRS: ReadonlyArray<[string, string]> = [

  ['elusive_featured_back', 'sub_4_3_demon'],

  ['slash_weapon', 'sub_4_3_demon'],

  ['seam_buster_te', 'slash_weapon'],

  ['megatron', 'basketball_convert_te'],

  ['megatron', 'seam_buster_te'],

  ['sub_4_3_demon', 'speed_ballhawk'],

  ['tower_burner_cb', 'speed_ballhawk'],

  ['range_coverage_lb', 'enforcer_thumper'],

  ['heavyweight_back', 'sub_4_3_demon'],

  ['sub_4_3_demon', 'contested_bully'],

  ['turbo_lineman', 'immovable_mountain'],

];



export const ISOLATED_ARCHETYPES = new Set<string>(['golden_leg']);



function buildHybridMap(pairs: ReadonlyArray<[string, string]>): Record<string, string[]> {

  const map: Record<string, Set<string>> = {};

  for (const k of Object.keys(FREAK_ARCHETYPES)) map[k] = new Set<string>();

  for (const [a, b] of pairs) {

    map[a]?.add(b);

    map[b]?.add(a);

  }

  const out: Record<string, string[]> = {};

  for (const [k, set] of Object.entries(map)) out[k] = [...set].sort();

  return out;

}



export const HYBRID_NATURAL: Record<string, string[]> = buildHybridMap(NATURAL_PAIRS);

export const HYBRID_STRETCH: Record<string, string[]> = buildHybridMap(STRETCH_PAIRS);

export const HYBRID_COMPATIBILITY: Record<string, string[]> = buildHybridMap([...NATURAL_PAIRS, ...STRETCH_PAIRS]);



/**

 * Biomechanical mass-speed feasibility envelope from the 2K engine:

 * t_40,min(W) = 4.22 + 0.0038 * max(0, W - 200)

 * Anchored to combine history (Bo Jackson 230lb 4.34s, Jordan Davis 341lb 4.78s).

 */

export function minFeasibleForty(weightLbs: number): number {

  if (weightLbs <= 200) return 4.22;

  return Number((4.22 + 0.0038 * (weightLbs - 200)).toFixed(2));

}



function clamp(v: number, lo: number, hi: number): number {

  return Math.max(lo, Math.min(hi, Math.round(v)));

}



/** Standard normal CDF approximation (Abramowitz & Stegun) for Cholesky quantile anchoring. */

function normalCdf(z: number): number {

  const t = 1 / (1 + 0.2316419 * Math.abs(z));

  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);

  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  return z >= 0 ? 1 - p : p;

}



/**

 * 2K _sample_band equivalent: anchors height/weight inside an archetype's [lo, hi] window

 * to the prospect's underlying Cholesky standard-normal draw z plus +-0.15 jitter.

 */

function sampleBand(rng: SeededRng, z: number, lo: number, hi: number): number {

  if (hi <= lo) return lo;

  const u = Math.max(0, Math.min(1, normalCdf(z) + rng.uniform(-0.15, 0.15)));

  return Math.round(lo + u * (hi - lo));

}



function formatHeight(inches: number): string {

  const ft = Math.floor(inches / 12);

  const rem = inches % 12;

  return `${ft}'${rem}"`;

}



function quantile(sorted: number[], q: number): number {

  if (sorted.length === 0) return 0;

  const pos = (sorted.length - 1) * q;

  const base = Math.floor(pos);

  const rest = pos - base;

  if (sorted[base + 1] !== undefined) {

    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);

  }

  return sorted[base]!;

}



interface CalibratedExemplarData {

  compLabels: string[];

  avgRatings: Record<string, number>;

  maxRatings: Record<string, number>;

}



class ProspectVarianceServiceImpl {

  private calibratedCache = new Map<string, CalibratedExemplarData>();

  private positionalTails = new Map<string, PositionalHistoricalTail>();

  private initialized = false;



  private ensureCalibrated(): void {

    if (this.initialized) return;

    this.initialized = true;



    // 1. Mine 1936-2026 positional tail distributions (95th & 99th percentiles of Ht, Wt, wAV)

    const groupAcc = new Map<string, { hts: number[]; wts: number[]; wavs: number[] }>();

    for (const y of PlayerLookupService.years()) {

      for (const p of PlayerLookupService.byYear(y, 'combined')) {

        const posId = PositionMapper.resolve(p.firstName, p.lastName, p.position, p.weight);

        const grp = PositionMapper.groupFromId(posId);

        let entry = groupAcc.get(grp);

        if (!entry) {

          entry = { hts: [], wts: [], wavs: [] };

          groupAcc.set(grp, entry);

        }

        if (p.heightInches != null && p.heightInches >= 62 && p.heightInches <= 84) entry.hts.push(p.heightInches);

        if (p.weight != null && p.weight >= 150 && p.weight <= 390) entry.wts.push(p.weight);

        if (p.wav != null && p.wav > 0) entry.wavs.push(p.wav);

      }

    }



    for (const [grp, acc] of groupAcc.entries()) {

      acc.hts.sort((a, b) => a - b);

      acc.wts.sort((a, b) => a - b);

      acc.wavs.sort((a, b) => a - b);

      this.positionalTails.set(grp, {

        posGroup: grp,

        sampleCount: Math.max(acc.hts.length, acc.wts.length, acc.wavs.length),

        htP95: Math.round(quantile(acc.hts, 0.95)),

        htP99: Math.round(quantile(acc.hts, 0.99)),

        wtP95: Math.round(quantile(acc.wts, 0.95)),

        wtP99: Math.round(quantile(acc.wts, 0.99)),

        wavP95: Math.round(quantile(acc.wavs, 0.95)),

        wavP99: Math.round(quantile(acc.wavs, 0.99)),

      });

    }



    // 2. Calibrate all 29 Freak Archetypes against their real 1936-2026 NFL exemplars

    const exRng = new SeededRng(19362026);

    for (const [key, spec] of Object.entries(FREAK_ARCHETYPES)) {

      const compLabels: string[] = [];

      const sumRatings: Record<string, number> = {};

      const maxRatings: Record<string, number> = {};

      let foundCount = 0;



      for (const ex of spec.exemplars) {

        const matches = PlayerLookupService.byYear(ex.year, 'combined').filter(

          p => p.firstName.toLowerCase() === ex.firstName.toLowerCase() &&

               p.lastName.toLowerCase() === ex.lastName.toLowerCase()

        );

        const player = matches[0];

        if (!player) continue;



        const posId = PositionMapper.resolve(player.firstName, player.lastName, player.position, player.weight);

        const posName = PositionMapper.name(posId);

        const profile = CalibrationService.positionProfile(posName, 'm27');

        const career = NflverseCareerService.get(player.firstName, player.lastName, player.draftYear, nflversePick(player));

        const ht = player.heightInches ?? career?.heightInches ?? Math.round(profile.htMean);

        const wt = player.weight ?? career?.weight ?? Math.round(profile.wtMean);

        const archetype = ArchetypeService.assign(posName, ht, wt, career, player.combine);

        const { attrs: archAttrs, ovrMean: archOvrMean } = CalibrationService.archetypeAttrs(posName, archetype, 'm27');

        const targetOvr = clamp(Math.round(RatingService.caliber(player, posId) * 0.86), 76, 82);



        const attrs = generateAttributes({

          posId,

          profile,

          archAttrs,

          archOvrMean,

          overall: targetOvr,

          rand: () => exRng.next(),

          combine: player.combine,

          career,

          draftYear: player.draftYear,

          uncapped: false,

        });

        reconcileToTarget(attrs, posId, archetype, targetOvr, 'm27');



        foundCount++;

        const hStr = ht ? formatHeight(ht) : '';

        const wStr = wt ? `${wt} lbs` : '';

        const meas = [hStr, wStr].filter(Boolean).join(', ');

        compLabels.push(`${player.firstName} ${player.lastName} ('${String(player.draftYear).slice(-2)}${meas ? ` · ${meas}` : ''})`);



        for (const rKey of RATING_KEYS) {

          const val = Number(attrs[rKey] ?? 50);

          sumRatings[rKey] = (sumRatings[rKey] ?? 0) + val;

          maxRatings[rKey] = Math.max(maxRatings[rKey] ?? 0, val);

        }

      }



      const avgRatings: Record<string, number> = {};

      if (foundCount > 0) {

        for (const rKey of RATING_KEYS) {

          avgRatings[rKey] = Math.round((sumRatings[rKey] ?? 60) / foundCount);

        }

      }



      this.calibratedCache.set(key, {

        compLabels: compLabels.length > 0

          ? compLabels

          : spec.exemplars.map(e => `${e.firstName} ${e.lastName} ('${String(e.year).slice(-2)})`),

        avgRatings,

        maxRatings,

      });

    }

  }



  public getHistoricalCalibrationSummary(): {

    positionalTails: Record<string, PositionalHistoricalTail>;

    archetypeExemplars: Record<string, { comps: string[]; topAvgRatings: Record<string, number> }>;

  } {

    this.ensureCalibrated();

    const positionalTails: Record<string, PositionalHistoricalTail> = {};

    for (const [k, v] of this.positionalTails.entries()) positionalTails[k] = v;



    const archetypeExemplars: Record<string, { comps: string[]; topAvgRatings: Record<string, number> }> = {};

    for (const [k, v] of this.calibratedCache.entries()) {

      const sorted = Object.entries(v.avgRatings)

        .sort((a, b) => b[1] - a[1])

        .slice(0, 8);

      archetypeExemplars[k] = {

        comps: v.compLabels,

        topAvgRatings: Object.fromEntries(sorted),

      };

    }

    return { positionalTails, archetypeExemplars };

  }



  public resolvePresetSettings(settings?: FreakSettings): Required<FreakSettings> {

    const preset: FreakPreset = settings?.preset ?? 'balanced';

    const defaults: Record<FreakPreset, Omit<Required<FreakSettings>, 'enabled' | 'preset' | 'seed'>> = {

      balanced:      { freakRate: 0.04, freakCap: 16,  generationalShare: 0.15, hybridRate: 0.18, superFusionRate: 0.05 },

      freak_show:    { freakRate: 0.10, freakCap: 40,  generationalShare: 0.22, hybridRate: 0.25, superFusionRate: 0.10 },

      super_fusions: { freakRate: 0.08, freakCap: 32,  generationalShare: 0.28, hybridRate: 0.35, superFusionRate: 0.30 },

      all_freaks:    { freakRate: 1.00, freakCap: 402, generationalShare: 0.20, hybridRate: 0.28, superFusionRate: 0.12 },

    };

    const base = defaults[preset] ?? defaults.balanced;

    return {

      enabled: settings?.enabled ?? false,

      preset,

      freakRate: settings?.freakRate ?? base.freakRate,

      freakCap: settings?.freakCap ?? base.freakCap,

      generationalShare: settings?.generationalShare ?? base.generationalShare,

      hybridRate: settings?.hybridRate ?? base.hybridRate,

      superFusionRate: settings?.superFusionRate ?? base.superFusionRate,

      seed: settings?.seed ?? 2027,

    };

  }



  /**

   * Builds a 402-prospect procedural class synthesized from real 1936-2026 names, colleges,

   * hometowns, and positional distributions, ready for the Cholesky & Outlier Engine pipeline.

   */

  public buildProceduralClass(settings?: FreakSettings, year = 2027): BaselinePlayer[] {

    this.ensureCalibrated();

    const resolved = this.resolvePresetSettings(settings);

    const rng = new SeededRng(resolved.seed);



    const sampleYears = [1989, 1996, 2001, 2004, 2007, 2011, 2014, 2017, 2020, 2022, 2024];

    const pool: BaselinePlayer[] = [];

    for (const y of sampleYears) {

      pool.push(...PlayerLookupService.byYear(y, 'combined'));

    }



    const firstNames = pool.map(p => p.firstName).filter(Boolean);

    const lastNames = pool.map(p => p.lastName).filter(Boolean);

    const colleges = pool.map(p => p.college).filter(c => c && c !== 'Unknown');

    const states = pool.map(p => p.homeState).filter((s): s is string => Boolean(s));



    const posSlots: { pos: string; count: number }[] = [

      { pos: 'QB', count: 20 },

      { pos: 'HB', count: 34 },

      { pos: 'FB', count: 8 },

      { pos: 'WR', count: 52 },

      { pos: 'TE', count: 24 },

      { pos: 'OT', count: 34 },

      { pos: 'OG', count: 30 },

      { pos: 'C',  count: 16 },

      { pos: 'DE', count: 36 },

      { pos: 'DT', count: 32 },

      { pos: 'LB', count: 44 },

      { pos: 'CB', count: 40 },

      { pos: 'S',  count: 22 },

      { pos: 'K',  count: 5 },

      { pos: 'P',  count: 5 },

    ];



    const rawSlots: string[] = [];

    for (const s of posSlots) {

      for (let i = 0; i < s.count; i++) rawSlots.push(s.pos);

    }

    for (let i = rawSlots.length - 1; i > 0; i--) {

      const j = rng.randint(0, i);

      const tmp = rawSlots[i]!;

      rawSlots[i] = rawSlots[j]!;

      rawSlots[j] = tmp;

    }

    // Keep specialists (K, P, FB) out of Rounds 1-3 (swap any in top 110 into picks 115..395)

    for (let i = 0; i < Math.min(110, rawSlots.length); i++) {

      if (rawSlots[i] === 'K' || rawSlots[i] === 'P' || rawSlots[i] === 'FB') {

        for (let attempt = 0; attempt < 30; attempt++) {

          const swapIdx = rng.randint(115, rawSlots.length - 1);

          const candidate = rawSlots[swapIdx]!;

          if (candidate !== 'K' && candidate !== 'P' && candidate !== 'FB') {

            rawSlots[swapIdx] = rawSlots[i]!;

            rawSlots[i] = candidate;

            break;

          }

        }

      }

    }



    const usedNames = new Set<string>();

    const players: BaselinePlayer[] = [];



    for (let i = 0; i < rawSlots.length; i++) {

      let fn = rng.choice(firstNames);

      let ln = rng.choice(lastNames);

      let attempts = 0;

      while (usedNames.has(`${fn} ${ln}`) && attempts < 10) {

        fn = rng.choice(firstNames);

        ln = rng.choice(lastNames);

        attempts++;

      }

      usedNames.add(`${fn} ${ln}`);



      const pos = rawSlots[i]!;

      const pick = i + 1;

      const round = pick <= 224 ? Math.ceil(pick / 32) : null;

      const draftPick = pick <= 224 ? pick : null;

      const age = rng.randint(21, 23);



      players.push({

        firstName: fn,

        lastName: ln,

        college: rng.choice(colleges),

        draftYear: year,

        draftRound: round,

        draftPick,

        position: pos,

        jersey: null,

        league: 'NFL',

        isHOF: false,

        photoId: null,

        playerAssetsId: null,

        commId: null,

        plpo: null,

        heightInches: null,

        weight: null,

        age,

        homeState: states.length > 0 ? rng.choice(states) : 'TX',

        race: SkinToneService.fictionalRaceFor(pos, `${fn}|${ln}|${i}|${resolved.seed}`),

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



    return players;

  }



  /**

   * Pure physical/combine/athletic traits that a rookie Freak can legitimately enter

   * the league with at 90-99 without inflating veteran technical/skill ratings.

   */

  private static readonly PHYSICAL_FREAK_KEYS = new Set<string>([

    'speed', 'acceleration', 'agility', 'changeOfDirection', 'jumping', 'strength',

    'throwPower', 'kickPower', 'hitPower', 'trucking', 'stiffArm', 'jukeMove',

    'spinMove', 'breakTackle', 'spectacularCatch', 'impactBlocking', 'breakSack',

    'toughness', 'stamina', 'injury',

  ]);



  /**

   * Applies Cholesky correlated physical variance to all prospects and injects

   * Freak Archetypes, Dual-Archetype Hybrids, and 3-Way Super-Fusions calibrated

   * against the 1936-2026 NFL dataset while keeping rookie OVRs in a realistic

   * franchise band (top player 83-84 OVR, late-round freaks as raw physical outliers).

   */

  public applyVarianceAndFreaks(

    prospects: MdcProspect[],

    players: BaselinePlayer[],

    settings?: FreakSettings,

    gameVersion: 'm26' | 'm27' = 'm27'

  ): Map<number, FreakMetadata> {

    this.ensureCalibrated();

    const resolved = this.resolvePresetSettings(settings);

    const rng = new SeededRng(resolved.seed);

    const metadataMap = new Map<number, FreakMetadata>();



    const total = prospects.length;

    const isProcedural = players.length > 0 && players[0]?.source === 'generated';

    const targetFreakCount = Math.min(

      resolved.freakCap,

      Math.round(total * Math.max(0, Math.min(1, resolved.freakRate)))

    );



    const candidateIndices = prospects.map((_, idx) => idx);

    const selectedFreakIndices = new Set<number>();



    if (targetFreakCount >= total) {

      for (let i = 0; i < total; i++) selectedFreakIndices.add(i);

    } else if (targetFreakCount > 0) {

      const scored = candidateIndices.map(idx => {

        const p = prospects[idx]!;

        const posName = PositionMapper.name(Number(p.position) || 0);

        // Weight Round 1-2 higher than late rounds, but still allow mid/late-round combine freaks

        const tierBoost = idx < 12 ? 2.1 : idx < 32 ? 1.65 : idx < 96 ? 1.15 : 0.85;

        const specPenalty = (posName === 'K' || posName === 'P' || posName === 'LS') ? 0.35 : 1.0;

        const score = Math.pow(rng.next(), 1 / (tierBoost * specPenalty));

        return { idx, score };

      });

      scored.sort((a, b) => b.score - a.score);

      for (let i = 0; i < targetFreakCount && i < scored.length; i++) {

        selectedFreakIndices.add(scored[i]!.idx);

      }

    }



    for (let i = 0; i < total; i++) {

      const prospect = prospects[i]!;

      const player = players[i];

      const posId = Number(prospect.position) || 0;

      const pos = PositionMapper.name(posId);

      const geom = POS_GEOMETRY[pos] ?? POS_GEOMETRY.WR!;



      // Normalize base OVR for top picks so non-freak #1 starts at 81-82 (leaving 83-84 for the class leader)

      let baseOvr = Number(prospect.overall) || 70;

      if (isProcedural) {

        const stdSlotCap = i === 0 ? 82 : i < 3 ? 81 : i < 8 ? 80 : i < 16 ? 79 : i < 32 ? 77 : 82;

        if (baseOvr > stdSlotCap) {

          baseOvr = stdSlotCap;

          prospect.overall = baseOvr;

        }

      }



      // 1. Sample 6D Cholesky correlated physical vector: [height, weight, speed, agility, strength, jumping]

      const z = [rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss()];

      const corr: number[] = [0, 0, 0, 0, 0, 0];

      for (let r = 0; r < 6; r++) {

        let s = 0;

        for (let c = 0; c <= r; c++) s += CHOLESKY_L[r]![c]! * z[c]!;

        corr[r] = s;

      }



      const isFreak = selectedFreakIndices.has(i);



      if (!isFreak) {

        if (!player?.heightInches) {

          prospect.heightInches = clamp(geom.hMean + corr[0]! * geom.hStd, geom.hMin, geom.hMax);

        }

        if (!player?.weight) {

          prospect.weight = clamp(geom.wMean + corr[1]! * geom.wStd, geom.wMin, geom.wMax);

        }

        prospect.speed = clampRating(Number(prospect.speed ?? 75) + corr[2]! * 2.2);

        prospect.acceleration = clampRating(Number(prospect.acceleration ?? 75) + corr[2]! * 1.8 + corr[3]! * 0.8);

        prospect.agility = clampRating(Number(prospect.agility ?? 72) + corr[3]! * 2.5);

        prospect.changeOfDirection = clampRating(Number(prospect.changeOfDirection ?? 72) + corr[3]! * 2.5);

        prospect.strength = clampRating(Number(prospect.strength ?? 70) + corr[4]! * 2.8);

        prospect.jumping = clampRating(Number(prospect.jumping ?? 72) + corr[5]! * 2.8);

        prospect.bodyType = bodyTypeFor(pos, Number(prospect.weight) || 215, () => rng.next());

        reconcileToTarget(

          prospect as Record<string, number>,

          posId,

          Number(prospect.archetype) || 0,

          baseOvr,

          gameVersion

        );

        continue;

      }



      // 2. Freak / Hybrid / Super-Fusion Roll

      // Only top-16 picks can roll Super-Fusion, and only Round 1 picks (i < 32) can roll Generational.

      // Mid/late-round Freaks (i >= 32) are raw physical Unicorns or Hybrids!

      const roll = rng.next();

      const canSuperFusion = i < 16;

      const canGenerational = i < 32 && pos !== 'K' && pos !== 'P' && pos !== 'LS';

      const eligibleFusions = canSuperFusion ? SUPER_FUSIONS.filter(f => f.positions.includes(pos)) : [];

      const eligibleArchetypes = Object.values(FREAK_ARCHETYPES).filter(a => a.positions.includes(pos));



      if (eligibleArchetypes.length === 0) continue;



      let chosenSpecs: FreakArchetypeSpec[] = [];

      let chosenTier: FreakMetadata['tier'] = 'unicorn';

      let chosenKey = '';

      let chosenLabel = '';

      let chosenEmoji = '';

      let chosenSummary = '';

      let bonusOvr = 1;



      if (canSuperFusion && roll < resolved.superFusionRate && eligibleFusions.length > 0) {

        const fusion = rng.choice(eligibleFusions);

        chosenSpecs = fusion.components

          .map(k => FREAK_ARCHETYPES[k])

          .filter((x): x is FreakArchetypeSpec => Boolean(x));

        chosenTier = 'super_fusion';

        chosenKey = fusion.key;

        chosenLabel = fusion.label;

        chosenEmoji = fusion.emoji;

        chosenSummary = fusion.summary;

        bonusOvr = rng.randint(2, 4);

      } else if (roll < resolved.superFusionRate + resolved.hybridRate) {

        const primary = rng.choice(eligibleArchetypes);

        const useStretch = rng.next() < 0.20;

        let pool = useStretch ? (HYBRID_STRETCH[primary.key] ?? []) : (HYBRID_NATURAL[primary.key] ?? []);

        if (pool.length === 0) {

          pool = HYBRID_COMPATIBILITY[primary.key] ?? [];

        }

        // Strictly require secondary archetype to also be eligible for this position (no random fallback)

        const validPartners = ISOLATED_ARCHETYPES.has(primary.key)

          ? []

          : pool.filter(k => FREAK_ARCHETYPES[k]?.positions.includes(pos));

        const secondary = validPartners.length > 0

          ? (FREAK_ARCHETYPES[rng.choice(validPartners)] ?? primary)

          : primary;



        if (secondary.key !== primary.key) {

          chosenSpecs = [primary, secondary];

          chosenTier = 'hybrid';

          chosenKey = `${primary.key}__${secondary.key}`;

          chosenLabel = `${primary.label} × ${secondary.label}`;

          chosenEmoji = `${primary.emoji}${secondary.emoji}`;

          chosenSummary = `Dual-Archetype Hybrid combining ${primary.label} (${primary.summary}) with ${secondary.label}`;

          bonusOvr = i < 32 ? rng.randint(1, 3) : rng.randint(1, 2);

        } else {

          const isGen = canGenerational && rng.next() < resolved.generationalShare;

          chosenSpecs = [primary];

          chosenTier = isGen ? 'generational' : 'unicorn';

          chosenKey = primary.key;

          chosenLabel = primary.label;

          chosenEmoji = primary.emoji;

          chosenSummary = primary.summary;

          bonusOvr = isGen ? rng.randint(2, 3) : rng.randint(1, 2);

        }

      } else {

        const primary = rng.choice(eligibleArchetypes);

        const isGen = canGenerational && rng.next() < resolved.generationalShare;

        chosenSpecs = [primary];

        chosenTier = isGen ? 'generational' : 'unicorn';

        chosenKey = primary.key;

        chosenLabel = primary.label;

        chosenEmoji = primary.emoji;

        chosenSummary = primary.summary;

        bonusOvr = isGen ? rng.randint(2, 3) : rng.randint(1, 2);

      }



      // Draft-slot ceiling keeps the board order realistic and caps the best player at 83-84 OVR

      const isTopTier = chosenTier === 'super_fusion' || chosenTier === 'generational';

      let slotCeiling: number;

      if (i === 0) {

        slotCeiling = 84;

      } else if (i < 4) {

        slotCeiling = isTopTier ? 84 : 82;

      } else if (i < 10) {

        slotCeiling = isTopTier ? 83 : 81;

      } else if (i < 20) {

        slotCeiling = isTopTier ? 81 : 79;

      } else if (i < 32) {

        slotCeiling = isTopTier ? 79 : 78;

      } else if (i < 64) {

        slotCeiling = 76;

      } else if (i < 128) {

        slotCeiling = 73;

      } else {

        slotCeiling = Math.min(71, baseOvr + 2);

      }



      const newTargetOvr = clamp(baseOvr + bonusOvr, 60, slotCeiling);



      const meta = this.applyMultiSpecsToProspect(

        prospect,

        player,

        chosenSpecs,

        chosenTier,

        chosenKey,

        chosenLabel,

        chosenEmoji,

        chosenSummary,

        newTargetOvr,

        rng,

        corr[0] ?? 0,

        corr[1] ?? 0

      );



      const archId = Number(prospect.archetype) || 0;

      const lockedFloors = this.collectRookieScaledFloors(meta.archetypeKey, newTargetOvr);

      this.reconcileFreakToTarget(

        prospect as Record<string, number>,

        posId,

        archId,

        newTargetOvr,

        lockedFloors,

        gameVersion

      );

      prospect.bodyType = bodyTypeFor(pos, Number(prospect.weight) || 225, () => rng.next());



      metadataMap.set(i, meta);

    }



    // 3. Ensure the best player in a procedural class lands at 83 or 84 OVR

    if (isProcedural && total > 0) {

      let maxOvr = 0;

      let bestIdx = 0;

      for (let i = 0; i < Math.min(15, total); i++) {

        const o = Number(prospects[i]?.overall) || 0;

        if (o > maxOvr) {

          maxOvr = o;

          bestIdx = i;

        }

      }

      if (maxOvr < 83) {

        // Prefer promoting the highest-ranked top-5 Freak, or Pick #1

        let targetIdx = bestIdx;

        for (let i = 0; i < Math.min(6, total); i++) {

          if (metadataMap.has(i)) {

            targetIdx = i;

            break;

          }

        }

        const topP = prospects[targetIdx]!;

        const topPosId = Number(topP.position) || 0;

        const topArch = Number(topP.archetype) || 0;

        const peakOvr = 83 + (resolved.seed % 2); // 83 or 84 OVR

        const fMeta = metadataMap.get(targetIdx);

        if (fMeta) {

          const floors = this.collectRookieScaledFloors(fMeta.archetypeKey, peakOvr);

          this.reconcileFreakToTarget(topP as Record<string, number>, topPosId, topArch, peakOvr, floors, gameVersion);

        } else {

          reconcileToTarget(topP as Record<string, number>, topPosId, topArch, peakOvr, gameVersion);

          topP.overall = peakOvr;

        }

      }



      // 4. Rebalance Development Traits for procedural rookie classes so X-Factor (2-3),

      // Superstar (6-8), and Star (34-42) rates are realistic and not a 109-player wall

      this.rebalanceProceduralDevTraits(prospects, metadataMap, rng);

    }



    return metadataMap;

  }



  /**

   * Rebalances development traits across a procedural rookie class so that:

   * - X-Factor (3): 2 to 3 prospects (top Generational/Super-Fusion freaks or #1/#2 overall)

   * - Superstar (2): 6 to 8 prospects (spread across Round 1 and top Freaks)

   * - Star (1): ~35 to 42 prospects (probabilistic curve across Rounds 1-4 + mid/late Freaks)

   * - Normal (0): ~350+ prospects (including normal-dev players in Round 1)

   */

  private rebalanceProceduralDevTraits(

    prospects: MdcProspect[],

    metadataMap: Map<number, FreakMetadata>,

    rng: SeededRng

  ): void {

    const total = prospects.length;

    for (let i = 0; i < total; i++) {

      prospects[i]!.devTrait = 0;

    }



    const maxXf = rng.randint(2, 3);

    const maxSs = rng.randint(6, 8);

    const maxStar = rng.randint(35, 42);



    let xfCount = 0;

    let ssCount = 0;

    let starCount = 0;



    // Sort indices by OVR descending (tie-break by draft pick)

    const byOvr = prospects

      .map((p, idx) => ({ idx, ovr: Number(p.overall) || 60, pos: PositionMapper.name(Number(p.position) || 0) }))

      .sort((a, b) => b.ovr - a.ovr || a.idx - b.idx);



    // 1. Assign X-Factors (2-3): prioritize Super-Fusion / Generational freaks in top 12, then top OVR non-specialists

    for (const item of byOvr) {

      if (xfCount >= maxXf) break;

      if (item.pos === 'K' || item.pos === 'P' || item.pos === 'LS') continue;

      const meta = metadataMap.get(item.idx);

      if (meta && (meta.tier === 'super_fusion' || meta.tier === 'generational') && item.ovr >= 80) {

        prospects[item.idx]!.devTrait = 3;

        xfCount++;

      }

    }

    for (const item of byOvr) {

      if (xfCount >= maxXf) break;

      if (prospects[item.idx]!.devTrait !== 0) continue;

      if (item.pos === 'K' || item.pos === 'P' || item.pos === 'LS') continue;

      if (item.ovr >= 81 && (xfCount === 0 || rng.next() < 0.55)) {

        prospects[item.idx]!.devTrait = 3;

        xfCount++;

      }

    }



    // 2. Assign Superstars (6-8): mix of remaining Generational/Hybrid freaks and high-OVR Round 1-2 prospects

    for (const item of byOvr) {

      if (ssCount >= maxSs) break;

      if (prospects[item.idx]!.devTrait !== 0) continue;

      if (item.pos === 'K' || item.pos === 'P' || item.pos === 'LS') continue;

      const meta = metadataMap.get(item.idx);

      const isFreak = Boolean(meta);

      const prob = (meta?.tier === 'generational' || meta?.tier === 'super_fusion')

        ? 0.90

        : meta?.tier === 'hybrid' && item.idx < 64

          ? 0.60

          : item.ovr >= 80

            ? 0.50

            : item.ovr >= 77

              ? 0.30

              : isFreak && item.idx < 96

                ? 0.25

                : 0.0;

      if (prob > 0 && rng.next() < prob) {

        prospects[item.idx]!.devTrait = 2;

        ssCount++;

      }

    }



    // 3. Assign Stars (35-42): probabilistic across Freaks and Rounds 1-5 so Normal devs also appear in Round 1

    for (const item of byOvr) {

      if (starCount >= maxStar) break;

      if (prospects[item.idx]!.devTrait !== 0) continue;

      const meta = metadataMap.get(item.idx);

      const isFreak = Boolean(meta);

      let prob = 0;

      if (isFreak) {

        prob = 0.72;

      } else if (item.ovr >= 78) {

        prob = 0.55;

      } else if (item.ovr >= 75) {

        prob = 0.42;

      } else if (item.ovr >= 72) {

        prob = 0.26;

      } else if (item.ovr >= 69) {

        prob = 0.12;

      } else {

        prob = 0.03;

      }

      if (rng.next() < prob) {

        prospects[item.idx]!.devTrait = 1;

        starCount++;

      }

    }

  }



  /**

   * Collects merged floors for a Freak archetype/hybrid/fusion, keeping pure physical/combine

   * traits at their 90-99 outlier values while scaling technical/skill floors relative to the

   * rookie's targetOvr so they don't inflate overall into the 90s.

   */

  private collectRookieScaledFloors(archetypeKey: string, targetOvr: number): Record<string, number> {

    const out: Record<string, number> = {};

    const fusion = SUPER_FUSIONS.find(f => f.key === archetypeKey);

    const keys = fusion

      ? fusion.components

      : archetypeKey.includes('__')

        ? archetypeKey.split('__')

        : [archetypeKey];



    for (const k of keys) {

      const spec = FREAK_ARCHETYPES[k];

      if (!spec) continue;

      for (const [rKey, val] of Object.entries(spec.floors)) {

        if (typeof val !== 'number') continue;

        const scaled = ProspectVarianceServiceImpl.PHYSICAL_FREAK_KEYS.has(rKey)

          ? val

          : clamp(Math.round(targetOvr + (val - 88) * 0.55), 65, Math.min(86, targetOvr + 4));

        out[rKey] = Math.max(out[rKey] ?? 0, scaled);

      }

    }

    return out;

  }



  /**

   * Reconciles a Freak prospect's attributes to `targetOvr` while preserving his locked

   * physical outlier floors (90-99 Speed/Strength/ThrowPower/HitPower/Jumping/etc.) by

   * compensating in non-locked mental and technical ratings (awareness, playRecognition, etc.).

   */

  private reconcileFreakToTarget(

    attrs: Record<string, number>,

    posId: number,

    archId: number,

    targetOvr: number,

    lockedFloors: Record<string, number>,

    gameVersion: 'm26' | 'm27'

  ): void {

    reconcileToTarget(attrs, posId, archId, targetOvr, gameVersion);



    for (const [fKey, fVal] of Object.entries(lockedFloors)) {

      if (typeof fVal === 'number' && RATING_KEYS.includes(fKey)) {

        attrs[fKey] = Math.max(Number(attrs[fKey] ?? 50), fVal);

      }

    }



    const posName = PositionMapper.name(posId);

    const prof = CalibrationService.positionProfile(posName, gameVersion);

    const eligibleArchs = Object.keys(prof?.archetypeDist ?? {}).map(Number).filter(n => Number.isFinite(n));

    if (!eligibleArchs.includes(archId)) eligibleArchs.push(archId);



    // First pass: lower non-locked technical/mental attributes (especially awareness & playRecognition)

    // if locked Freak floors pushed any eligible archetype's OVR above targetOvr

    const nonLockedMovable = RATING_KEYS.filter(

      k => !ProspectVarianceServiceImpl.PHYSICAL_FREAK_KEYS.has(k) && !(k in lockedFloors)

    );

    const skillFloorKeys = RATING_KEYS.filter(

      k => !ProspectVarianceServiceImpl.PHYSICAL_FREAK_KEYS.has(k) && (k in lockedFloors)

    );



    for (let step = 0; step < 80; step++) {

      const g = gameOverall(attrs, posId, archId, gameVersion);

      const curBest = g.overall ?? targetOvr;

      if (curBest <= targetOvr) break;



      const overArch = g.archetype;

      const entry = OVRWeightsCalculator.ovrEntryFor(posId, overArch, gameVersion);

      const weights = entry?.weights ?? {};



      // Find highest-weight non-locked movable attribute that is still above a raw rookie minimum (42)

      const candidates = nonLockedMovable

        .filter(k => (weights[k] ?? 0) > 0 && (Number(attrs[k]) || 0) > 42)

        .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));



      if (candidates.length > 0) {

        for (const cKey of candidates.slice(0, 3)) {

          attrs[cKey] = Math.max(42, (Number(attrs[cKey]) || 50) - 2);

        }

      } else {

        // If all non-locked attributes are already at floor, gently step down non-physical skill floors

        const skillCandidates = skillFloorKeys

          .filter(k => (weights[k] ?? 0) > 0 && (Number(attrs[k]) || 0) > 55)

          .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));

        if (skillCandidates.length === 0) break;

        for (const sKey of skillCandidates.slice(0, 2)) {

          attrs[sKey] = Math.max(55, (Number(attrs[sKey]) || 60) - 1);

        }

      }

    }



    // Second pass: if OVR dropped below targetOvr, nudge non-locked skill attributes up to targetOvr

    for (let step = 0; step < 30; step++) {

      const g = gameOverall(attrs, posId, archId, gameVersion);

      const curBest = g.overall ?? targetOvr;

      if (curBest >= targetOvr) break;

      const entry = OVRWeightsCalculator.ovrEntryFor(posId, archId, gameVersion);

      const weights = entry?.weights ?? {};

      const upCandidates = nonLockedMovable

        .filter(k => (weights[k] ?? 0) > 0 && (Number(attrs[k]) || 0) < 88)

        .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));

      if (upCandidates.length === 0) break;

      const pick = upCandidates[0]!;

      attrs[pick] = (Number(attrs[pick]) || 50) + 1;

      if ((gameOverall(attrs, posId, archId, gameVersion).overall ?? targetOvr) > targetOvr) {

        attrs[pick] -= 1;

        break;

      }

    }



    const finalGame = gameOverall(attrs, posId, archId, gameVersion);

    attrs.overall = Math.min(targetOvr, finalGame.overall ?? targetOvr);

  }



  private applyMultiSpecsToProspect(

    prospect: MdcProspect,

    player: BaselinePlayer | undefined,

    specs: FreakArchetypeSpec[],

    tier: FreakMetadata['tier'],

    archetypeKey: string,

    archetypeLabel: string,

    emoji: string,

    summary: string,

    targetOvr: number,

    rng: SeededRng,

    zHeight = 0,

    zWeight = 0

  ): FreakMetadata {

    const curH = Number(prospect.heightInches) || 73;

    const curW = Number(prospect.weight) || 215;



    // 1. Sample per-archetype height/weight inside each spec's window (quantile-anchored to Cholesky z)

    //    and blend using 2K weights: Single: 100% | Dual Hybrid: 70/30 | 3-Way Super-Fusion: 60/25/15

    const sampledH = specs.map(s => sampleBand(rng, zHeight, s.minHeightIn ?? curH, Math.max(s.minHeightIn ?? curH, s.maxHeightIn ?? curH)));

    const sampledW = specs.map(s => sampleBand(rng, zWeight, s.minWeightLbs ?? curW, Math.max(s.minWeightLbs ?? curW, s.maxWeightLbs ?? curW)));



    if (specs.length >= 3) {

      prospect.heightInches = Math.round(0.60 * sampledH[0]! + 0.25 * sampledH[1]! + 0.15 * sampledH[2]!);

      prospect.weight = Math.round(0.60 * sampledW[0]! + 0.25 * sampledW[1]! + 0.15 * sampledW[2]!);

    } else if (specs.length === 2) {

      prospect.heightInches = Math.round(0.70 * sampledH[0]! + 0.30 * sampledH[1]!);

      prospect.weight = Math.round(0.70 * sampledW[0]! + 0.30 * sampledW[1]!);

    } else {

      prospect.heightInches = sampledH[0] ?? curH;

      prospect.weight = sampledW[0] ?? curW;

    }



    // 2. Collect Historical Exemplar Comps (without blending all 50+ attributes to career-peak 95s)

    const comps: string[] = [];

    for (const s of specs) {

      const cal = this.calibratedCache.get(s.key);

      if (!cal) continue;

      for (const c of cal.compLabels) {

        if (!comps.includes(c)) comps.push(c);

      }

    }



    // 2b. Apply 2K Generational vs. Raw Project mental/instinct split prior to OVR reconciliation:

    //     Generational & Super-Fusion freaks enter with polished day-1 instincts (72-82),

    //     whereas Unicorn & Hybrid 'Raw Project' freaks enter with raw awareness/recognition (48-62)

    //     so their OVR budget goes into their elite physical and technical traits.

    if (tier === 'super_fusion' || tier === 'generational') {

      prospect.awareness = Math.max(Number(prospect.awareness ?? 65), rng.randint(72, 82));

      prospect.playRecognition = Math.max(Number(prospect.playRecognition ?? 65), rng.randint(72, 82));

    } else {

      prospect.awareness = rng.randint(48, 62);

      prospect.playRecognition = rng.randint(48, 62);

    }



    // 3. Apply explicit Freak Archetype floors (full 90-99 for physicals, rookie-scaled for technical skills)

    for (const s of specs) {

      for (const [rKey, floorVal] of Object.entries(s.floors)) {

        if (typeof floorVal !== 'number' || !RATING_KEYS.includes(rKey)) continue;

        const cur = Number(prospect[rKey] ?? 50);

        const isPhysical = ProspectVarianceServiceImpl.PHYSICAL_FREAK_KEYS.has(rKey);

        if (isPhysical) {

          const boost = tier === 'super_fusion' ? rng.randint(0, 2) : tier === 'generational' ? rng.randint(0, 1) : rng.randint(-1, 1);

          const target = clamp(floorVal + boost, floorVal - 1, 99);

          if (target > cur) prospect[rKey] = target;

        } else {

          const scaledFloor = clamp(Math.round(targetOvr + (floorVal - 88) * 0.55), 65, Math.min(86, targetOvr + 4));

          if (scaledFloor > cur) prospect[rKey] = scaledFloor;

        }

      }

    }



    // 4. Synthesize NFL Combine measurements calibrated to the Freak archetype + biomechanical minFeasibleForty(weight)

    const sampledForties = specs.map(s => rng.uniform(s.combine40Range[0], s.combine40Range[1]));

    const rawForty = Math.min(...sampledForties);

    const feasibleFloor = minFeasibleForty(Number(prospect.weight) || 215);

    const finalForty = Number(Math.max(rawForty, feasibleFloor).toFixed(2));



    // If biomechanical weight floor slowed down a heavy hybrid/super-fusion's 40 time, cap speed to match

    if (finalForty > rawForty + 0.04) {

      const feasibleSpeedCap = clamp(Math.round(99 - (finalForty - 4.24) * 38), 72, 99);

      if (Number(prospect.speed ?? 0) > feasibleSpeedCap) {

        prospect.speed = feasibleSpeedCap;

      }

    }



    const bestVertMin = Math.max(...specs.map(s => s.combineVertRange[0]));

    const bestVertMax = Math.max(...specs.map(s => s.combineVertRange[1]));

    const bestBenchMin = Math.max(...specs.map(s => s.combineBenchRange[0]));

    const bestBenchMax = Math.max(...specs.map(s => s.combineBenchRange[1]));

    const bestBroadMin = Math.max(...specs.map(s => s.combineBroadRange[0]));

    const bestBroadMax = Math.max(...specs.map(s => s.combineBroadRange[1]));

    const bestConeMin = Math.min(...specs.map(s => s.combineConeRange[0]));

    const bestConeMax = Math.min(...specs.map(s => s.combineConeRange[1]));

    const bestShuttleMin = Math.min(...specs.map(s => s.combineShuttleRange[0]));

    const bestShuttleMax = Math.min(...specs.map(s => s.combineShuttleRange[1]));



    const combine: CombineMeasurements = {

      forty: finalForty,

      vertical: Number(rng.uniform(bestVertMin, bestVertMax).toFixed(1)),

      bench: rng.randint(bestBenchMin, bestBenchMax),

      broad: rng.randint(bestBroadMin, bestBroadMax),

      cone: Number(rng.uniform(bestConeMin, bestConeMax).toFixed(2)),

      shuttle: Number(rng.uniform(bestShuttleMin, bestShuttleMax).toFixed(2)),

    };

    if (player) {

      player.combine = combine;

      player.heightInches = Number(prospect.heightInches);

      player.weight = Number(prospect.weight);

    }



    // Elevate devTrait for Historical-class Freaks (procedural classes run rebalanceProceduralDevTraits after)

    const curDev = Number(prospect.devTrait) || 0;

    if (tier === 'super_fusion') {

      prospect.devTrait = 3;

    } else if (tier === 'generational') {

      prospect.devTrait = Math.max(curDev, 2);

    } else {

      prospect.devTrait = Math.max(curDev, 1);

    }



    return {

      isFreak: true,

      tier,

      archetypeKey,

      archetypeLabel,

      emoji,

      summary,

      historicalComps: comps.slice(0, 4),

      combine40: combine.forty ?? undefined,

      combineVert: combine.vertical ?? undefined,

      combineBench: combine.bench ?? undefined,

    };

  }

}



export const ProspectVarianceService = new ProspectVarianceServiceImpl();

