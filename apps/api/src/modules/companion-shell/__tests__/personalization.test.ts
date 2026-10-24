import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionPersonalizationWriteV1Schema } from '@astella/shared/companion-shell-contracts';

test('private addressing requires a revision and an explicit bounded value', () => {
  assert.deepEqual(companionPersonalizationWriteV1Schema.parse({ revision: 2, preferredAddress: '  小林  ' }), { revision: 2, preferredAddress: '小林' });
  for (const body of [{ preferredAddress: 'x' }, { revision: 0, preferredAddress: '' }, { revision: 0, preferredAddress: 'x'.repeat(41) }, { revision: 0, preferredAddress: 'x', displayName: 'public' }]) {
    assert.equal(companionPersonalizationWriteV1Schema.safeParse(body).success, false);
  }
  assert.equal(companionPersonalizationWriteV1Schema.safeParse({ revision: 0, preferredAddress: null }).success, true);
});
