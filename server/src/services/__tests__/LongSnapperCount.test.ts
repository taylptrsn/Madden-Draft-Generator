import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetLongSnapperCount } from '../GenericFillerService';
import { enrichedClass, allTimeGreatsClass, teamGreatsClass } from '../DraftEnrichment';
import { DraftClassBuilder } from '../DraftClassBuilder';

test('targetLongSnapperCount: always yields between 5 and 10 prospects', () => {
  for (let year = 1960; year <= 2035; year++) {
    const count = targetLongSnapperCount(year);
    assert.ok(count >= 5 && count <= 10, `Expected 5 <= count <= 10 for year ${year}, got ${count}`);
  }

  for (const key of ['all-time', 'DAL', '1990-1999', 'custom-board-seed-123']) {
    const count = targetLongSnapperCount(key);
    assert.ok(count >= 5 && count <= 10, `Expected 5 <= count <= 10 for key ${key}, got ${count}`);
  }
});

test('M27 draft classes: every historical year contains 5-10 Long Snapper prospects', async () => {
  // Test over-capacity years (2024, 1976), years with real LS (1983), and filler-heavy years (1995, 2026)
  const testYears = [1976, 1983, 1995, 2024, 2026];

  for (const year of testYears) {
    const { players } = await enrichedClass(year, 'NFL', { fill: true });
    const { prospects } = DraftClassBuilder.buildProspects(players, 'madden', {}, 'm27');
    const lsProspects = prospects.filter((p) => Number(p.position) === 21);

    assert.equal(prospects.length, 402, `Year ${year} should have full logical capacity of 402`);
    assert.ok(
      lsProspects.length >= 5 && lsProspects.length <= 10,
      `Year ${year} expected 5-10 LS prospects, found ${lsProspects.length}`
    );

    // Verify LS attributes and archetypes
    for (const p of lsProspects) {
      assert.equal(Number(p.position), 21, 'Position should be 21 (LS)');
      assert.ok([65, 66].includes(Number(p.archetype)), `Archetype ${p.archetype} should be Power LS (65) or Accurate LS (66)`);
      assert.ok(Number(p.heightInches) >= 69 && Number(p.heightInches) <= 80, `Height ${p.heightInches} within LS range`);
      assert.ok(Number(p.weight) >= 210 && Number(p.weight) <= 295, `Weight ${p.weight} within LS range`);
    }
  }
});

test('M27 UI preview: preview rows contain 5-10 Long Snappers with matching positionId and label', async () => {
  const { players } = await enrichedClass(2024, 'NFL', { fill: true });
  const preview = DraftClassBuilder.preview(players, 'madden', {}, 'm27');
  const lsRows = preview.rows.filter((r) => r.position === 'LS' || r.positionId === 21);

  assert.equal(preview.rows.length, 402);
  assert.ok(lsRows.length >= 5 && lsRows.length <= 10, `Expected 5-10 LS in preview, got ${lsRows.length}`);

  for (const r of lsRows) {
    assert.equal(r.position, 'LS');
    assert.equal(r.positionId, 21);
    assert.ok(r.archetypeName.includes('LS') || [65, 66].includes(r.archetype));
  }
});

test('All-Time and Team Greats: retain 5-10 Long Snappers', async () => {
  const { players: atPlayers } = await allTimeGreatsClass();
  const atProspects = DraftClassBuilder.buildProspects(atPlayers, 'madden', {}, 'm27').prospects;
  const atLs = atProspects.filter((p) => Number(p.position) === 21);
  assert.ok(atLs.length >= 5 && atLs.length <= 10, `All-Time Greats expected 5-10 LS, got ${atLs.length}`);

  const { players: tgPlayers } = await teamGreatsClass('DAL');
  const tgProspects = DraftClassBuilder.buildProspects(tgPlayers, 'madden', {}, 'm27').prospects;
  const tgLs = tgProspects.filter((p) => Number(p.position) === 21);
  assert.ok(tgLs.length >= 5 && tgLs.length <= 10, `Team Greats expected 5-10 LS, got ${tgLs.length}`);
});
