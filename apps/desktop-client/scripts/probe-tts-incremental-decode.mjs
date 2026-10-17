/**
 * 可行性探针：Chromium 的 `decodeAudioData` 能不能**按 MP3 帧边界分段解码**。
 *
 * 为什么必须先验这条：增量播放的整条路都压在这一点上。如果 Chromium 只认
 * "带 ID3 头的完整文件"，那就只能退回 MSE + `<audio>`，而 MSE 会丢掉现有的
 * 播放进度与口型振幅那条通道（`createMediaElementSource` 能补回来，但要另写一层）。
 *
 * 判据：
 *   1. 把 `/voice/tts/stream` 的字节按帧切开，逐段 `decodeAudioData` 是否成功；
 *   2. 首段可解码的时刻比"收齐整段"早多少；
 *   3. 分段解码出来的时长累加，是否等于整段解码的时长（否则会漏帧）。
 *
 * 跑法（隔离栈 api 在 4400）：
 *   node scripts/probe-tts-incremental-decode.mjs
 */
import { chromium } from '@playwright/test'

const BASE = process.env.BENCH_BASE ?? 'http://127.0.0.1:4400'
const EMAIL = process.env.BENCH_EMAIL ?? 'owner@astella.local'
const PASSWORD = process.env.BENCH_PASSWORD ?? 'astella_owner'
const TEXT = process.env.PROBE_TEXT ?? '机会成本是你为了得到一样东西而放弃的、价值最高的那个替代选项。'

// 这台机器的 Playwright 缓存里是 chromium-1194；新版期望的版本号对不上，
// 直接指到缓存里那个可执行文件（走查老坑，见 dev-stack-live-probing）。
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
})
const page = await browser.newPage()

try {
  // 登录与拉流都在 Node 侧做：页面是 about:blank，直接 fetch 会被跨域挡住。
  const loginResponse = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!loginResponse.ok) throw new Error(`login ${loginResponse.status}`)
  const { token } = await loginResponse.json()

  const segmentId = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  const started = Date.now()
  const streamResponse = await fetch(BASE + '/voice/tts/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ version: 1, runId: crypto.randomUUID(), generation: 1,
      ordinal: 1, segmentId, text: TEXT }),
  })
  if (!streamResponse.ok) throw new Error(`stream ${streamResponse.status}: ${await streamResponse.text()}`)
  const chunks = []
  const reader = streamResponse.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push({ at: Date.now() - started, bytes: Array.from(value) })
  }
  const streamed = { chunks, contentType: streamResponse.headers.get('content-type') }

  const totalBytes = streamed.chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0)
  console.log(`流式：${streamed.chunks.length} 块 / ${totalBytes}B / ${streamed.contentType}`)
  console.log(`首块 ${streamed.chunks[0]?.at}ms，末块 ${streamed.chunks.at(-1)?.at}ms`)

  // 2) 在页面里：整段解码 vs 按帧边界分段解码。
  const result = await page.evaluate(async ({ chunks }) => {
    const context = new OfflineAudioContext(1, 1024, 48000)
    const all = new Uint8Array(chunks.flatMap(chunk => chunk.bytes))
    const concat = new Uint8Array(all.length)
    concat.set(all)

    const BITRATES = {
      // MPEG1 Layer III
      1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
      // MPEG2/2.5 Layer III
      2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    }
    const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

    function frameLength(bytes, offset) {
      if (offset + 4 > bytes.length) return -1
      if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return -1
      const versionBits = (bytes[offset + 1] >> 3) & 0x03   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layerBits = (bytes[offset + 1] >> 1) & 0x03     // 1 = Layer III
      if (layerBits !== 1) return -1
      const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f
      const rateIndex = (bytes[offset + 2] >> 2) & 0x03
      const padding = (bytes[offset + 2] >> 1) & 0x01
      const table = versionBits === 3 ? BITRATES[1] : BITRATES[2]
      const bitrate = table[bitrateIndex] * 1000
      const sampleRate = RATES[versionBits === 3 ? 3 : versionBits === 2 ? 2 : 0]?.[rateIndex]
      if (!bitrate || !sampleRate || rateIndex === 3) return -1
      const length = versionBits === 3
        ? Math.floor((144 * bitrate) / sampleRate) + padding
        : Math.floor((72 * bitrate) / sampleRate) + padding
      return length > 4 ? length : -1
    }

    // 找第一个可识别的帧头（跳过 ID3v2 标签）。
    let start = 0
    if (concat[0] === 0x49 && concat[1] === 0x44 && concat[2] === 0x33) {
      const size = ((concat[6] & 0x7f) << 21) | ((concat[7] & 0x7f) << 14)
        | ((concat[8] & 0x7f) << 7) | (concat[9] & 0x7f)
      start = 10 + size
    }

    // 逐帧扫描，把连续完整的帧攒成"解码单元"（约 8 帧一批，约 0.2 秒音频）。
    const units = []
    let cursor = start
    let batch = []
    let batchBytes = 0
    while (cursor < concat.length) {
      const length = frameLength(concat, cursor)
      if (length < 0) { cursor += 1; continue }
      if (cursor + length > concat.length) break
      batch.push(concat.subarray(cursor, cursor + length))
      batchBytes += length
      cursor += length
      if (batch.length >= 8) {
        units.push(new Uint8Array(batchBytes).map((_, index) => index).constructor.from(batch.reduce(
          (acc, frame) => [...acc, ...frame], [])))
        batch = []
        batchBytes = 0
      }
    }
    if (batch.length > 0) {
      units.push(Uint8Array.from(batch.reduce((acc, frame) => [...acc, ...frame], [])))
    }

    // 整段解码（对照组）
    let whole = null
    try {
      const buffer = await context.decodeAudioData(concat.buffer.slice(0))
      whole = { ok: true, duration: buffer.duration }
    } catch (error) {
      whole = { ok: false, error: String(error).slice(0, 120) }
    }

    // 分段解码
    const pieces = []
    for (const unit of units) {
      try {
        const buffer = await context.decodeAudioData(unit.buffer.slice(0))
        pieces.push({ ok: true, duration: buffer.duration })
      } catch (error) {
        pieces.push({ ok: false, error: String(error).slice(0, 80) })
      }
    }

    return {
      whole,
      units: units.length,
      decoded: pieces.filter(piece => piece.ok).length,
      failed: pieces.filter(piece => !piece.ok).slice(0, 3),
      pieceDuration: pieces.filter(piece => piece.ok).reduce((sum, piece) => sum + piece.duration, 0),
    }
  }, { chunks: streamed.chunks })

  console.log('\n整段解码：', JSON.stringify(result.whole))
  console.log(`分段：${result.units} 段，成功 ${result.decoded}，累计时长 ${result.pieceDuration?.toFixed?.(3)}s`)
  if (result.failed.length) console.log('失败样例：', JSON.stringify(result.failed))
  if (result.whole?.ok) {
    const delta = Math.abs(result.pieceDuration - result.whole.duration)
    console.log(`分段累计 vs 整段：差 ${delta.toFixed(3)}s ${delta < 0.3 ? '（对齐，没有漏帧）' : '（差异大，需检查帧切分）'}`)
  }
} finally {
  await browser.close()
}
