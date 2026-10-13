import { useEffect, useRef } from 'react'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { useMotion } from '../platform/motion.ts'
import { companionEnvelope } from './speech-envelope.ts'

/**
 * 脚下那层流光。
 *
 * 它是"她刚到"这一件事：进入伴星那屏时升起一次（4.2 秒），然后落回静值。
 * 强度只有一个来源——真实音频的包络；没有声音的时候不拿文字增长冒充说话，
 * 所以流光是静的，画面里也不会有别的假节拍。
 */
const ENTRY_MS = 4200

export function CompanionFlow() {
  const root = usePhoneRoot()
  const layer = useRef<HTMLDivElement>(null)
  const motion = useMotion()

  useEffect(() => {
    const host = root
    if (!host) return
    if (motion.off) {
      host.dataset.flow = 'idle'
      companionEnvelope.calm()
      return
    }
    host.dataset.flow = 'entry'
    companionEnvelope.rise(0.55, ENTRY_MS)
    const timer = window.setTimeout(() => {
      if (host.dataset.flow === 'entry') host.dataset.flow = 'idle'
    }, ENTRY_MS)
    return () => window.clearTimeout(timer)
  }, [root, motion.off])

  // 包络把 --flow-level 写在这一层上，`.flow-breath` 与两片光跟着它呼吸。
  useEffect(() => {
    companionEnvelope.attach(layer.current)
    return () => companionEnvelope.detach()
  }, [])

  return (
    <div className="companion-flow" ref={layer} aria-hidden="true">
      <div className="flow-breath">
        <i className="flow-light" />
        <i className="flow-light flow-light-secondary" />
      </div>
    </div>
  )
}
