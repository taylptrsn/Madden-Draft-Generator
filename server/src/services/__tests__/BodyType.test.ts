import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyTypeFor, BODY_TYPE_BANDS } from '../DraftClassBuilder';
import { BODY_TYPE_ID } from '../M27Fields';

const fixed = (x: number) => () => x;

test('body types respect the editor weight bands and the real roster mix', () => {
  // Witten (264 lb TE): not Heavy (280+), not Standard (<= 230) -> Muscular.
  assert.equal(bodyTypeFor('TE', 264, fixed(0.5)), 'Muscular');
  assert.equal(bodyTypeFor('TE', 225, fixed(0.5)), 'Standard');
  // DBs are never Muscular/Heavy at normal weights; the lightest can be Lean.
  for (const r of [0.05, 0.5, 0.95]) {
    assert.ok(['Standard', 'Thin', 'Lean'].includes(bodyTypeFor('CB', 190, fixed(r))));
    assert.equal(bodyTypeFor('SS', 206, fixed(r)) === 'Heavy', false);
    assert.equal(bodyTypeFor('WR', 205, fixed(r)), 'Standard');
    assert.equal(bodyTypeFor('LEDG', 262, fixed(r)), 'Muscular');
    assert.equal(bodyTypeFor('LEDG', 310, fixed(0.5)), 'Muscular');
    assert.equal(bodyTypeFor('LG', 315, fixed(r)) === 'Standard', false);
    assert.equal(bodyTypeFor('K', 190, fixed(0.5)), 'Thin');
  }
  assert.equal(bodyTypeFor('LS', 225, fixed(0.5)), 'Standard');
  assert.equal(bodyTypeFor('LS', 250, fixed(0.5)), 'Muscular');
  assert.equal(bodyTypeFor('LS', 285, fixed(0.5)), 'Heavy');
  assert.equal(bodyTypeFor('WR', 168, fixed(0.5)), 'Lean');
  assert.equal(bodyTypeFor('DT', 304, fixed(0.5)), 'Heavy');
  assert.equal(bodyTypeFor('LT', 300, fixed(0.9)), 'Muscular');
  assert.equal(bodyTypeFor('LT', 330, fixed(0.5)), 'Heavy');
  assert.equal(bodyTypeFor('QB', 232, fixed(0.5)), 'Thin');
  assert.equal(bodyTypeFor('QB', 300, fixed(0.5)), 'Heavy');
  assert.equal(bodyTypeFor('HB', 205, fixed(0.5)), 'Standard');
  assert.equal(bodyTypeFor('HB', 228, fixed(0.5)), 'Muscular');
});

test('every assigned type sits inside its editor band except where EA itself breaks it', () => {
  // Sweep positions x weights; outside-band results are only the roster-proven
  // exceptions (Muscular edge/tackle/DT above 285).
  const positions = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LEDG', 'REDG', 'DT', 'SAM', 'MIKE', 'WILL', 'CB', 'FS', 'SS', 'K', 'P', 'LS'];
  const bad: string[] = [];
  for (const pos of positions) {
    for (let w = 160; w <= 380; w += 5) {
      for (const r of [0.1, 0.5, 0.9]) {
        const bt = bodyTypeFor(pos, w, fixed(r));
        const [lo, hi] = BODY_TYPE_BANDS[bt];
        const allowed = bt === 'Muscular' && w > 285 && ['LT', 'RT', 'LG', 'RG', 'C', 'LEDG', 'REDG', 'DT', 'FB'].includes(pos);
        if ((w < lo || w > hi) && !allowed) bad.push(`${pos} ${w} -> ${bt}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('Lean maps to the Player-table enum Freshman = 4 for the M27 byte', () => {
  assert.equal(BODY_TYPE_ID.Lean, 4);
});
