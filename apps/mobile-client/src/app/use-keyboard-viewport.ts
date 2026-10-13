import { useEffect, useState } from 'react'

/** 软键盘出现时，让输入区跟着可见视口落位。焦点不等待过渡。 */
export function useKeyboardViewport() {
  const [viewport, setViewport] = useState<{ height: number; keyboard: boolean } | null>(null)
  useEffect(() => {
    const visual = window.visualViewport
    if (!visual) return
    const update = () => setViewport({
      height: visual.height + visual.offsetTop,
      keyboard: window.innerHeight - visual.height > 120,
    })
    update()
    visual.addEventListener('resize', update)
    visual.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      visual.removeEventListener('resize', update)
      visual.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return viewport
}
