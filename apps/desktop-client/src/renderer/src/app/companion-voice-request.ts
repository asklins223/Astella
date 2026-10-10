import type { GatewayResultV1, RequestMetaV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, unwrapGatewayResult } from "./desktop-client";

/** 停止朗读同时取消主进程的真实请求，避免旧回复继续占用合成队列。 */
export async function requestCompanionVoiceAudio<T>(
  invoke: (meta: RequestMetaV1) => Promise<GatewayResultV1<T>>,
  workspaceEpoch: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const meta = createRequestMeta(workspaceEpoch);
  const cancel = (): void => {
    void window.astella.runtime.cancel({ meta: createRequestMeta(), requestId: meta.requestId }).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = unwrapGatewayResult(await invoke(meta));
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
