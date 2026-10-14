import { SOURCE_IMAGE_MIME_TYPES } from '@astella/shared/source-image-contracts'

export const MAX_COMPANION_IMAGE_BYTES = 10 * 1024 * 1024

/** Validate once, before either the chat tray or the notes shelf accepts a photo. */
export function companionImageError(file: File): string | null {
  if (!SOURCE_IMAGE_MIME_TYPES.includes(file.type as typeof SOURCE_IMAGE_MIME_TYPES[number])) {
    return '暂不支持这种图片格式，请选 JPEG、PNG、GIF 或 WebP。'
  }
  if (file.size > MAX_COMPANION_IMAGE_BYTES) return '图片超过 10 MB，请压缩后再选。'
  return null
}
