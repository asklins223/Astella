import { useLayoutEffect, useRef } from 'react'
import { useStore, createStore } from '../state/store.ts'
import { useMotion } from '../platform/motion.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { CompanionRuntime, type CompanionRuntimeState } from './live2d-runtime.ts'
import { companionEnvelope } from './speech-envelope.ts'
import { useCompanion } from '../state/companion.ts'

interface ModelState {
  seat: HTMLElement | null
  state: CompanionRuntimeState
  error: string | null
}

const modelStore = createStore<ModelState>({ seat: null, state: 'idle', error: null })
const seats = new Map<HTMLElement, number>()
function chooseSeat(): void {
  const next = [...seats].filter(([node]) => node.isConnected)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  modelStore.set({ seat: next })
}

/**
 * 页面只报告角色当前的落脚位。舞台本身挂在 App 壳上，换分区或切换场景时不卸载模型，
 * 这样 WebGL 上下文和 Live2D 资源不会随着一次普通导航被销毁、重建。
 */
export function CompanionSeat({ variant = 'scene' }: { variant?: 'scene' | 'compact' | 'panel' }) {
  const seat = useRef<HTMLDivElement>(null)
  const model = useStore(modelStore)

  useLayoutEffect(() => {
    const node = seat.current
    if (!node) return
    seats.set(node, variant === 'panel' ? 30 : variant === 'scene' ? 20 : 10)
    chooseSeat()
    return () => {
      seats.delete(node)
      chooseSeat()
    }
  }, [variant])

  return (
    <div className="live2d-seat" ref={seat} data-companion-seat={variant} aria-hidden={variant !== 'scene' || undefined}>
      <p className="model-status" role="status" hidden={model.state === 'ready'}>
        {variant === 'compact' ? '伴星' : model.error ?? '伴星正在过来…'}
      </p>
    </div>
  )
}

/** 常驻于 App 壳；当前页面只改变它定位到的 seat，不拥有 WebGL 生命周期。 */
export function CompanionModelStage() {
  const root = usePhoneRoot()
  const motion = useMotion()
  const companion = useCompanion()
  const { seat, state: modelState } = useStore(modelStore)
  const runtime = useRef<CompanionRuntime | null>(null)
  const animatedRun = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!root) return
    const instance = new CompanionRuntime(root, () => companionEnvelope.get(), (state, error) => {
      modelStore.set({ state, error })
    })
    runtime.current = instance
    return () => {
      instance.dispose()
      runtime.current = null
    }
  }, [root])

  useLayoutEffect(() => {
    runtime.current?.sync(seat, motion.off)
    if (motion.off) companionEnvelope.calm()
  }, [motion.off, root, seat])

  const turn = companion.turn
  const activity = turn && (!turn.initiative || turn.visible) ? turn.phase : 'idle'
  useLayoutEffect(() => {
    runtime.current?.setActivity(activity, motion.off)
  }, [activity, motion.off, seat])

  useLayoutEffect(() => {
    if (!turn) {
      animatedRun.current = null
      return
    }
    // The model may still be loading when a turn begins. Wait for the real
    // Live2D stage before consuming this run's one acknowledgement motion.
    if (!turn.visible || !turn.runId || modelState !== 'ready' || !seat) return
    if (animatedRun.current === turn.runId) return
    animatedRun.current = turn.runId
    if (!motion.off) runtime.current?.playMotion('Bubble')
  }, [modelState, motion.off, seat, turn?.runId, turn?.visible])

  return null
}
