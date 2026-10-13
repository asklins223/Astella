import { useEffect, useRef, useState } from 'react'
import { SOURCE_IMAGE_MIME_TYPES, sourceImageObjectKeyFromUrl } from '@astella/shared/source-image-contracts'
import { Icon } from '../app/icons.tsx'
import { ApiError, requestBlob } from '../platform/api-client.ts'
import { getToken } from '../platform/credentials.ts'
import { handleUnauthorized } from '../state/session.ts'

/** Private image URLs need the mobile Bearer token; <img src> cannot send it. */
export function MobileImage({ url, alt, label, compact = false }: { url: string; alt: string; label: string; compact?: boolean }) {
  const objectKey = sourceImageObjectKeyFromUrl(url)
  if (!objectKey) return <ImageUnavailable label={label} compact={compact} />
  return <AuthenticatedImage objectKey={objectKey} alt={alt || label} label={label} compact={compact} />
}

function AuthenticatedImage({ objectKey, alt, label, compact }: { objectKey: string; alt: string; label: string; compact: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const liveUrl = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const requestToken = getToken()
    let active = true
    setSrc(null)
    setFailed(false)
    requestBlob(`/uploads/${objectKey}`, { signal: controller.signal })
      .then((blob) => {
        const mimeType = blob.type.split(';', 1)[0]?.trim().toLowerCase()
        if (!SOURCE_IMAGE_MIME_TYPES.includes(mimeType as typeof SOURCE_IMAGE_MIME_TYPES[number])) {
          throw new Error('图片格式不受支持。')
        }
        const objectUrl = URL.createObjectURL(blob)
        liveUrl.current = objectUrl
        if (active) setSrc(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      })
      .catch((error: unknown) => {
        if (
          active
          && !controller.signal.aborted
          && getToken() === requestToken
          && error instanceof ApiError
          && error.isUnauthorized
        ) handleUnauthorized()
        if (active && !controller.signal.aborted) setFailed(true)
      })
    return () => {
      active = false
      controller.abort()
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current)
      liveUrl.current = null
    }
  }, [objectKey, attempt])

  if (!src) {
    return (
      <div className={`mobile-image-state${failed ? ' failed' : ''}${compact ? ' compact' : ''}`} role={compact ? undefined : 'status'}>
        <Icon name="image" />
        {!compact && !failed && <span className="spinner" aria-hidden="true" />}
        {!compact && <span>{failed ? '图片没有取到' : '正在打开图片…'}</span>}
        {!compact && failed && <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>}
      </div>
    )
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => {
    if (liveUrl.current) URL.revokeObjectURL(liveUrl.current)
    liveUrl.current = null
    setSrc(null)
    setFailed(true)
  }} />
}

function ImageUnavailable({ label, compact }: { label: string; compact: boolean }) {
  return (
    <div className={`mobile-image-state failed${compact ? ' compact' : ''}`} role={compact ? undefined : 'status'}>
      <Icon name="image" />
      {!compact && <span>{label || '图片地址暂时无法打开'}</span>}
    </div>
  )
}
