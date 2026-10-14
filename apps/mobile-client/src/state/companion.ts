import type { CompanionAgentToolEventV1 } from '@astella/shared/companion-agent-contracts'
import type {
  CompanionPageContextV1,
  CompanionContentBlockV1,
  CompanionStreamEventV1,
  CreateCompanionTurnRequestV1,
  CreateCompanionTurnResponseV1,
  CompanionSelectionV1,
} from '@astella/shared/companion-conversation-contracts'
import { companionApi, uuid, type CompanionMessage, type CompanionRunSnapshot, type CompanionRunSummary, type CompanionTranscription } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { openCompanionRealtime, RealtimeUnavailableError, type CompanionRealtimeState } from '../platform/companion-realtime.ts'
import { handleUnauthorized } from './session.ts'
import { createStore, useStore } from './store.ts'
import { appendRunProcess, emptyRunProcess, mergeRunProcesses, processToolTrace, readProcessTool, restoreRunProcesses,
  upsertProcessTool, type CompanionRunProcess, type ToolTrace } from './companion-process.ts'

export type { CompanionRunProcess, CompanionRunProcessRow, ToolTrace } from './companion-process.ts'

export type ProposalStatus = 'pending' | 'rejected' | 'accepted' | 'executing' | 'succeeded' | 'failed' | 'expired'

export interface ProposalCard {
  proposalId: string
  title: string
  targetSummary: string
  impactSummary: string
  /** 决定要带回这个指纹；没取到快照之前不许按确认。 */
  payloadSha256: string
  status: ProposalStatus
  deciding: boolean
  runId: string | null
}

export interface NoteEditReceipt {
  runId: string | null
  noteId: string
  noteVersionId: string
  operation: string
  summary: string
  at: string
}

export interface LiveTurn {
  runId: string
  generation: number
  initiative?: boolean
  /** A silent consideration becomes visible only when it emits thinking, tools, or speech. */
  visible: boolean
  /** waiting = 还在路上；thinking = 真的开了思考档；acting = 正在动手。三个词不说混。 */
  phase: 'waiting' | 'thinking' | 'acting' | 'streaming'
  statusLabel: string | null
  text: string
  thinkingText: string
  thinkingLastIndex: number
  thinkingGapped: boolean
  /** 增量出现过缝：不猜内容，末尾用长度核对触发整段重读。 */
  gapped: boolean
}

export interface CompanionState {
  /** 服务端没开这一族能力时（404）不藏入口，用掉那一步时说实话。 */
  capability: 'unknown' | 'off' | 'on'
  conversationId: string | null
  /** Initial message/run snapshot has settled; sends stay blocked before this point. */
  historyReady: boolean
  messages: CompanionMessage[]
  /** Recent run outcomes make interrupted turns legible after a refresh. */
  runs: CompanionRunSummary[]
  /** Real process history, keyed by run so refresh and older messages retain their own traces. */
  runProcesses: Record<string, CompanionRunProcess>
  runProcessErrors: Record<string, string>
  olderAvailable: boolean
  loadingHistory: boolean
  turn: LiveTurn | null
  memoryRefs: Array<{ messageId: string; kind: string; content: string }>
  draft: string
  /** A real page reference carried with the next submitted draft (for example, the note being read). */
  draftContext: CompanionPageContextV1 | null
  /** Input, attachment, and send feedback belongs to the composer, not the realtime connection. */
  composerError: string | null
  pendingImage: File | null
  pendingImageBlock: Extract<CompanionContentBlockV1, { type: 'image' }> | null
  uploadingImage: boolean
  pendingVoice: { artifactId: string; transcript: string } | null
  transcribingVoice: boolean
  proposals: ProposalCard[]
  tools: ToolTrace[]
  noteEdits: NoteEditReceipt[]
  stream: CompanionRealtimeState
  error: string | null
}

export const companionStore = createStore<CompanionState>({
  capability: 'unknown',
  conversationId: null,
  historyReady: false,
  messages: [],
  runs: [],
  runProcesses: {},
  runProcessErrors: {},
  olderAvailable: false,
  loadingHistory: false,
  turn: null,
  memoryRefs: [],
  draft: '',
  draftContext: null,
  composerError: null,
  pendingImage: null,
  pendingImageBlock: null,
  uploadingImage: false,
  pendingVoice: null,
  transcribingVoice: false,
  proposals: [],
  tools: [],
  noteEdits: [],
  stream: 'closed',
  error: null,
})

const store = companionStore
const get = store.get.bind(store)
const set = store.set.bind(store)
const INBOX_CONNECT_TIMEOUT_MS = 20_000
const SNAPSHOT_SYNC_TIMEOUT_MS = 20_000

let realtime: ReturnType<typeof openCompanionRealtime> | null = null
let cursor = 0
let scopeGeneration = 0
let attachGeneration = 0
let opening = false
let latestGeneration = 0
let settledGeneration = 0
let inboxRequest: AbortController | null = null
let transcriptionRequest: AbortController | null = null
let imageUploadRequest: AbortController | null = null
let reportedRunError: { runId: string; message: string } | null = null

function prioritizeUserInput(): void {
  window.dispatchEvent(new Event('astella:companion-user-input'))
  const turn = get().turn
  if (!turn?.initiative || !turn.runId) return
  const scope = scopeGeneration
  settledGeneration = Math.max(settledGeneration, turn.generation)
  set({ turn: null })
  void companionApi.cancelRun(turn.runId, turn.generation).catch((error) => {
    // The next real user turn also supersedes an internal participation on the server.
    if (scope !== scopeGeneration) return
    handleUnauthorizedForScope(error, scope)
  })
}

/** Background reads and best-effort controls still share the account session. */
function handleUnauthorizedForScope(error: unknown, scope: number, conversationId?: string | null): boolean {
  if (scope !== scopeGeneration || (conversationId !== undefined && conversationId !== get().conversationId)) return false
  if (!(error instanceof ApiError) || !error.isUnauthorized) return false
  handleUnauthorized()
  return true
}

/** Contextual input participates in attention without replacing the main draft. */
export function notifyCompanionInput(): void {
  prioritizeUserInput()
}

export function setDraft(text: string): void {
  prioritizeUserInput()
  set({ draft: text, composerError: null })
}

export function setDraftContext(context: CompanionPageContextV1 | null): void {
  set({ draftContext: context })
}

export function setPendingImage(file: File | null): void {
  if (file) prioritizeUserInput()
  set({ pendingImage: file, pendingImageBlock: null, composerError: null })
}

export function setPendingVoice(transcription: CompanionTranscription | null): void {
  if (transcription) prioritizeUserInput()
  set({
    pendingVoice: transcription ? { artifactId: transcription.voiceArtifactId, transcript: transcription.text } : null,
    ...(transcription ? { draft: transcription.text } : {}),
    composerError: null,
  })
}

export function setComposerError(error: string): void {
  set({ composerError: error || null })
}

/**
 * 打开唯一那条会话。
 *
 * 手机不另开一套「手机聊天」：`POST /companion/inbox/ensure` 幂等返回与桌面共用的
 * 那条 inbox，历史从这里读，流也挂在这里。
 */
export async function openConversation(): Promise<void> {
  if (get().conversationId || get().capability === 'off' || opening) return
  const generation = scopeGeneration
  opening = true
  const controller = new AbortController()
  inboxRequest = controller
  const timeout = setTimeout(() => {
    controller.abort(new Error('连接书房超时，请检查网络后重试。'))
  }, INBOX_CONNECT_TIMEOUT_MS)
  try {
    const inbox = await companionApi.ensureInbox(controller.signal)
    if (generation !== scopeGeneration) return
    set({ conversationId: inbox.id, historyReady: false, capability: 'on', stream: 'connecting', error: null, composerError: null })
    await attachRealtime(inbox.id, generation)
  } catch (error) {
    if (generation !== scopeGeneration) return
    if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND')) {
      set({ capability: 'off' })
      return
    }
    if (error instanceof ApiError && error.isUnauthorized) return handleUnauthorized()
    set({ error: describe(error) })
  } finally {
    clearTimeout(timeout)
    if (inboxRequest === controller) inboxRequest = null
    if (generation === scopeGeneration) opening = false
  }
}

export async function retryConversation(): Promise<void> {
  const scope = scopeGeneration
  const conversationId = get().conversationId
  set({ error: null })
  if (!conversationId) {
    if (get().capability === 'off') set({ capability: 'unknown' })
    await openConversation()
    return
  }
  try {
    await attachRealtime(conversationId, scope)
  } catch (error) {
    if (scope !== scopeGeneration || get().conversationId !== conversationId) return
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    else set({ error: describe(error) })
  }
}

async function attachRealtime(conversationId: string, scope: number): Promise<void> {
  const generation = ++attachGeneration
  realtime?.close()
  realtime = null
  const wasReady = get().historyReady
  set({ historyReady: false, stream: 'connecting' })
  let loaded: Awaited<ReturnType<typeof loadConversationSnapshot>>
  try {
    loaded = await loadConversationSnapshot(conversationId)
  } catch (error) {
    if (scope === scopeGeneration && generation === attachGeneration && get().conversationId === conversationId) {
      set({ historyReady: wasReady, stream: 'closed' })
    }
    throw error
  }
  const { page, snapshot } = loaded
  if (scope !== scopeGeneration || generation !== attachGeneration || get().conversationId !== conversationId) return
  const isCurrent = () => scope === scopeGeneration
    && generation === attachGeneration
    && get().conversationId === conversationId
  // 起点是快照给的 `latestSeq`（= 从最新处挂）。消息的 seq 与事件的 seq 不是一个序列，
  // 拿消息 seq 当游标会一直 409；而 `after=0` 在留存窗前移过的会话上同样被判过期——
  // 服务端的规则是 `after + 1 < minReplayable` 即拒绝（2026-10-12 实测三种取值都 409）。
  cursor = snapshot.latestSeq
  latestGeneration = Math.max(latestGeneration, ...snapshot.runs.map((run) => run.generation), 0)
  settledGeneration = Math.max(
    settledGeneration,
    ...snapshot.runs.filter((run) => !isActiveRun(run.status)).map((run) => run.generation),
    0,
  )
  const runProcesses = restoreRunProcesses(snapshot)
  const resumedTurn = restoreActiveTurn(snapshot, runProcesses)
  set({
    messages: page.items,
    historyReady: true,
    olderAvailable: page.hasMore,
    runs: snapshot.runs,
    runProcesses,
    runProcessErrors: {},
    turn: resumedTurn,
    tools: resumedTurn ? runProcesses[resumedTurn.runId]?.tools ?? [] : [],
    proposals: restoreProposals(snapshot),
  })
  hydrateRestoredProposals(get().proposals)
  realtime = openCompanionRealtime({
    conversationId,
    getCursor: () => cursor,
    onEvent: (event) => {
      if (isCurrent()) handleEvent(event)
    },
    onUnauthorized: () => { if (isCurrent()) handleUnauthorized() },
    onState: (state) => { if (isCurrent()) set({ stream: state }) },
    onError: (message) => { if (isCurrent()) set({ error: message }) },
    // 游标过期 = 中间漏了事件，不是断线：重取一次快照，从快照给的 latestSeq 重新挂。
    onGap: async () => {
      if (!isCurrent()) return
      const wasReady = get().historyReady
      const previousTurn = get().turn
      set({ historyReady: false })
      let loaded: Awaited<ReturnType<typeof loadConversationSnapshot>>
      try {
        loaded = await loadConversationSnapshot(conversationId)
      } catch (error) {
        if (scope === scopeGeneration && generation === attachGeneration && get().conversationId === conversationId) {
          set({ historyReady: wasReady, turn: previousTurn })
          handleUnauthorizedForScope(error, scope, conversationId)
        }
        throw error
      }
      if (scope !== scopeGeneration || generation !== attachGeneration || get().conversationId !== conversationId) return
      const { page, snapshot: nextSnapshot } = loaded
      cursor = nextSnapshot.latestSeq
      latestGeneration = Math.max(latestGeneration, ...nextSnapshot.runs.map((run) => run.generation), 0)
      settledGeneration = Math.max(
        settledGeneration,
        ...nextSnapshot.runs.filter((run) => !isActiveRun(run.status)).map((run) => run.generation),
        0,
      )
      const runProcesses = mergeRunProcesses(get().runProcesses, restoreRunProcesses(nextSnapshot))
      const resumedTurn = restoreActiveTurn(nextSnapshot, runProcesses)
      set({
        messages: page.items,
        historyReady: true,
        olderAvailable: page.hasMore,
        runs: nextSnapshot.runs,
        runProcesses,
        turn: resumedTurn,
        tools: resumedTurn ? runProcesses[resumedTurn.runId]?.tools ?? [] : [],
        proposals: restoreProposals(nextSnapshot),
      })
      hydrateRestoredProposals(get().proposals)
    },
  })
}

async function loadConversationSnapshot(conversationId: string): Promise<{
  page: Awaited<ReturnType<typeof companionApi.messages>>
  snapshot: CompanionRunSnapshot
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('同步对话超时，请检查网络后重试。'))
  }, SNAPSHOT_SYNC_TIMEOUT_MS)
  try {
    const [page, snapshot] = await Promise.all([
      companionApi.messages(conversationId, { limit: 50, signal: controller.signal }),
      companionApi.runNodes(conversationId, 0, controller.signal, { includeThinking: true }),
    ])
    const missingRunIds = [...new Set(page.items.flatMap((message) => message.runId ? [message.runId] : []))]
      .filter((runId) => !snapshot.runs.some((run) => run.runId === runId))
    if (!missingRunIds.length) return { page, snapshot }
    const olderProcesses = await companionApi.runNodes(conversationId, 0, controller.signal,
      { includeThinking: true, runIds: missingRunIds })
    return { page, snapshot: { ...snapshot, runs: [...snapshot.runs, ...olderProcesses.runs] } }
  } finally {
    clearTimeout(timeout)
  }
}

export function closeConversation(): void {
  attachGeneration += 1
  realtime?.close()
  realtime = null
  set({ stream: 'closed' })
}

export function resetConversation(): void {
  scopeGeneration += 1
  inboxRequest?.abort(new Error('书房已切换。'))
  inboxRequest = null
  transcriptionRequest?.abort(new Error('书房已切换。'))
  transcriptionRequest = null
  imageUploadRequest?.abort(new Error('书房已切换。'))
  imageUploadRequest = null
  opening = false
  cursor = 0
  latestGeneration = 0
  settledGeneration = 0
  reportedRunError = null
  closeConversation()
  set({
    capability: 'unknown',
    conversationId: null,
    historyReady: false,
    messages: [],
    runs: [],
    runProcesses: {},
    runProcessErrors: {},
    olderAvailable: false,
    loadingHistory: false,
    turn: null,
    memoryRefs: [],
    draft: '',
    draftContext: null,
    pendingImage: null,
    pendingImageBlock: null,
    uploadingImage: false,
    pendingVoice: null,
    transcribingVoice: false,
    proposals: [],
    tools: [],
    noteEdits: [],
    error: null,
    composerError: null,
  })
}

export async function transcribeVoice(file: File, durationMs: number, expectedConversationId: string): Promise<boolean> {
  if (!expectedConversationId || get().conversationId !== expectedConversationId) return false
  prioritizeUserInput()
  const conversationId = get().conversationId
  const generation = scopeGeneration
  const controller = new AbortController()
  transcriptionRequest?.abort()
  transcriptionRequest = controller
  set({ transcribingVoice: true, composerError: null })
  try {
    const transcription = await companionApi.transcribeDialogueAudio(file, durationMs, controller.signal)
    if (generation !== scopeGeneration || conversationId !== get().conversationId) return false
    const currentDraft = get().draft
    const canKeepArtifact = !currentDraft.trim() && !get().pendingImage
    set({
      pendingVoice: canKeepArtifact
        ? { artifactId: transcription.voiceArtifactId, transcript: transcription.text }
        : null,
      draft: currentDraft.trim()
        ? `${currentDraft.trim()} ${transcription.text}`
        : transcription.text,
      transcribingVoice: false,
      composerError: null,
    })
    return true
  } catch (error) {
    if (generation !== scopeGeneration || conversationId !== get().conversationId) return false
    if (error instanceof ApiError && error.isUnauthorized) {
      handleUnauthorized()
      return false
    }
    set({ transcribingVoice: false, composerError: describeTranscriptionError(error) })
    return false
  } finally {
    if (transcriptionRequest === controller) transcriptionRequest = null
  }
}

export async function loadOlder(): Promise<void> {
  const state = get()
  const oldest = state.messages[0]?.seq
  if (!state.conversationId || oldest === undefined || state.loadingHistory) return
  const conversationId = state.conversationId
  const scope = scopeGeneration
  set({ loadingHistory: true })
  try {
    const page = await companionApi.messages(conversationId, { limit: 50, beforeSeq: oldest })
    if (scope !== scopeGeneration || get().conversationId !== conversationId) return
    set({ messages: [...page.items, ...get().messages], olderAvailable: page.hasMore, loadingHistory: false })
    void refreshRunArchives(page.items.flatMap((message) => message.runId ? [message.runId] : []))
  } catch (error) {
    if (scope !== scopeGeneration || get().conversationId !== conversationId) return
    if (handleUnauthorizedForScope(error, scope, conversationId)) return
    set({ loadingHistory: false, error: describe(error) })
  }
}

/**
 * 发一条。
 *
 * 普通回复保留明确的停止操作；用户开始输入时，主动参与先让出交流。
 * 乐观消息就地递入，服务端回合仍由稳定的 clientMessageId 保证幂等。
 */
export async function sendTurn(
  text: string,
  options: { selection?: CompanionSelectionV1; context?: CompanionPageContextV1; composer?: 'main' | 'isolated' } = {},
): Promise<boolean> {
  if (get().turn?.initiative) prioritizeUserInput()
  const state = get()
  const trimmed = text.trim()
  if (!state.conversationId || !state.historyReady || !trimmed || state.turn || state.uploadingImage || state.transcribingVoice) return false

  const conversationId = state.conversationId
  const scope = scopeGeneration
  const isolated = options.composer === 'isolated' || Boolean(options.selection)
  const pendingImage = isolated ? null : state.pendingImage
  const pendingVoice = isolated ? null : state.pendingVoice
  const submittedContext = options.context ?? (isolated ? null : state.draftContext)
  const sendingCurrentDraft = !isolated && state.draft.trim() === trimmed
  const previousTurn = state.turn
  let imageBlock = pendingImage ? state.pendingImageBlock : null
  let optimisticId: string | null = null
  set({ composerError: null, ...(pendingImage && !imageBlock ? { uploadingImage: true } : {}) })

  if (pendingImage && !imageBlock) {
    const controller = new AbortController()
    imageUploadRequest?.abort()
    imageUploadRequest = controller
    try {
      imageBlock = await companionApi.uploadImage(pendingImage, controller.signal)
    } catch (error) {
      if (imageUploadRequest === controller) imageUploadRequest = null
      if (scope !== scopeGeneration || get().conversationId !== conversationId || get().pendingImage !== pendingImage) return false
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        return false
      }
      set({ uploadingImage: false, composerError: describeSendError(error, true) })
      return false
    }
    if (imageUploadRequest === controller) imageUploadRequest = null
    // The selected image may have been cleared by a session transition while
    // the upload was in flight. Never attach it to a different session.
    if (scope !== scopeGeneration || get().conversationId !== conversationId || get().pendingImage !== pendingImage) {
      set({ uploadingImage: false })
      return false
    }
    set({ pendingImageBlock: imageBlock })
  }

  const current = get()
  if (scope !== scopeGeneration || current.conversationId !== conversationId || (pendingImage && current.pendingImage !== pendingImage)) {
    set({ uploadingImage: false })
    return false
  }
  if (current.turn) {
    set({
      uploadingImage: false,
      composerError: '她正在回复；这段文字和照片都还在，停止当前回复后再发送。',
    })
    return false
  }

  const clientMessageId = uuid()
  optimisticId = clientMessageId
  const optimistic: CompanionMessage = {
    version: 1,
    id: clientMessageId,
    conversationId,
    seq: -1,
    role: 'user',
    kind: 'user_text',
    blocks: [{ type: 'text', text: trimmed }, ...(imageBlock ? [imageBlock] : [])],
    clientMessageId,
    createdAt: new Date().toISOString(),
  }
  set({
    messages: [...current.messages, optimistic],
    draft: sendingCurrentDraft ? '' : current.draft,
    ...(sendingCurrentDraft ? { draftContext: null } : {}),
    composerError: null,
    tools: [],
    turn: {
      runId: '',
      generation: 0,
      visible: true,
      phase: 'waiting',
      statusLabel: null,
      text: '',
      thinkingText: '',
      thinkingLastIndex: -1,
      thinkingGapped: false,
      gapped: false,
    },
  })

  const voiceArtifactMatches = Boolean(
    pendingVoice && trimmed === pendingVoice.transcript && !imageBlock && !pendingImage,
  )
  const request: CreateCompanionTurnRequestV1 = {
      version: 1,
      clientMessageId,
      inputKind: voiceArtifactMatches ? 'voice_transcript' : 'text',
      blocks: [{ type: 'text', text: trimmed }, ...(imageBlock ? [imageBlock] : [])],
      ...(voiceArtifactMatches && pendingVoice ? { voiceArtifactId: pendingVoice.artifactId } : {}),
      sourceSurface: 'main',
      ...(submittedContext ? { context: submittedContext } : {}),
      ...(options.selection ? { selection: options.selection } : {}),
  }
  try {
    let accepted: CreateCompanionTurnResponseV1
    try {
      accepted = realtime
        ? await realtime.submitTurn(request)
        : await companionApi.createTurn(conversationId, request)
    } catch (error) {
      if (!(error instanceof RealtimeUnavailableError)) throw error
      if (scope !== scopeGeneration || get().conversationId !== conversationId) return false
      // If the socket dropped after the server committed, the stable clientMessageId
      // makes this HTTP retry an idempotent replay instead of a second turn.
      accepted = await companionApi.createTurn(conversationId, request)
    }
    if (scope !== scopeGeneration || get().conversationId !== conversationId) return false
    applyTurnAccepted(accepted)
    if (pendingImage && get().pendingImage === pendingImage) set({ pendingImage: null, pendingImageBlock: null })
    set({
      uploadingImage: false,
      ...(get().pendingVoice === pendingVoice ? { pendingVoice: null } : {}),
      composerError: null,
    })
    return true
  } catch (error) {
    if (scope !== scopeGeneration || get().conversationId !== conversationId) return false
    if (handleUnauthorizedForScope(error, scope, conversationId)) return false
    set({
      ...(optimisticId ? { messages: get().messages.filter((message) => message.id !== optimisticId) } : {}),
      ...(!isolated ? { draft: restoreDraft(trimmed, get().draft) } : {}),
      ...(!isolated && get().draftContext === null && submittedContext ? { draftContext: submittedContext } : {}),
      turn: previousTurn,
      uploadingImage: false,
      composerError: describeSendError(error, Boolean(pendingImage && !imageBlock)),
    })
    return false
  }
}

function restoreDraft(sentText: string, currentDraft: string): string {
  if (!currentDraft.trim() || currentDraft === sentText) return sentText
  return `${sentText}\n${currentDraft}`
}

function describeSendError(error: unknown, imageUploadFailed: boolean): string {
  if (imageUploadFailed) {
    if (error instanceof ApiError && error.status === 413) return '这张图片太大，请选 10 MB 以内的图片。'
    if (error instanceof ApiError && error.status === 415) return '这张图片暂不支持，请使用 JPEG、PNG、GIF 或 WebP。'
    if (error instanceof ApiError && error.status === 429) return '图片上传太频繁，稍后再试；原图和文字都还在。'
    return '图片没有上传成功；原图和文字都还在，可以重试。'
  }
  return describe(error)
}

function describeTranscriptionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，请重新登录后再试。'
    if (error.status === 403) return '请先在使用设置中允许语音识别。'
    if (error.status === 413) return '录音文件超过 10 MB，请缩短后重录。'
    if (error.status === 415) return '录音格式或时长不受支持，请重新录制。'
    if (error.status === 429) return '语音识别请求太频繁，请稍后再试。'
    if (error.status >= 500) return '小米 MiMo 语音识别暂时不可用，录音没有发送成功。'
    return error.message
  }
  return error instanceof Error ? error.message : '语音识别失败，请重试。'
}

/** 幂等重放可能带回真实终态（succeeded/cancelled/…），那种情况下不再挂"正在说"。 */
function applyTurnAccepted(accepted: CreateCompanionTurnResponseV1): void {
  cursor = Math.max(cursor, accepted.eventCursor)
  latestGeneration = Math.max(latestGeneration, accepted.generation)
  const stillRunning = (accepted.status === 'accepted' || accepted.status === 'running')
    && accepted.generation > settledGeneration
  if (!stillRunning) settledGeneration = Math.max(settledGeneration, accepted.generation)
  const current = get().turn
  const sameTurn = current?.runId === accepted.runId && current.generation === accepted.generation
  const process = get().runProcesses[accepted.runId] ?? emptyRunProcess(accepted.runId, accepted.generation)
  set({
    messages: get().messages.map((message) => message.clientMessageId === accepted.clientMessageId
      ? { ...message, id: accepted.userMessageId, runId: accepted.runId } : message),
    runProcesses: { ...get().runProcesses, [accepted.runId]: { ...process, generation: accepted.generation,
      status: accepted.generation <= settledGeneration && isActiveRun(accepted.status) ? process.status : accepted.status } },
    turn: stillRunning
      ? {
          runId: accepted.runId,
          generation: accepted.generation,
          visible: sameTurn ? current.visible : true,
          phase: sameTurn ? current.phase : 'waiting',
          statusLabel: sameTurn ? current.statusLabel : null,
          text: sameTurn ? current.text : '',
          thinkingText: sameTurn ? current.thinkingText : process.thinkingText,
          thinkingLastIndex: sameTurn ? current.thinkingLastIndex : process.thinkingLastIndex,
          thinkingGapped: sameTurn ? current.thinkingGapped : process.thinkingGapped,
          gapped: sameTurn ? current.gapped : false,
        }
      : null,
  })
  // A retried submit may return a cursor beyond already emitted process frames.
  // Read its archive even while active so those thoughts/tools are not skipped.
  if (!sameTurn || !stillRunning) void refreshRunArchives([accepted.runId])
  const scope = scopeGeneration
  const conversationId = get().conversationId
  if (conversationId) void companionApi.messages(conversationId, { limit: 50 }).then((page) => {
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return
    const userMessage = page.items.find((message) => message.id === accepted.userMessageId)
    if (userMessage) set({ messages: replacePersistedMessage(get().messages, userMessage) })
    if (!stillRunning) set({ messages: mergePersistedPage(get().messages, page.items) })
  }).catch((error) => { handleUnauthorizedForScope(error, scope, conversationId) })
}

export async function interrupt(): Promise<void> {
  const turn = get().turn
  if (!turn?.runId) return
  const scope = scopeGeneration
  const conversationId = get().conversationId
  try {
    await companionApi.cancelRun(turn.runId, turn.generation)
  } catch (error) {
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return
    if (handleUnauthorizedForScope(error, scope, conversationId)) return
    set({ error: describe(error) })
  }
}

export async function decide(proposalId: string, decision: 'confirm' | 'reject'): Promise<void> {
  const card = get().proposals.find((item) => item.proposalId === proposalId)
  if (!card || card.deciding || !card.payloadSha256) return
  const scope = scopeGeneration
  const conversationId = get().conversationId
  const mark = (patch: Partial<ProposalCard>) => ({
    proposals: get().proposals.map((item) => (item.proposalId === proposalId ? { ...item, ...patch } : item)),
  })
  set(mark({ deciding: true }))
  try {
    await companionApi.decideProposal(proposalId, { decision, expectedPayloadSha256: card.payloadSha256 })
    // 终态由 action.decision / agent.tool 的事件回来，这里不自己判成功。
  } catch (error) {
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return
    if (handleUnauthorizedForScope(error, scope, conversationId)) return
    set({
      ...mark({ deciding: false }),
      error: error instanceof ApiError && error.status === 409
        ? '这一条的内容已经变了，请看一眼新的说明再决定。'
        : describe(error),
    })
  }
}

function restoreActiveTurn(snapshot: CompanionRunSnapshot, processes: Record<string, CompanionRunProcess>): LiveTurn | null {
  const active = snapshot.runs.find((run) => isActiveRun(run.status))
  if (!active) return null

  const statusNode = [...snapshot.items].reverse().find((item) => item.runId === active.runId && item.type === 'assistant.status')
  const payload = statusNode?.payload && typeof statusNode.payload === 'object'
    ? statusNode.payload as { status?: unknown; safeLabel?: unknown; inputKind?: unknown }
    : null
  const status = payload?.status
  const process = processes[active.runId]
  const phase: LiveTurn['phase'] = process?.phase ?? (status === 'thinking' || status === 'acting' || status === 'waiting'
    ? status
    : active.status === 'waiting_for_confirmation'
      ? 'acting'
      : 'waiting')
  const fallbackLabel = active.status === 'waiting_for_confirmation'
    ? '等你确认'
    : active.status === 'cancel_requested'
      ? '正在停下'
      : active.status === 'accepted'
        ? '正在接着处理'
        : '正在继续这一轮'
  return {
    runId: active.runId,
    generation: active.generation,
    initiative: active.userMessageId === null || payload?.inputKind === 'initiative',
    visible: (active.userMessageId !== null && payload?.inputKind !== 'initiative') || Boolean(process?.thinkingText || process?.tools.length),
    phase,
    statusLabel: process?.statusLabel ?? (typeof payload?.safeLabel === 'string' ? payload.safeLabel : fallbackLabel),
    // The history snapshot carries status/tool nodes, not assistant deltas. If this
    // resumed run completes, finalize() will compare lengths and fetch its full reply.
    text: '',
    thinkingText: process?.thinkingText ?? '',
    thinkingLastIndex: process?.thinkingLastIndex ?? -1,
    thinkingGapped: process?.thinkingGapped ?? false,
    gapped: false,
  }
}

function isActiveRun(status: string): boolean {
  return status === 'accepted'
    || status === 'running'
    || status === 'waiting_for_confirmation'
    || status === 'cancel_requested'
}

/** Fetch retained process archives for loaded message runs, including runs beyond the latest 20. */
export async function refreshRunArchives(runIds: string[]): Promise<void> {
  const conversationId = get().conversationId
  const scope = scopeGeneration
  if (!conversationId || !runIds.length) return
  try {
    const snapshot = await companionApi.runNodes(conversationId, 0, undefined,
      { includeThinking: true, runIds: [...new Set(runIds)].slice(0, 100) })
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return
    const incomingIds = new Set(snapshot.runs.map((run) => run.runId))
    const runProcessErrors = { ...get().runProcessErrors }
    for (const runId of runIds) delete runProcessErrors[runId]
    const runProcesses = mergeRunProcesses(get().runProcesses, restoreRunProcesses(snapshot))
    set({ runs: [...snapshot.runs, ...get().runs.filter((run) => !incomingIds.has(run.runId))]
      .sort((left, right) => right.generation - left.generation), runProcesses, runProcessErrors })
    if (reportedRunError) {
      const errorRun = snapshot.runs.find((run) => run.runId === reportedRunError?.runId)
      if (errorRun?.userMessageId === null && get().error === reportedRunError.message) {
        set({ error: null })
        reportedRunError = null
      }
    }
    const active = get().turn
    const process = active?.runId ? runProcesses[active.runId] : null
    if (active && process) set({ tools: process.tools, turn: { ...active,
      thinkingText: process.thinkingText, thinkingLastIndex: process.thinkingLastIndex,
      thinkingGapped: process.thinkingGapped,
      visible: active.visible || Boolean(process.thinkingText || process.tools.length),
      phase: active.text ? 'streaming' : process.phase,
      statusLabel: active.text ? null : process.statusLabel } })
  } catch (error) {
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    else set({ runProcessErrors: { ...get().runProcessErrors,
      ...Object.fromEntries(runIds.map((runId) => [runId, '这轮过程暂时没有同步成功，可以重试。'])) } })
  }
}

/** 从 durable run nodes 重建尚未结束的提议；刷新或补游标后仍可在「手边」决定。 */
function restoreProposals(snapshot: CompanionRunSnapshot): ProposalCard[] {
  const byId = new Map<string, ProposalCard>()
  const nodes = [...snapshot.runs.flatMap((run) => run.processTimeline ?? []), ...snapshot.items]
    .sort((left, right) => left.seq - right.seq)
  for (const item of nodes) {
    if (!item.payload || typeof item.payload !== 'object') continue
    const payload = item.payload as Record<string, unknown>
    if (item.type === 'agent.tool') {
      const tool = readProcessTool(payload.tool)
      if (!tool?.proposalId || tool.status !== 'waiting_confirmation') continue
      byId.set(tool.proposalId, {
        proposalId: tool.proposalId,
        title: tool.safeLabel,
        targetSummary: tool.safeSummary ?? '',
        impactSummary: '',
        payloadSha256: '',
        status: 'pending',
        deciding: false,
        runId: item.runId,
      })
      continue
    }
    if (item.type === 'action.proposed') {
      const proposal = payload.proposal
      if (!proposal || typeof proposal !== 'object') continue
      const value = proposal as Record<string, unknown>
      if (typeof value.id !== 'string' || !isProposalStatus(value.status)) continue
      byId.set(value.id, {
        proposalId: value.id,
        title: typeof value.title === 'string' ? value.title : '伴星的修改提议',
        targetSummary: typeof value.targetSummary === 'string' ? value.targetSummary : '',
        impactSummary: typeof value.impactSummary === 'string' ? value.impactSummary : '',
        payloadSha256: typeof value.payloadSha256 === 'string' ? value.payloadSha256 : '',
        status: value.status,
        deciding: false,
        runId: item.runId,
      })
      continue
    }
    if (item.type === 'action.decision' && typeof payload.proposalId === 'string') {
      const current = byId.get(payload.proposalId)
      if (current && (payload.status === 'accepted' || payload.status === 'rejected')) {
        byId.set(payload.proposalId, { ...current, status: payload.status })
      }
      continue
    }
    if (item.type === 'action.expired' && typeof payload.proposalId === 'string') {
      const current = byId.get(payload.proposalId)
      if (current) byId.set(payload.proposalId, { ...current, status: 'expired' })
    }
  }
  return [...byId.values()]
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return value === 'pending' || value === 'rejected' || value === 'accepted'
    || value === 'executing' || value === 'succeeded' || value === 'failed' || value === 'expired'
}

function hydrateRestoredProposals(cards: ProposalCard[]): void {
  for (const card of cards) {
    if (card.status === 'pending' && !card.payloadSha256) void retryProposalDetails(card.proposalId)
  }
}

/** A failed proposal read leaves its confirmation disabled and offers a real retry. */
export async function retryProposalDetails(proposalId: string): Promise<boolean> {
  const scope = scopeGeneration
  const conversationId = get().conversationId
  if (!conversationId || !get().proposals.some((card) => card.proposalId === proposalId)) return false
  try {
      const snapshot = await companionApi.proposal(proposalId)
      if (scope !== scopeGeneration || conversationId !== get().conversationId) return false
      const proposal = snapshot.proposal
      set({
        proposals: get().proposals.map((item) => item.proposalId === proposal.proposalId
          ? {
              ...item,
              title: proposal.title,
              targetSummary: proposal.targetSummary,
              impactSummary: proposal.impactSummary,
              payloadSha256: proposal.payloadSha256,
              status: proposal.status === 'pending' && item.status !== 'pending' ? item.status : proposal.status,
            }
          : item),
      })
      return true
  } catch (error) {
    if (scope !== scopeGeneration || conversationId !== get().conversationId) return false
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    else set({ error: describe(error) })
    return false
  }
}

function handleEvent(event: CompanionStreamEventV1): void {
  if (event.seq <= cursor) return
  cursor = Math.max(cursor, event.seq)
  switch (event.type) {
    case 'assistant.status': {
      if (!acceptRunEvent(event)) return
      const turn = openTurn(event)
      const process = recordProcessEvent(event)
      const initiative = event.payload.inputKind === 'initiative' || turn.initiative
      set({ turn: { ...turn, initiative: event.payload.inputKind === 'initiative' || turn.initiative,
        visible: !initiative || Boolean(turn.text || process?.thinkingText || process?.tools.length),
        phase: event.payload.status, statusLabel: event.payload.safeLabel } })
      return
    }
    case 'assistant.thinking': {
      if (!acceptRunEvent(event)) return
      const turn = openTurn(event)
      const process = recordProcessEvent(event)
      if (!process) return
      set({ turn: { ...turn, visible: true, phase: 'thinking', statusLabel: process.statusLabel,
        thinkingText: process.thinkingText, thinkingLastIndex: process.thinkingLastIndex,
        thinkingGapped: process.thinkingGapped } })
      return
    }
    case 'assistant.delta': {
      if (!acceptRunEvent(event)) return
      const turn = openTurn(event)
      const next = appendDelta(turn.text, event.payload.appendFrom, event.payload.textDelta)
      updateProcess(event.runId, { phase: 'streaming', statusLabel: null })
      set({ turn: { ...turn, visible: true, phase: 'streaming', statusLabel: null,
        text: next.text, gapped: turn.gapped || next.gapped } })
      return
    }
    case 'assistant.utterance': {
      if (!acceptRunEvent(event)) return
      const payload = event.payload
      const message: CompanionMessage = { version: 1, id: payload.messageId, conversationId: event.conversationId,
        seq: payload.messageSeq, role: 'assistant', kind: payload.proactive ? 'proactive' : 'text',
        blocks: [{ type: 'text', text: payload.text }], runId: event.runId, createdAt: event.createdAt }
      updateProcess(event.runId, { phase: 'waiting', statusLabel: null })
      set({ messages: mergeMessage(get().messages, message),
        turn: { ...openTurn(event), initiative: payload.proactive, visible: true,
          phase: 'waiting', statusLabel: null, text: '' } })
      return
    }
    case 'turn.completed': {
      latestGeneration = Math.max(latestGeneration, event.generation)
      settledGeneration = Math.max(settledGeneration, event.generation)
      updateProcess(event.runId, { status: 'succeeded', statusLabel: null })
      if (get().turn?.runId === event.runId) set({ turn: null })
      if (event.runId) void refreshRunArchives([event.runId])
      return
    }
    case 'assistant.final': {
      finalize(event)
      return
    }
    case 'assistant.followups.ready': {
      applyFollowupSuggestions(event)
      return
    }
    case 'agent.tool':
      if (!acceptRunEvent(event)) return
      set({ turn: { ...openTurn(event), visible: true } })
      recordProcessEvent(event)
      applyToolEvent(event.payload.tool, event.runId, event.seq)
      return
    case 'action.proposed': {
      if (!acceptRunEvent(event)) return
      const proposal = event.payload.proposal
      set({
        proposals: upsertProposal(get().proposals, {
          proposalId: proposal.id,
          title: proposal.title,
          targetSummary: proposal.targetSummary,
          impactSummary: proposal.impactSummary,
          payloadSha256: proposal.payloadSha256,
          status: proposal.status,
          deciding: false,
          runId: event.runId,
        }),
      })
      return
    }
    case 'action.decision':
      if (!acceptRunEvent(event)) return
      set({
        proposals: get().proposals.map((card) =>
          card.proposalId === event.payload.proposalId
            ? { ...card, status: event.payload.status, deciding: false }
            : card,
        ),
      })
      return
    case 'action.expired':
      if (!acceptRunEvent(event)) return
      set({
        proposals: get().proposals.map((card) =>
          card.proposalId === event.payload.proposalId ? { ...card, status: 'expired', deciding: false } : card,
        ),
      })
      return
    case 'turn.cancelled': {
      latestGeneration = Math.max(latestGeneration, event.generation)
      settledGeneration = Math.max(settledGeneration, event.generation)
      updateProcess(event.runId, { status: 'cancelled', statusLabel: null })
      const turn = get().turn
      if (turn?.generation === event.generation && turn.runId === event.runId) set({ turn: null })
      if (event.runId) void refreshRunArchives([event.runId])
      return
    }
    case 'error': {
      if (!acceptRunEvent(event)) return
      // 服务端说得出原因时就用它那句（"这一轮引用的记忆已变更或撤回…"），
      // 说不出原因时才用我们自己的说法——不把原因吞掉。
      const reason = event.payload.message?.trim()
      latestGeneration = Math.max(latestGeneration, event.generation)
      settledGeneration = Math.max(settledGeneration, event.generation)
      const turn = get().turn
      const message = reason || (event.payload.recoverable ? '这一轮没说完，可以再发一次。' : '这一轮停下了。')
      const errorRun = get().runs.find((run) => run.runId === event.runId)
      const initiative = (turn?.runId === event.runId && turn.initiative) || errorRun?.userMessageId === null
      const process = event.runId ? get().runProcesses[event.runId] ?? emptyRunProcess(event.runId, event.generation) : null
      if (process && event.runId) set({ runProcesses: { ...get().runProcesses,
        [event.runId]: { ...process, status: 'failed', statusLabel: null, error: message } } })
      if (!initiative && event.runId) reportedRunError = { runId: event.runId, message }
      set({
        ...(turn?.generation === event.generation && (!event.runId || turn.runId === event.runId) ? { turn: null } : {}),
        ...(!initiative ? { error: message } : {}),
      })
      if (event.runId) void refreshRunArchives([event.runId])
      return
    }
    default:
      // turn.accepted 已由发送回执处理；character.cue / voice.* / proactive.* 不改这一屏的文字。
      return
  }
}

function acceptRunEvent(event: CompanionStreamEventV1): boolean {
  if (event.generation <= settledGeneration || event.generation < latestGeneration) return false
  const current = get().turn
  if (current) {
    if (event.generation < current.generation) return false
    if (event.generation === current.generation) {
      // A blank runId marks a new submit still awaiting its receipt. Events from the
      // superseded generation must not be merged into that optimistic placeholder.
      if (!current.runId && event.runId) return false
      if (current.runId && event.runId && current.runId !== event.runId) return false
    }
  }
  latestGeneration = Math.max(latestGeneration, event.generation)
  return true
}

function openTurn(event: CompanionStreamEventV1): LiveTurn {
  const current = get().turn
  if (current && current.generation === event.generation && current.runId) return current
  return {
    runId: event.runId ?? '',
    generation: event.generation,
    visible: true,
    phase: 'waiting',
    statusLabel: null,
    text: '',
    thinkingText: '',
    thinkingLastIndex: -1,
    thinkingGapped: false,
    gapped: false,
  }
}

function recordProcessEvent(event: CompanionStreamEventV1): CompanionRunProcess | null {
  if (!event.runId) return null
  const current = get().runProcesses[event.runId] ?? emptyRunProcess(event.runId, event.generation)
  const process = appendRunProcess(current, { version: 1, seq: event.seq, type: event.type,
    runId: event.runId, payload: event.payload })
  set({ runProcesses: { ...get().runProcesses, [event.runId]: { ...process, generation: event.generation } } })
  return process
}

function updateProcess(runId: string | null, patch: Partial<CompanionRunProcess>): void {
  if (!runId) return
  const process = get().runProcesses[runId]
  if (process) set({ runProcesses: { ...get().runProcesses, [runId]: { ...process, ...patch } } })
}

function finalize(event: Extract<CompanionStreamEventV1, { type: 'assistant.final' }>): void {
  if (!acceptRunEvent(event)) return
  latestGeneration = Math.max(latestGeneration, event.generation)
  settledGeneration = Math.max(settledGeneration, event.generation)
  updateProcess(event.runId, { status: 'succeeded', phase: 'streaming', statusLabel: null })
  if (event.runId) void refreshRunArchives([event.runId])
  const turn = get().turn
  const matchesTurn = turn?.generation === event.generation && turn.runId === event.runId
  const text = turn?.text ?? ''
  const conversationId = get().conversationId
  // 长度对不上就是中间漏了增量：不拿半截当成品，整段重读。
  if (!matchesTurn || turn.gapped || text.length !== event.payload.textLength) {
    if (matchesTurn) set({ turn: null })
    if (conversationId) {
      const scope = scopeGeneration
      companionApi
        .messages(conversationId, { limit: 50 })
        .then((page) => {
          if (scope === scopeGeneration && conversationId === get().conversationId) {
            set({ messages: mergePersistedPage(get().messages, page.items) })
          }
        })
        .catch((error) => {
          if (scope === scopeGeneration && conversationId === get().conversationId) describeError(error)
        })
    }
    return
  }
  const provisionalMessageSeq = Math.max(0, ...get().messages.map((message) => message.seq)) + 1
  set({
    messages: mergeMessage(get().messages, {
      version: 1,
      id: event.payload.messageId,
      conversationId: event.conversationId,
      // Event and message sequences are separate counters. This is only a brief
      // local placeholder; the persisted row below supplies the authoritative seq.
      seq: provisionalMessageSeq,
      role: 'assistant',
      kind: 'assistant_text',
      blocks: [
        { type: 'text', text },
      ],
      ...(event.payload.followUpPrompts?.length ? { followUpPrompts: event.payload.followUpPrompts } : {}),
      runId: event.runId,
      createdAt: event.createdAt,
    }),
    turn: null,
    memoryRefs: [
      ...get().memoryRefs.filter((item) => item.messageId !== event.payload.messageId),
      ...(event.payload.memoryRefs ?? []).map((ref) => ({ messageId: event.payload.messageId, ...ref })),
    ],
  })
  // assistant.final intentionally carries only terminal text. Re-read the persisted
  // row so citations, diagrams, and other rich blocks are not lost on the live path.
  if (!conversationId) return
  const scope = scopeGeneration
  companionApi.messages(conversationId, { limit: 50 })
    .then((page) => {
      if (scope !== scopeGeneration || conversationId !== get().conversationId) return
      const persisted = page.items.find((message) => message.id === event.payload.messageId)
      if (!persisted) return
      set({ messages: replacePersistedMessage(get().messages, persisted) })
    })
    .catch((error) => { handleUnauthorizedForScope(error, scope, conversationId) })
}

function applyFollowupSuggestions(
  event: Extract<CompanionStreamEventV1, { type: 'assistant.followups.ready' }>,
): void {
  if (event.conversationId !== get().conversationId) return
  const messageId = event.payload.messageId
  const prompts = event.payload.followUpPrompts
  if (prompts.length === 0) return
  const current = get().messages
  if (current.some((message) => message.id === messageId)) {
    set({ messages: current.map((message) => message.id === messageId
      ? attachFollowupSuggestions(message, prompts)
      : message) })
    return
  }

  // A reconnect can deliver the late event before the matching final has been
  // merged locally. Recover just this row without replacing loaded older pages.
  const conversationId = get().conversationId
  const scope = scopeGeneration
  if (!conversationId) return
  companionApi.messages(conversationId, { limit: 50 })
    .then((page) => {
      if (scope !== scopeGeneration || conversationId !== get().conversationId) return
      const persisted = page.items.find((message) => message.id === messageId)
      if (!persisted) return
      set({ messages: replacePersistedMessage(get().messages, attachFollowupSuggestions(persisted, prompts)) })
    })
    .catch((error) => { handleUnauthorizedForScope(error, scope, conversationId) })
}

function attachFollowupSuggestions<T extends CompanionMessage>(message: T, prompts: string[]): T {
  return {
    ...message,
    followUpPrompts: prompts,
  }
}

function replacePersistedMessage(messages: CompanionMessage[], persisted: CompanionMessage): CompanionMessage[] {
  const index = messages.findIndex((message) => message.id === persisted.id
    || (persisted.clientMessageId && message.clientMessageId === persisted.clientMessageId))
  const current = index < 0 ? null : messages[index]
  const currentLegacyFollowups = current?.blocks.find((block) => block.type === 'follow_up_suggestions')
  const currentLegacyPrompts = currentLegacyFollowups && (currentLegacyFollowups as { prompts?: unknown }).prompts
  const currentPrompts = current?.followUpPrompts?.length
    ? current.followUpPrompts
    : Array.isArray(currentLegacyPrompts) && currentLegacyPrompts.every((prompt): prompt is string => typeof prompt === 'string')
      ? currentLegacyPrompts
      : []
  const persistedHasFollowups = Boolean(persisted.followUpPrompts?.length)
    || persisted.blocks.some((block) => block.type === 'follow_up_suggestions')
  const merged = currentPrompts.length > 0 && !persistedHasFollowups
    ? attachFollowupSuggestions(persisted, [...currentPrompts])
    : persisted
  const next = index < 0
    ? [...messages, merged]
    : messages.map((message, itemIndex) => itemIndex === index ? merged : message)
  return next.sort((left, right) => {
    if (left.seq < 0 && right.seq < 0) return 0
    if (left.seq < 0) return 1
    if (right.seq < 0) return -1
    return left.seq - right.seq
  })
}

function mergePersistedPage(messages: CompanionMessage[], persisted: CompanionMessage[]): CompanionMessage[] {
  return persisted.reduce((merged, message) => replacePersistedMessage(merged, message), messages)
}

function applyToolEvent(tool: CompanionAgentToolEventV1, runId: string | null, seq: number): void {
  const trace = processToolTrace(tool, seq)
  const process = runId ? get().runProcesses[runId] : null
  const tools = process?.tools ?? upsertProcessTool(get().tools, trace)
  const turn = get().turn
  const receipt = readNoteEdit(tool, runId)

  set({
    tools,
    ...(turn ? { turn: { ...turn, phase: process?.phase ?? 'acting', statusLabel: process?.statusLabel ?? null } } : {}),
    ...(receipt && !get().noteEdits.some((item) => item.runId === runId && item.noteId === receipt.noteId
      && item.noteVersionId === receipt.noteVersionId && item.operation === receipt.operation)
      ? { noteEdits: [...get().noteEdits, receipt] } : {}),
    ...(tool.proposalId && tool.status === 'waiting_confirmation'
      ? {
          proposals: upsertProposal(get().proposals, {
            proposalId: tool.proposalId,
            title: tool.safeLabel,
            targetSummary: tool.safeSummary ?? '',
            impactSummary: '',
            payloadSha256: '',
            status: 'pending',
            deciding: false,
            runId,
          }),
        }
      : {}),
  })

  // Summary text is not an approval fingerprint; any missing fingerprint needs the real proposal.
  if (tool.proposalId && tool.status === 'waiting_confirmation') {
    hydrateRestoredProposals(get().proposals.filter((card) => card.proposalId === tool.proposalId))
  }
}

function readNoteEdit(tool: CompanionAgentToolEventV1, runId: string | null): NoteEditReceipt | null {
  if (tool.status !== 'succeeded') return null
  const edit = tool.noteEdit
  if (!edit || typeof edit !== 'object') return null
  const noteId = (edit as { noteId?: unknown }).noteId
  const noteVersionId = (edit as { noteVersionId?: unknown }).noteVersionId
  if (typeof noteId !== 'string' || typeof noteVersionId !== 'string') return null
  return {
    runId,
    noteId,
    noteVersionId,
    operation: String((edit as { operation?: unknown }).operation ?? 'unknown'),
    summary: String((edit as { summary?: unknown }).summary ?? ''),
    at: new Date().toISOString(),
  }
}

function upsertProposal(cards: ProposalCard[], card: ProposalCard): ProposalCard[] {
  if (!cards.some((item) => item.proposalId === card.proposalId)) return [...cards, card]
  return cards.map((item) =>
    item.proposalId === card.proposalId
      ? {
          ...item,
          ...card,
          // 快照迟到时不要把已经填好的指纹擦回空串。
          payloadSha256: card.payloadSha256 || item.payloadSha256,
          impactSummary: card.impactSummary || item.impactSummary,
          deciding: item.deciding,
        }
      : item,
  )
}

function mergeMessage(messages: CompanionMessage[], message: CompanionMessage): CompanionMessage[] {
  const settled = messages.filter((item) => !(item.seq === -1 && item.clientMessageId === message.clientMessageId))
  if (settled.some((item) => item.id === message.id)) return settled
  return [...settled, message]
}

function describeError(error: unknown): void {
  if (error instanceof ApiError && error.isUnauthorized) {
    handleUnauthorized()
    return
  }
  set({ error: describe(error) })
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return '这一下太密了，缓一口气再发。'
    if (error.status === 0) return '伴星连接暂时不可用，请检查网络后重试。'
    if (error.status >= 500) return '伴星服务暂时不可用，请稍后重试。'
    return error.message
  }
  return error instanceof Error ? error.message : '未知错误'
}

export function useCompanion(): CompanionState {
  return useStore(store)
}

/** 增量按 `appendFrom`（这段的起点下标）归位；缝不猜，只标记。 */
export function appendDelta(text: string, appendFrom: number, delta: string): { text: string; gapped: boolean } {
  if (appendFrom === text.length) return { text: text + delta, gapped: false }
  if (appendFrom < text.length) return { text: text.slice(0, appendFrom) + delta, gapped: false }
  return { text: text + delta, gapped: true }
}
