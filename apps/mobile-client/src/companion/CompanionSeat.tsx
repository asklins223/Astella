import { useLayoutEffect, useRef } from 'react'
import { useStore, createStore } from '../state/store.ts'
import { useMotion } from '../platform/motion.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { CompanionRuntime, type CompanionRuntimeState } from './live2d-runtime.ts'
import { companionEnvelope } from './speech-envelope.ts'

interface ModelState {
  seat: HTMLElement | null
  state: CompanionRuntimeState
  error: string | null
}

const modelStore = createStore<ModelState>({ seat: null, state: 'idle', error: null })

/**
 * 页面只报告角色当前的落脚位。舞台本身挂在 App 壳上，换分区或切换场景时不卸载模型，
 * 这样 WebGL 上下文和 Live2D 资源不会随着一次普通导航被销毁、重建。
 */
export function CompanionSeat() {
  const seat = useRef<HTMLDivElement>(null)
  const model = useStore(modelStore)

  useLayoutEffect(() => {
    const node = seat.current
    if (!node) return
    modelStore.set({ seat: node })
    return () => {
      if (modelStore.get().seat === node) modelStore.set({ seat: null })
    }
  }, [])

  return (
    <div className="live2d-seat" ref={seat}>
      <p className="model-status" role="status" hidden={model.state === 'ready'}>
        {model.error ?? '伴星正在过来…'}
      </p>
    </div>
  )
}

/** 常驻于 App 壳；当前页面只改变它定位到的 seat，不拥有 WebGL 生命周期。 */
export function CompanionModelStage() {
  const root = usePhoneRoot()
  const motion = useMotion()
  const { seat } = useStore(modelStore)
  const runtime = useRef<CompanionRuntime | null>(null)

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

  return null
}
