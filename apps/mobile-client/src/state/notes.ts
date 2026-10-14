import type { NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import type { NoteDetailV1 } from '@astella/shared/note-projection-contracts'
import type { NoteMindMapV1 } from '@astella/shared/note-mind-map-contracts'
import type { NoteOverviewV1 } from '@astella/shared/note-overview-contracts'
import type { NoteLearningArtifactV1 } from '@astella/shared/note-learning-artifact-contracts'
import type { NoteAnnotationAnchorV1 } from '@astella/shared/note-annotation-contracts'
import { notesApi, uuid, type NoteListItem, type NoteSearchPage } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { companionStore } from './companion.ts'
import { handleUnauthorized } from './session.ts'
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
  artifactHtmlError: string | null
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
const pollTokens = new Map<string, symbol>()
let workspaceGeneration = 0
let listGeneration = 0
let readerGeneration = 0
let detailGeneration = 0
let annotationGeneration = 0
const annotationWrites = new Set<string>()
const removedAnnotationIds = new Set<string>()
const artifactHtmlRequests = new Map<string, Promise<string | null>>()
let focusFrame: number | null = null
type TaskKind = 'overview' | 'mindMap' | 'artifact'
const taskGenerations: Record<TaskKind, number> = { overview: 0, mindMap: 0, artifact: 0 }
interface ReaderScope { workspace: number; reader: number; noteId: string }
interface TaskScope<K extends TaskKind = TaskKind> { reader: ReaderScope; kind: K; generation: number; versionId: string }

function readerScope(noteId = get().reader?.noteId): ReaderScope | null {
  if (!noteId || get().reader?.noteId !== noteId) return null
  return { workspace: workspaceGeneration, reader: readerGeneration, noteId }
}

function isCurrentReader(scope: ReaderScope): boolean {
  return scope.workspace === workspaceGeneration && scope.reader === readerGeneration
    && get().reader?.noteId === scope.noteId
}

function isCurrentVersion(scope: ReaderScope, versionId: string): boolean {
  return isCurrentReader(scope) && get().reader?.detail?.currentVersionId === versionId
}

function annotationWriteKey(scope: ReaderScope, kind: 'save' | 'explain', anchor: NoteAnnotationAnchorV1): string {
  // Positions within an immutable version identify the same passage regardless
  // of property order or the amount of surrounding context included by a caller.
  return `${scope.workspace}:${scope.reader}:${kind}:${anchor.noteVersionId}:${anchor.startBlockOrdinal}:${anchor.startOffset}:${anchor.endBlockOrdinal}:${anchor.endOffset}`
}

function beginTask<K extends TaskKind>(scope: ReaderScope, kind: K, versionId: string): TaskScope<K> {
  stopPoll(`${kind}:${scope.noteId}`)
  return { reader: scope, kind, generation: ++taskGenerations[kind], versionId }
}

function isCurrentTask(scope: TaskScope): boolean {
  return isCurrentReader(scope.reader) && taskGenerations[scope.kind] === scope.generation
    && get().reader?.detail?.currentVersionId === scope.versionId
}

function taskPatch<K extends TaskKind>(scope: TaskScope<K>, view: ReaderState[K]): void {
  if (!isCurrentTask(scope)) return
  readerPatch({ [scope.kind]: view } as Partial<ReaderState>, scope.reader)
}

function failTask(scope: TaskScope, error: unknown): void {
  if (!isCurrentTask(scope)) return
  if (handleExpiredSession(error)) return
  taskPatch(scope, { phase: 'failed', data: null, forVersion: null, error: taskFailure(error) })
}

function handleExpiredSession(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.isUnauthorized) return false
  handleUnauthorized()
  return true
}

function poll(key: string, tick: () => Promise<boolean>, onError?: (error: unknown) => void): void {
  stopPoll(key)
  const token = Symbol(key)
  pollTokens.set(key, token)
  const schedule = () => {
    const timer = setTimeout(async () => {
      if (pollTokens.get(key) !== token) return
      timers.delete(key)
      let keepGoing = false
      try {
        keepGoing = await tick()
      } catch (error) {
        if (pollTokens.get(key) === token) onError?.(error)
      }
      // A tick may already be awaiting its response when the reader closes or a
      // newer task starts. Its response must never revive the cancelled poll.
      if (pollTokens.get(key) !== token) return
      if (keepGoing) schedule()
      else pollTokens.delete(key)
    }, POLL_MS)
    timers.set(key, timer)
  }
  schedule()
}

function stopPoll(key: string): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
  pollTokens.delete(key)
}

function stopAllPolls(): void {
  if (focusFrame !== null) cancelAnimationFrame(focusFrame)
  focusFrame = null
  for (const key of new Set([...timers.keys(), ...pollTokens.keys()])) stopPoll(key)
}

const isLive = (phase: TaskPhase): boolean => phase === 'queued' || phase === 'running'
const running = (status: string): boolean => status === 'queued' || status === 'running'

function readerPatch(patch: Partial<ReaderState>, scope: ReaderScope): void {
  const reader = get().reader
  if (!reader || !isCurrentReader(scope)) return
  set({ reader: { ...reader, ...patch } })
}

// ─── 列表 ─────────────────────────────────────────────────────────────────

export async function loadNotes(refresh = false): Promise<void> {
  const list = get().list
  if (list.loading || (list.items.length > 0 && !refresh)) return
  const workspace = workspaceGeneration
  const generation = ++listGeneration
  set({ list: { ...list, loading: true, loadingMore: false, error: null } })
  try {
    const page = await notesApi.list({ limit: 30 })
    if (workspace !== workspaceGeneration || generation !== listGeneration) return
    set({ list: { items: uniqueNotes(page.items), loading: false, loadingMore: false, nextCursor: page.nextCursor ?? null, error: null } })
  } catch (error) {
    if (workspace !== workspaceGeneration || generation !== listGeneration) return
    if (handleExpiredSession(error)) return
    set({ list: { ...get().list, loading: false, error: describe(error) } })
  }
}

export async function loadMoreNotes(): Promise<void> {
  const list = get().list
  if (!list.nextCursor || list.loading || list.loadingMore) return
  const cursor = list.nextCursor
  const workspace = workspaceGeneration
  const generation = listGeneration
  const isCurrent = () => workspace === workspaceGeneration && generation === listGeneration
    && get().list.nextCursor === cursor && !get().list.loading
  set({ list: { ...list, loadingMore: true, error: null } })
  try {
    const page = await notesApi.list({ limit: 30, cursor })
    if (!isCurrent()) return
    set({
      list: {
        ...get().list,
        items: uniqueNotes([...get().list.items, ...page.items]),
        nextCursor: page.nextCursor === cursor ? null : page.nextCursor ?? null,
        loadingMore: false,
        error: null,
      },
    })
  } catch (error) {
    if (!isCurrent()) return
    if (handleExpiredSession(error)) return
    set({ list: { ...get().list, loadingMore: false, error: describe(error) } })
  }
}

function uniqueNotes(items: NoteListItem[]): NoteListItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

/** A workspace switch is a hard content boundary; never keep the previous shelf visible. */
export function resetNotesForWorkspace(): void {
  workspaceGeneration += 1
  listGeneration += 1
  readerGeneration += 1
  detailGeneration += 1
  annotationGeneration += 1
  annotationWrites.clear()
  removedAnnotationIds.clear()
  artifactHtmlRequests.clear()
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
  const editOffset = companionStore.get().noteEdits.length
  readerGeneration += 1
  const requestGeneration = ++detailGeneration
  annotationGeneration += 1
  annotationWrites.clear()
  removedAnnotationIds.clear()
  artifactHtmlRequests.clear()
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
      artifactHtmlError: null,
      focusOrdinal: null,
      editedByCompanion: null,
    },
  })
  const scope = readerScope(noteId)!
  try {
    const detail = await notesApi.detail(noteId)
    if (!isCurrentReader(scope) || requestGeneration !== detailGeneration) return
    readerPatch({ detail, loading: false, title: detail.title }, scope)
    hydrateReaderViews(scope, detail.currentVersionId)
    watchCompanionEdits(scope, editOffset)
  } catch (error) {
    if (requestGeneration !== detailGeneration || !isCurrentReader(scope)) return
    if (handleExpiredSession(error)) return
    readerPatch({ loading: false, error: describe(error) }, scope)
  }
}

/**
 * A confirmed history restore already returns the target snapshot and blocks.
 * Replace only the open note's content while keeping its route and scroll
 * position alive; reopening it would briefly erase the reader and lose focus.
 */
export function applyRestoredNoteVersion(
  noteId: string,
  result: Awaited<ReturnType<typeof notesApi.restoreVersion>>,
): boolean {
  const scope = readerScope(noteId)
  const current = get().reader
  if (!scope || !current?.detail || result.note.id !== noteId || result.version.noteId !== noteId
    || result.note.currentVersionId !== result.version.id) return false

  const blocks = result.blocks
    .map(({ ordinal, type, content }) => ({ ordinal, type, content }))
    .sort((first, second) => first.ordinal - second.ordinal)
  const detail: NoteDetailV1 = {
    ...current.detail,
    title: result.note.title,
    titleSource: result.note.titleSource,
    currentVersionId: result.version.id,
    revision: result.version.id,
    snapshotAt: result.note.updatedAt,
    currentVersion: {
      versionId: result.version.id,
      noteId,
      versionNo: result.version.versionNo,
      contentHash: result.version.contentHash,
      createdAt: result.version.createdAt,
      updatedAt: result.version.updatedAt,
      blocks,
    },
  }
  const focusedBlockStillExists = blocks.some((block) => block.ordinal === current.focusOrdinal)
  annotationGeneration += 1
  annotationWrites.clear()
  removedAnnotationIds.clear()
  readerPatch({
    detail,
    title: detail.title,
    loading: false,
    error: null,
    annotations: [],
    annotationsError: null,
    overview: idle(),
    mindMap: idle(),
    artifact: idle(),
    artifactHtml: null,
    artifactHtmlFor: null,
    artifactHtmlError: null,
    focusOrdinal: focusedBlockStillExists ? current.focusOrdinal : null,
    editedByCompanion: null,
  }, scope)
  set(({ list, browse }) => ({
    list: {
      ...list,
      items: list.items.map((item) => item.id === noteId
        ? { ...item, title: detail.title, titleSource: detail.titleSource, currentVersionId: detail.currentVersionId, updatedAt: detail.currentVersion.updatedAt }
        : item),
    },
    browse: {
      ...browse,
      search: {
        ...browse.search,
        items: browse.search.items.map((item) => item.objectId === noteId ? { ...item, title: detail.title } : item),
      },
    },
  }))
  hydrateReaderViews(scope, detail.currentVersionId)
  return true
}

export function closeNote(): void {
  readerGeneration += 1
  detailGeneration += 1
  annotationGeneration += 1
  annotationWrites.clear()
  removedAnnotationIds.clear()
  artifactHtmlRequests.clear()
  stopAllPolls()
  editWatcher?.()
  editWatcher = null
  set({ reader: null })
}

function hydrateReaderViews(scope: ReaderScope, versionId: string): void {
  // Independent views settle independently. Each view's request generation also
  // prevents an opening snapshot from replacing a generation the user started.
  const annotations = hydrateAnnotations(scope)
  const generation = annotationGeneration
  void annotations.then((loaded) => {
    if (!loaded || generation !== annotationGeneration || !isCurrentVersion(scope, versionId)) return
    return hydrateAnnotationTask(scope, versionId, generation)
  }).catch((error) => {
    if (generation !== annotationGeneration || !isCurrentVersion(scope, versionId)) return
    if (handleExpiredSession(error)) return
    readerPatch({ annotationsError: taskFailure(error) }, scope)
  })
  const overview = beginTask(scope, 'overview', versionId)
  void hydrateOverviewTask(overview).catch((error) => failTask(overview, error))
  const mindMap = beginTask(scope, 'mindMap', versionId)
  void hydrateMindMapTask(mindMap).catch((error) => failTask(mindMap, error))
  const artifact = beginTask(scope, 'artifact', versionId)
  void hydrateArtifactTasks(artifact).catch((error) => failTask(artifact, error))
}

async function hydrateAnnotations(scope: ReaderScope): Promise<boolean> {
  const generation = ++annotationGeneration
  try {
    const page = await notesApi.annotations(scope.noteId)
    if (generation !== annotationGeneration || !isCurrentReader(scope)) return false
    readerPatch({ annotations: uniqueAnnotations(page.items), annotationsError: null }, scope)
    return true
  } catch (error) {
    if (generation !== annotationGeneration || !isCurrentReader(scope)) return false
    if (handleExpiredSession(error)) return false
    readerPatch({ annotationsError: taskFailure(error) }, scope)
    return false
  }
}

async function hydrateAnnotationTask(scope: ReaderScope, versionId: string, generation: number): Promise<void> {
  const result = await notesApi.latestAnnotationTask(scope.noteId, versionId)
  if (generation !== annotationGeneration || !isCurrentVersion(scope, versionId) || !result.task) return
  const task = result.task
  if (task.annotation) addAnnotation(scope, task.annotation)
  if (running(task.status)) trackAnnotationTask(scope, task.anchor, task.taskId)
  else if (task.status === 'failed') readerPatch({ annotationsError: reasonText(task.failureReason) }, scope)
}

export function retryAnnotations(noteId: string): void {
  const scope = readerScope(noteId)
  if (!scope) return
  readerPatch({ annotationsError: null }, scope)
  const versionId = get().reader?.detail?.currentVersionId
  const annotations = hydrateAnnotations(scope)
  const generation = annotationGeneration
  void annotations.then((loaded) => {
    if (!loaded || !versionId || generation !== annotationGeneration || !isCurrentVersion(scope, versionId)) return
    return hydrateAnnotationTask(scope, versionId, generation)
  }).catch((error) => {
    if (!versionId || generation !== annotationGeneration || !isCurrentVersion(scope, versionId)) return
    if (handleExpiredSession(error)) return
    readerPatch({ annotationsError: taskFailure(error) }, scope)
  })
}

async function hydrateOverviewTask(scope: TaskScope<'overview'>): Promise<void> {
  const result = await notesApi.latestOverviewTask(scope.reader.noteId, scope.versionId)
  if (!isCurrentTask(scope)) return
  if (!result.task) {
    taskPatch(scope, idle<never>())
    return
  }
  applyOverviewTask(scope, result.task)
  if (running(result.task.status)) poll(
    `overview:${scope.reader.noteId}`,
    () => refreshOverviewTask(scope),
    (error) => failTask(scope, error),
  )
}

async function refreshOverviewTask(scope: TaskScope<'overview'>): Promise<boolean> {
  if (!isCurrentTask(scope)) return false
  const result = await notesApi.latestOverviewTask(scope.reader.noteId, scope.versionId)
  if (!isCurrentTask(scope)) return false
  if (!result.task) {
    taskPatch(scope, { phase: 'failed', data: null, forVersion: null, error: '生成状态没取到，请再试一次。' })
    return false
  }
  applyOverviewTask(scope, result.task)
  return running(result.task.status)
}

function applyOverviewTask(scope: TaskScope<'overview'>, task: { status: string; overview: NoteOverviewV1 | null; failureReason: string | null }): void {
  taskPatch(scope, {
    phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
    data: task.overview,
    forVersion: task.overview?.noteVersionNumber ?? null,
    error: task.status === 'failed' ? reasonText(task.failureReason) : null,
  })
}

async function hydrateMindMapTask(scope: TaskScope<'mindMap'>): Promise<void> {
  const result = await notesApi.latestMindMapTask(scope.reader.noteId, scope.versionId)
  if (!isCurrentTask(scope)) return
  if (!result.task) {
    taskPatch(scope, idle<never>())
    return
  }
  applyMindMapTask(scope, result.task)
  if (running(result.task.status)) poll(
    `mindMap:${scope.reader.noteId}`,
    () => refreshMindMapTask(scope),
    (error) => failTask(scope, error),
  )
}

async function refreshMindMapTask(scope: TaskScope<'mindMap'>): Promise<boolean> {
  if (!isCurrentTask(scope)) return false
  const result = await notesApi.latestMindMapTask(scope.reader.noteId, scope.versionId)
  if (!isCurrentTask(scope)) return false
  if (!result.task) {
    taskPatch(scope, { phase: 'failed', data: null, forVersion: null, error: '生成状态没取到，请再试一次。' })
    return false
  }
  applyMindMapTask(scope, result.task)
  return running(result.task.status)
}

function applyMindMapTask(scope: TaskScope<'mindMap'>, task: { status: string; mindMap: NoteMindMapV1 | null; failureReason: string | null; failureMessage?: string | null }): void {
  taskPatch(scope, {
    phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
    data: task.mindMap,
    forVersion: task.mindMap?.noteVersionNumber ?? null,
    error: task.status === 'failed' ? (task.failureMessage || reasonText(task.failureReason ?? null)) : null,
  })
}

async function hydrateArtifactTasks(scope: TaskScope<'artifact'>): Promise<void> {
  // 任务页必须带 noteVersionId：服务端那条 query 校验不过就回 400「记录位置无效」。
  const page = await notesApi.artifactTasks(scope.reader.noteId, scope.versionId)
  if (!isCurrentTask(scope)) return
  // The API orders newest first. An old finished artifact must not hide a newer
  // running or failed attempt, otherwise the page appears to ignore regeneration.
  const latest = page.items[0]
  if (!latest) {
    taskPatch(scope, idle<never>())
    return
  }
  applyArtifactTask(scope, latest)
  if (running(latest.status)) {
    poll(
      `artifact:${scope.reader.noteId}`,
      () => refreshArtifactTask(scope, latest.taskId),
      (error) => failTask(scope, error),
    )
  }
}

async function refreshArtifactTask(scope: TaskScope<'artifact'>, taskId: string): Promise<boolean> {
  if (!isCurrentTask(scope)) return false
  const task = await notesApi.artifactTask(scope.reader.noteId, taskId)
  if (!isCurrentTask(scope)) return false
  applyArtifactTask(scope, task)
  return running(task.status)
}

function applyArtifactTask(scope: TaskScope<'artifact'>, task: { status: string; artifact: NoteLearningArtifactV1 | null; failureReason: string | null }): void {
  taskPatch(scope, {
    phase: task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : (task.status as TaskPhase),
    data: task.artifact,
    forVersion: task.artifact?.noteVersionNumber ?? null,
    error: task.status === 'failed' ? reasonText(task.failureReason) : null,
  })
}

// ─── 触发一次生成 ─────────────────────────────────────────────────────────

export async function generateOverview(): Promise<void> {
  const reader = get().reader
  const readerRequest = readerScope()
  if (!reader?.detail || !readerRequest || isLive(reader.overview.phase)) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  const scope = beginTask(readerRequest, 'overview', noteVersionId)
  taskPatch(scope, { ...idle<never>(), phase: 'queued' })
  let task: Awaited<ReturnType<typeof notesApi.createOverviewTask>>
  try {
    task = await notesApi.createOverviewTask(noteId, { noteVersionId, requestId: uuid() })
  } catch (error) {
    failTask(scope, error)
    return
  }
  if (!isCurrentTask(scope)) return
  applyOverviewTask(scope, task)
  if (running(task.status)) poll(
    `overview:${noteId}`,
    () => refreshOverviewTask(scope),
    (error) => failTask(scope, error),
  )
}

export async function generateMindMap(): Promise<void> {
  const reader = get().reader
  const readerRequest = readerScope()
  if (!reader?.detail || !readerRequest || isLive(reader.mindMap.phase)) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  const scope = beginTask(readerRequest, 'mindMap', noteVersionId)
  taskPatch(scope, { ...idle<never>(), phase: 'queued' })
  let task: Awaited<ReturnType<typeof notesApi.createMindMapTask>>
  try {
    task = await notesApi.createMindMapTask(noteId, { noteVersionId, requestId: uuid() })
  } catch (error) {
    failTask(scope, error)
    return
  }
  if (!isCurrentTask(scope)) return
  applyMindMapTask(scope, task)
  if (running(task.status)) poll(
    `mindMap:${noteId}`,
    () => refreshMindMapTask(scope),
    (error) => failTask(scope, error),
  )
}

export async function generateExplainer(anchor?: NoteAnnotationAnchorV1): Promise<void> {
  const reader = get().reader
  const readerRequest = readerScope()
  if (!reader?.detail || !readerRequest || isLive(reader.artifact.phase)) return
  const noteId = reader.detail.noteId
  const noteVersionId = reader.detail.currentVersionId
  if (anchor && anchor.noteVersionId !== noteVersionId) {
    readerPatch({ artifact: { ...idle(), phase: 'failed', error: '笔记刚刚更新，请重新选取原文。' } }, readerRequest)
    return
  }
  const scope = beginTask(readerRequest, 'artifact', noteVersionId)
  taskPatch(scope, { ...idle<never>(), phase: 'queued' })
  readerPatch({ artifactHtml: null, artifactHtmlFor: null, artifactHtmlError: null }, readerRequest)
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
    failTask(scope, error)
    return
  }
  if (!isCurrentTask(scope)) return
  applyArtifactTask(scope, task)
  if (running(task.status)) poll(
    `artifact:${noteId}`,
    () => refreshArtifactTask(scope, task.taskId),
    (error) => failTask(scope, error),
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
  const scope = readerScope(noteId)!
  const isCurrent = () => isCurrentReader(scope)
    && get().reader?.artifact.data?.artifactId === artifact.artifactId
  const requestKey = `${scope.workspace}:${scope.reader}:${artifact.artifactId}`
  const pending = artifactHtmlRequests.get(requestKey)
  if (pending) return pending
  readerPatch({ artifactHtmlError: null }, scope)
  const request = (async () => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20_000)
    try {
      const html = await notesApi.artifactHtml(artifact.artifactId, controller.signal)
      if (!isCurrent()) return null
      readerPatch({ artifactHtml: html, artifactHtmlFor: artifact.artifactId, artifactHtmlError: null }, scope)
      return html
    } catch (error) {
      const failure = controller.signal.aborted ? new Error('讲解画面加载超时，请重试。') : error
      if (!isCurrent()) return null
      if (handleExpiredSession(failure)) return null
      readerPatch({ artifactHtmlError: describe(failure) }, scope)
      return null
    } finally {
      window.clearTimeout(timeout)
    }
  })()
  artifactHtmlRequests.set(requestKey, request)
  try { return await request }
  finally { if (artifactHtmlRequests.get(requestKey) === request) artifactHtmlRequests.delete(requestKey) }
}

// ─── 标注 ─────────────────────────────────────────────────────────────────

/**
 * 选中一段 → 让她解释。
 *
 * 这走的是**批注**那一族：结果是一条挂在原句锚点上的说明，笔记正文一个字都没动。
 * 手机上不给人直接改正文，但圈一段出来问、把答案留在原处，是这一屏该有的能力。
 */
/** true means accepted by the server; a queued task still finishes by polling. */
export async function explainSelection(anchor: NoteAnnotationAnchorV1): Promise<boolean> {
  const reader = get().reader
  const scope = readerScope()
  if (!reader?.detail || !scope) return false
  const noteId = reader.detail.noteId
  if (anchor.noteVersionId !== reader.detail.currentVersionId) {
    readerPatch({ annotationsError: '笔记刚刚更新，请重新选取原文。' }, scope)
    return false
  }
  const writeKey = annotationWriteKey(scope, 'explain', anchor)
  if (annotationWrites.has(writeKey)) return false
  annotationWrites.add(writeKey)
  annotationGeneration += 1
  readerPatch({ annotationsError: null }, scope)
  let polling = false
  try {
    const task = await notesApi.createAnnotationTask(noteId, { anchor, requestId: uuid() })
    if (!isCurrentVersion(scope, anchor.noteVersionId)) return false
    if (task.annotation) {
      addAnnotation(scope, task.annotation)
      return true
    }
    if (running(task.status)) {
      polling = true
      trackAnnotationTask(scope, anchor, task.taskId)
      return true
    }
    if (task.status === 'failed') readerPatch({ annotationsError: reasonText(task.failureReason) }, scope)
    else readerPatch({ annotationsError: '生成已结束，但批注没有返回，请重试。' }, scope)
    return false
  } catch (error) {
    if (!isCurrentVersion(scope, anchor.noteVersionId)) return false
    if (handleExpiredSession(error)) return false
    readerPatch({ annotationsError: taskFailure(error) }, scope)
    return false
  } finally {
    if (!polling) annotationWrites.delete(writeKey)
  }
}

function trackAnnotationTask(scope: ReaderScope, anchor: NoteAnnotationAnchorV1, taskId: string): void {
  const writeKey = annotationWriteKey(scope, 'explain', anchor)
  annotationWrites.add(writeKey)
  poll(`annotate:${scope.noteId}:${taskId}`, async () => {
    const live = await refreshAnnotationTask(scope, anchor.noteVersionId, taskId)
    if (!live) annotationWrites.delete(writeKey)
    return live
  }, (error) => {
    annotationWrites.delete(writeKey)
    if (!isCurrentVersion(scope, anchor.noteVersionId)) return
    if (handleExpiredSession(error)) return
    readerPatch({ annotationsError: taskFailure(error) }, scope)
  })
}

async function refreshAnnotationTask(scope: ReaderScope, versionId: string, taskId: string): Promise<boolean> {
  if (!isCurrentVersion(scope, versionId)) return false
  const task = await notesApi.annotationTask(scope.noteId, taskId)
  if (!isCurrentVersion(scope, versionId)) return false
  if (task.annotation) addAnnotation(scope, task.annotation)
  if (task.status === 'failed') readerPatch({ annotationsError: reasonText(task.failureReason) }, scope)
  else if (task.status === 'ready' && !task.annotation) readerPatch({ annotationsError: '生成已结束，但批注没有返回，请重试。' }, scope)
  return running(task.status)
}

function uniqueAnnotations(items: NoteAnnotationV1[]): NoteAnnotationV1[] {
  const byId = new Map<string, NoteAnnotationV1>()
  for (const item of items) {
    if (removedAnnotationIds.has(item.annotationId)) continue
    const previous = byId.get(item.annotationId)
    if (!previous || item.revision > previous.revision) byId.set(item.annotationId, item)
  }
  return [...byId.values()]
}

function addAnnotation(scope: ReaderScope, annotation: NoteAnnotationV1): void {
  if (!isCurrentReader(scope)) return
  annotationGeneration += 1
  readerPatch({ annotations: uniqueAnnotations([annotation, ...get().reader!.annotations]), annotationsError: null }, scope)
}

export async function saveAnnotation(anchor: NoteAnnotationAnchorV1, explanation: string): Promise<boolean> {
  const reader = get().reader
  const scope = readerScope()
  if (!reader?.detail || !scope) return false
  const noteId = reader.detail.noteId
  if (anchor.noteVersionId !== reader.detail.currentVersionId) {
    readerPatch({ annotationsError: '笔记刚刚更新，请重新选取原文。' }, scope)
    return false
  }
  const writeKey = annotationWriteKey(scope, 'save', anchor)
  if (annotationWrites.has(writeKey)) return false
  annotationWrites.add(writeKey)
  annotationGeneration += 1
  readerPatch({ annotationsError: null }, scope)
  try {
    const result = await notesApi.createAnnotation(noteId, { anchor, explanation })
    if (!isCurrentVersion(scope, anchor.noteVersionId)) return false
    if ('removed' in result) void hydrateAnnotations(scope)
    else addAnnotation(scope, result)
    return true
  } catch (error) {
    if (!isCurrentVersion(scope, anchor.noteVersionId)) return false
    if (handleExpiredSession(error)) return false
    readerPatch({ annotationsError: taskFailure(error) }, scope)
    return false
  } finally {
    annotationWrites.delete(writeKey)
  }
}

/** 删一条批注会连带删掉它那一页讲解，回执里说得很明白，屏上照实说。 */
export async function removeAnnotation(annotation: NoteAnnotationV1): Promise<void> {
  const reader = get().reader
  const scope = readerScope()
  if (!reader?.detail || !scope) return
  const noteId = reader.detail.noteId
  const writeKey = `${scope.workspace}:${scope.reader}:remove:${annotation.annotationId}`
  if (annotationWrites.has(writeKey)) return
  annotationWrites.add(writeKey)
  annotationGeneration += 1
  readerPatch({ annotationsError: null }, scope)
  try {
    const result = await notesApi.deleteAnnotation(noteId, annotation.annotationId, annotation.revision)
    const current = get().reader
    if (!current || !isCurrentReader(scope)) return
    annotationGeneration += 1
    removedAnnotationIds.add(annotation.annotationId)
    readerPatch({ annotations: current.annotations.filter((item) => item.annotationId !== annotation.annotationId) }, scope)
    if ('removedArtifacts' in result && result.removedArtifacts > 0) {
      beginTask(scope, 'artifact', current.detail!.currentVersionId)
      readerPatch({ artifact: idle(), artifactHtml: null, artifactHtmlFor: null, artifactHtmlError: null }, scope)
    }
  } catch (error) {
    if (!isCurrentReader(scope)) return
    if (handleExpiredSession(error)) return
    readerPatch({ annotationsError: taskFailure(error) }, scope)
  } finally {
    annotationWrites.delete(writeKey)
  }
}

// ─── 回到原文那一格 ────────────────────────────────────────────────────────

/**
 * 速看要点、脑图节点、批注都指着正文里的某一块。
 * 跳过去之后自己清掉：同一块连着跳两次也该再闪一次，而不是"值没变"就没反应。
 */
export function focusBlock(ordinal: number | null): void {
  if (ordinal === null) return
  const scope = readerScope()
  if (!scope) return
  const noteId = scope.noteId
  const key = `focus:${noteId}`
  stopPoll(key)
  if (focusFrame !== null) cancelAnimationFrame(focusFrame)
  readerPatch({ focusOrdinal: null }, scope)
  focusFrame = requestAnimationFrame(() => {
    focusFrame = null
    if (!isCurrentReader(scope)) return
    readerPatch({ focusOrdinal: ordinal }, scope)
    const timer = setTimeout(() => {
      timers.delete(key)
      const reader = get().reader
      if (isCurrentReader(scope) && reader?.focusOrdinal === ordinal) readerPatch({ focusOrdinal: null }, scope)
    }, 1600)
    timers.set(key, timer)
  })
}

// ─── 伴星改动 ─────────────────────────────────────────────────────────────

let editWatcher: (() => void) | null = null

/**
 * 笔记正文只能由伴星改。她在对话里改完之后，手机端要**当场**把阅读那一侧重读一次，
 * 而不是让用户以为看到的是同一版——这条订阅就是那个"当场"。
 */
function watchCompanionEdits(scope: ReaderScope, editOffset: number): void {
  if (editWatcher) return
  let seen = editOffset
  const refreshOnEdit = () => {
    if (!isCurrentReader(scope)) return
    const edits = companionStore.get().noteEdits
    if (edits.length === seen) return
    const fresh = edits.slice(seen)
    seen = edits.length
    const last = [...fresh].reverse().find((edit) => edit.noteId === scope.noteId)
    const reader = get().reader
    if (!last || !reader?.detail) return
    const generation = ++detailGeneration
    readerPatch({ editedByCompanion: { noteVersionId: last.noteVersionId, summary: last.summary, at: last.at } }, scope)
    void notesApi
      .detail(scope.noteId)
      .then((detail) => {
        if (!isCurrentReader(scope) || generation !== detailGeneration) return
        const changedVersion = get().reader?.detail?.currentVersionId !== detail.currentVersionId
        readerPatch({ detail, title: detail.title, error: null }, scope)
        if (changedVersion) {
          stopAllPolls()
          annotationWrites.clear()
          readerPatch({ overview: idle(), mindMap: idle(), artifact: idle(), artifactHtml: null, artifactHtmlFor: null, artifactHtmlError: null, focusOrdinal: null }, scope)
          hydrateReaderViews(scope, detail.currentVersionId)
        }
      })
      .catch((error) => {
        if (generation !== detailGeneration || !isCurrentReader(scope)) return
        if (handleExpiredSession(error)) return
        readerPatch({ error: describe(error) }, scope)
      })
  }
  editWatcher = companionStore.subscribe(refreshOnEdit)
  // The initial detail fetch may span a companion edit; process changes that
  // arrived during opening before waiting for another store notification.
  refreshOnEdit()
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
