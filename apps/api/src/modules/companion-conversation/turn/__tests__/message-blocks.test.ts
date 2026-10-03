import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoredCompanionBlocks } from '../message-blocks.ts';

test('keeps canonical rich content and its order', () => {
  const blocks = [{ type: 'text', text: '原文' }, { type: 'quote', text: '引文', label: '依据' }];
  assert.deepEqual(readStoredCompanionBlocks(blocks), blocks);
});

test('reads the persisted action envelope as its real blocks', () => {
  const blocks = [{ type: 'text', text: '操作回执' }, { type: 'action_ref', proposalId: '11111111-1111-4111-8111-111111111111' }];
  assert.deepEqual(readStoredCompanionBlocks({ blocks }), blocks);
});

test('reads the old text discriminator without changing the text', () => {
  assert.deepEqual(readStoredCompanionBlocks([{ kind: 'text', text: '第一行\n第二行' }]), [{ type: 'text', text: '第一行\n第二行' }]);
});

test('rejects corrupted blocks instead of silently making an empty response', () => {
  assert.throws(() => readStoredCompanionBlocks([{ type: 'quote', text: '缺少来源标题' }]));
  assert.throws(() => readStoredCompanionBlocks({ blocks: [] }));
});
