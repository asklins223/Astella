/**
 * 设置页里的「语音识别模型」状态机。
 *
 * 下载是主进程那边一个跑很久的任务（239 MB），它不占这一发 invoke：
 * 这里点一下就拿到第一份读数，然后**轮询**读到装好为止。轮询而不是推送，是因为
 * 这条通道本来就已经存在、状态随时可读——为一个设置页再开一条事件流，多出来的
 * 是「谁负责在窗口关闭时注销」的活，而轮询没有这个问题。
 *
 * 轮询只在 `downloading` 时开：装好了就停，退到「等用户再点一次」而不是后台空转。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { gatewayErrorMessage } from "../../../app/desktop-client";
import {
  cancelVoiceAsrModel,
  downloadVoiceAsrModel,
  readVoiceAsrModel,
  removeVoiceAsrModel,
  type VoiceAsrModelSnapshotV1,
} from "../../companion/voice-asr-model";

/** 400ms 一次：足够让进度条看起来是连续的，又不至于把一条通道问成轮询风暴。 */
const POLL_INTERVAL_MS = 400;

export interface VoiceAsrModelController {
  readonly state: VoiceAsrModelSnapshotV1 | null;
  /** 主进程读不到状态（还没接线 / 窗口正在重启）。这不是"没装"，界面分开讲。 */
  readonly readFailure: string | null;
  readonly actionFailure: string | null;
  readonly busy: "download" | "cancel" | "remove" | null;
  readonly download: () => void;
  readonly cancel: () => void;
  readonly remove: () => void;
  readonly refresh: () => void;
}

export function useVoiceAsrModel(): VoiceAsrModelController {
  const [state, setState] = useState<VoiceAsrModelSnapshotV1 | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<VoiceAsrModelController["busy"]>(null);
  const aliveRef = useRef(true);
  const busyRef = useRef<VoiceAsrModelController["busy"]>(null);
  const readSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const next = await readVoiceAsrModel();
      if (!aliveRef.current || sequence !== readSequence.current) return null;
      setState(next);
      setReadFailure(null);
      return next;
    } catch (error) {
      if (!aliveRef.current || sequence !== readSequence.current) return null;
      setReadFailure(gatewayErrorMessage(error));
      return null;
    }
  }, []);

  useEffect(() => {
    // React Activity 与 StrictMode 都会重新启用 effect，必须恢复可接收状态。
    aliveRef.current = true;
    setBusy(busyRef.current);
    void refresh();
    return () => { aliveRef.current = false; readSequence.current++; };
  }, [refresh]);

  const downloading = state?.status === "downloading";
  useEffect(() => {
    if (!downloading) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [downloading, refresh]);

  /** 三个动作共用一条收尾：无论成功失败都回读一次，让界面跟着磁盘走而不是跟着乐观假设走。 */
  const run = useCallback(async (kind: Exclude<VoiceAsrModelController["busy"], null>, action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = kind;
    readSequence.current++;
    setBusy(kind);
    setActionFailure(null);
    try {
      await action();
    } catch (error) {
      if (aliveRef.current) setActionFailure(gatewayErrorMessage(error));
    } finally {
      await refresh();
      busyRef.current = null;
      if (aliveRef.current) setBusy(null);
    }
  }, [refresh]);

  return {
    state,
    readFailure,
    actionFailure,
    busy,
    download: useCallback(() => { void run("download", downloadVoiceAsrModel); }, [run]),
    cancel: useCallback(() => { void run("cancel", cancelVoiceAsrModel); }, [run]),
    remove: useCallback(() => { void run("remove", removeVoiceAsrModel); }, [run]),
    refresh: useCallback(() => { void refresh(); }, [refresh]),
  };
}
