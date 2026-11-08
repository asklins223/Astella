import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useRoomStore } from "../../../app/home/room-store";
import { subscribeHomeV2VoiceLevel } from "../../../app/companion-session/companion-voice-level";
import { CompanionVoiceOrb } from "./CompanionVoiceOrb";
import type { CompanionVoiceInput, CompanionVoiceActivity } from "./use-companion-voice-input";

/**
 * 伴星语音对话：只要一颗球（2026-11-07 用户决定），浮在她身侧，无遮罩、
 * 无对话记录；操作藏在球的点按和 Esc 里，指针移上来才露出关闭钮。
 *
 * 球里的云由 CompanionVoiceOrb 实时画：收音用麦克风 RMS、她说话用播放响度，
 * 两路信号按各自性格包络后只写 ref 和 CSS 变量，不每帧 setState。
 */
const STATUS: Record<CompanionVoiceActivity, string> = {
  idle: "点一下球继续聊",
  starting: "正在打开麦克风",
  listening: "在听",
  capturing: "在听你说",
  transcribing: "正在辨认",
  waiting: "她在想",
  speaking: "她在说",
  paused: "已暂停，点一下球继续",
};

/** 输入振幅（录音器 RMS，0..1）开方放大后交给烟球；说话时改用播放振幅。 */
const INPUT_LEVEL_GAIN = 5;

export function CompanionVoiceConversation({ voice, onClose, onActivity, onModelSettings, failure }: {
  readonly voice: CompanionVoiceInput;
  readonly onClose: () => void;
  readonly onActivity: () => void;
  readonly onModelSettings: () => void;
  readonly failure?: string | null;
}) {
  const stage = useRef<HTMLElement>(null);
  const level = useRef(0);
  const muted = useRoomStore(state => state.masterMuted);
  const label = STATUS[voice.activity];
  const receiving = voice.activity === "listening" || voice.activity === "capturing";
  const busy = voice.activity === "waiting" || voice.activity === "speaking";
  const ended = voice.phase === "idle";

  // 振幅只写一个 ref（画布里的云）和一个 CSS 变量；每来一帧都 setState 会把
  // 整页 React 拖进 60Hz 重渲。人声的 RMS 本来就小，先开方再交给画面：轻声
  // 说话也能看出云跑起来；底噪压在死区里，不让房间声把球晃起来。
  const writeLevel = (value: number) => {
    const raw = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    const next = raw <= 0.03 ? 0 : Math.sqrt(raw);
    level.current = next;
    stage.current?.style.setProperty("--voice-level", String(next));
  };
  useEffect(() => voice.subscribeLevel(level => writeLevel(receiving ? level * INPUT_LEVEL_GAIN : 0)), [voice.subscribeLevel, receiving]);
  useEffect(() => subscribeHomeV2VoiceLevel(level => { if (busy) writeLevel(level); }), [busy]);
  // 一轮结束、回到待说话时把球收回静止大小，不留上一轮的残影。
  useEffect(() => { if (!receiving && !busy) writeLevel(0); }, [receiving, busy]);

  /** 点球：能说完了就说完了，她在说就插话，停着就重新开始。 */
  const primary = voice.activity === "capturing" ? voice.sendNow
    : busy ? voice.interrupt
      : ended ? voice.toggle
        : voice.phase === "paused" ? voice.resume : voice.sendNow;
  const primaryLabel = voice.activity === "capturing" ? "说好了" : busy ? "我想说"
    : ended ? "重新开始" : voice.phase === "paused" ? "继续收音" : "说好了";

  const note = voice.note ?? failure ?? null;
  const status = note ?? (muted ? "她的声音已静音，对话还在继续" : label);

  return <section ref={stage} className="companion-voice" data-activity={voice.activity} role="region" aria-label="语音对话"
    onPointerMove={onActivity} onWheel={onActivity} onFocus={onActivity}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div className="companion-voice__stage">
      <button type="button" className="companion-voice__orb" onClick={primary} aria-label={primaryLabel} title={primaryLabel}>
        <span className="companion-voice__shell">
          <span className="companion-voice__ball" aria-hidden="true">
            <CompanionVoiceOrb level={level} mode={receiving ? "input" : busy ? "output" : "idle"} />
          </span>
        </span>
      </button>
      <button type="button" className="companion-voice__close" onClick={onClose} aria-label="关掉语音对话" title="关掉语音对话"><X size={16} /></button>
      <p className="companion-voice__status" data-tone={note ? "note" : undefined} role="status">{status}</p>
      {voice.modelMissing ? <p className="companion-voice__hint">识别模型还没装。<button type="button" className="text-action" onClick={onModelSettings}>去设置里下载</button></p> : null}
    </div>
  </section>;
}
