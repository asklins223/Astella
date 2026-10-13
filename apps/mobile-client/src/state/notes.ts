import type { NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import type { NoteDetailV1 } from '@astella/shared/note-projection-contracts'
import type { NoteMindMapV1 } from '@astella/shared/note-mind-map-contracts'
import type { NoteOverviewV1 } from '@astella/shared/note-overview-contracts'
import type { NoteLearningArtifactV1 } from '@astella/shared/note-learning-artifact-contracts'
import type { NoteAnnotationAnchorV1 } from '@astella/shared/note-annotation-contracts'
import { notesApi, uuid, type NoteListItem, type NoteSearchPage } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { companionStore } from './companion.ts'
import { createStore, useStore } from './store.ts'

/**
 * 四个派生视图共用一台小状态机。
 *
 * 它们的共同点不是"都是卡片"，而是**都是后台作业**：提交任务 → queued/running →
 * ready 带成品 / failed 带原因。服务端没有推送通道，桌面端按 1600ms 轮询，
 * 手机端沿用同一个节奏，免得两端对同一次生成给出不同的"还要等多久"。
 */
export type TaskPhase = 'idle' | 'queued' | 'running' | 'ready' | 'failed'

export interface TaskView<T> {
  phase: TaskPhase
  data: T | null
  /** 成品是**哪一版**笔记生成的：不一致时屏上要说得出来。 */
  forVersion: number | null
  error: string | null
}

const idle = <T>(): TaskView<T> => ({ phase: 'idle', data: null, forVersion: null, error: null })

export interface ReaderState {
  noteId: string | null
  title: string
  detail: NoteDetailV1 | null
  loading: boolean
  error: string | null
  annotations: NoteAnnotationV1[]
  annotationsError: string | null
  overview: TaskView<NoteOverviewV1>
  mindMap: TaskView<NoteMindMapV1>
  artifact: TaskView<NoteLearningArtifactV1>
  artifactHtml: string | null
  artifactHtmlFor: string | null
  /** 从脑图节点、速看要点或批注跳回正文时，落在哪一块。 */
  focusOrdinal: number | null
  /** 伴星刚动过这一篇：给一条就地可点的说明，而不是弹层。 */
  editedByCompanion: { noteVersionId: string; summary: string; at: string } | null
}

export interface NoteSearchState {
  items: NoteSearchPage['items']
  total: number
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
}

const emptySearch = (): NoteSearchState => ({
  items: [],
  total: 0,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
})

export interface NotesState {
  list: {
    items: NoteListItem[]
    loading: boolean
    loadingMore: boolean
    nextCursor: string | null
    error: string | null
  }
  reader: ReaderState | null
  /** 列表离开去读正文时仍保留查询、结果与滚动所需的数据。 */
  browse: {
    query: string
    search: NoteSearchState
  }
}

export const notesStore = createStore<NotesState>({
  list: { items: [], loading: false, loadingMore: false, nextCursor: null, error: null },
  reader: null,
  browse: { query: '', search: emptySearch() },
})

const store = notesStore
const get = store.get.bind(store)
const set = store.set.bind(store)

const POLL_MS = 1600
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let workspaceGeneration = 0

function poll(key: string, tick: () => Promise<boolean>, onError?: (error: unknown) => void): void {
  stopPoll(key)
  const timer = setTimeout(async () => {
    timers.delete(key)
    let keepGoing = false
    try {
      keepGoing = await tick()
    } catch (error) {
      onError?.(error)
      keepGoing = false
    }
    if (keepGoing) poll(key, tick, onError)
  }, POLL_MS)
  timers.set(key, timer)
}

function stopPoll(key: string): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
}

function stopAllPolls(): void {
  for (const key of [...timers.keys()]) stopPoll(key)
}

const isLive = (phase: TaskPhase): boolean => phase === 'queued' || phase === 'running'
const running = (status: string): boolean => status === 'queued' || status === 'running'

function readerPatch(patch: Partial<ReaderState>, expectedNoteId?: string): void {
  const reader = get().reader
  if (!reader || (expectedNoteId && reader.noteId !== expectedNoteId)) return
  set({ reader: { ...reader, ...patch } })
}

// ─── 列表 ─────────────────────────────────────────────────────────────────

export async function loadNotes(refresh = false): Promise<void> {
  const list = get().list
  if (list.loading || (list.items.length > 0 && !refresh)) return
  const generation = workspaceGeneration
  set({ list: { ...list, loading: true, error: null } })
  try {
    const page = await notesApi.list({ limit: 30 })
    if (generation !== workspaceGeneration) return
    set({ list: { items: page.items, loading: false, loadingMore: false, nextCursor: page.nextCursor ?? null, error: null } })
  } catch (error) {
    if (generation !== workspaceGeneration) return
    set({ list: { ...get().list, loading: false, error: describe(error) } })
  }
}

export async function loadMoreNotes(): Promise<void> {
  const list = get().list
  if (!list.nextCursor || list.loadingMore) return
  const generation = workspaceGeneration
  set({ list: { ...list, loadingMore: true } })
  try {
    const page = await notesApi.list({ limit: 30, cursor: list.nextCursor })
    if (generation !== workspaceGeneration) return
    set({
      list: {
        ...list,
        items: [...list.items, ...page.items],
        nextCursor: page.nextCursor ?? null,
        loadingMore: false,
      },
    })
  } catch (error) {
    if (generation !== workspaceGeneration) return
    set({ list: { ...get().list, loadingMore: false, error: describe(error) } })
  }
}

/** A workspace switch is a hard content boundary; never keep the previous shelf visible. */
export function resetNotesForWorkspace(): void {
  workspaceGeneration += 1
  stopAllPolls()
  editWatcher?.()
  editWatcher = null
  set({
    list: { items: [], loading: false, loadingMore: false, nextCursor: null, error: null },
    reader: null,
    browse: { query: '', search: emptySearch() },
  })
}

export function setNoteSearchQuery(query: string): void {
  const browse = get().browse
  if (browse.query === query) return
  set({ browse: { query, search: emptySearch() } })
}

export function updateNoteSearch(
  update: Partial<NoteSearchState> | ((current: NoteSearchState) => NoteSearchState),
): void {
  const browse = get().browse
  const search = typeof update === 'function' ? update(browse.search) : { ...browse.search, ...update }
  set({ browse: { ...browse, search } })
}

// ─── 阅读器 ───────────────────────────────────────────────────────────────

export async function openNote(noteId: string, title = ''): Promise<void> {
  stopAllPolls()
  editWatcher?.()
  editWatcher = null
  set({
    reader: {
      noteId,
      title,
      detail: null,
      loading: true,
      error: null,
      annotations: [],
      annotationsError: null,
      overview: idle(),
      mindMap: idle(),
      artifact: idle(),
      artifactHtml: null,
      artifactHtmlFor: null,
      focusOrdinal: null,
      editedByCompanion: null,
    },
  })
  try {
    const detail = await notesApi.detail(noteId)
    if (get().reader?.noteId !== noteId) return
    readerPatch({ detail, loading: false, title: detail.title }, noteId)
    // 三份"最新任务"与批注同时问，谁回来都不等别人；四个视图各自填自己的格子。
    // 每一次都要有人接住失败：`void` 掉一个会抛的 Promise 就是控制台里一条没人接的
    // rejection（实测 artifact-tasks 服务端 500 时屏上什么都不说）。
    void hydrateAnnotations(noteId)
    void hydrateOverviewTask(noteId, detail.currentVersionId).catch((error) => readerPatch({
      overview: { phase: 'failed', data: null, forVersion: detail.currentVersion.versionNo, error: taskFailure(error) },
    }, noteId))
    void hydrateMindMapTask(noteId, detail.currentVersionId).catch((error) => readerPatch({
      mindMap: { phase: 'failed', data: null, forVersion: detail.currentVersion.versionNo, error: taskFailure(error) },
    }, noteId))
    void hydrateArtifactTasks(noteId, detail.currentVersionId).catch((error) => readerPatch({
      artifact: { phase: 'failed', data: null, forVersion: detail.currentVersion.versionNo, error: taskFailure(error) },
    }, noteId))
    watchCompanionEdits(noteId)
  } catch (error) {
    readerPatch({ loading: false, error: describe(error) }, noteId)
  }
}

export function closeNote(): void {
  stopAllPolls()
  editWatcher?.()
  editWatcher = null
  set({ reader: null })
}

async function hydrateAnnotations(noteId: string): Promise<void> {
  try {
    const page = await notesApi.annotations(noteId)
    readerPatch({ annotations: page.items, annotationsError: null }, noteId)
  } catch (error) {
    readerPatch({ annotationsError: taskFailure(error) }, noteId)
  }
}

export function retryAnnotations(noteId: string): void {
  readerPatch({ annotationsError: null }, noteId)
  void hydrateAnnotations(noteId)
}

async function hydrateOverviewTask(noteId: string, noteVersionId: string): Promise<void> {
  const result = await notesApi.latestOverviewTask(noteId, noteVersionId)
  if (get().reader?.noteId !== noteId) return
  if (!result.task) {
    readerPatch({ overview: idle() }, noteId)
    return
  }
  applyOverviewTask(noteId, result.task)
  if (running(result.task.status)) poll(
    `overview:${noteId}`,
    () => refreshOverviewTask(noteId, noteVersionId),
    (error) => readerPatch({ overview: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
  )
}

async function refreshOverviewTask(noteId: string, noteVersionId: string): Promise<boolean> {
  if (get().reader?.noteId !== noteId) return false
  const result = await notesApi.latestOverviewTask(noteId, noteVersionId)
  if (get().reader?.noteId !== noteId) return false
  if (!result.task) {
    readerPatch({ overview: { phase: 'failed', data: null, forVersion: null, error: '生成状态没取到，请再试一次。' } }, noteId)
    return false
  }
  applyOverviewTask(noteId, result.task)
  return running(result.task.status)
}

function applyOverviewTask(noteId: string, task: { status: string; overview: NoteOverviewV1 | null; failureReason: string | null }): void {
  readerPatch({
    overview: {
      phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
      data: task.overview,
      forVersion: task.overview?.noteVersionNumber ?? null,
      error: task.status === 'failed' ? reasonText(task.failureReason) : null,
    },
  }, noteId)
}

async function hydrateMindMapTask(noteId: string, noteVersionId: string): Promise<void> {
  const result = await notesApi.latestMindMapTask(noteId, noteVersionId)
  if (get().reader?.noteId !== noteId) return
  if (!result.task) {
    readerPatch({ mindMap: idle() }, noteId)
    return
  }
  applyMindMapTask(noteId, result.task)
  if (running(result.task.status)) poll(
    `mindmap:${noteId}`,
    () => refreshMindMapTask(noteId, noteVersionId),
    (error) => readerPatch({ mindMap: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
  )
}

async function refreshMindMapTask(noteId: string, noteVersionId: string): Promise<boolean> {
  if (get().reader?.noteId !== noteId) return false
  const result = await notesApi.latestMindMapTask(noteId, noteVersionId)
  if (get().reader?.noteId !== noteId) return false
  if (!result.task) {
    readerPatch({ mindMap: { phase: 'failed', data: null, forVersion: null, error: '生成状态没取到，请再试一次。' } }, noteId)
    return false
  }
  applyMindMapTask(noteId, result.task)
  return running(result.task.status)
}

function applyMindMapTask(noteId: string, task: { status: string; mindMap: NoteMindMapV1 | null; failureReason: string | null; failureMessage?: string | null }): void {
  readerPatch({
    mindMap: {
      phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
      data: task.mindMap,
      forVersion: task.mindMap?.noteVersionNumber ?? null,
      error: task.status === 'failed' ? (task.failureMessage || reasonText(task.failureReason ?? null)) : null,
    },
  }, noteId)
}

async function hydrateArtifactTasks(noteId: string, noteVersionId: string): Promise<void> {
  // 任务页必须带 noteVersionId：服务端那条 query 校验不过就回 400「记录位置无效」。
  const page = await notesApi.artifactTasks(noteId, noteVersionId)
  if (get().reader?.noteId !== noteId) return
  const ready = page.items.find((item) => item.status === 'ready' && item.artifact)
  const live = page.items.find((item) => running(item.status))
  if (ready?.artifact) {
    readerPatch({
      artifact: { phase: 'ready', data: ready.artifact, forVersion: ready.artifact.noteVersionNumber, error: null },
    }, noteId)
    return
  }
  if (live) {
    readerPatch({ artifact: { phase: live.status as TaskPhase, data: null, forVersion: null, error: null } }, noteId)
    poll(
      `artifact:${noteId}`,
      () => refreshArtifactTask(noteId, live.taskId),
      (error) => readerPatch({ artifact: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
    )
    return
  }
  readerPatch({ artifact: idle() }, noteId)
}

async function refreshArtifactTask(noteId: string, taskId: string): Promise<boolean> {
  if (get().reader?.noteId !== noteId) return false
  const task = await notesApi.artifactTask(noteId, taskId)
  if (get().reader?.noteId !== noteId) return false
  readerPatch({
    artifact: {
      phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
      data: task.artifact,
      forVersion: task.artifact?.noteVersionNumber ?? null,
      error: task.status === 'failed' ? reasonText(task.failureReason) : null,
    },
  }, noteId)
  return running(task.status)
}

// ─── 触发一次生成 ─────────────────────────────────────────────────────────

export async function generateOverview(): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  readerPatch({ overview: { ...idle(), phase: 'queued' } }, noteId)
  let task: Awaited<ReturnType<typeof notesApi.createOverviewTask>>
  try {
    task = await notesApi.createOverviewTask(noteId, { noteVersionId, requestId: uuid() })
  } catch (error) {
    readerPatch({ overview: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId)
    return
  }
  if (get().reader?.noteId !== noteId) return
  applyOverviewTask(noteId, task)
  if (running(task.status)) poll(
    `overview:${noteId}`,
    () => refreshOverviewTask(noteId, noteVersionId),
    (error) => readerPatch({ overview: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
  )
}

export async function generateMindMap(): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  readerPatch({ mindMap: { ...idle(), phase: 'queued' } }, noteId)
  let task: Awaited<ReturnType<typeof notesApi.createMindMapTask>>
  try {
    task = await notesApi.createMindMapTask(noteId, { noteVersionId, requestId: uuid() })
  } catch (error) {
    readerPatch({ mindMap: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId)
    return
  }
  if (get().reader?.noteId !== noteId) return
  applyMindMapTask(noteId, task)
  if (running(task.status)) poll(
    `mindmap:${noteId}`,
    () => refreshMindMapTask(noteId, noteVersionId),
    (error) => readerPatch({ mindMap: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
  )
}

export async function generateExplainer(anchor?: NoteAnnotationAnchorV1): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  readerPatch({ artifact: { ...idle(), phase: 'queued' } }, noteId)
  let task
  try {
    task = await notesApi.createArtifactTask(noteId, {
      noteVersionId,
      requestId: uuid(),
      sourceKind: anchor ? 'annotation' : 'overview',
      ...(anchor ? { selectionAnchor: anchor } : {}),
    })
  } catch (error) {
    // 失败要落在屏上的一句话，不是控制台里一个没人接的 reject。
    readerPatch({ artifact: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId)
    return
  }
  if (get().reader?.noteId !== noteId) return
  readerPatch({
    artifact: {
      phase: task.status === 'ready' ? 'ready' : (task.status as TaskPhase),
      data: task.artifact,
      forVersion: task.artifact?.noteVersionNumber ?? null,
      error: task.status === 'failed' ? reasonText(task.failureReason) : null,
    },
  }, noteId)
  if (running(task.status)) poll(
    `artifact:${noteId}`,
    () => refreshArtifactTask(noteId, task.taskId),
    (error) => readerPatch({ artifact: { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) } }, noteId),
  )
}

/** 成品 HTML 只在打开那一格时取一次；切回来用缓存，不为同版本重问。 */
export async function ensureExplainerHtml(): Promise<string | null> {
  const reader = get().reader
  const artifact = reader?.artifact.data
  if (!reader || !artifact) return null
  const noteId = reader.noteId
  if (!noteId) return null
  if (reader.artifactHtmlFor === artifact.artifactId && reader.artifactHtml) return reader.artifactHtml
  try {
    const html = await notesApi.artifactHtml(artifact.artifactId)
    readerPatch({ artifactHtml: html, artifactHtmlFor: artifact.artifactId }, noteId)
    return html
  } catch (error) {
    readerPatch({ error: describe(error) }, noteId)
    return null
  }
}

// ─── 标注 ─────────────────────────────────────────────────────────────────

/**
 * 选中一段 → 让她解释。
 *
 * 这走的是**批注**那一族：结果是一条挂在原句锚点上的说明，笔记正文一个字都没动。
 * 手机上不给人直接改正文，但圈一段出来问、把答案留在原处，是这一屏该有的能力。
 */
export async function explainSelection(anchor: NoteAnnotationAnchorV1): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  try {
    const task = await notesApi.createAnnotationTask(noteId, { anchor, requestId: uuid() })
    if (get().reader?.noteId !== noteId) return
    if (task.annotation) {
      readerPatch({ annotations: [task.annotation, ...get().reader!.annotations], annotationsError: null }, noteId)
      return
    }
    if (running(task.status)) {
      poll(`annotate:${noteId}`, () => refreshAnnotationTask(noteId, task.taskId), (error) => readerPatch({ annotationsError: taskFailure(error) }, noteId))
      return
    }
    if (task.status === 'failed') readerPatch({ annotationsError: reasonText(task.failureReason) }, noteId)
  } catch (error) {
    readerPatch({ annotationsError: taskFailure(error) }, noteId)
  }
}

async function refreshAnnotationTask(noteId: string, taskId: string): Promise<boolean> {
  if (get().reader?.noteId !== noteId) return false
  const task = await notesApi.annotationTask(noteId, taskId)
  const reader = get().reader
  if (!reader || reader.noteId !== noteId) return false
  if (task.annotation && !reader.annotations.some((item) => item.annotationId === task.annotation!.annotationId)) {
    readerPatch({ annotations: [task.annotation, ...reader.annotations], annotationsError: null }, noteId)
  }
  if (task.status === 'failed') readerPatch({ annotationsError: reasonText(task.failureReason) }, noteId)
  return running(task.status)
}

export async function saveAnnotation(anchor: NoteAnnotationAnchorV1, explanation: string): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  try {
    const result = await notesApi.createAnnotation(noteId, { anchor, explanation })
    const current = get().reader
    if (!current || current.noteId !== noteId) return
    if ('removed' in result) void hydrateAnnotations(noteId)
    else readerPatch({ annotations: [result, ...current.annotations], annotationsError: null }, noteId)
  } catch (error) {
    readerPatch({ annotationsError: taskFailure(error) }, noteId)
  }
}

/** 删一条批注会连带删掉它那一页讲解，回执里说得很明白，屏上照实说。 */
export async function removeAnnotation(annotation: NoteAnnotationV1): Promise<void> {
  const reader = get().reader
  if (!reader?.detail) return
  const noteId = reader.detail.noteId
  try {
    const result = await notesApi.deleteAnnotation(noteId, annotation.annotationId, annotation.revision)
    const current = get().reader
    if (!current || current.noteId !== noteId) return
    readerPatch({ annotations: current.annotations.filter((item) => item.annotationId !== annotation.annotationId) }, noteId)
    if ('removedArtifacts' in result && result.removedArtifacts > 0) readerPatch({ artifact: idle() }, noteId)
  } catch (error) {
    readerPatch({ annotationsError: taskFailure(error) }, noteId)
  }
}

// ─── 回到原文那一格 ────────────────────────────────────────────────────────

/**
 * 速看要点、脑图节点、批注都指着正文里的某一块。
 * 跳过去之后自己清掉：同一块连着跳两次也该再闪一次，而不是"值没变"就没反应。
 */
export function focusBlock(ordinal: number | null): void {
  if (ordinal === null) return
  const noteId = get().reader?.noteId
  if (!noteId) return
  readerPatch({ focusOrdinal: ordinal }, noteId)
  const key = `focus:${noteId}:${ordinal}`
  stopPoll(key)
  const timer = setTimeout(() => {
    timers.delete(key)
    const reader = get().reader
    if (reader?.noteId === noteId && reader.focusOrdinal === ordinal) readerPatch({ focusOrdinal: null }, noteId)
  }, 1600)
  timers.set(key, timer)
}

// ─── 伴星改动 ─────────────────────────────────────────────────────────────

let editWatcher: (() => void) | null = null

/**
 * 笔记正文只能由伴星改。她在对话里改完之后，手机端要**当场**把阅读那一侧重读一次，
 * 而不是让用户以为看到的是同一版——这条订阅就是那个"当场"。
 */
function watchCompanionEdits(noteId: string): void {
  if (editWatcher) return
  let seen = companionStore.get().noteEdits.length
  editWatcher = companionStore.subscribe(() => {
    const edits = companionStore.get().noteEdits
    if (edits.length === seen) return
    seen = edits.length
    const last = edits[edits.length - 1]
    const reader = get().reader
    if (!last || reader?.noteId !== noteId || !reader.detail || last.noteId !== noteId) return
    readerPatch({ editedByCompanion: { noteVersionId: last.noteVersionId, summary: last.summary, at: last.at } }, noteId)
    void notesApi
      .detail(noteId)
      .then((detail) => readerPatch({ detail, title: detail.title }, noteId))
      .catch((error) => readerPatch({ error: describe(error) }, noteId))
  })
}

function reasonText(reason: string | null): string {
  switch (reason) {
    case 'ai_consent_required':
      return '还没有同意 AI 使用说明，这一份生成不了。'
    case 'ai_data_policy_denied':
      return '按当前的数据外发政策，这段内容不能交给模型。'
    case 'unknown':
      return '生成没成功，可以再试一次。'
    default:
      return '生成没成功，可以再试一次。'
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'mobile_note_edit_forbidden') return '手机上不改笔记正文，要改动请交给伴星。'
    if (error.status === 0) return '网络暂时不可用，请检查连接后重试。'
    if (error.status >= 500) return '服务暂时不可用，请稍后重试。'
    return error.message
  }
  return error instanceof Error ? error.message : '未知错误'
}

function taskFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return '网络暂时不可用，请稍后重试。'
  if (error instanceof ApiError && error.status >= 500) return '服务暂时不可用，请稍后重试。'
  return describe(error)
}

export function useNotes(): NotesState {
  return useStore(store)
}

export function isTaskLive(phase: TaskPhase): boolean {
  return isLive(phase)
}
