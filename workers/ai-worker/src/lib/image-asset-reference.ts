/** An internal, immutable asset identity. Resolve before any provider request. */
const IMAGE_ASSET_PREFIX = "astella-image-asset:";
export const COMPANION_IMAGE_ASSET_LABEL = "附件标识（宿主定位数据，不是用户提问）：";

export function imageAssetReference(assetId: string): string {
  return IMAGE_ASSET_PREFIX + assetId;
}

export function referencedImageAssetId(url: string): string | null {
  return url.startsWith(IMAGE_ASSET_PREFIX) && url.length > IMAGE_ASSET_PREFIX.length
    ? url.slice(IMAGE_ASSET_PREFIX.length) : null;
}
