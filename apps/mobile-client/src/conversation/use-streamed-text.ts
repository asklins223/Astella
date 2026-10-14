import { useEffect, useRef, useState } from 'react'
import { useMotion } from '../platform/motion.ts'

/** 展示追赶已收到的增量；增量持续到来时复用同一帧循环，不等流结束才刷新。 */
export function useStreamedText(text: string, live: boolean): string {
  const motion = useMotion()
  const target = live ? text.slice(-1600) : text
  const targetRef = useRef(target)
  targetRef.current = target
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  const frame = useRef<number | null>(null)
  const running = useRef(false)

  useEffect(() => {
    const cancel = () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
      frame.current = null
      running.current = false
    }

    if (!live || motion.off) {
      cancel()
      current.current = target
      setShown(previous => previous === target ? previous : target)
      return
    }

    if (!target.startsWith(current.current)) {
      current.current = target
      setShown(previous => previous === target ? previous : target)
      return
    }
    if (current.current === target || running.current) return

    running.current = true
    let lastReveal = performance.now()
    const advance = (now: number) => {
      const destination = targetRef.current
      const previous = current.current

      if (!destination.startsWith(previous)) {
        current.current = destination
        setShown(destination)
      } else if (destination !== previous && now - lastReveal >= 45) {
        lastReveal = now
        const gap = destination.length - previous.length
        const nextLength = Math.min(destination.length, previous.length + Math.max(1, Math.ceil(gap / 5)))
        current.current = destination.slice(0, nextLength)
        setShown(current.current)
      }

      if (current.current !== targetRef.current) {
        frame.current = window.requestAnimationFrame(advance)
      } else {
        frame.current = null
        running.current = false
      }
    }
    frame.current = window.requestAnimationFrame(advance)
  }, [target, live, motion.off])

  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    frame.current = null
    running.current = false
  }, [])

  return !live || motion.off ? target : shown
}
