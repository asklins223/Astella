import { companionAgentToolEventV1Schema, type CompanionAgentToolEventV1 } from '@astella/shared/companion-agent-contracts'
import type { CompanionRunNode, CompanionRunSnapshot } from '../platform/api.ts'

// Durable archives deliberately omit toolVersion/riskClass and all execution data.
// Parse only the display contract; the full realtime schema is stricter than this projection.
const processToolSchema = companionAgentToolEventV1Schema.pick({
  toolCallId: true, name: true, status: true, safeLabel: true, safeSummary: true,
  proposalId: true, preparationToolCallId: true,
}).strip()

export function readProcessTool(value: unknown): ToolTrace | null {
  const parsed = processToolSchema.safeParse(value)
  return parsed.success ? { ...parsed.data, eventSeq: 0 } : null
}

export interface ToolTrace {
  toolCallId: string
  name: string
  status: CompanionAgentToolEventV1['status']
  safeLabel: string
  safeSummary?: string
  proposalId?: string
  preparationToolCallId?: string
  eventSeq: number
}

export type CompanionRunProcessRow = {
  key: string
  kind: 'thinking'
  text: string
  firstIndex: number
  lastIndex: number
  gapped: boolean
} | {
  key: string
  kind: 'tool'
  tool: ToolTrace
}

export interface CompanionRunProcess {
  runId: string
  generation: number
  status: string
  phase: 'waiting' | 'thinking' | 'acting' | 'streaming'
  statusLabel: string | null
  error: string | null
  thinkingText: string
  thinkingLastIndex: number
  thinkingGapped: boolean
  tools: ToolTrace[]
  /** Ordered display rows: a tool separates two stretches of thinking. */
  rows: CompanionRunProcessRow[]
  /** Retain the real process frames so a later slim archive can add, never erase, live steps. */
  events: CompanionRunNode[]
  lastSeq: number
}

export function emptyRunProcess(runId: string, generation = 0): CompanionRunProcess {
  return { runId, generation, status: 'running', phase: 'waiting', statusLabel: null, error: null,
    thinkingText: '', thinkingLastIndex: -1, thinkingGapped: false, tools: [], rows: [], events: [], lastSeq: -1 }
}

/** One call keeps its place as requested/executing/terminal receipts arrive. */
export function upsertProcessTool(tools: ToolTrace[], trace: ToolTrace): ToolTrace[] {
  const previewId = trace.preparationToolCallId !== trace.toolCallId ? trace.preparationToolCallId : undefined
  const saved = tools.find((tool) => tool.toolCallId === trace.toolCallId)
  if (saved && saved.eventSeq >= trace.eventSeq) return tools
  const index = tools.findIndex((tool) => tool.toolCallId === trace.toolCallId || tool.toolCallId === previewId)
  if (index < 0) return [...tools, trace]
  return tools.flatMap((tool, at) => {
    if (at === index) return [trace]
    if (tool.toolCallId === trace.toolCallId || tool.toolCallId === previewId) return []
    return [tool]
  })
}

export function processToolTrace(tool: CompanionAgentToolEventV1, seq: number): ToolTrace {
  return { toolCallId: tool.toolCallId, name: tool.name, status: tool.status,
    safeLabel: tool.safeLabel, eventSeq: seq,
    ...(tool.safeSummary ? { safeSummary: tool.safeSummary } : {}),
    ...(tool.proposalId ? { proposalId: tool.proposalId } : {}),
    ...(tool.preparationToolCallId ? { preparationToolCallId: tool.preparationToolCallId } : {}) }
}

/** Live WS and persisted processTimeline use the same projection. */
export function appendRunProcess(process: CompanionRunProcess, node: CompanionRunNode): CompanionRunProcess {
  if (node.runId !== process.runId || node.seq <= process.lastSeq) return process
  const base = { ...process, lastSeq: node.seq, events: [...process.events, node] }
  if (!node.payload || typeof node.payload !== 'object') return base
  const payload = node.payload as Record<string, unknown>
  if (node.type === 'assistant.status') {
    if ((payload.status !== 'waiting' && payload.status !== 'thinking' && payload.status !== 'acting') || typeof payload.safeLabel !== 'string') return base
    return { ...base, phase: payload.status, statusLabel: payload.safeLabel }
  }
  if (node.type === 'assistant.thinking') {
    const { index, text } = payload
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || typeof text !== 'string' || !text || index <= process.thinkingLastIndex) return base
    const gapped = index !== process.thinkingLastIndex + 1
    const last = process.rows.at(-1)
    const rows: CompanionRunProcessRow[] = last?.kind === 'thinking' && !gapped
      ? [...process.rows.slice(0, -1), { ...last, text: last.text + text, lastIndex: index }]
      : [...process.rows, { key: `thinking:${index}`, kind: 'thinking', text, firstIndex: index, lastIndex: index, gapped }]
    return { ...base, phase: 'thinking', statusLabel: process.phase === 'thinking' ? process.statusLabel : null,
      thinkingText: process.thinkingText + (gapped && process.thinkingText ? '\n\n' : '') + text,
      thinkingLastIndex: index, thinkingGapped: process.thinkingGapped || gapped, rows }
  }
  if (node.type === 'agent.tool') {
    const parsed = readProcessTool(payload.tool)
    if (!parsed) return base
    const trace = { ...parsed, eventSeq: node.seq }
    const tools = upsertProcessTool(process.tools, trace)
    const previewId = trace.preparationToolCallId !== trace.toolCallId ? trace.preparationToolCallId : undefined
    const index = process.rows.findIndex((row) => row.kind === 'tool' && (row.tool.toolCallId === trace.toolCallId || row.tool.toolCallId === previewId))
    const row: CompanionRunProcessRow = { key: `tool:${trace.toolCallId}`, kind: 'tool', tool: trace }
    const rows = index < 0 ? [...process.rows, row] : process.rows.flatMap((current, at) => {
      if (at === index) return [row]
      if (current.kind === 'tool' && (current.tool.toolCallId === trace.toolCallId || current.tool.toolCallId === previewId)) return []
      return [current]
    })
    const busy = [...tools].reverse().find((tool) => tool.status === 'requested' || tool.status === 'executing' || tool.status === 'waiting_confirmation')
    return { ...base, tools, rows, phase: busy ? 'acting' : process.phase === 'streaming' ? 'streaming' : 'waiting',
      statusLabel: busy?.safeLabel ?? null }
  }
  return base
}

export function restoreRunProcesses(snapshot: CompanionRunSnapshot): Record<string, CompanionRunProcess> {
  const processes: Record<string, CompanionRunProcess> = {}
  for (const run of snapshot.runs) {
    const events = mergeProcessEvents(run.processTimeline ?? [], snapshot.items.filter((node) => node.runId === run.runId))
    let process = emptyRunProcess(run.runId, run.generation)
    for (const event of events) process = appendRunProcess(process, event)
    // The full archive is authoritative; gaps in the TTL event window never become fabricated prose.
    if (typeof run.thinkingText === 'string') {
      process = { ...process, thinkingText: run.thinkingText, thinkingGapped: false }
      if (!process.rows.length && run.thinkingText) process.rows = [{ key: 'thinking:archive', kind: 'thinking',
        text: run.thinkingText, firstIndex: 0, lastIndex: process.thinkingLastIndex, gapped: false }]
    }
    processes[run.runId] = { ...process, status: run.status }
  }
  // The recent node window can include an active run outside the requested history ids.
  for (const node of snapshot.items) {
    if (!node.runId || processes[node.runId]) continue
    processes[node.runId] = emptyRunProcess(node.runId)
    for (const event of snapshot.items.filter((item) => item.runId === node.runId)) {
      processes[node.runId] = appendRunProcess(processes[node.runId]!, event)
    }
  }
  return processes
}

/** A late archive response must not rewind newer live receipts. */
export function mergeRunProcesses(
  current: Record<string, CompanionRunProcess>,
  incoming: Record<string, CompanionRunProcess>,
): Record<string, CompanionRunProcess> {
  const merged = { ...current }
  for (const [runId, process] of Object.entries(incoming)) {
    const live = current[runId]
    if (!live) {
      merged[runId] = process
      continue
    }
    let combined = emptyRunProcess(runId, process.generation || live.generation)
    for (const event of mergeProcessEvents(process.events ?? [], live.events ?? [])) combined = appendRunProcess(combined, event)
    const status = isTerminalProcessStatus(process.status) ? process.status
      : isTerminalProcessStatus(live.status) ? live.status : process.status
    const archiveHasAllThinking = !process.thinkingGapped && process.thinkingLastIndex >= combined.thinkingLastIndex
    const thinkingText = archiveHasAllThinking && process.thinkingText.length >= combined.thinkingText.length
      ? process.thinkingText : combined.thinkingText
    // Old runs with only thinking_text have no recorded chronology; keep their archive row.
    const rows = combined.rows.length ? combined.rows : process.rows.length ? process.rows : live.rows
    merged[runId] = { ...combined, status, rows, thinkingText, error: live.error ?? process.error,
      thinkingGapped: archiveHasAllThinking ? process.thinkingGapped : combined.thinkingGapped,
      phase: live.phase === 'streaming' && live.lastSeq >= process.lastSeq ? live.phase : combined.phase,
      statusLabel: isTerminalProcessStatus(status) ? null : combined.statusLabel }
  }
  return merged
}

/** A slim duplicate cannot discard richer fields in an already received frame. */
function mergeProcessEvents(archive: CompanionRunNode[], live: CompanionRunNode[]): CompanionRunNode[] {
  const bySeq = new Map<number, CompanionRunNode>()
  for (const event of [...archive, ...live]) {
    const existing = bySeq.get(event.seq)
    if (!existing || event.type !== 'agent.tool' || existing.type !== 'agent.tool') {
      bySeq.set(event.seq, event)
      continue
    }
    const oldPayload = existing.payload as { tool?: Record<string, unknown> }
    const newPayload = event.payload as { tool?: Record<string, unknown> }
    bySeq.set(event.seq, { ...event, payload: { tool: { ...oldPayload.tool, ...newPayload.tool } } })
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

export function isTerminalProcessStatus(status: string): boolean {
  return status !== 'accepted' && status !== 'running' && status !== 'waiting_for_confirmation' && status !== 'cancel_requested'
}
