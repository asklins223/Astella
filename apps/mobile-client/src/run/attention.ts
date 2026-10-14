import type { CompanionState } from '../state/companion.ts'

/** 已答复的交流和后台自主考虑不成为一项等待用户重发的任务。 */
export function interruptedUserRun(companion: CompanionState) {
  const latest = companion.runs.filter(run => Boolean(run.userMessageId))
    .reduce<CompanionState['runs'][number] | undefined>((saved, run) => !saved || run.generation > saved.generation ? run : saved, undefined)
  return latest && !latest.assistantMessageId && ['failed', 'cancelled'].includes(latest.status) ? latest : undefined
}
