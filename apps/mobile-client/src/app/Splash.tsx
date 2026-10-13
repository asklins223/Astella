import { useEffect } from 'react'
import { useMotion } from '../platform/motion.ts'

/**
 * 开屏。
 *
 * 开屏只显示安装到桌面的同一枚应用图标，不再叠加标题、标语或角色动画；
 * 图标居中落位后整层淡出，把重心递给伴星，不重建舞台。
 *
 * 网络不参与这条时间线：登录态在后台恢复，屏已经落位。
 * 关掉动效（她的设置或系统减少动态）时不留这一层，直接就位。
 */
const GONE_AT = 900

export function Splash({ onDone }: { onDone: () => void }) {
  const motion = useMotion()

  useEffect(() => {
    if (motion.off) {
      onDone()
      return
    }
    const timer = window.setTimeout(onDone, GONE_AT)
    return () => clearTimeout(timer)
  }, [motion.off, onDone])

  return (
    <div className="splash" role="presentation">
      <img className="splash-icon" src="/assets/brand/app-icon.png" alt="" />
    </div>
  )
}
