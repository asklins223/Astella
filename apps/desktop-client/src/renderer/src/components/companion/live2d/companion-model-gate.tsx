import { useEffect, useState, type ReactNode } from "react";
import type { CompanionModelSnapshotV1 } from "@astella/shared/companion-model-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { WINDOW_LIVE2D_MODEL_REGISTRY, type WindowLive2DModelId } from "./window-live2d-contract";

/**
 * 伴星入口的模型门（2026-11-18）。
 *
 * 模型不随安装包分发：某个形态第一次被载入时，先把它整份下载到本机并通过
 * 逐文件校验，**校验通过之前不进入伴星**。之后就绪状态直接放行，不再等待。
 *
 * 这里只读状态与发起下载；字节怎么来（签名 URL / 会话授权）、放哪、怎么校验
 * 全在主进程。用户在下载中途关掉伴星不会丢进度——下载跑在主进程，不随组件卸载。
 */

const POLL_INTERVAL_MS = 400;

const FAILURE_COPY: Record<NonNullable<CompanionModelSnapshotV1["failure"]>, string> = {
  network: "网络断开或学习服务连不上，模型没有下完。",
  storage: "学习服务暂时拿不到模型文件，稍后重试即可。",
  integrity: "模型文件校验没有通过，已整份丢弃；重试会重新下载。",
  disk: "磁盘空间不够，腾出一些空间后再试。",
  cancelled: "下载已停下。",
};

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function CompanionModelGate(props: {
  readonly modelId: WindowLive2DModelId;
  readonly children: ReactNode;
}) {
  const descriptor = WINDOW_LIVE2D_MODEL_REGISTRY[props.modelId];
  const serverModelId = descriptor.manifestExpectation.modelId;
  const [snapshot, setSnapshot] = useState<CompanionModelSnapshotV1 | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setFailure(null);
    const read = async () => {
      const state = unwrapGatewayResult(
        await window.astella.companion.model.getState({ meta: createRequestMeta(), modelId: serverModelId }),
      );
      if (!active) return state;
      if (state.status === "absent") {
        // 首次载入：自动开始整份下载；发起后立即返回，进度靠轮询。
        const started = unwrapGatewayResult(
          await window.astella.companion.model.download({ meta: createRequestMeta(), modelId: serverModelId }),
        );
        if (active) setSnapshot(started);
        return started;
      }
      setSnapshot(state);
      return state;
    };
    void read().catch((error: unknown) => {
      if (active) setFailure(gatewayErrorMessage(error));
    });
    return () => {
      active = false;
    };
  }, [serverModelId]);

  useEffect(() => {
    if (snapshot?.status !== "downloading") return;
    let active = true;
    const timer = window.setInterval(() => {
      void window.astella.companion.model
        .getState({ meta: createRequestMeta(), modelId: serverModelId })
        .then((result) => {
          if (active) setSnapshot(unwrapGatewayResult(result));
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [snapshot?.status, serverModelId]);

  if (snapshot?.status === "ready") return <>{props.children}</>;

  const act = (kind: "download" | "cancel") => {
    if (actionBusy) return;
    setActionBusy(true);
    setFailure(null);
    void window.astella.companion.model[kind]({ meta: createRequestMeta(), modelId: serverModelId })
      .then((result) => setSnapshot(unwrapGatewayResult(result)))
      .catch((error: unknown) => setFailure(gatewayErrorMessage(error)))
      .finally(() => setActionBusy(false));
  };

  if (snapshot === null && failure === null) {
    return <div className="companion-model-gate companion-model-gate--quiet" aria-hidden="true" />;
  }

  const totalBytes = snapshot?.totalBytes ?? 0;
  const receivedBytes = snapshot?.receivedBytes ?? 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : 0;
  const failedFailure = snapshot?.status === "failed" ? snapshot.failure : null;
  const failed = failedFailure !== null;

  return (
    <div className="companion-model-gate" role="status" aria-live="polite">
      <p className="companion-model-gate__title">「{descriptor.displayName}」第一次出现</p>
      {failed ? (
        <>
          <p className="companion-model-gate__detail">{failure ?? FAILURE_COPY[failedFailure]}</p>
          <button type="button" className="companion-model-gate__action" disabled={actionBusy} onClick={() => act("download")}>
            重新下载
          </button>
        </>
      ) : (
        <>
          <p className="companion-model-gate__detail">
            需要先把她的模型完整下载到这台电脑，校验通过后才会现身。
          </p>
          <div
            className="companion-model-gate__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="companion-model-gate__meta">
            {mb(receivedBytes)} MB / {totalBytes > 0 ? `${mb(totalBytes)} MB` : "准备中"}
          </p>
          <button
            type="button"
            className="companion-model-gate__action"
            disabled={actionBusy}
            onClick={() => act(snapshot?.status === "downloading" ? "cancel" : "download")}
          >
            {snapshot?.status === "downloading" ? "暂停下载" : "继续下载"}
          </button>
        </>
      )}
    </div>
  );
}