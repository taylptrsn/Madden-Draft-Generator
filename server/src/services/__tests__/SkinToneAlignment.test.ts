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
