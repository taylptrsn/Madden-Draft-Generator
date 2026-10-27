import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutData } from './data';
import { TwoWayService } from '../TwoWayService';
import { PositionMapper } from '../PositionMapper';

test('curated two-way roles (pre-1980): Baugh punts and plays safety, Blanda kicks', () => {
  const qb = PositionMapper.toM26Id('QB');
  assert.deepEqual(TwoWayService.rolesFor('Sammy', 'Baugh', 1937, qb)?.roles.sort(), ['FS', 'P']);
  assert.deepEqual(TwoWayService.rolesFor('George', 'Blanda', 1949, qb)?.roles.sort(), ['FS', 'K']);
  // Graham kicked nothing (Groza did); the era rule still has him at safety.
  assert.deepEqual(TwoWayService.rolesFor('Otto', 'Graham', 1944, qb)?.roles, ['FS']);
});

test('from 1980 the career totals decide: Deion caught 60 passes, Troy Brown picked off 3, Watt caught 3 (no role)', skipWithoutData, () => {
  assert.deepEqual(TwoWayService.rolesFor('Deion', 'Sanders', 1989, PositionMapper.toM26Id('CB'), 5)?.roles, ['WR']);
  assert.deepEqual(TwoWayService.rolesFor('Troy', 'Brown', 1993, PositionMapper.toM26Id('WR'), 198)?.roles, ['CB']);
  assert.equal(TwoWayService.rolesFor('J.J.', 'Watt', 2011, PositionMapper.toM26Id('LEDG'), 11), null);
  assert.equal(TwoWayService.rolesFor('Peyton', 'Manning', 1998, PositionMapper.toM26Id('QB'), 1), null);
  // Two 2013 undrafted Ryan Griffins: the tight end's 210 catches must not reach the quarterback.
  assert.equal(TwoWayService.rolesFor('Ryan', 'Griffin', 2013, PositionMapper.toM26Id('QB'), null), null);
  // A receiver with 100+ carries is a usable back (Cordarrelle Patterson).
  assert.deepEqual(TwoWayService.rolesFor('Cordarrelle', 'Patterson', 2013, PositionMapper.toM26Id('WR'), 29)?.roles, ['HB']);
});

test('the single-platoon era gives everyone the mirrored side; it ends in 1949', () => {
  assert.deepEqual(TwoWayService.rolesFor('Some', 'Guard', 1946, PositionMapper.toM26Id('LG'))?.roles, ['DT']);
  assert.deepEqual(TwoWayService.rolesFor('Some', 'End', 1940, PositionMapper.toM26Id('WR'))?.roles, ['CB']);
  assert.equal(TwoWayService.rolesFor('Some', 'Guard', 1950, PositionMapper.toM26Id('LG')), null);
});

test('Baugh leaves the 1937 class able to punt and cover; his quarterback overall is unchanged', skipWithoutData, async () => {
  const { enrichedClass } = await import('../DraftEnrichment');
  const { DraftClassBuilder } = await import('../DraftClassBuilder');
  const { OVRWeightsCalculator } = await import('../OVRWeightsCalculator');
  const { players } = await enrichedClass(1937, 'NFL', { fill: true });
  const r = DraftClassBuilder.preview(players, 'madden', {}, 'm27').rows.find((x) => x.lastName === 'Baugh')!;
  assert.ok(r, 'Baugh in 1937');
  assert.equal(r.position, 'QB');
  assert.ok(r.ratings.kickPower >= r.overall - 4 && r.ratings.kickAccuracy >= r.overall - 4, `KPW ${r.ratings.kickPower} KAC ${r.ratings.kickAccuracy} vs ${r.overall}`);
  assert.ok(r.ratings.zoneCoverage >= r.overall - 8, `ZCV ${r.ratings.zoneCoverage}`);
  assert.equal(OVRWeightsCalculator.computeOverall(r.positionId, r.archetype, r.ratings, 'm27'), r.overall);
  assert.deepEqual(r.twoWay?.roles.sort(), ['FS', 'P']);
});

test('a curated entry overrides the data rule in any year (pin roles, or pin none)', () => {
  // Watt is pinned to "none" in the file; the rule would already give nothing, but the pin wins regardless.
  assert.equal(TwoWayService.rolesFor('J.J.', 'Watt', 2011, PositionMapper.toM26Id('LEDG'), 11), null);
  assert.equal(TwoWayService.rolesFor('JJ', 'Watt', 2011, PositionMapper.toM26Id('LEDG'), 11), null, 'key ignores punctuation');
});

test('the weekly stats cover the undrafted: Taysom Hill (QB) is a usable back and tight end; Lamar Jackson is not a back', skipWithoutData, () => {
  const { NflverseStatsService } = require('../NflverseStatsService');
  const hill = TwoWayService.rolesFor('Taysom', 'Hill', 2017, PositionMapper.toM26Id('QB'), null);
  assert.deepEqual(hill?.roles.sort(), ['HB', 'TE'], JSON.stringify(hill));
  assert.equal(hill?.source, 'stats');
  assert.equal(TwoWayService.rolesFor('Lamar', 'Jackson', 2018, PositionMapper.toM26Id('QB'), 32), null);
  if (NflverseStatsService.available) assert.ok(NflverseStatsService.usage('Taysom', 'Hill', 2017)!.carries > 400);
});
