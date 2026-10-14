/** Shared geometry for contextual panels and small physical feedback. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 略微欠阻尼：有一小段回弹的尾巴，但不橡皮。 */
export function spring(t: number): number {
  return 1 - Math.exp(-8.5 * t) * (Math.cos(8 * t) + 1.0625 * Math.sin(8 * t))
}

export function frames(
  make: (eased: number, progress: number) => Record<string, string | number>,
  count = 48,
): Keyframe[] {
  return Array.from({ length: count + 1 }, (_, index) => {
    const offset = index / count
    return { ...make(index === count ? 1 : spring(offset), offset), offset }
  })
}

export function localRect(rect: DOMRect, root: DOMRect): Rect {
  return { x: rect.left - root.left, y: rect.top - root.top, width: rect.width, height: rect.height }
}

/**
 * `expanded` 那一类是内容面板（提问、选笔记、同意、她的活），居中贴着底；
 * 其余从触发它的那一枚长出来，落不下去就往上翻。
 */
export function panelPlacement(kind: string, origin: Rect, size: Size, height: number): Rect {
  const margin = Math.min(12, size.width / 12)
  const expanded = ['ask', 'companion-chat', 'note-picker', 'consent', 'selection', 'annotation'].includes(kind)
  const width = Math.max(0, expanded ? size.width - margin * 2 : Math.min(size.width - margin * 2, 344))
  const top = Math.min(48, Math.max(margin, size.height * 0.08))
  const bottom = Math.min(16, margin)
  const maxHeight = Math.max(0, size.height - top - bottom)
  const resolved = clamp(height, 0, maxHeight)
  let x = expanded ? (size.width - width) / 2 : origin.x
  let y = expanded ? size.height - resolved - bottom : origin.y + origin.height + 9
  if (!expanded && y + resolved > size.height - bottom) y = origin.y - resolved - 10
  return {
    x: clamp(x, margin, Math.max(margin, size.width - width - margin)),
    y: clamp(y, top, Math.max(top, size.height - resolved - bottom)),
    width,
    height: resolved,
  }
}

export function rectTransform(from: Rect, to: Rect): { x: number; y: number; sx: number; sy: number } {
  return {
    x: from.x - to.x,
    y: from.y - to.y,
    sx: Math.max(0.04, from.width / Math.max(1, to.width)),
    sy: Math.max(0.04, from.height / Math.max(1, to.height)),
  }
}

export function transformOf({ x = 0, y = 0, sx = 1, sy = 1 }: { x?: number; y?: number; sx?: number; sy?: number }): string {
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy})`
}
