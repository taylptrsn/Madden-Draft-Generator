import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { LOOKUPS_DIR } from '../../config/paths';
import { ProspectVarianceService } from '../ProspectVarianceService';
import { DraftClassBuilder } from '../DraftClassBuilder';
import { EraGearService } from '../EraGearService';

const m27Assets = new Set<string>(
  JSON.parse(fs.readFileSync(path.join(LOOKUPS_DIR, 'm27-game-gear-assets.json'), 'utf8'))
);

test('Enhancement 1 & 3 & 4: Procedural class features Draft Board Uncertainty (Reaches & Sleepers), Age vs Polish curves, and Return Specialists', () => {
  const settings = { enabled: true, preset: 'balanced' as const, seed: 2027 };
  const players = ProspectVarianceService.buildProceduralClass(settings, 2027);
  const { prospects } = DraftClassBuilder.buildProspects(
    players,
    'madden',
    { freakMode: true, freakPreset: 'balanced', freakSeed: 2027 },
    'm27'
  );

  assert.equal(prospects.length, 402);

  // 1. Draft Board Uncertainty: Round 1-2 Combine Reaches (picks 9..58 with OVR 67-71 and Normal dev)
  const earlyReaches = prospects.slice(8, 58).filter(
    (p) => Number(p.overall) >= 67 && Number(p.overall) <= 71 && Number(p.devTrait) === 0
  );
  assert.ok(
    earlyReaches.length >= 3,
    `Expected at least 3 Round 1-2 reaches (67-71 OVR, Normal dev), got ${earlyReaches.length}`
  );

  // Day 3 / UDFA Hidden Gems (picks 109..375 with OVR 72-76)
  const lateGems = prospects.slice(108, 375).filter(
    (p) => Number(p.overall) >= 72 && Number(p.overall) <= 76 && Number(p.position) !== 21
  );
  assert.ok(
    lateGems.length >= 5,
    `Expected at least 5 Day 3 / UDFA hidden gems (72-76 OVR), got ${lateGems.length}`
  );
  const devGems = lateGems.filter((p) => Number(p.devTrait) >= 1);
  assert.ok(
    devGems.length >= 3,
    `Expected at least 3 Day 3 hidden gems to carry Star/Superstar dev traits, got ${devGems.length}`
  );

  // 3. Age vs. Polish Curve: ages 20..24 are all represented
  const ageCounts = new Map<number, number>();
  for (const p of prospects) {
    const a = Number(p.age) || 22;
    ageCounts.set(a, (ageCounts.get(a) ?? 0) + 1);
  }
  for (const expectedAge of [20, 21, 22, 23, 24]) {
    assert.ok((ageCounts.get(expectedAge) ?? 0) >= 8, `Expected age ${expectedAge} to be represented, count=${ageCounts.get(expectedAge)}`);
  }

  // 4. Designated Kick/Punt Return Specialists: 5+ mid/late-round players with kickReturn >= 88
  const returners = prospects.slice(64).filter((p) => Number(p.kickReturn) >= 88);
  assert.ok(
    returners.length >= 5,
    `Expected at least 5 designated mid/late-round Kick Return specialists (KR >= 88), got ${returners.length}`
  );
});

test('Enhancement 2: Modern M27 equipment includes full visor palette, scrunch/under socks, handwarmers, and asymmetric arm/wrist/QB-glove drip', () => {
  const visors = new Set<string>();
  const socks = new Set<string>();
  let handwarmers = 0;
  let asymmetricArms = 0;
  let asymmetricWrists = 0;
  let qbSingleLeftGlove = 0;
  let qbCoachWristband = 0;

  for (let i = 0; i < 360; i++) {
    const posId = i % 21;
    const lo = EraGearService.loadout(2026, posId, `drip-test-${i}`, 'm27');
    const bySlot = new Map<string, string>();
    for (const el of lo.loadoutElements) {
      if (el.itemAssetName) {
        assert.ok(m27Assets.has(el.itemAssetName), `Unverified M27 asset: ${el.itemAssetName}`);
      }
      if (el.slotType && el.itemAssetName) {
        bySlot.set(el.slotType, el.itemAssetName);
      }
    }
    const v = bySlot.get('Visor');
    if (v) visors.add(v);
    const s = bySlot.get('InnerSocks');
    if (s) socks.add(s);
    if (bySlot.get('WaistWear') === 'Handwarmer_Standard' && bySlot.get('WaistWearOverride') === 'HandwarmerStyle_Back') {
      handwarmers++;
    }
    if (bySlot.get('LeftArmWear') !== bySlot.get('RightArmWear')) {
      asymmetricArms++;
    }
    if (bySlot.get('LeftWristWear') !== bySlot.get('RightWristWear')) {
      asymmetricWrists++;
    }
    if (posId === 0) {
      if (bySlot.has('LeftHandWear') && !bySlot.has('RightHandWear')) {
        qbSingleLeftGlove++;
      }
      if (bySlot.get('LeftWristWear')?.startsWith('GearWrist_wristBandCoach_')) {
        qbCoachWristband++;
      }
    }
  }

  assert.ok(visors.size >= 5, `Expected at least 5 distinct M27 visor styles, got ${visors.size}: ${[...visors].join(', ')}`);
  assert.ok(socks.has('Gear_Socks_Wrinkle_Mid') || socks.has('Gear_Socks_Wrinkle_High'), `Expected scrunch/wrinkle socks in modern M27 class: ${[...socks].join(', ')}`);
  assert.ok(socks.has('Gear_Socks_Under'), `Expected under socks in modern M27 class: ${[...socks].join(', ')}`);
  assert.ok(handwarmers >= 8, `Expected at least 8 waist handwarmers across sample, got ${handwarmers}`);
  assert.ok(asymmetricArms >= 10, `Expected at least 10 asymmetric arm sleeve/tape loadouts, got ${asymmetricArms}`);
  assert.ok(asymmetricWrists >= 8, `Expected at least 8 asymmetric wristwear loadouts, got ${asymmetricWrists}`);
  assert.ok(qbSingleLeftGlove >= 1, `Expected at least 1 QB with non-throwing left-hand single glove, got ${qbSingleLeftGlove}`);
  assert.ok(qbCoachWristband >= 2, `Expected at least 2 QBs with left-wrist coach playcall band, got ${qbCoachWristband}`);
});

test('Enhancement 5 & 6: Class-to-Class Positional Waves, Cultural Name Coherence, and College Pipeline Weighting', () => {
  const wave0 = ProspectVarianceService.getClassWave(2027);
  const wave1 = ProspectVarianceService.getClassWave(2028);
  assert.notEqual(wave0.label, wave1.label);

  const players = ProspectVarianceService.buildProceduralClass({ enabled: true, seed: 2027 }, 2027);

  // Check Polynesian / Nigerian / Hispanic cohort presence and skin-tone coherence
  const polyLast = new Set(['Sewell', 'Tagovailoa', 'Hufanga', 'Vea', 'Latu', 'Buckner', 'Polamalu', 'Fanu', 'Tuipulotu', 'Aumavae', 'Lotulelei', 'Seau', 'Ngata', 'Maiava', 'Uiagalelei', 'Nacua', 'Suamataia', 'Fuaga', 'Savaiinaea', 'Taumoepenu', 'Tavai', 'Fotu', 'Anae', 'Tonga']);
  const nigLast = new Set(['Oweh', 'Mafe', 'Madubuike', 'Odighizuwa', 'Ojulari', 'Nwosu', 'Awuzie', 'Asomugha', 'Okwara', 'Onwuzurike', 'Anudike', 'Ezeiruaku', 'Ogbah', 'Okoye', 'Njoku', 'Egbuka', 'Igbinoghene', 'Adebawore', 'Oluwatimi', 'Ojomo', 'Ebukam', 'Onyemata', 'Ogbonnia', 'Okoronkwo']);

  const polyPlayers = players.filter((p) => polyLast.has(p.lastName));
  const nigPlayers = players.filter((p) => nigLast.has(p.lastName));
  assert.ok(polyPlayers.length >= 5, `Expected at least 5 Polynesian cohort prospects, got ${polyPlayers.length}`);
  assert.ok(nigPlayers.length >= 10, `Expected at least 10 Nigerian/West African cohort prospects, got ${nigPlayers.length}`);

  for (const p of polyPlayers) {
    assert.ok((p.race ?? 0) >= 3 && (p.race ?? 0) <= 5, `Expected Polynesian prospect ${p.firstName} ${p.lastName} to have tone 3-5, got ${p.race}`);
  }
  for (const p of nigPlayers) {
    assert.ok((p.race ?? 0) >= 6 && (p.race ?? 0) <= 7, `Expected Nigerian prospect ${p.firstName} ${p.lastName} to have tone 6-7, got ${p.race}`);
  }

  // Check Blue-Blood college weighting in Rounds 1-2 vs Small-School sleepers in Day 3
  const blueBloodRegex = /^(Alabama|Georgia|Ohio St|LSU|Michigan|Texas|Oregon|Clemson|Notre Dame|Penn St|USC|Oklahoma|Florida|Miami|Washington|Florida St|Auburn|Tennessee|Texas A&M|Wisconsin|Iowa|Utah)$/i;
  const r12BlueBloods = players.slice(0, 64).filter((p) => blueBloodRegex.test(p.college.trim())).length;
  const lateBlueBloods = players.slice(200, 264).filter((p) => blueBloodRegex.test(p.college.trim())).length;
  assert.ok(
    r12BlueBloods > lateBlueBloods + 8,
    `Expected Rounds 1-2 Blue-Blood count (${r12BlueBloods}) to significantly exceed late-round count (${lateBlueBloods})`
  );
});
