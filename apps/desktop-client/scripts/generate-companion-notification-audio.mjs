import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

// Developer asset generation only. Packaged clients play these clips locally.
const output = resolve(import.meta.dirname, '../src/renderer/public/assets/companion-notifications')
const origin = process.env.EDGE_TTS_ASSET_URL || 'http://127.0.0.1:8088'
const voice = 'zh-CN-XiaoxiaoNeural'
const lines = {
  'voice-model-needed': '这台设备还没有语音识别模型。我帮你打开设置了，选择下载，装好后我会提醒你。',
  'voice-model-ready': '语音识别模型已经装好了。现在点语音按钮，就可以和我说话啦。',
  'voice-model-failed': '语音识别模型这次没下载成功。你可以在设置里重试，其他功能照常使用。',
  'task-ready': '你交给我的后台任务完成了，结果已经保存。方便的时候可以打开看看。',
  'task-failed': '后台任务这次没有完成。可以打开原来的页面查看原因，再试一次。',
  'review-due': '今天有学过的知识到了复习时间。方便的时候，和我一起温习一下吧。',
}
await mkdir(output, { recursive: true })
const manifest = { generator: 'edge-tts', voice, rate: '+0%', clips: {} }
for (const [name, text] of Object.entries(lines)) {
  const response = await fetch(new URL('/v1/audio/speech', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edge-TTS-Token': process.env.EDGE_TTS_AUTH_TOKEN || '' },
    body: JSON.stringify({ model: 'edge-tts', input: text, voice, rate: '+0%' }), signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`${name}: TTS returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1_000) throw new Error(`${name}: empty or truncated audio`)
  await writeFile(resolve(output, `${name}.mp3`), bytes)
  manifest.clips[name] = { text, file: `${name}.mp3`, bytes: bytes.length }
  console.log(`${name}: ${bytes.length} bytes`)
}
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
