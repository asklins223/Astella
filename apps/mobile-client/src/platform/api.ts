import { z } from 'zod'
import { companionImageBlockV1Schema } from '@astella/shared/companion-conversation-contracts'
import { SOURCE_IMAGE_MIME_TYPES, sourceImageObjectKeyFromUrl } from '@astella/shared/source-image-contracts'
import {
  companionProposalSnapshotV1Schema,
  createCompanionTurnRequestV1Schema,
  createCompanionTurnResponseV1Schema,
  type CreateCompanionTurnRequestV1,
  type CreateCompanionTurnResponseV1,
} from '@astella/shared/companion-conversation-contracts'
import {
  noteAnnotationLatestTaskV1Schema,
  noteAnnotationPageV1Schema,
  noteAnnotationTaskV1Schema,
  noteAnnotationWriteResultV1Schema,
  type NoteAnnotationAnchorV1,
} from '@astella/shared/note-annotation-contracts'
import { noteDetailV1Schema } from '@astella/shared/note-projection-contracts'
import {
  noteOverviewLatestTaskV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
} from '@astella/shared/note-overview-contracts'
import {
  noteMindMapLatestTaskV1Schema,
  noteMindMapPageV1Schema,
  noteMindMapSourceV1Schema,
  noteMindMapTaskV1Schema,
} from '@astella/shared/note-mind-map-contracts'
import {
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
} from '@astella/shared/note-learning-artifact-contracts'
import { requestFormData, requestJson, requestText } from './api-client.ts'
import { CLIENT_KIND } from './config.ts'

/**
 * 手机端的全部接口面。
 *
 * 读侧一律 parse 之后再进状态：这些形状里有一半是模型生成的（速看要点、脑图节点、
 * 讲解大纲），拿着未校验的对象往 JSX 里传，症状是"某篇笔记把整屏刷白了"。
 * 写侧同样先过 schema——客户端该比服务端更早知道自己填错了。
 */

export function uuid(): string {
  return crypto.randomUUID()
}

const isoTime = z.string()

function parseAs<T>(schema: z.ZodType<T>) {
  return (value: unknown): T => schema.parse(value)
}

// ─── 身份 ──────────────────────────────────────────────────────────────────

const authEnvelopeSchema = z.object({
  token: z.string().min(1),
  ctx: z.object({
    userId: z.string(),
    workspaceId: z.string(),
    workspaceEpoch: z.number().int().positive(),
  }).passthrough(),
  workspaces: z.array(z.object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    role: z.string(),
    workspaceType: z.string(),
    isPersonal: z.boolean(),
  }).passthrough()).optional(),
}).passthrough()
export type AuthEnvelope = z.infer<typeof authEnvelopeSchema>

export const authMeSchema = z.object({
  userId: z.string(),
  workspaceId: z.string(),
  email: z.string(),
  role: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  workspaceName: z.string(),
  workspaceType: z.string(),
  isPersonal: z.boolean(),
  personalWorkspaceId: z.string().nullable().optional(),
  workspaceEpoch: z.number().int().positive(),
}).passthrough()
export type AuthMe = z.infer<typeof authMeSchema>

const workspaceInfoSchema = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  role: z.string(),
  workspaceType: z.string(),
  isPersonal: z.boolean(),
  leftAt: z.string().nullable(),
}).passthrough()
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>

const workspaceSwitchSchema = z.object({
  token: z.string().min(1),
  ctx: z.object({
    userId: z.string(),
    workspaceId: z.string().uuid(),
    membershipRole: z.string().nullable(),
    workspaceEpoch: z.number().int().positive(),
    clientKind: z.string(),
  }).passthrough(),
}).passthrough()
export type WorkspaceSwitch = z.infer<typeof workspaceSwitchSchema>

/** 三条登录/注册路都要带 clientKind：判据落在签发的会话上，之后每个请求都跟着走。 */
export const authApi = {
  login(input: { email: string; password: string; remember?: boolean }, signal?: AbortSignal) {
    return requestJson<unknown>('/auth/login', {
      method: 'POST',
      body: { ...input, clientKind: CLIENT_KIND },
      signal,
    }).then(parseAs(authEnvelopeSchema))
  },
  loginWithCode(input: { email: string; code: string; remember?: boolean }, signal?: AbortSignal) {
    return requestJson<unknown>('/auth/login-with-code', {
      method: 'POST',
      body: { ...input, clientKind: CLIENT_KIND },
      signal,
    }).then(parseAs(authEnvelopeSchema))
  },
  /** 注册默认强制两步：不带 emailCode 时服务端回 400 `client_update_required`。 */
  requestEmailCode(email: string, purpose: 'register' | 'login' | 'reset_password', signal?: AbortSignal) {
    return requestJson<{ ok: boolean; resendInSeconds: number }>('/auth/email-code', {
      method: 'POST',
      body: { email, purpose },
      signal,
    })
  },
  register(input: { email: string; password: string; displayName?: string; emailCode?: string }, signal?: AbortSignal) {
    return requestJson<unknown>('/auth/register-v2', {
      method: 'POST',
      body: { ...input, clientKind: CLIENT_KIND },
      signal,
    }).then(parseAs(authEnvelopeSchema))
  },
  resetPassword(input: { email: string; code: string; newPassword: string }, signal?: AbortSignal) {
    return requestJson<void>('/auth/reset-password', { method: 'POST', body: input, signal })
  },
  me(signal?: AbortSignal) {
    return requestJson<unknown>('/auth/me', { signal }).then(parseAs(authMeSchema))
  },
  updateProfile(input: { displayName?: string | null; avatarUrl?: string | null }) {
    const profileSchema = z.object({
      ok: z.literal(true),
      displayName: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }).passthrough()
    return requestJson<unknown>('/auth/profile', { method: 'PUT', body: input }).then(parseAs(profileSchema))
  },
  async uploadAvatar(file: File, signal?: AbortSignal) {
    const form = new FormData()
    form.set('file', file, file.name || '头像')
    const raw = await requestFormData<unknown>('/uploads/avatars', form, { signal })
    return z.object({
      url: z.string().min(1).max(500),
      objectKey: z.string().min(1).max(512),
      size: z.number().int().positive().max(10 * 1024 * 1024),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    }).passthrough().parse(raw)
  },
  workspaces() {
    return requestJson<unknown>('/auth/workspaces').then(parseAs(z.object({ workspaces: z.array(workspaceInfoSchema) }))).then((result) => result.workspaces)
  },
  switchWorkspace(workspaceId: string) {
    return requestJson<unknown>('/auth/switch-workspace', {
      method: 'POST',
      body: { workspaceId },
    }).then(parseAs(workspaceSwitchSchema))
  },
  logout(signal?: AbortSignal) {
    return requestJson<void>('/auth/logout', { method: 'POST', signal })
  },
}

// ─── 伴星对话 ──────────────────────────────────────────────────────────────

const inboxSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  workspaceId: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.string(),
  lastMessageAt: isoTime.nullable().optional(),
}).passthrough()
export type CompanionInbox = z.infer<typeof inboxSchema>

const messageSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant', 'system']),
  kind: z.string(),
  blocks: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  followUpPrompts: z.array(z.string().min(4).max(120)).max(3).optional(),
  runId: z.string().nullable().optional(),
  clientMessageId: z.string().nullable().optional(),
  createdAt: isoTime,
  editedAt: isoTime.nullable().optional(),
}).passthrough()
export type CompanionMessage = z.infer<typeof messageSchema>

const messagesPageSchema = z.object({
  version: z.literal(1),
  items: z.array(messageSchema),
  hasMore: z.boolean(),
  oldestSeq: z.number().int().nullable().optional(),
}).passthrough()
export type CompanionMessagesPage = z.infer<typeof messagesPageSchema>

const companionRunNodeSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().nonnegative(),
  runId: z.string().nullable(),
  type: z.string(),
  payload: z.unknown(),
}).passthrough()
export type CompanionRunNode = z.infer<typeof companionRunNodeSchema>

const companionRunSummarySchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  userMessageId: z.string().nullable().optional(),
  status: z.string(),
  generation: z.number().int().positive(),
  stepCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive().nullable(),
  maxToolCalls: z.number().int().positive().nullable(),
  assistantMessageId: z.string().nullable(),
  thinkingText: z.string().nullable().optional(),
  processTimeline: z.array(companionRunNodeSchema).optional(),
  nodeCount: z.number().int().nonnegative(),
}).passthrough()
export type CompanionRunSummary = z.infer<typeof companionRunSummarySchema>

const companionRunSnapshotSchema = z.object({
  version: z.literal(1),
  items: z.array(companionRunNodeSchema),
  runs: z.array(companionRunSummarySchema),
  latestSeq: z.number().int().nonnegative(),
}).passthrough()
export type CompanionRunSnapshot = z.infer<typeof companionRunSnapshotSchema>

const companionAccountSchema = z.object({
  agentSettings: z.object({ permissionLevel: z.enum(['read_only', 'guided', 'full']).optional() }).passthrough().optional(),
  animationOff: z.boolean().optional(),
  voiceOff: z.boolean().optional(),
}).passthrough()
export type CompanionAccount = z.infer<typeof companionAccountSchema>

const companionTranscriptionSchema = z.object({
  version: z.literal(1),
  voiceArtifactId: z.string().uuid(),
  text: z.string().min(1).max(4_000),
  transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  asrProvider: z.literal('mimo'),
  asrModel: z.string().min(1),
  language: z.string().min(1),
  durationMs: z.number().int().min(200).max(60_000),
  expiresAt: z.string(),
}).passthrough()
export type CompanionTranscription = z.infer<typeof companionTranscriptionSchema>

export const companionApi = {
  ensureInbox(signal?: AbortSignal) {
    return requestJson<unknown>('/companion/inbox/ensure', { method: 'POST', signal }).then(parseAs(inboxSchema))
  },
  messages(conversationId: string, input: { limit?: number; beforeSeq?: number; signal?: AbortSignal } = {}) {
    return requestJson<unknown>(`/companion/conversations/${conversationId}/messages`, {
      query: { limit: input.limit, beforeSeq: input.beforeSeq },
      signal: input.signal,
    }).then(parseAs(messagesPageSchema))
  },
  /** `Idempotency-Key` 必须是 UUID v4（服务端拿正则判），这里直接用 clientMessageId 顶上。 */
  createTurn(conversationId: string, input: CreateCompanionTurnRequestV1): Promise<CreateCompanionTurnResponseV1> {
    const body = createCompanionTurnRequestV1Schema.parse(input)
    return requestJson<unknown>(`/companion/conversations/${conversationId}/turns`, {
      method: 'POST',
      idempotencyKey: body.clientMessageId,
      body,
    }).then(parseAs(createCompanionTurnResponseV1Schema))
  },
  async uploadImage(file: File, signal?: AbortSignal) {
    const form = new FormData()
    form.set('file', file, file.name || '手机照片')
    const raw = await requestFormData<unknown>('/uploads/companion-images', form, { signal })
    const uploaded = z.object({
      assetId: z.string().uuid(),
      url: z.string().max(512),
      size: z.number().int().positive().max(10 * 1024 * 1024),
      mimeType: z.enum(SOURCE_IMAGE_MIME_TYPES),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).passthrough().parse(raw)
    if (!sourceImageObjectKeyFromUrl(uploaded.url)) throw new Error('服务端返回的图片地址无效。')
    const label = (file.name || '手机照片').slice(0, 80)
    return companionImageBlockV1Schema.parse({
      type: 'image',
      url: uploaded.url,
      label,
      alt: label.slice(0, 120),
      assetId: uploaded.assetId,
    })
  },
  async transcribeDialogueAudio(file: File, durationMs: number, signal?: AbortSignal): Promise<CompanionTranscription> {
    const form = new FormData()
    // The server reads these purpose fields alongside the file and keeps the
    // transcript eligible for the voice_artifact provenance check on send.
    form.set('purpose', 'companion_dialogue')
    form.set('language', 'zh-CN')
    form.set('durationMs', String(Math.round(durationMs)))
    form.set('file', file, file.name || 'mobile-voice.wav')
    const raw = await requestFormData<unknown>('/voice/transcribe', form, { signal })
    return companionTranscriptionSchema.parse(raw)
  },
  cancelRun(runId: string, generation: number) {
    return requestJson<unknown>(`/companion/runs/${runId}/cancel`, {
      method: 'POST',
      body: { version: 1, generation, reason: 'user' },
    })
  },
  proposal(proposalId: string) {
    return requestJson<unknown>(`/companion/proposals/${proposalId}`).then(parseAs(companionProposalSnapshotV1Schema))
  },
  decideProposal(proposalId: string, input: { decision: 'confirm' | 'reject'; expectedPayloadSha256: string }) {
    return requestJson<unknown>(`/companion/proposals/${proposalId}/decision`, {
      method: 'POST',
      idempotencyKey: uuid(),
      body: { version: 1, ...input },
    })
  },
  account() {
    return requestJson<unknown>('/me/companion').then(parseAs(companionAccountSchema))
  },
  /**
   * 事件流的**起点**从这一条里拿。
   *
   * 快照（messages）本身不带游标，而 `?after=0` 在事件留存窗已经前移的会话上会被判
   * `CURSOR_EXPIRED`（服务端 rule：`after + 1 < minReplayable`）。`run-nodes` 回的
   * `latestSeq` 就是"从最新处挂"的那个值——2026-10-12 实测，逐条对过。
   */
  async runNodes(
    conversationId: string,
    after = 0,
    signal?: AbortSignal,
    options: { includeThinking?: boolean; runIds?: string[] } = {},
  ): Promise<CompanionRunSnapshot> {
    const raw = await requestJson<unknown>(`/companion/conversations/${conversationId}/run-nodes`, {
      query: { after, includeThinking: options.includeThinking, runIds: options.runIds?.length ? options.runIds.join(',') : undefined },
      signal,
    })
    return companionRunSnapshotSchema.parse(raw)
  },
}

// ─── 笔记与四个派生视图 ────────────────────────────────────────────────────

const noteListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleSource: z.enum(['manual', 'auto']).optional(),
  updatedAt: isoTime,
  createdAt: isoTime.optional(),
  shareScope: z.enum(['private', 'shared']).optional(),
  currentVersionId: z.string().optional(),
  firstImageBlock: z.string().nullable().optional(),
}).passthrough()
export type NoteListItem = z.infer<typeof noteListItemSchema>

const noteListPageSchema = z.object({
  items: z.array(noteListItemSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough()

const noteSearchPageSchema = z.object({
  items: z.array(z.object({
    objectType: z.literal('note'),
    objectId: z.string(),
    title: z.string().nullable(),
    snippet: z.string(),
    indexedAt: isoTime,
    href: z.string(),
    matchCount: z.number().int().nonnegative().optional(),
  }).passthrough()),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).passthrough()
export type NoteSearchResult = z.infer<typeof noteSearchPageSchema>['items'][number]
export type NoteSearchPage = z.infer<typeof noteSearchPageSchema>

const noteVersionsSchema = z.object({
  items: z.array(z.object({
    // GET /notes/:id/versions exposes the DB `id` directly and intentionally
    // omits contentHash. Keep this contract aligned with that response.
    id: z.string().uuid(),
    noteId: z.string().uuid(),
    versionNo: z.number().int().positive(),
    createdBy: z.string().uuid(),
    createdAt: isoTime,
    updatedAt: isoTime,
  }).passthrough()),
}).passthrough()

const restoredNoteVersionSchema = z.object({
  note: z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    title: z.string().max(200),
    titleSource: z.enum(['manual', 'auto']),
    currentVersionId: z.string().uuid(),
    updatedAt: isoTime,
  }).passthrough(),
  version: z.object({
    id: z.string().uuid(),
    noteId: z.string().uuid(),
    versionNo: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{32}$/),
    createdAt: isoTime,
    updatedAt: isoTime,
  }).passthrough(),
  blocks: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    type: z.enum(['paragraph', 'heading', 'code', 'list', 'quote', 'image']),
    content: z.string().max(50_000),
  }).passthrough()),
}).passthrough()

export const notesApi = {
  list(input: { limit?: number; cursor?: string; trashed?: boolean } = {}) {
    return requestJson<unknown>('/notes', { query: input }).then(parseAs(noteListPageSchema))
  },
  search(input: { q: string; limit?: number; cursor?: string; signal?: AbortSignal }) {
    return requestJson<unknown>('/search', {
      query: { q: input.q, type: 'note', limit: input.limit ?? 20, cursor: input.cursor },
      signal: input.signal,
    }).then(parseAs(noteSearchPageSchema))
  },
  /**
   * 正文用投影这一条，而不是 `/doc-state`：服务端已经把 blocks 摆成
   * `{ordinal,type,content}`，手机端不必为了读一篇文章在浏览器里跑一遍
   * Yjs + ProseMirror。
   */
  detail(noteId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}`).then(parseAs(noteDetailV1Schema))
  },
  versions(noteId: string, input: { limit?: number; offset?: number } = {}) {
    return requestJson<unknown>(`/notes/${noteId}/versions`, { query: input }).then(parseAs(noteVersionsSchema))
  },
  restoreVersion(noteId: string, versionId: string, baseVersionId: string) {
    return requestJson<unknown>(`/notes/${noteId}/versions/${versionId}/restore`, {
      method: 'POST',
      body: { baseVersionId },
    }).then(parseAs(restoredNoteVersionSchema))
  },
  overviews(noteId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/overviews`).then(parseAs(noteOverviewPageV1Schema))
  },
  latestOverviewTask(noteId: string, noteVersionId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/overview-tasks/latest`, {
      query: { noteVersionId },
    }).then(parseAs(noteOverviewLatestTaskV1Schema))
  },
  createOverviewTask(noteId: string, input: { noteVersionId: string; requestId: string }) {
    return requestJson<unknown>(`/v2/notes/${noteId}/overview-tasks`, {
      method: 'POST',
      body: input,
    }).then(parseAs(noteOverviewTaskV1Schema))
  },
  mindMaps(noteId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/mind-maps`).then(parseAs(noteMindMapPageV1Schema))
  },
  mindMapSource(noteId: string, mindMapId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/mind-maps/${mindMapId}/source`).then(parseAs(noteMindMapSourceV1Schema))
  },
  latestMindMapTask(noteId: string, noteVersionId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/mind-map-tasks/latest`, {
      query: { noteVersionId },
    }).then(parseAs(noteMindMapLatestTaskV1Schema))
  },
  createMindMapTask(noteId: string, input: { noteVersionId: string; requestId: string }) {
    return requestJson<unknown>(`/v2/notes/${noteId}/mind-map-tasks`, {
      method: 'POST',
      body: input,
    }).then(parseAs(noteMindMapTaskV1Schema))
  },
  artifactTasks(noteId: string, noteVersionId?: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/learning-artifact-tasks`, {
      query: { noteVersionId },
    }).then(parseAs(noteLearningArtifactTaskPageV1Schema))
  },
  artifactTask(noteId: string, taskId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/learning-artifact-tasks/${taskId}`).then(
      parseAs(noteLearningArtifactTaskV1Schema),
    )
  },
  createArtifactTask(noteId: string, input: {
    noteVersionId: string
    requestId: string
    sourceKind: 'overview' | 'annotation'
    selectionAnchor?: NoteAnnotationAnchorV1
  }) {
    return requestJson<unknown>(`/v2/notes/${noteId}/learning-artifact-tasks`, {
      method: 'POST',
      body: input,
    }).then(parseAs(noteLearningArtifactTaskV1Schema))
  },
  /** 成品 HTML 由带凭据的 fetch 取回，再交给同源沙箱页；见 artifacts/sandbox 的说明。 */
  artifactHtml(artifactId: string, signal?: AbortSignal) {
    return requestText(`/v2/note-learning-artifacts/${artifactId}`, { signal })
  },
  annotations(noteId: string, noteVersionId?: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotations`, {
      query: { noteVersionId },
    }).then(parseAs(noteAnnotationPageV1Schema))
  },
  latestAnnotationTask(noteId: string, noteVersionId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotation-tasks/latest`, {
      query: { noteVersionId },
    }).then(parseAs(noteAnnotationLatestTaskV1Schema))
  },
  createAnnotationTask(noteId: string, input: { anchor: NoteAnnotationAnchorV1; requestId: string }) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotation-tasks`, {
      method: 'POST',
      body: input,
    }).then(parseAs(noteAnnotationTaskV1Schema))
  },
  annotationTask(noteId: string, taskId: string) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotation-tasks/${taskId}`).then(parseAs(noteAnnotationTaskV1Schema))
  },
  deleteAnnotation(noteId: string, annotationId: string, expectedRevision: number) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotations/${annotationId}`, {
      method: 'DELETE',
      body: { expectedRevision },
    }).then(parseAs(noteAnnotationWriteResultV1Schema))
  },
  createAnnotation(noteId: string, input: { anchor: NoteAnnotationAnchorV1; explanation: string; sourceMessageId?: string }) {
    return requestJson<unknown>(`/v2/notes/${noteId}/annotations`, {
      method: 'POST',
      body: input,
    }).then(parseAs(noteAnnotationWriteResultV1Schema))
  },
}
