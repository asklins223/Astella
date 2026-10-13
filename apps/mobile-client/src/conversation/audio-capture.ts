export interface CapturedWav {
  file: File
  durationMs: number
}

export interface MobileRecording {
  elapsedMs: () => number
  stop: () => Promise<CapturedWav>
  cancel: () => void
}

const TARGET_SAMPLE_RATE = 16_000
const MAX_DURATION_MS = 60_000

/** Start only from an explicit microphone-button gesture; callers own cancellation. */
export async function startMobileRecording(): Promise<MobileRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('当前浏览器不支持录音，请更新浏览器后重试。')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let recorder: MediaRecorder
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((candidate) => MediaRecorder.isTypeSupported(candidate))
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  } catch {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('录音暂时无法启动，请检查浏览器权限后重试。')
  }

  const chunks: BlobPart[] = []
  const startedAt = performance.now()
  let discarded = false
  let resolved = false
  let resolveRecording!: (blob: Blob) => void
  let rejectRecording!: (error: Error) => void
  const finished = new Promise<Blob>((resolve, reject) => {
    resolveRecording = resolve
    rejectRecording = reject
  })
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop())

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.onerror = () => {
    if (resolved) return
    resolved = true
    stopTracks()
    rejectRecording(new Error('录音中断了，请再试一次。'))
  }
  recorder.onstop = () => {
    stopTracks()
    if (resolved) return
    resolved = true
    if (discarded) {
      resolveRecording(new Blob())
      return
    }
    resolveRecording(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
  }
  try {
    recorder.start(250)
  } catch {
    stopTracks()
    throw new Error('录音暂时无法启动，请检查浏览器权限后重试。')
  }

  let maxTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop()
  }, MAX_DURATION_MS)

  const stop = async (): Promise<CapturedWav> => {
    if (recorder.state === 'recording') recorder.stop()
    const source = await finished
    if (maxTimer) clearTimeout(maxTimer)
    maxTimer = undefined
    const durationMs = Math.min(MAX_DURATION_MS, Math.round(performance.now() - startedAt))
    if (durationMs < 200 || source.size === 0) throw new Error('这段录音太短，没有识别到声音。')
    const wav = await convertToMono16KhzWav(source)
    return { file: new File([wav], 'mobile-voice.wav', { type: 'audio/wav' }), durationMs }
  }

  const cancel = () => {
    discarded = true
    if (maxTimer) clearTimeout(maxTimer)
    maxTimer = undefined
    if (recorder.state === 'recording') recorder.stop()
    else stopTracks()
  }

  return {
    elapsedMs: () => Math.min(MAX_DURATION_MS, performance.now() - startedAt),
    stop,
    cancel,
  }
}

async function convertToMono16KhzWav(source: Blob): Promise<Blob> {
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('当前浏览器无法转换语音格式，请更新浏览器后重试。')
  const context = new AudioContextCtor()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(await source.arrayBuffer())
  } catch {
    throw new Error('录音格式暂不支持，请重新录制后重试。')
  } finally {
    await context.close().catch(() => undefined)
  }

  const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE)
  const input = offline.createBufferSource()
  input.buffer = decoded
  input.connect(offline.destination)
  input.start(0)
  const mono = await offline.startRendering()
  const samples = mono.getChannelData(0)
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}
