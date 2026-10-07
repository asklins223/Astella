import { useEffect, useRef } from "react";
import { Loader2, MessageCircle, Mic, MicOff, Pause, Play, Send, Volume2, X } from "lucide-react";
import { useRoomStore } from "../../app/room-store";
import type { CompanionVoiceInput, CompanionVoiceActivity } from "./use-companion-voice-input";

const STATUS: Record<CompanionVoiceActivity, [string, string]> = {
  idle: ["语音尚未开始", "重新开始，就能继续聊。"],
  starting: ["正在连接麦克风", "若系统询问，请允许使用麦克风。"],
  listening: ["轮到你说", "自然开口，停顿片刻后自动发送。"],
  capturing: ["正在听你说", "可以继续说，也可以点「说好了」。"],
  transcribing: ["正在辨认最后一句", "听完整后再送出。"],
  waiting: ["伴星正在准备回复", "想补充一句，点「我想说」。"],
  speaking: ["伴星正在说", "听完会继续收音，也可以随时插话。"],
  paused: ["收音已暂停", "麦克风已关闭，准备好后再继续。"],
};

export function CompanionVoiceConversation({ voice, onClose, onText, onActivity, onModelSettings, failure }: {
  readonly voice: CompanionVoiceInput;
  readonly onClose: () => void;
  readonly onText: () => void;
  readonly onActivity: () => void;
  readonly onModelSettings: () => void;
  readonly failure?: string | null;
}) {
  const meter = useRef<HTMLDivElement>(null);
  const muted = useRoomStore(state => state.masterMuted);
  useEffect(() => voice.subscribeLevel(level => meter.current?.style.setProperty("--input-level", String(Math.min(1, level * 5)))), [voice.subscribeLevel]);
  const [label, hint] = STATUS[voice.activity];
  const receiving = voice.activity === "listening" || voice.activity === "capturing";
  const busy = voice.activity === "waiting" || voice.activity === "speaking";
  const ended = voice.phase === "idle";
  return <section className="companion-hud__panel companion-hud__voice" data-activity={voice.activity} aria-label="语音对话"
    onPointerMove={onActivity} onWheel={onActivity} onFocus={onActivity}
    onKeyDown={event => { onActivity(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <header><strong><Mic size={15} />语音对话</strong><button type="button" onClick={onClose} aria-label="关掉语音对话"><X size={16} /></button></header>
    <div className="companion-voice-status">
      <div ref={meter} className="companion-voice-meter" data-receiving={receiving || undefined} aria-hidden="true">
        {voice.activity === "starting" || voice.activity === "transcribing" || voice.activity === "waiting" ? <Loader2 size={22} className="companion-hud__spin" />
          : voice.activity === "speaking" ? <Volume2 size={23} /> : voice.activity === "paused" || ended ? <MicOff size={22} /> : <><i /><i /><i /><i /><i /></>}
      </div>
      <div><p role="status">{label}</p><span>{hint}</span></div>
    </div>
    {voice.caption ? <div className="companion-voice-transcript"><small>你正在说</small><p aria-live="polite">{voice.caption.text || "正在听清这一句…"}</p></div>
      : voice.lastTurn ? <div className="companion-voice-transcript" data-sent="true"><small>刚才你说</small><p>{voice.lastTurn}</p></div> : null}
    {muted ? <p className="companion-voice-note" role="status">当前总静音，伴星回复会以文字显示。</p> : null}
    {voice.note || failure ? <p className="companion-voice-note" role="status">{voice.note ?? failure}</p> : null}
    {voice.modelMissing ? <p className="companion-voice-note">本机识别模型还未安装。<button type="button" className="text-action" onClick={onModelSettings}>去设置里下载</button></p> : null}
    <footer>
      <button type="button" className="text-action" onClick={onText}><MessageCircle size={14} />改用文字</button>
      {!ended && voice.phase !== "starting" ? <button type="button" className="text-action" onClick={voice.phase === "paused" ? voice.resume : voice.pause}>{voice.phase === "paused" ? <Play size={14} /> : <Pause size={14} />}{voice.phase === "paused" ? "继续收音" : "暂停收音"}</button> : null}
      {busy ? <button type="button" className="button primary" onClick={voice.interrupt}><Mic size={14} />我想说</button>
        : voice.activity === "capturing" ? <button type="button" className="button primary" onClick={voice.sendNow}><Send size={14} />说好了</button>
          : ended && !voice.modelMissing ? <button type="button" className="button primary" onClick={voice.toggle}><Mic size={14} />重新开始</button> : null}
    </footer>
  </section>;
}
