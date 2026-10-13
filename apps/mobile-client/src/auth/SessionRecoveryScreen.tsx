import { useEffect, useState } from 'react'
import type { SessionStatus } from '../state/session.ts'

type RecoveryStatus = Extract<SessionStatus, 'unknown' | 'restoring' | 'unavailable'>

/** Keep startup honest: restoration and a retryable outage are different states. */
export function SessionRecoveryScreen({
  status,
  error,
  onRetry,
}: {
  status: RecoveryStatus
  error: string | null
  onRetry: () => void
}) {
  const unavailable = status === 'unavailable'
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (status !== 'restoring') {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [status])

  return (
    <section className="viewport boot-scroll session-recovery" aria-labelledby="session-recovery-title">
      <img className="session-app-icon" src="/assets/brand/app-icon.png" alt="" />
      <div className="session-recovery-copy">
        <h1 id="session-recovery-title">{unavailable ? '暂时接不上书房' : slow ? '连接时间有点久' : '正在回到书房'}</h1>
        <p role={unavailable ? 'alert' : 'status'}>
          {unavailable
            ? error || '网络恢复后可以重试；这台设备上的登录状态会保留。'
            : slow
              ? '书房还没回应。可以重试连接；这台设备上的登录状态会保留。'
              : '正在确认登录状态，接上后会继续上次的交流。'}
        </p>
      </div>
      {unavailable || slow ? (
        <button className="session-recovery-retry" type="button" onClick={onRetry}>重新连接</button>
      ) : (
        <span className="session-recovery-progress" aria-hidden="true"><i /></span>
      )}
    </section>
  )
}
