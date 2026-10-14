import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../app/icons.tsx'
import { goTab } from '../app/nav.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { localRect } from '../platform/geometry.ts'
import { refreshRunArchives, useCompanion, type CompanionRunProcessRow, type ToolTrace } from '../state/companion.ts'
import { openSheet } from '../ui/sheet-store.ts'
import { useStreamedText } from './use-streamed-text.ts'

const TOOL_STATE: Record<string, string> = {
  requested: '准备执行', executing: '进行中', waiting_confirmation: '等你确认',
  succeeded: '已完成', failed: '没完成', outcome_unknown: '结果待核对',
  blocked: '未获准执行', expired: '已过期', not_executed: '没有执行', unavailable: '暂不可用',
}
const disclosureStates = new Map<string, boolean>()

function useProcessDisclosure(key: string, initial: boolean) {
  const [choice, setChoice] = useState<boolean | undefined>(() => disclosureStates.get(key))
  const open = choice ?? initial
  return [open, () => {
    disclosureStates.set(key, !open)
    setChoice(!open)
  }] as const
}

/** 一轮只留一份过程；实时与历史共用，展开由读者控制。 */
export function RunProcess({ runId, mode = 'record' }: { runId: string; mode?: 'record' | 'compact' | 'panel' }) {
  const companion = useCompanion()
  const process = companion.runProcesses[runId]
  const live = companion.turn?.runId === runId
  const [open, toggleOpen] = useProcessDisclosure(`run:${runId}`, live)
  const contentId = useId()
  const root = usePhoneRoot()
  const activeTool = [...(process?.tools ?? [])].reverse().find(tool => ['requested', 'executing', 'waiting_confirmation'].includes(tool.status))
  const last = process?.rows.at(-1)
  const preview = activeTool ? [activeTool.safeLabel, activeTool.safeSummary].filter(Boolean).join(' · ')
    : last?.kind === 'thinking' ? last.text.slice(-360)
      : last?.kind === 'tool' ? [toolLabel(last.tool), last.tool.safeSummary].filter(Boolean).join(' · ') : ''
  const shownPreview = useStreamedText(preview, live && last?.kind === 'thinking' && !activeTool)
  const archiveError = companion.runProcessErrors[runId]
  if (!process?.rows.length) return archiveError ? <p className="run-process-gap">过程记录暂时没取到。<button className="run-process-confirm" type="button" onClick={() => void refreshRunArchives([runId])}>重新读取</button></p> : null
  const label = live ? activeTool ? '正在处理' : process.phase === 'thinking' ? '正在思考' : '这轮过程'
    : process.status === 'failed' ? '这轮未完成' : ['cancelled', 'superseded'].includes(process.status) ? '这轮已停止' : '思考与操作'
  const count = process.tools.length ? `${process.tools.length} 项操作` : '思考记录'

  if (mode === 'compact') return (
    <button className="run-process-compact" type="button" data-live={live || undefined} aria-label={`${label}，${count}。查看这轮思考与操作`} onClick={event => {
      const trigger = event.currentTarget
      const origin = root ? localRect(trigger.getBoundingClientRect(), root.getBoundingClientRect()) : { x: 12, y: 200, width: 300, height: 48 }
      openSheet({ kind: 'process', title: '这轮思考与操作', origin, trigger, children: <RunProcess runId={runId} mode="panel" /> })
    }}>
      <span className="run-process-heading"><Icon name={activeTool ? 'list-tree' : 'lightbulb'} /><strong>{label}</strong><small>{count}</small><Icon name="chevron-right" /></span>
      {live && <span className="run-process-preview" aria-hidden="true">{shownPreview}</span>}
    </button>
  )

  return (
    <section className="run-process" data-live={live || undefined} data-panel={mode === 'panel' || undefined} aria-label="这轮思考与操作" aria-live="off">
      {mode !== 'panel' && <button className="run-process-toggle" type="button" aria-expanded={open} aria-controls={contentId} onClick={toggleOpen}>
        <Icon name="chevron-down" /><strong>{label}</strong><small>{count}</small>
        {!open && <span className="run-process-summary" aria-hidden="true">{preview.replace(/\s+/g, ' ').slice(-100)}</span>}
      </button>}
      <div id={contentId} hidden={mode !== 'panel' && !open}>
        <ol className="run-process-timeline">
          {process.rows.map(row => <ProcessStep key={row.key} runId={runId} row={row} live={live && last?.key === row.key} />)}
        </ol>
        {process.thinkingGapped && <p className="run-process-gap">中间有思考片段未收到，已保留实际收到的内容。</p>}
        {process.error && <p className="run-process-gap" role="status">{process.error}</p>}
        {archiveError && <p className="run-process-gap">完整记录暂时没取到，已收到的过程仍保留。<button className="run-process-confirm" type="button" onClick={() => void refreshRunArchives([runId])}>重新读取</button></p>}
      </div>
    </section>
  )
}

function ProcessStep({ runId, row, live }: { runId: string; row: CompanionRunProcessRow; live: boolean }) {
  const [expanded, toggleExpanded] = useProcessDisclosure(`${runId}:${row.key}`, row.kind === 'thinking' && live)
  const contentId = useId()
  const body = useRef<HTMLParagraphElement>(null)
  const pinned = useRef(true)
  const thought = row.kind === 'thinking'
  const text = thought ? row.text : row.tool.safeSummary ?? ''
  const shownText = useStreamedText(text, live && thought)
  const label = thought ? live ? '正在思考' : '思考' : toolLabel(row.tool)
  const state = thought ? live ? '正在输出' : '已记录' : toolState(row.tool)
  useLayoutEffect(() => {
    if (thought && live && expanded && pinned.current && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [expanded, live, shownText, thought])
  return (
    <li className="run-process-step" data-kind={row.kind} data-state={thought ? 'thinking' : row.tool.status}>
      <button type="button" className="run-process-step-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={toggleExpanded}>
        <span className="run-process-mark"><Icon name={thought ? 'lightbulb' : row.tool.status === 'succeeded' ? 'check' : 'list-tree'} /></span>
        <span className="run-process-step-copy"><strong>{label}</strong><small>{state}</small></span>
        <Icon name="chevron-down" />
      </button>
      <div id={contentId} className="run-process-step-detail" hidden={!expanded}>
        <p ref={body} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24 }}>{shownText || state}</p>
        {!thought && row.tool.status === 'waiting_confirmation' && row.tool.proposalId && <button className="run-process-confirm" type="button" onClick={() => goTab('hand')}>查看待确认的操作<Icon name="arrow-right" /></button>}
        {thought && row.gapped && <small>这段与上一段之间有未收到的片段。</small>}
      </div>
    </li>
  )
}

function toolState(tool: ToolTrace): string {
  return TOOL_STATE[tool.status] ?? '结果待核对'
}

function toolLabel(tool: ToolTrace): string {
  return tool.safeLabel.replace(/^正在/, '') || tool.safeLabel
}
