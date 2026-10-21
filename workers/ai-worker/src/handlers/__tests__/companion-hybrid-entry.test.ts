import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AIProvider } from '../../lib/ai-provider.ts';
import { buildCompanionHybridRequest, runCompanionHybridEntry } from '../turn/companion-hybrid-entry.ts';
import { CompanionOutputTimeoutError } from '../agent/companion-output-watchdog.ts';

const reply = '今天累了就先慢下来吧，你愿意说说发生了什么，我就在这里陪你听着。';
test('explicit separate messages hand off without a model preamble', async () => {
  const result = await runCompanionHybridEntry({ provider: {} as AIProvider, turnPolicy: '',
    messages: [{ role: 'user', content: '分两条跟我说，第一条只问好，第二条问我今天想做什么。' }],
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
  assert.equal(result.facts.decision, 'task'); assert.equal(result.facts.basis, 'utterances'); assert.equal(result.facts.requestedModelCalls, 0);
});
test('the first hybrid generation receives the same explicit length rules as final validation', () => {
  const request = buildCompanionHybridRequest({ provider: {} as AIProvider, turnPolicy: '',
    messages: [{ role: 'user', content: '写一个约400字的完整童话故事。' }] });
  assert.match(request.systemPrompt, /340–460 字/);
  assert.match(request.systemPrompt, /标题与标点不能充当正文字数/);
});
function provider(chunks: string[], calls: unknown[] = [], ending?: () => Promise<void>, reasoning?: string): AIProvider {
  return { id: 'mock', modelId: 'mock', chatCompletionStreamToolCalls: true,
    chatCompletionStream: async (_messages: unknown, _options: unknown, _signal: AbortSignal, delta: (text: string) => void) => {
      if (reasoning) (_options as { onReasoningDelta?: (text: string) => void }).onReasoningDelta?.(reasoning);
      for (const chunk of chunks) { delta(chunk); await new Promise(resolve => setImmediate(resolve)); }
      await ending?.();
      return { content: chunks.join(''), toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'stop' };
    },
  } as unknown as AIProvider;
}
function run(raw: AIProvider, delta?: (text: string) => Promise<boolean>) {
  return runCompanionHybridEntry({ provider: raw, turnPolicy: '自然陪伴用户。', messages: [{ role: 'user', content: '今天有点累。' }],
    signal: new AbortController().signal, deadlineAt: Date.now() + 2000, onProviderDelta: delta });
}
test('hybrid streams the same reply before completion, without exposing its JSON envelope', async () => {
  const chunks: string[] = []; let finished = false;
  const raw = provider(['{"rep', 'ly":"' + reply.slice(0, 27), reply.slice(27) + '"}'], [], async () => {
    assert.equal(chunks.join(''), reply); finished = true;
  });
  const result = await run(raw, async text => { assert.equal(finished, false); chunks.push(text); return true; });
  assert.equal(result.facts.decision, 'reply'); assert.equal(result.prefetched?.emitted, true);
  assert.equal(result.facts.requestedModelCalls, 1);
  assert.equal(result.prefetched?.result.content, reply); assert.equal(chunks.join(''), reply);
});
test('short valid replies retain the existing hold policy for final publication', async () => {
  const chunks: string[] = [];
  const result = await run(provider(['{"reply":"早安呀。"}']), async text => { chunks.push(text); return true; });
  assert.equal(result.facts.decision, 'reply'); assert.equal(result.prefetched?.emitted, false);
  assert.equal(result.prefetched?.result.content, '早安呀。'); assert.deepEqual(chunks, []);
});
test('hybrid forwards actual provider progress separately from the reply body', async () => {
  const progress: string[] = [];
  const result = await runCompanionHybridEntry({ provider: provider(['{"reply":"早安呀。"}'], [], undefined, '正在整理故事的结尾'),
    turnPolicy: '', messages: [{ role: 'user', content: '接着讲。' }], signal: new AbortController().signal,
    deadlineAt: Date.now() + 2000, onReasoningDelta: text => progress.push(text) });
  assert.deepEqual(progress, ['正在整理故事的结尾']);
  assert.equal(result.prefetched?.result.content, '早安呀。');
});
test('structured handoff stays private and never executes business tools', async () => {
  const chunks: string[] = [];
  const result = await run(provider(['{"task":true}']), async text => { chunks.push(text); return true; });
  assert.equal(result.facts.decision, 'task'); assert.equal(result.prefetched, null); assert.deepEqual(chunks, []);
});
test('unoffered tools and invalid handoff arguments fall back without publication', async () => {
  for (const call of [{ id: 'bad', name: 'companion_edit_note', arguments: {} }, { id: 'bad', name: 'companion_deepen', arguments: { overwrite: true } }]) {
    const result = await run(provider([], [call])); assert.equal(result.facts.decision, 'fallback');
  }
});
test('unframed prose stays private and returns to the classified path', async () => {
  let deltas = 0;
  const result = await run(provider(['没读过笔记也不能编一个得分。']), async () => { deltas++; return true; });
  assert.equal(result.facts.decision, 'fallback'); assert.equal(deltas, 0);
});
test('a transport failure before publication can fall back, and a failure after publication cannot replay', async () => {
  const fail = async () => { throw new Error('transport stopped'); };
  assert.equal((await run(provider([], [], fail))).facts.decision, 'fallback');
  await assert.rejects(run(provider([JSON.stringify({ reply })], [], fail), async () => true), /transport stopped/);
});
test('cancellation by the publication pipeline stops the provider and does not hand off', async () => {
  await assert.rejects(run(provider([JSON.stringify({ reply })]), async () => false), /stream stopped/);
});
test('a late native handoff cannot turn an already published reply into a second answer', async () => {
  await assert.rejects(run(provider([JSON.stringify({ reply })], [{ id: 'late', name: 'companion_deepen', arguments: {} }]), async () => true), /after publishing/);
});
test('providers without streaming skip the hybrid request', async () => {
  const raw = {} as AIProvider;
  assert.equal((await run(raw)).facts.decision, 'fallback');
});
test('a hybrid first-output timeout uses the declared fitting fallback exactly once before publication', async () => {
  let primaryCalls = 0, recoveries = 0;
  const raw = provider([], [], async () => { primaryCalls++; throw new CompanionOutputTimeoutError('provider_first_output_timeout'); });
  const fallback = provider([JSON.stringify({ reply })]);
  const chunks: string[] = [];
  const result = await runCompanionHybridEntry({ provider: raw, fallbackProvider: fallback, turnPolicy: '',
    messages: [{ role: 'user', content: '今天有点累。' }], signal: new AbortController().signal, deadlineAt: Date.now() + 2000,
    onRecovery: async () => { recoveries++; }, onProviderDelta: async delta => { chunks.push(delta); return true; } });
  assert.equal(primaryCalls, 1); assert.equal(recoveries, 1); assert.equal(result.facts.usedFallback, true);
  assert.equal(result.facts.requestedModelCalls, 2); assert.equal(result.prefetched!.result.content, reply); assert.equal(chunks.join(''), reply);
});
test('hybrid recovery preserves post-publication failure, cancellation and an incompatible fallback boundary', async () => {
  let fallbackCalls = 0;
  const fallback = provider([], [], async () => { fallbackCalls++; });
  const failure = async () => { throw new CompanionOutputTimeoutError('provider_idle_timeout'); };
  const invoke = (raw: AIProvider, onProviderDelta?: (text: string) => Promise<boolean>, alternate = fallback) => runCompanionHybridEntry({
    provider: raw, fallbackProvider: alternate, turnPolicy: '', messages: [{ role: 'user', content: '今天有点累。' }],
    signal: new AbortController().signal, deadlineAt: Date.now() + 2000, onProviderDelta });
  await assert.rejects(invoke(provider([JSON.stringify({ reply })], [], failure), async () => true), CompanionOutputTimeoutError);
  const tooSmall = { ...fallback, getCapabilities: () => ({ contextWindowTokens: 40, outputLimitEnforced: true }), resolveOutputTokenLimit: () => 20 } as unknown as AIProvider;
  await assert.rejects(invoke(provider([], [], failure), undefined, tooSmall), CompanionOutputTimeoutError);
  assert.equal(fallbackCalls, 0);
});
test('expression-only replies cannot be accepted as conversational content', async () => {
  let deltas = 0;
  assert.equal((await run(provider(['{"reply":"[neutral]"}']), async () => { deltas++; return true; })).facts.decision, 'fallback');
  assert.equal(deltas, 0);
});
test('escaped quotes, newlines and emoji retain exactly the same body', async () => {
  const text = '你说“今天累了”，那就坐会儿。\n这里有一句带"引号"的话，还有一个小小的🙂。';
  const wire = JSON.stringify({ reply: text });
  const result = await run(provider([...wire]));
  assert.equal(result.facts.decision, 'reply');assert.equal(result.prefetched?.result.content, text);
});
test('an explicit dialect request uses the existing voice route without a fast model request', async () => {
  const raw = { chatCompletionStream: async () => { throw new Error('voice settings must not use the casual stream'); } } as unknown as AIProvider;
  const result = await runCompanionHybridEntry({ provider: raw, turnPolicy: '', messages: [{ role: 'user', content: '这句用粤语说，慢一点。' }],
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
  assert.equal(result.facts.decision, 'task'); assert.equal(result.facts.basis, 'voice-context');assert.equal(result.facts.requestedModelCalls, 0);
});
test('multiple named dialects retain the task route that separates one-turn and durable settings', async () => {
  const result = await runCompanionHybridEntry({ provider: {} as AIProvider, turnPolicy: '',
    messages: [{ role: 'user', content: '以后默认河南话，但这一句用四川话。' }], signal: new AbortController().signal, deadlineAt: Date.now()+1000 });
  assert.equal(result.facts.basis, 'voice-context');
});
test('Mandarin resets and topic-only voice mentions conservatively keep the existing voice path', async () => {
  for (const content of ['以后都用普通话，别固定方言了。', '四川话听着很亲切，我没有要改设置。']) {
    const result = await runCompanionHybridEntry({ provider: {} as AIProvider, turnPolicy: '',
      messages: [{ role: 'user', content }], signal: new AbortController().signal, deadlineAt: Date.now()+1000 });
    assert.equal(result.facts.basis, 'voice-context');
  }
});

function runWith(messages: Array<{ role: 'user' | 'assistant'; content: string }>, raw: AIProvider) {
  return runCompanionHybridEntry({ provider: raw, turnPolicy: '', messages,
    signal: new AbortController().signal, deadlineAt: Date.now() + 2000 });
}
const uncallable = { chatCompletionStream: async () => { throw new Error('awaiting-offer turns must not use the casual stream'); } } as unknown as AIProvider;

test('a short reply that accepts her pending question hands off instead of chatting', async () => {
  const result = await runWith([
    { role: 'assistant', content: '要不要我把这段整理成卡片？' },
    { role: 'user', content: '好啊' },
  ], uncallable);
  assert.equal(result.facts.decision, 'task');
  assert.equal(result.facts.basis, 'pending-offer');
  assert.equal(result.facts.requestedModelCalls, 0);
  assert.equal(result.prefetched, null);
});

test('an offer tail without a question mark still hands off', async () => {
  const result = await runWith([
    { role: 'assistant', content: '这些先留着，需要我展开就说一声' },
    { role: 'user', content: '要，展开吧' },
  ], uncallable);
  assert.equal(result.facts.basis, 'pending-offer');
  assert.equal(result.facts.requestedModelCalls, 0);
});

test('a long reply after a pending offer stays with the fast path', async () => {
  const result = await runWith([
    { role: 'assistant', content: '要不要我把这段整理成卡片？' },
    { role: 'user', content: '我今天想把昨天没弄完的那部分先放一放，你陪我聊会儿别的。' },
  ], provider([JSON.stringify({ reply })], []));
  assert.equal(result.facts.decision, 'reply');
  assert.equal(result.facts.basis, undefined);
  assert.equal(result.facts.requestedModelCalls, 1);
});

test('a short reply with no pending offer keeps the fast path', async () => {
  const result = await runWith([
    { role: 'assistant', content: '今天辛苦啦。' },
    { role: 'user', content: '谢谢' },
  ], provider([JSON.stringify({ reply })], []));
  assert.equal(result.facts.decision, 'reply');
  assert.equal(result.facts.requestedModelCalls, 1);
});

test('a short new question after her question is not mistaken for accepting the offer', async () => {
  const result = await runWith([
    { role: 'assistant', content: '今天是累在身上，还是脑子转不动那种？' },
    { role: 'user', content: '我今天一共学了多久了？' },
  ], provider([JSON.stringify({ reply })], []));
  assert.equal(result.facts.decision, 'reply');
  assert.equal(result.facts.basis, undefined);
  assert.equal(result.facts.requestedModelCalls, 1);
});

test('a new greeting or name after a casual question streams without a classifier handoff', async () => {
  for (const content of ['小猪', '早上好', '你好呀', 'Hello']) {
    const result = await runWith([
      { role: 'assistant', content: '回来啦，今天过得怎么样？' },
      { role: 'user', content },
    ], provider([JSON.stringify({ reply })]));
    assert.equal(result.facts.decision, 'reply', content);
    assert.equal(result.facts.requestedModelCalls, 1, content);
  }
});

test('offer acceptances, refusals and object references retain the task handoff', async () => {
  for (const content of ['好啊', '不用了', '可以', '就这样', '第二个', '两张', 'yes']) {
    const result = await runWith([
      { role: 'assistant', content: '要不要我把这段整理成卡片？' },
      { role: 'user', content },
    ], uncallable);
    assert.equal(result.facts.basis, 'pending-offer', content);
    assert.equal(result.facts.requestedModelCalls, 0, content);
  }
});
