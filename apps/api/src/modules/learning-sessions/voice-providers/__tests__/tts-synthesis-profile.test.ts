import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION } from '@astella/shared/tts-voice-catalog';
import { resolveTtsSynthesisProfile } from '../tts-synthesis-profile.ts';
import { synthesizeTtsBytes } from '../tts-engine.ts';
import { resolveTtsSelection, type StoredVoicePreference } from '../tts-preference.ts';
import type { TtsEngineConfig } from '../tts-config.ts';

const config: TtsEngineConfig = {
  engine: 'qwen',
  qwen: { workspaceId: 'fixture', model: 'qwen-audio-3.1-tts-flash', voice: 'longhua_v3.1',
    format: 'mp3', sampleRate: 22050, instruction: '声音柔和，语速自然' },
  edge: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
};
const cases: Array<{ name: string; stored: StoredVoicePreference | null; turn?: string; voice: string; instruction: string }> = [
  { name: '账号音色与基础描述不能在冷流式中丢失',
    stored: { engine: 'qwen', voice: 'longanlingxi_v3.1', instruction: '声音低柔，语速偏慢' },
    turn: '语气轻松', voice: 'longanlingxi_v3.1', instruction: '保持基础音色：声音低柔，语速偏慢。本轮表达要求：语气轻松' },
  { name: '没有账号偏好时场景表达仍保留配置基础音色', stored: null, turn: '自然地讲述',
    voice: 'longhua_v3.1', instruction: '保持基础音色：声音柔和，语速自然。本轮表达要求：自然地讲述' },
  { name: '没有本轮语气时沿用账号声音描述',
    stored: { engine: 'qwen', voice: 'longanlingxi_v3.1', instruction: '温柔自然' },
    voice: 'longanlingxi_v3.1', instruction: '温柔自然' },
  { name: '长期方言对直接流式与预热同样生效',
    stored: { engine: 'qwen', voice: 'longhua_v3.1', dialect: '河南话', instruction: '声音温柔，语速偏慢' },
    turn: '轻松自然', voice: 'longanhuan_v3.1', instruction: '请用河南话表达。声音温柔，语速偏慢，轻松自然' },
  { name: '本轮普通话覆盖长期方言',
    stored: { engine: 'qwen', voice: 'longhua_v3.1', dialect: '河南话', instruction: '声音温柔' },
    turn: QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION, voice: 'longhua_v3.1',
    instruction: `保持基础音色：声音温柔。本轮表达要求：${QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION}` },
];

for (const fixture of cases) {
  test(fixture.name, async () => {
    const selection = resolveTtsSelection(fixture.stored, config);
    const profile = resolveTtsSynthesisProfile(config, selection, fixture.turn);
    assert.equal(profile.qwenVoice, fixture.voice);
    assert.equal(profile.instruction, fixture.instruction);
    let captured: { voice: string; instruction?: string } | undefined;
    await synthesizeTtsBytes({
      text: '星星和轻轻吹过的风。', queueKey: 'profile-test', edgeVoice: config.edge.voice,
      selection, instruction: fixture.turn,
      scope: { workspaceId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000002', currentActiveTransaction: () => undefined },
      deps: {
        loadConfig: () => config,
        governance: { settings: async () => ({ requiresConsent: false, consentAt: new Date(), consentVersion: 'v1',
          dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: false } }),
          audit: async () => undefined },
        qwenSynthesize: async (_key, _text, options) => {
          captured = { voice: options.voice, instruction: options.instruction };
          return { contentType: 'audio/mpeg', stream: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
          }) };
        },
        edgeSynthesize: async () => { throw new Error('unexpected fallback'); },
      },
    });
    assert.deepEqual(captured, { voice: profile.qwenVoice, instruction: profile.instruction },
      '用于冷流式的参数必须等于预热/整段真正交给合成器的参数');
  });
}

test('账号选择 Edge 时，冷流式不能因全局默认千问而切回千问', () => {
  const selection = resolveTtsSelection({ engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' }, config);
  assert.equal(resolveTtsSynthesisProfile(config, selection).engine, 'edge');
});
