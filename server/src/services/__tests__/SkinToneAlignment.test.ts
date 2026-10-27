import { LikenessService, headStyleCode, headStyleGroup, headBuildCode, buildCompatibilityTier, inferPlayerBodyType, VISUAL_HEAD_BUILD_OVERRIDES } from '../LikenessService';
import { PortraitService } from '../PortraitService';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftClassBuilder } from '../DraftClassBuilder';
import { Mdc27Service } from '../Mdc27Service';
import { MdcService } from '../MdcService';
import type { BaselinePlayer } from '../../types/player';

function makePlayer(p: Partial<BaselinePlayer>): BaselinePlayer {
  return {
    firstName: 'Test',
    lastName: 'Player',
    draftYear: 2024,
    draftRound: 1,
    draftPick: 1,
    position: 'QB',
    college: 'USC',
    photoId: null,
    playerAssetsId: null,
    race: 7,
    source: 'historical',
    age: 22,
    height: 74,
    weight: 220,
    ...p,
  } as BaselinePlayer;
}

test('M27: Real head scan prospects retain tone-matched genericHeadName for 3D body skin textures', () => {
  const caleb = makePlayer({
    firstName: 'Caleb',
    lastName: 'Williams',
    playerAssetsId: 'WilliamsCaleb_14500',
    race: 7,
  });
  const alt = makePlayer({
    firstName: 'Joe',
    lastName: 'Alt',
    position: 'LT',
    playerAssetsId: 'AltJoe_14694',
    race: 1,
  });

  const res = DraftClassBuilder.buildMdc27([caleb, alt]);
  const parsed = Mdc27Service.parse(res.buffer);

  // Caleb Williams: Dark skin (tone 7)
  const calebParsed = parsed[0];
  assert.equal(calebParsed.assetName, 'WilliamsCaleb_14500');
  const calebVis = calebParsed.visuals as { genericHeadName?: string; skinTone?: number };
  assert.ok(calebVis.genericHeadName, 'genericHeadName must not be undefined');
  assert.match(calebVis.genericHeadName!, /^gen_7_/i, '3D body skin genericHeadName must match tone 7');
  assert.equal(calebVis.skinTone, 7, 'visuals.skinTone must be 7');

  // Joe Alt: Light skin (tone 1)
  const altParsed = parsed[1];
  assert.equal(altParsed.assetName, 'AltJoe_14694');
  const altVis = altParsed.visuals as { genericHeadName?: string; skinTone?: number };
  assert.ok(altVis.genericHeadName, 'genericHeadName must not be undefined');
  assert.match(altVis.genericHeadName!, /^gen_1_/i, '3D body skin genericHeadName must match tone 1');
  assert.equal(altVis.skinTone, 1, 'visuals.skinTone must be 1');
});

test('M26: Real head scan prospects replace template slot genericHeadName with tone-matched face', () => {
  // Place Caleb Williams (tone 7) in slot 2 (where M26 template has Drew Allar, tone 2)
  const dummy1 = makePlayer({ firstName: 'D1', lastName: 'P1', race: 1, source: 'generated' });
  const dummy2 = makePlayer({ firstName: 'D2', lastName: 'P2', race: 1, source: 'generated' });
  const caleb = makePlayer({
    firstName: 'Caleb',
    lastName: 'Williams',
    playerAssetsId: 'WilliamsCaleb_14500',
    draftPick: 3,
    race: 7,
  });
  // Place Joe Alt (tone 1) in slot 3 (where M26 template has LaNorris Sellers, tone 7)
  const alt = makePlayer({
    firstName: 'Joe',
    lastName: 'Alt',
    playerAssetsId: 'AltJoe_14694',
    draftPick: 4,
    race: 1,
  });

  const res = DraftClassBuilder.buildMdc([dummy1, dummy2, caleb, alt]);
  const parsed = MdcService.parse(res.buffer);

  // Caleb in slot 2 (must NOT inherit Drew Allar's gen_2 White hands)
  const calebParsed = parsed[2];
  assert.equal(calebParsed.assetName, 'WilliamsCaleb_14500');
  const calebVis = calebParsed.visuals as { genericHeadName?: string; skinTone?: number };
  assert.ok(calebVis.genericHeadName, 'genericHeadName must exist');
  assert.match(calebVis.genericHeadName!, /^gen_7_/i, 'Caleb must have gen_7 generic head for body skin, not gen_2');
  assert.equal(calebVis.skinTone, 7);

  // Alt in slot 3 (must NOT inherit LaNorris Sellers' gen_7 Black hands)
  const altParsed = parsed[3];
  assert.equal(altParsed.assetName, 'AltJoe_14694');
  const altVis = altParsed.visuals as { genericHeadName?: string; skinTone?: number };
  assert.ok(altVis.genericHeadName, 'genericHeadName must exist');
  assert.match(altVis.genericHeadName!, /^gen_1_/i, 'Alt must have gen_1 generic head for body skin, not gen_7');
  assert.equal(altVis.skinTone, 1);
});


test('M27: Borrowed 2D portraits strictly match 3D generic head hairstyle and facial hair', () => {
  assert.equal(headStyleGroup('gen_1_B_B_005'), 'bald');
  assert.equal(headStyleGroup('gen_1_B_N_010'), 'clean');
  assert.equal(headStyleGroup('gen_2_BMH_BD_01'), 'beard');
  assert.equal(headStyleGroup('gen_7_M_G_005'), 'goatee_stubble');

  // Create 15 generated prospects in tone 1
  const baldProspects: Array<Record<string, unknown>> = [];
  const baldPlayers: BaselinePlayer[] = [];
  for (let i = 0; i < 15; i++) {
    baldProspects.push({
      PEPS: 'gen_1_B_B_005',
      bodyType: 'Standard',
      PID: 0,
      visuals: {},
    });
    baldPlayers.push(makePlayer({
      firstName: `Rookie${i}`,
      lastName: `Bald${i}`,
      race: 1,
      source: 'historical', // keep as generic head to test generic head borrowing
      position: 'WR',
      weight: 200,
    }));
  }

  LikenessService.balanceClassGenericHeads(baldProspects, baldPlayers, 'm27', 0);

  for (let i = 0; i < baldProspects.length; i++) {
    const p = baldProspects[i];
    const pid = Number(p.PID);
    assert.ok(pid > 0, `Prospect ${i} must have a valid PID`);
    const plpo = PortraitService.plpoForPid(pid);
    assert.ok(plpo, `PID ${pid} must resolve to a valid plpo`);
    const pGroup = headStyleGroup(plpo);
    const vis = (p.visuals ?? {}) as { genericHeadName?: string };
    const headName = String(vis.genericHeadName || p.PEPS || '');
    const hGroup = headStyleGroup(headName);
    assert.equal(pGroup, hGroup, `Prospect ${i} portrait style (${pGroup}, ${plpo}) must match 3D head (${hGroup}, ${headName})`);
  }

  // Create 15 generated prospects in tone 1 (clean-shaven head)
  const cleanProspects: Array<Record<string, unknown>> = [];
  const cleanPlayers: BaselinePlayer[] = [];
  for (let i = 0; i < 15; i++) {
    cleanProspects.push({
      PEPS: 'gen_1_B_N_010',
      bodyType: 'Standard',
      PID: 0,
      visuals: {},
    });
    cleanPlayers.push(makePlayer({
      firstName: `Rookie${i}`,
      lastName: `Clean${i}`,
      race: 1,
      source: 'historical',
      position: 'WR',
      weight: 200,
    }));
  }

  LikenessService.balanceClassGenericHeads(cleanProspects, cleanPlayers, 'm27', 0);

  for (let i = 0; i < cleanProspects.length; i++) {
    const p = cleanProspects[i];
    const pid = Number(p.PID);
    assert.ok(pid > 0, `Prospect ${i} must have a valid PID`);
    const plpo = PortraitService.plpoForPid(pid);
    assert.ok(plpo, `PID ${pid} must resolve to a valid plpo`);
    const pGroup = headStyleGroup(plpo);
    const vis = (p.visuals ?? {}) as { genericHeadName?: string };
    const headName = String(vis.genericHeadName || p.PEPS || '');
    const hGroup = headStyleGroup(headName);
    assert.equal(pGroup, hGroup, `Prospect ${i} portrait style (${pGroup}, ${plpo}) must match 3D head (${hGroup}, ${headName})`);
  }

  // Create 15 generated prospects with fictional source (testing assignedExtraHead constraint)
  const fictionalProspects: Array<Record<string, unknown>> = [];
  const fictionalPlayers: BaselinePlayer[] = [];
  for (let i = 0; i < 15; i++) {
    fictionalProspects.push({
      PEPS: 'gen_1_B_N_010',
      bodyType: 'Standard',
      PID: 0,
      visuals: {},
    });
    fictionalPlayers.push(makePlayer({
      firstName: `Fictional${i}`,
      lastName: `Player${i}`,
      race: 1,
      source: 'generated',
      position: 'WR',
      weight: 200,
    }));
  }

  LikenessService.balanceClassGenericHeads(fictionalProspects, fictionalPlayers, 'm27', 0);

  for (let i = 0; i < fictionalProspects.length; i++) {
    const p = fictionalProspects[i];
    const pid = Number(p.PID);
    assert.ok(pid > 0, `Prospect ${i} must have a valid PID`);
    const plpo = PortraitService.plpoForPid(pid);
    assert.ok(plpo, `PID ${pid} must resolve to a valid plpo`);
    const pGroup = headStyleGroup(plpo);
    const vis = (p.visuals ?? {}) as { genericHeadName?: string };
    const headName = String(vis.genericHeadName || p.PEPS || '');
    const hGroup = headStyleGroup(headName);
    assert.equal(pGroup, hGroup, `Fictional prospect ${i} portrait style (${pGroup}, ${plpo}) must match 3D head preset (${hGroup}, ${headName})`);
  }
});

test('M27: Visual face fullness matches bodyType (no skinny faces on Heavy linemen, no chubby faces on QBs/skill players)', () => {
  // 1. Verify specific reported outlier heads are properly classified
  assert.equal(headBuildCode('gen_2_B_BD_03'), 'H', 'Chubby face gen_2_B_BD_03 (Jimmie Smith) must be classified as Heavy (H)');
  assert.equal(headBuildCode('plpo_generic_2_B_BD_03'), 'H', 'Portrait plpo_generic_2_B_BD_03 must be classified as Heavy (H)');
  assert.equal(headBuildCode('gen_2_B_N_0018'), 'H', 'Chubby face gen_2_B_N_0018 (Brian Warren) must be classified as Heavy (H)');
  assert.equal(headBuildCode('plpo_generic_2_B_N_0018'), 'H', 'Portrait plpo_generic_2_B_N_0018 must be classified as Heavy (H)');
  assert.equal(buildCompatibilityTier(headBuildCode('gen_2_BMH_S_004'), 'Heavy'), 0, 'Skinny face gen_2_BMH_S_004 (Ricardo Rambo) must be incompatible with Heavy');
  assert.equal(buildCompatibilityTier(headBuildCode('gen_2_B_BD_03'), 'Standard'), 0, 'Chubby face gen_2_B_BD_03 must be incompatible with Standard');
  assert.equal(buildCompatibilityTier(headBuildCode('gen_2_B_N_0018'), 'Standard'), 0, 'Chubby face gen_2_B_N_0018 must be incompatible with Standard');

  // 2. Test across a large mixed class of Heavy linemen (including 305 lb Muscular OL) and Standard/Thin QBs/WRs across all skin tones
  const prospects: Array<Record<string, unknown>> = [];
  const players: BaselinePlayer[] = [];

  for (let tone = 1; tone <= 7; tone++) {
    // 10 Heavy/Lineman prospects per tone (half Heavy, half 305lb Muscular RT like Ricardo Rambo)
    for (let j = 0; j < 10; j++) {
      const bt = j % 2 === 0 ? 'Heavy' : 'Muscular';
      prospects.push({
        PEPS: `gen_${tone}_B_N_01`,
        bodyType: bt,
        weight: 305,
        position: 'RT',
        PID: 0,
        visuals: {},
      });
      players.push(makePlayer({
        firstName: `Lineman_${tone}_${j}`,
        lastName: `Rambo_${tone}_${j}`,
        race: tone,
        source: 'generated',
        position: 'RT',
        weight: 305,
      }));
    }

    // 12 Standard QBs per tone (201-217 lbs like Jimmie Smith & Brian Warren)
    for (let j = 0; j < 12; j++) {
      prospects.push({
        PEPS: `gen_${tone}_B_N_01`,
        bodyType: 'Standard',
        weight: 205 + (j % 15),
        position: 'QB',
        PID: 0,
        visuals: {},
      });
      players.push(makePlayer({
        firstName: `QB_${tone}_${j}`,
        lastName: `Warren_${tone}_${j}`,
        race: tone,
        source: 'generated',
        position: 'QB',
        weight: 205 + (j % 15),
      }));
    }
  }

  LikenessService.balanceClassGenericHeads(prospects, players, 'm27', 0);

  for (let i = 0; i < prospects.length; i++) {
    const p = prospects[i];
    const pl = players[i];
    const effBt = inferPlayerBodyType(pl, String(p.bodyType || ''));
    const peps = String(p.PEPS || '');
    const vis = (p.visuals ?? {}) as { genericHeadName?: string };
    const headCode = String(vis.genericHeadName || peps);
    const hBuild = headBuildCode(headCode);

    const pid = Number(p.PID);
    const plpo = PortraitService.plpoForPid(pid) || '';
    const pBuild = headBuildCode(plpo);

    if ((pl.weight ?? 0) >= 285) {
      assert.equal(effBt, 'Heavy', `305lb lineman ${pl.firstName} must resolve to Heavy face bodyType`);
      assert.equal(hBuild, 'H', `305lb lineman ${pl.firstName} got non-Heavy 3D head ${headCode} (build=${hBuild})`);
      assert.equal(pBuild, 'H', `305lb lineman ${pl.firstName} got non-Heavy 2D portrait ${plpo} (build=${pBuild})`);
    } else {
      assert.notEqual(hBuild, 'H', `QB ${pl.firstName} (${pl.weight}lb) got chubby/Heavy 3D head ${headCode}`);
      assert.notEqual(pBuild, 'H', `QB ${pl.firstName} (${pl.weight}lb) got chubby/Heavy 2D portrait ${plpo}`);
      for (const [ovSuffix, ovBuild] of Object.entries(VISUAL_HEAD_BUILD_OVERRIDES)) {
        if (ovBuild === 'H') {
          assert.ok(!headCode.toLowerCase().endsWith(ovSuffix), `QB ${pl.firstName} got visually chubby head ${headCode}`);
          assert.ok(!plpo.toLowerCase().endsWith(ovSuffix), `QB ${pl.firstName} got visually chubby portrait ${plpo}`);
        }
      }
    }
  }
});

test('M27: balanceClassGenericHeads preserves pre-pinned legend portraits on generic-headed players', () => {
  const prospects: Array<Record<string, unknown>> = [
    {
      PEPS: 'gen_6_B_N_01',
      bodyType: 'Muscular',
      weight: 250,
      position: 'SAM',
      PID: 4829,
      pinPortrait: true,
      visuals: {},
    },
  ];
  const players: BaselinePlayer[] = [
    makePlayer({
      firstName: 'Terrell',
      lastName: 'Suggs',
      draftYear: 2003,
      race: 6,
      source: 'historical',
      position: 'SAM',
      weight: 250,
    }),
  ];
  LikenessService.balanceClassGenericHeads(prospects, players, 'm27', 0);
  assert.equal(prospects[0].PID, 4829, 'Pinned legend portrait PID must not be overwritten by generic head balancer');
  assert.equal(prospects[0].pinPortrait, true, 'pinPortrait flag must remain intact for assignM27Fields');
});
