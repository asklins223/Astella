import { useEffect, useState } from "react";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { createRequestMeta, getCurrentWorkspaceEpoch, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { subscribeGateInvalidation } from "../../../app/gate-invalidation";

/**
 * 一张图片在渲染层可能的归宿。
 *
 * 来源解析把网页内嵌图片下载后写进对象存储，正文引用随之变成
 * `/api/uploads/{objectKey}`。渲染层跑在 `astella-app://` 下：这个相对路径会落到
 * 应用包内（404），而回退保留的外链又会被渲染层 CSP（`img-src 'self' data: blob:`）
 * 拦掉。所以站内图片走 main 的字节通道取回，这里转成 blob URL 交给 `<img>`。
 * CSP 已经允许 `blob:`，不需要为它放宽任何策略。
 */
export type SourceImageState =
  /** 站外直链：渲染层直接交给 `<img>`，与通道和会话无关。 */
  | { readonly status: "external"; readonly src: string }
  /** 站内对象正在取字节。 */
  | { readonly status: "loading" }
  /** 站内对象已就位，`src` 是一个 blob URL。 */
  | { readonly status: "ready"; readonly src: string }
  /** 站内对象取不回来（越权、已删除、服务不可用）——正文照旧读，只有图缺失。 */
  | { readonly status: "unavailable" };

/**
 * blob URL 的进程内缓存。
 *
 * 同一张图会在正文片段、笔记块、翻页回看时被反复渲染，按 objectKey 缓存使每次
 * 呈现最多只取一次字节。按部署、账号和工作区纪元隔离，门禁失效时清理；
 * 上限之外按最久未读淘汰，并回收被淘汰图片的 blob URL。
 */
const blobUrlCache = new Map<string, Promise<string | null>>();
const MAX_CACHED_IMAGE_BLOBS = 64;

function cacheKey(objectKey: string, workspaceEpoch?: number): string {
  const scope = useRoomStore.getState().spaceIdentity;
  return `${scope?.deploymentRef ?? ""}:${scope?.userId ?? ""}:${workspaceEpoch ?? getCurrentWorkspaceEpoch()}:${objectKey}`;
}

function clearSourceImageCache(): void {
  for (const value of blobUrlCache.values()) void value.then(url => { if (url) URL.revokeObjectURL(url); });
  blobUrlCache.clear();
}
subscribeGateInvalidation(clearSourceImageCache);

/** 服务端确认保存了原图片之后直接显示本机文件，避免上传后立刻再下载一遍。 */
export function primeSourceImageBlobUrl(objectKey: string, file: Blob, workspaceEpoch?: number): void {
  const key = cacheKey(objectKey, workspaceEpoch);
  const previous = blobUrlCache.get(key);
  blobUrlCache.set(key, Promise.resolve(URL.createObjectURL(file)));
  if (previous) void previous.then(url => { if (url) URL.revokeObjectURL(url); });
  trimSourceImageCache();
}

function trimSourceImageCache(): void {
  while (blobUrlCache.size > MAX_CACHED_IMAGE_BLOBS) {
    const oldest = blobUrlCache.entries().next();
    if (oldest.done) break;
    blobUrlCache.delete(oldest.value[0]);
    void oldest.value[1].then(url => { if (url) URL.revokeObjectURL(url); });
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function fetchSourceImageBlobUrl(objectKey: string, workspaceEpoch?: number): Promise<string | null> {
  if (!window.astella) return null;
  try {
    const result = unwrapGatewayResult(await window.astella.source.getImage({
      meta: createRequestMeta(workspaceEpoch),
      request: { version: 1, objectKey },
    }));
    return URL.createObjectURL(base64ToBlob(result.imageBase64, result.mimeType));
  } catch {
    // 取图失败不是阅读失败：正文照旧铺开，只有这一张图缺位。
    return null;
  }
}

/**
 * 取一张站内图片的 blob URL，走上面那份缓存。
 *
 * 除了 `useSourceImage`（阅读页的图片块），笔记编辑器里的图片节点视图也用它：
 * 编辑器里同样够不到 `/api/uploads/…`，节点视图必须把那串地址换成 blob URL 才
 * 画得出来。两处共用一个缓存，同一张图在一篇笔记里只取一次字节。
 */
export function loadSourceImageBlobUrl(objectKey: string, workspaceEpoch?: number): Promise<string | null> {
  const key = cacheKey(objectKey, workspaceEpoch);
  const cached = blobUrlCache.get(key);
  if (cached) {
    // 命中即移到队尾，使淘汰永远落在最久没被读到的图上。
    blobUrlCache.delete(key);
    blobUrlCache.set(key, cached);
    return cached;
  }

  const pending = fetchSourceImageBlobUrl(objectKey, workspaceEpoch);
  blobUrlCache.set(key, pending);
  // 取不回的图不驻留缓存：失败往往是瞬时的（API 正在重启、网络抖动），
  // 缓存住 null 会把这张图冻死到 LRU 逐出为止——下一次渲染必须真的重取。
  void pending.then((url) => {
    if (url === null && blobUrlCache.get(key) === pending) blobUrlCache.delete(key);
  });
  trimSourceImageCache();
  return pending;
}

/** 丢掉一张图的缓存（图片加载失败时调用），让下一次渲染重新取。 */
export function invalidateSourceImage(objectKey: string, workspaceEpoch?: number): void {
  const key = cacheKey(objectKey, workspaceEpoch);
  const cached = blobUrlCache.get(key);
  if (!cached) return;
  blobUrlCache.delete(key);
  void cached.then((url) => { if (url) URL.revokeObjectURL(url); });
}

/** 站外直链直接交给 `<img>`；其余不可达地址如实标记为取不回来。 */
function staticState(url: string): SourceImageState {
  return /^https?:\/\//.test(url)
    ? { status: "external", src: url }
    : { status: "unavailable" };
}

/**
 * 把一段图片地址解析成可以直接交给 `<img>` 的 `src`。
 *
 * 站内地址（`/api/uploads/…`）会被换成一个 blob URL；站外地址原样返回。地址形状
 * 由 `sourceImageObjectKeyFromUrl` 判定，与 main 侧复核用的是同一份规则。
 */
export type SourceImageHandle = {
  readonly state: SourceImageState;
  /**
   * 图片元素加载失败时调用：丢掉这一张的缓存并重新取一次。
   *
   * 这是"缓存淘汰回收了仍挂在屏上的 blob URL"的兜底。每挂载一次最多重取一次，
   * 免得一张真损坏的图把渲染拖进重试循环。
   */
  readonly retry: () => void;
  /** Explicit user action may retry again after a second transient failure. */
  readonly reload: () => void;
};

export function useSourceImage(url: string, workspaceEpoch?: number): SourceImageHandle {
  const objectKey = sourceImageObjectKeyFromUrl(url);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SourceImageState>(() => (
    objectKey ? { status: "loading" } : staticState(url)
  ));

  useEffect(() => {
    if (!objectKey) {
      setState(staticState(url));
      return;
    }
    let active = true;
    setState({ status: "loading" });
    void loadSourceImageBlobUrl(objectKey, workspaceEpoch).then((blobUrl) => {
      if (!active) return;
      setState(blobUrl ? { status: "ready", src: blobUrl } : { status: "unavailable" });
    });
    return () => { active = false; };
  }, [objectKey, url, workspaceEpoch, attempt]);

  const retry = () => {
    if (!objectKey || attempt > 0) return;
    invalidateSourceImage(objectKey, workspaceEpoch);
    setAttempt((value) => value + 1);
  };

  const reload = () => {
    if (!objectKey) return;
    invalidateSourceImage(objectKey, workspaceEpoch);
    setAttempt(value => value + 1);
  };

  return { state, retry, reload };
}
