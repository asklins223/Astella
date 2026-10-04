import { Check, Download, HardDrive, Mic, ShieldCheck, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import {
  VOICE_ASR_MODEL_NAME,
  VOICE_ASR_MODEL_SIZE_LINE,
  voiceAsrModelBytesLine,
  voiceAsrModelFailureLine,
  voiceAsrModelPercent,
  voiceAsrModelSourceLine,
  voiceAsrModelStatusLine,
} from "../../companion/voice-asr-model";
import type { VoiceAsrModelController } from "./use-voice-asr-model";

/** 可选的本机模型：状态、实际传输与下一步操作放在同一张纸面上。 */
export function SettingsVoiceModelCard(props: { readonly model: VoiceAsrModelController }) {
  const { state, readFailure, actionFailure, busy, download, cancel, remove, refresh } = props.model;
  const percent = state ? voiceAsrModelPercent(state) : null;
  const status = readFailure ? "unknown" : state?.status ?? null;
  const disabled = busy !== null || !state || Boolean(readFailure);
  const source = voiceAsrModelSourceLine(state);
  const verifying = state?.status === "downloading" && state.receivedBytes >= state.expectedBytes;
  const cardRef = useRef<HTMLDivElement>(null);
  const focusedButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!focusedButton.current || focusedButton.current.isConnected || busy) return;
    focusedButton.current = null;
    // 状态换了按钮时接续键盘位置；用户已经移开焦点时不抢回。
    if (document.activeElement === document.body) cardRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [status, busy]);

  return (
    <div ref={cardRef} className="settings-voice-model" data-status={status ?? "loading"} tabIndex={-1} role="group" aria-label="本机语音识别模型" onFocusCapture={event => {
      focusedButton.current = event.target instanceof HTMLButtonElement ? event.target : null;
    }}>
      <div className="settings-voice-model__head">
        <span className="settings-voice-model__plate" aria-hidden="true"><Mic size={22} /></span>
        <div className="settings-voice-model__copy">
          <strong>{VOICE_ASR_MODEL_NAME}</strong>
          <p>支持普通话、粤语、英语、日语和韩语。</p>
        </div>
        <span className="settings-voice-model__state" role="status">
          {status === "ready" ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}
          {voiceAsrModelStatusLine(status)}
        </span>
      </div>

      <div className="settings-voice-model__facts">
        <span><HardDrive size={14} aria-hidden="true" />约 {VOICE_ASR_MODEL_SIZE_LINE} · 本机安装</span>
        <span><ShieldCheck size={14} aria-hidden="true" />识别时录音不离开设备</span>
      </div>

      {status === "downloading" && state ? (
        <div className="settings-voice-model__progress">
          <div className="settings-voice-model__transfer">
            <span>{verifying ? "正在校验并安装…" : state.activeSource ? `正在从${state.activeSource}下载` : "正在连接下载源…"}</span>
            <b>{percent === null ? "下载中" : `${percent}%`}</b>
            <button type="button" className="button settings-voice-model__cancel" disabled={busy !== null} onClick={cancel}>
              <X size={14} aria-hidden="true" />{busy === "cancel" ? "正在取消…" : "取消下载"}
            </button>
          </div>
          <span
            className="settings-voice-model__meter"
            role="progressbar"
            aria-label="模型下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent === null ? {} : { "aria-valuenow": percent, "aria-valuetext": `${percent}%` })}
            style={{ "--fill": `${percent ?? 0}%` } as CSSProperties}
          ><i /></span>
          <small>{voiceAsrModelBytesLine(state.receivedBytes)} / {VOICE_ASR_MODEL_SIZE_LINE} · 下载完成后自动安装</small>
        </div>
      ) : null}

      {source ? <p className="settings-voice-model__source">下载来源：{source}。</p> : null}
      {status === "error" && state?.failure ? (
        <p className="settings-voice-model__failure" role="alert">{voiceAsrModelFailureLine(state.failure)}</p>
      ) : null}
      {actionFailure ? <p className="settings-voice-model__failure" role="alert">这次操作没有完成：{actionFailure}</p> : null}
      {readFailure ? (
        <p className="settings-voice-model__failure" role="alert">暂时读不到模型状态：{readFailure}。重新读取后再操作。</p>
      ) : null}

      <div className="settings-voice-model__actions">
        {readFailure || !state ? (
          <button type="button" className="button" disabled={busy !== null || !readFailure} onClick={refresh}>
            {readFailure ? "重新读取状态" : "正在读取状态…"}
          </button>
        ) : state.status === "downloading" ? null : state.status === "ready" ? (
          <button type="button" className="button danger" disabled={disabled} onClick={remove}>
            <Trash2 size={14} aria-hidden="true" />{busy === "remove" ? "正在移除…" : "从这台设备移除"}
          </button>
        ) : (
          <button type="button" className="button primary" disabled={disabled} onClick={download}>
            <Download size={15} aria-hidden="true" />{busy === "download" ? "正在开始…" : state.status === "error" ? "重试下载" : "下载到这台设备"}
          </button>
        )}
        <p className="settings-voice-model__hint">
          {status === "ready"
            ? "现在可以用语音输入。移除之后语音输入会暂时停用，随时可以再下载回来。"
            : status === "downloading"
              ? "可以离开这一页，下载会继续。取消后，下次会保留已下载完整的文件。"
              : status === "unknown"
                ? "重新读取本机状态后，可以继续管理语音识别模型。"
              : state?.failure === "cancelled"
                ? "下载已取消。已下载完整的文件会保留，随时可以继续下载。"
                : "没下载也可以正常使用其它功能，仍然可以打字与伴星交谈。"}
        </p>
      </div>
    </div>
  );
}
