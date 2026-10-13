import { useCallback, useEffect, useRef, useState } from 'react'
import { SOURCE_IMAGE_MIME_TYPES } from '@astella/shared/source-image-contracts'
import {
  interrupt,
  retryConversation,
  sendTurn,
  setComposerError,
  setDraft,
  setDraftContext,
  setPendingImage,
  transcribeVoice,
  useCompanion,
} from '../state/companion.ts'
import { useNotes } from '../state/notes.ts'
import { Icon } from '../app/icons.tsx'
import { startMobileRecording, type MobileRecording } from './audio-capture.ts'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * 输入区把照片、语音、文字收在一条路径里：语音先成为可编辑文字，确认后才发送。
 * 录音只由用户点麦克风触发；识别走服务端 MiMo，浏览器不会直连供应商。
 */
export function ChatComposer() {
  const companion = useCompanion()
  const notes = useNotes()
  const field = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const recordingRef = useRef<MobileRecording | null>(null)
  const recordingConversationRef = useRef<string | null>(null)
  const currentConversationRef = useRef(companion.conversationId)
  currentConversationRef.current = companion.conversationId
  const observedConversationRef = useRef(companion.conversationId)
  const recordingAttemptRef = useRef(0)
  const mountedRef = useRef(true)
  const finishingRecording = useRef(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [startingRecording, setStartingRecording] = useState(false)
  const [preparingAudio, setPreparingAudio] = useState(false)
  const [recordingMs, setRecordingMs] = useState(0)
  const running = companion.turn !== null && !companion.turn.initiative
  const busy = running || companion.uploadingImage
  const canSend = companion.conversationId !== null
    && companion.historyReady
    && companion.draft.trim().length > 0
    && !busy
    && !companion.uploadingImage
    && !companion.transcribingVoice
    && !recording
    && !preparingAudio
  const noteContext = companion.draftContext?.pageKind === 'note' ? companion.draftContext : null
  const noteContextTitle = noteContext
    ? notes.list.items.find((item) => item.id === noteContext.noteId)?.title || '当前笔记'
    : ''
  const composerFeedback = companion.composerError
    ?? ((!companion.conversationId || companion.stream === 'open') ? companion.error : null)

  useEffect(() => {
    if (!companion.pendingImage) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(companion.pendingImage)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [companion.pendingImage])

  useEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(92, Math.max(44, node.scrollHeight))}px`
  }, [companion.draft])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      recordingRef.current?.cancel()
      recordingRef.current = null
    }
  }, [])

  useEffect(() => {
    if (observedConversationRef.current === companion.conversationId) return
    observedConversationRef.current = companion.conversationId
    recordingAttemptRef.current += 1
    recordingRef.current?.cancel()
    recordingRef.current = null
    recordingConversationRef.current = null
    setRecording(false)
    setPreparingAudio(false)
    setStartingRecording(false)
  }, [companion.conversationId])

  const finishRecording = useCallback(async () => {
    if (finishingRecording.current) return
    const capture = recordingRef.current
    if (!capture) return
    finishingRecording.current = true
    recordingRef.current = null
    setRecording(false)
    setPreparingAudio(true)
    try {
      const wav = await capture.stop()
      const expectedConversationId = recordingConversationRef.current
      recordingConversationRef.current = null
      if (!expectedConversationId || currentConversationRef.current !== expectedConversationId) {
        setComposerError('会话已切换，这段录音没有发送。')
        return
      }
      await transcribeVoice(wav.file, wav.durationMs, expectedConversationId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '录音没有处理成功，请重试。'
      setComposerError(message)
    } finally {
      finishingRecording.current = false
      setPreparingAudio(false)
    }
  }, [])

  useEffect(() => {
    if (!recording || !recordingRef.current) return
    const timer = window.setInterval(() => {
      const elapsed = recordingRef.current?.elapsedMs() ?? 0
      setRecordingMs(elapsed)
      if (elapsed >= 60_000) void finishRecording()
    }, 150)
    return () => window.clearInterval(timer)
  }, [recording, finishRecording])

  const beginRecording = async () => {
    if (startingRecording || recording || companion.transcribingVoice || !companion.conversationId || !companion.historyReady) return
    const conversationId = companion.conversationId
    const attempt = ++recordingAttemptRef.current
    setStartingRecording(true)
    setComposerError('')
    try {
      const capture = await startMobileRecording()
      if (
        !mountedRef.current
        || attempt !== recordingAttemptRef.current
        || document.visibilityState !== 'visible'
        || currentConversationRef.current !== conversationId
      ) {
        capture.cancel()
        return
      }
      recordingRef.current = capture
      recordingConversationRef.current = conversationId
      setRecordingMs(0)
      setRecording(true)
    } catch (error) {
      if (!mountedRef.current || attempt !== recordingAttemptRef.current) return
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
      const unavailable = error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError')
      const occupied = error instanceof DOMException && (error.name === 'NotReadableError' || error.name === 'TrackStartError')
      setComposerError(
        denied ? '麦克风权限未开启。允许后再点一次麦克风即可录音。'
          : unavailable ? '没有找到可用麦克风。连接麦克风后再试，或改用文字。'
            : occupied ? '麦克风现在无法使用，可能正被其他应用占用。释放后再试，或改用文字。'
              : error instanceof Error ? error.message : '无法开始录音，请重试。',
      )
    } finally {
      if (mountedRef.current && attempt === recordingAttemptRef.current) setStartingRecording(false)
    }
  }

  const cancelRecording = useCallback(() => {
    recordingAttemptRef.current += 1
    recordingRef.current?.cancel()
    recordingRef.current = null
    recordingConversationRef.current = null
    setRecording(false)
    setStartingRecording(false)
    setRecordingMs(0)
  }, [])

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState === 'visible' || (!recording && !startingRecording)) return
      cancelRecording()
      setComposerError('切到后台后，这段录音已取消。')
    }
    document.addEventListener('visibilitychange', stopWhenHidden)
    return () => document.removeEventListener('visibilitychange', stopWhenHidden)
  }, [cancelRecording, recording, startingRecording])

  const canRetry = companion.capability !== 'off' && !companion.conversationId

  return (
    <div className="composer-tray glass">
      {noteContext && (
        <div className="composer-context" role="status">
          <Icon name="book-open" />
          <span>
            <strong>{noteContextTitle}</strong>
            <small>{noteContext.noteVersionId ? '本轮会按你刚读的版本回答' : '本轮会围绕这篇笔记回答'}</small>
          </span>
          <button type="button" onClick={() => setDraftContext(null)} aria-label="移除本轮笔记引用">移除</button>
        </div>
      )}
      {companion.pendingImage && (
        <div className="composer-attachment" aria-label="待发送照片">
          {previewUrl
            ? <img className="composer-attachment-thumb" src={previewUrl} alt="照片预览" />
            : <span className="composer-attachment-thumb placeholder"><Icon name="image" /></span>}
          <span className="composer-attachment-copy">
            <strong>{companion.pendingImage.name || '手机照片'}</strong>
            <small>{companion.uploadingImage ? '正在上传并递给伴星…' : companion.pendingImageBlock ? '照片已准备好，发送失败时可直接重试' : companion.draft.trim() ? `${formatBytes(companion.pendingImage.size)} · 发送时上传` : `先写一句问题，再一起发送 · ${formatBytes(companion.pendingImage.size)}`}</small>
          </span>
          <button
            type="button"
            className="icon-button composer-attachment-remove"
            disabled={companion.uploadingImage}
            onClick={() => setPendingImage(null)}
            aria-label="移除待发送照片"
          ><Icon name="x" /></button>
        </div>
      )}
      {companion.pendingVoice && (
        <p className="voice-draft-label">
          <Icon name="mic" />
          {companion.draft.trim() === companion.pendingVoice.transcript ? 'MiMo 识别完成 · 可编辑后发送' : '文字已编辑 · 将按文字消息发送'}
        </p>
      )}
      {companion.transcribingVoice || preparingAudio ? (
        <p className="composer-feedback" role="status">{preparingAudio ? '正在整理录音…' : '正在交给小米 MiMo 识别…'}</p>
      ) : null}
      {running && companion.draft.trim() && (
        <p className="composer-turn-hint" role="status">她正在回复；这段文字会留在输入框，停止当前回复后再发送。</p>
      )}
      {companion.conversationId && companion.stream !== 'open' && (
        <div className="composer-connection" role="status">
          <span>{companion.error ?? (companion.stream === 'connecting' ? '正在连接伴星…' : companion.stream === 'retrying' ? '连接中断，正在恢复…' : '对话连接已关闭。')}</span>
          {companion.stream !== 'connecting' && <button type="button" onClick={() => void retryConversation()}>重新连接</button>}
        </div>
      )}
      {composerFeedback && (
        <div className="composer-feedback-row" role="status">
          <p className="composer-feedback">{composerFeedback}</p>
          {canRetry && <button type="button" className="composer-retry" onClick={() => void retryConversation()}>重新连接</button>}
        </div>
      )}
      <input
        ref={filePicker}
        className="visually-hidden"
        type="file"
        accept={SOURCE_IMAGE_MIME_TYPES.join(',')}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file) return
          if (!SOURCE_IMAGE_MIME_TYPES.includes(file.type as typeof SOURCE_IMAGE_MIME_TYPES[number])) {
            setComposerError('暂不支持这种图片格式，请选 JPEG、PNG、GIF 或 WebP。')
            return
          }
          if (file.size > MAX_IMAGE_BYTES) {
            setComposerError('图片超过 10 MB，请压缩后再选。')
            return
          }
          setPendingImage(file)
        }}
      />
      <form
        className={`composer${recording ? ' recording' : ''}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) void sendTurn(companion.draft)
        }}
      >
        <button
          type="button"
          className={`icon-button attach-image${companion.pendingImage ? ' selected' : ''}`}
          disabled={!companion.conversationId || !companion.historyReady || companion.uploadingImage || recording || preparingAudio}
          onClick={() => filePicker.current?.click()}
          aria-label="拍照或从相册选图"
          title="拍照或从相册选图"
        ><Icon name="image" /></button>
        {recording ? (
          <div className="recording-controls" role="status" aria-live="polite">
            <span className="recording-pulse" aria-hidden="true" />
            <span className="recording-copy"><strong>正在录音</strong><small>{formatTime(recordingMs)} · 最长 60 秒</small></span>
            <button type="button" className="recording-cancel" onClick={cancelRecording}>取消</button>
            <button type="button" className="recording-finish" onClick={() => void finishRecording()}>完成</button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="icon-button record-voice"
              disabled={!companion.conversationId || !companion.historyReady || startingRecording || companion.transcribingVoice || companion.uploadingImage || preparingAudio}
              onClick={() => void beginRecording()}
              aria-label="录一段语音"
              title="录音后交给小米 MiMo 转成文字"
            ><Icon name={startingRecording ? 'history' : 'mic'} /></button>
            <label className="visually-hidden" htmlFor="chat-input">想对伴星说的话</label>
            <textarea
              id="chat-input"
              rows={1}
              placeholder={composerPlaceholder(companion)}
              value={companion.draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && canSend) {
                  event.preventDefault()
                  void sendTurn(companion.draft)
                }
              }}
            />
            {running ? (
              <button type="button" className="icon-button send stop" disabled={!companion.turn?.runId} onClick={() => void interrupt()} aria-label="让她停下" title="停止当前回复">
                <Icon name="x" />
              </button>
            ) : (
              <button type="submit" className="icon-button send" disabled={!canSend} aria-label="发送消息">
                <Icon name="send" />
              </button>
            )}
          </>
        )}
      </form>
    </div>
  )
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1_000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
}

function composerPlaceholder(companion: ReturnType<typeof useCompanion>): string {
  if (companion.capability === 'off') return '这台服务端没开对话'
  if (!companion.conversationId) return companion.error ? '连接暂不可用' : '正在接上书房…'
  if (!companion.historyReady) return '正在同步对话…'
  return companion.pendingImage ? '写一句话，再把照片一起发给伴星…' : '说点什么…'
}

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
