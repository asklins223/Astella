import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { loadOlder, type CompanionState } from '../state/companion.ts'

/** 内容变高才跟随；阅读旧消息时保留位置，前插历史保留可见消息锚点。 */
export function useThreadScroll(companion: CompanionState) {
  const scroller = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [following, setFollowing] = useState(true)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  const firstMessage = useRef(companion.messages[0]?.id)

  const rememberAnchor = useCallback(() => {
    const node = scroller.current
    if (!node) return
    const edge = node.getBoundingClientRect().top
    const visible = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > edge + 8)
    anchor.current = visible ? { id: visible.dataset.messageId!, top: visible.getBoundingClientRect().top - edge } : null
  }, [])

  const jumpToLatest = useCallback(() => {
    const node = scroller.current
    pinned.current = true
    setFollowing(true)
    if (node) node.scrollTop = node.scrollHeight
    rememberAnchor()
  }, [rememberAnchor])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (firstMessage.current !== companion.messages[0]?.id && !pinned.current && anchor.current) {
      const saved = anchor.current
      const row = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === saved.id)
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.top
    } else if (pinned.current) node.scrollTop = node.scrollHeight
    firstMessage.current = companion.messages[0]?.id
    rememberAnchor()
  }, [companion.messages, companion.turn, companion.runProcesses, companion.proposals, rememberAnchor])

  useEffect(() => {
    const node = scroller.current
    const body = content.current
    if (!node || !body) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight
      rememberAnchor()
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [rememberAnchor])

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const onScroll = () => {
      const next = node.scrollHeight - node.scrollTop - node.clientHeight < 64
      pinned.current = next
      setFollowing(next)
      node.classList.toggle('content-cut', node.scrollTop > 8)
      rememberAnchor()
      if (node.scrollTop < 120 && companion.olderAvailable && !companion.loadingHistory) void loadOlder()
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [companion.olderAvailable, companion.loadingHistory, rememberAnchor])

  return { scroller, content, following, jumpToLatest }
}
