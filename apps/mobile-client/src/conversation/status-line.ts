import type { CompanionState } from '../state/companion.ts'

/**
 * 状态那一句话。三处共用（顶栏名字签、场景气泡、脚下副句），
 * 因为它们是同一件事：她此刻到底在做什么。
 */
export function companionLine(companion: CompanionState, detail = false): string {
  if (companion.capability === 'off') return '这台服务端没开对话'
  if (!companion.conversationId) return companion.error ? '连接失败' : '正在接上书房…'
  if (!companion.historyReady) return companion.error ? '同步没有完成' : '正在同步对话…'
  if (companion.stream === 'connecting' || companion.stream === 'retrying') return '正在接上…'
  if (companion.stream === 'closed') return '连接已断开'
  const turn = companion.turn
  if (turn && (!turn.initiative || turn.visible)) return turn.statusLabel ?? PHASE_LABEL[turn.phase]
  return detail ? '陪你读' : '我在'
}

const PHASE_LABEL: Record<NonNullable<CompanionState['turn']>['phase'], string> = {
  waiting: '正在路上',
  thinking: '正在想',
  acting: '正在动手',
  streaming: '正在回复',
}

/** 活的那一轮还没落库，措辞从 phase 直接给。 */
export function turnLine(turn: NonNullable<CompanionState['turn']>): string {
  return turn.statusLabel ?? PHASE_LABEL[turn.phase]
}

/** 气泡里那句是她正在说的话；太长了交给样式截三行，不在这儿砍字。 */
export function speakingText(companion: CompanionState, latest: string): string {
  const live = companion.turn?.text ?? ''
  return live || latest || '我在。想聊什么，直接告诉我。'
}
