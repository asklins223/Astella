import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentVoiceStyleDecisionV1Schema } from '@astella/shared/agent-contracts';
import { validateCompanionAgentToolArguments, canUseCompanionAgentTool, getCompanionAgentTool } from '@astella/shared';
import { companionDirectInterpretation, createCompanionDirectControls, resolveCompanionEntryMode, settleCompanionAttention } from '../turn/companion-entry-mode.ts';
const fresh = () => companionDirectInterpretation('a'.repeat(64));
test('entry mode is explicit and the unclassified placeholder never invents a tool decision', () => {
    assert.equal(resolveCompanionEntryMode(undefined), 'direct_fast');
    // Unknown or retired values fall back to the fast direct entry instead of
    // silently re-enabling a classifier.
    assert.equal(resolveCompanionEntryMode('unknown'), 'direct_fast');
    assert.equal(resolveCompanionEntryMode('hybrid'), 'direct_fast');
    assert.equal(resolveCompanionEntryMode('classified'), 'direct_fast');
    assert.equal(resolveCompanionEntryMode('direct_thinking'), 'direct_thinking');
    assert.equal(resolveCompanionEntryMode('direct_fast'), 'direct_fast');
    const a = fresh();
    assert.equal(a.toolUse, 'uncertain');
    assert.deepEqual(a.ambiguities, []);
});
test('the attention record settles without invoking a classifier and persists the voice callback before returning', async () => {
    let written = false;
    const attention = await settleCompanionAttention({ requestHash: 'a'.repeat(64), cached: null,
        args: { onTurnInterpretation: async () => { written = true; return 'not_requested'; } } as never });
    assert.equal(attention.toolUse, 'uncertain');
    assert.equal(attention.voicePreferenceWrite, 'not_requested');
    assert.equal(written, true);
});
test('the fast entry never forces reasoning off; the model decides per turn', async () => {
    // Forcing `none` on the fast entry made "分两条" come back as one prose
    // message 12/12 times on the production prompt, while the model's own
    // default answered with two sent messages 3/3 and still skipped reasoning
    // on small talk (measured 2026-10-28). Deepening remains an explicit raise.
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention: fresh(), userText: '请严谨推导。' });
    assert.equal(c.disableThinking(), false);
    const image = createCompanionDirectControls({ mode: 'direct_fast', attention: fresh(), userText: '', imageTurn: true });
    assert.equal(image.disableThinking(), true, 'a direct image turn uses the vision fast path');
    assert.equal((await c.apply('companion_deepen', {}))?.ok, true);
    assert.equal(c.deepened(), true);
    assert.equal(c.disableThinking(), false);
    const restored = createCompanionDirectControls({ mode: 'direct_fast', attention: fresh(), userText: '同一轮', deepened: c.deepened() });
    assert.equal(restored.disableThinking(), false);
});
test('temporary voice control is applied before speech and leaves the persistent preference unchanged', async () => {
    const attention = fresh();
    let seen: unknown;
    const c = createCompanionDirectControls({ mode: 'direct_thinking', attention, userText: '这句用四川话，语速慢一点。', onInterpretation: a => { seen = a.voiceStyle; return 'not_requested'; } });
    const args = { sourceQuote: '这句用四川话', voiceStyle: agentVoiceStyleDecisionV1Schema.parse({ decision: 'apply', instruction: '请用四川话，语速稍慢。', persistentPreference: { action: 'keep', dialect: null } }) };
    assert.equal(validateCompanionAgentToolArguments('companion_configure_turn', args).success, true);
    assert.equal((await c.apply('companion_configure_turn', args))?.ok, true);
    assert.deepEqual(seen, args.voiceStyle);
    assert.equal(attention.voiceStyle.persistentPreference.action, 'keep');
});
test('durable and one-turn dialect settings remain independent and failed writes have no success claim', async () => {
    const attention = fresh();
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '以后默认河南话，这次用四川话。', onInterpretation: () => 'failed' });
    const args = { sourceQuote: '以后默认河南话，这次用四川话', voiceStyle: { decision: 'apply', instruction: '请用四川话。', persistentPreference: { action: 'set', dialect: '河南话' } } };
    assert.equal((await c.apply('companion_configure_turn', args))?.ok, false);
    assert.equal(attention.voicePreferenceWrite, 'failed');
    assert.equal(attention.voiceStyle.instruction, '请用四川话。');
});
test('stale quoted instructions cannot change the voice or forbid a new timed request', async () => {
    const attention = fresh();
    let writes = 0;
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '五分钟后提醒我喝水。', onInterpretation: () => { writes++; } });
    assert.equal((await c.apply('companion_configure_turn', { sourceQuote: '不要定时', forbidTimeBasedWakeups: true }))?.ok, false);
    assert.equal(attention.executionConstraints, undefined);
    assert.equal(writes, 0);
});
test('a current event-only request binds the actual execution constraint', async () => {
    const attention = fresh();
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '只按事件触发，不要定时。' });
    assert.equal((await c.apply('companion_configure_turn', { sourceQuote: '不要定时', forbidTimeBasedWakeups: true }))?.ok, true);
    assert.equal(attention.executionConstraints?.timeBasedWakeups, 'forbid');
});
test('account voice controls retain existing preference semantics without authorizing note edits', () => {
    const voice = getCompanionAgentTool('companion_configure_turn')!;
    assert.deepEqual(canUseCompanionAgentTool('read_only', voice), { allowed: true, requiresConfirmation: false });
    const edit = getCompanionAgentTool('companion_notes_write')!;
    assert.equal(canUseCompanionAgentTool('read_only', edit, { action: 'edit', operation: 'replace_blocks' }).requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool('guided', edit, { action: 'edit', operation: 'delete_blocks' }).requiresConfirmation, true);
});
