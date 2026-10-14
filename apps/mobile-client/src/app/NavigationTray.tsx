import { useLayoutEffect, useRef } from 'react'
import { useCompanion } from '../state/companion.ts'
import { Icon } from './icons.tsx'
import { goTab, type Tab } from './nav.ts'
import { useMotion } from '../platform/motion.ts'
import { clamp, frames } from '../platform/geometry.ts'
import { interruptedUserRun } from '../run/attention.ts'

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'chat', label: '对话', icon: 'message-square-text' },
  { id: 'hand', label: '手边', icon: 'folder' },
  { id: 'notes', label: '手记', icon: 'book-open' },
]

/**
 * 底部导航。
 *
 * 那枚高亮不是换一枚贴纸，是**同一枚滑过去**。每次改向都从当前屏幕位置接着
 * 走 Demo 共用的弹簧，不跳回上一格；关闭动效时直接落位。
 */
export function NavigationTray({ tab }: { tab: Tab }) {
  const selectedIndex = TABS.findIndex((item) => item.id === tab)
  const index = Math.max(0, selectedIndex)

  const companion = useCompanion()
  const motion = useMotion()
  const indicator = useRef<HTMLSpanElement>(null)
  const indicatorAnimation = useRef<Animation | null>(null)
  const indicatorPlaced = useRef(false)
  const interrupted = Boolean(interruptedUserRun(companion))
  const connectionNeedsHelp = companion.capability !== 'off'
    && (companion.stream === 'retrying'
      || (companion.stream === 'closed' && Boolean(companion.conversationId || companion.error)))
  const handCount = companion.proposals.filter((item) => item.status === 'pending').length
    + Number(interrupted)
    + Number(connectionNeedsHelp)

  useLayoutEffect(() => {
    const node = indicator.current
    if (!node) return
    const bar = node.parentElement
    if (!bar || selectedIndex < 0) return
    let lastWidth = bar.clientWidth
    const place = (animate: boolean) => {
      // left stays fixed. Sampling the running transform before cancelling gives
      // a continuous starting point even when the user reverses several times.
      const computed = getComputedStyle(node).transform
      const current = new DOMMatrix(computed === 'none' ? undefined : computed).e
      const target = index * (bar.clientWidth - 4) / TABS.length
      indicatorAnimation.current?.cancel()
      indicatorAnimation.current = null
      node.style.transform = `translateX(${target}px)`
      const distance = Math.abs(current - target)
      if (!animate || !indicatorPlaced.current || motion.off || distance < 0.5) {
        indicatorPlaced.current = true
        return
      }
      const animation = node.animate(
        frames((progress) => ({
          transform: `translateX(${current + (target - current) * progress}px) scaleX(${1 + 0.035 * Math.sin(Math.PI * clamp(progress, 0, 1))})`,
        })),
        { duration: clamp(220 + distance * 0.45, 220, 360), easing: 'linear' },
      )
      indicatorAnimation.current = animation
      animation.onfinish = () => {
        if (indicatorAnimation.current !== animation) return
        animation.cancel()
        indicatorAnimation.current = null
      }
    }
    place(true)
    const observer = new ResizeObserver(() => {
      if (bar.clientWidth === lastWidth) return
      lastWidth = bar.clientWidth
      place(false)
    })
    observer.observe(bar)
    return () => {
      observer.disconnect()
    }
  }, [index, selectedIndex, motion.off])

  useLayoutEffect(() => () => indicatorAnimation.current?.cancel(), [])

  return (
    <div className="navigation-tray glass">
      <nav className="tabbar" role="tablist" aria-label="主要分区">
        <span
          ref={indicator}
          className="tab-indicator"
          style={{ left: '2px', visibility: selectedIndex < 0 ? 'hidden' : 'visible' }}
          aria-hidden="true"
        />
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id || (selectedIndex < 0 && item.id === 'chat') ? 0 : -1}
            aria-label={item.id === 'hand' && handCount > 0 ? `手边，有 ${handCount} 项待处理` : item.label}
            onClick={() => goTab(item.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0
                : event.key === 'End' ? TABS.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
              goTab(TABS[next]!.id)
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus({ preventScroll: true })
            }}
          >
            <Icon name={item.icon} />
            <span>{item.label}{item.id === 'hand' && handCount > 0 && <i className="tab-badge" aria-hidden="true">{handCount > 9 ? '9+' : handCount}</i>}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
