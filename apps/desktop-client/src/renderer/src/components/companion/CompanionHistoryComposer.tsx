import { useLayoutEffect, useRef } from "react";
import { Loader2, Mic, Plus, Send, Square } from "lucide-react";
import type { CompanionVoiceInput } from "./use-companion-voice-input";
import { isCompanionComposition, shouldSendCompanionOnEnter } from "./companion-composer-key";

/** The Demo's two-row paper composer, connected to the shared production draft. */
export function CompanionHistoryComposer({ input, onInputChange, onSend, voice, voiceEnabled, companionName, sending, stopping, onStop, onVoiceToggle, onPageActions }: {
  input: string; onInputChange: (value: string) => void; onSend: () => Promise<void>;
  voice: CompanionVoiceInput; voiceEnabled: boolean; companionName: string; sending: boolean; stopping: boolean;
  onStop: () => void; onVoiceToggle: () => void; onPageActions: () => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    const resize = () => {
      const style = getComputedStyle(field);
      const minimum = Number.parseFloat(style.minHeight) || 28;
      const maximum = Number.parseFloat(style.maxHeight) || 100;
      const scrollTop = field.scrollTop;
      field.style.height = "0px";
      field.style.height = `${Math.min(maximum, Math.max(minimum, field.scrollHeight))}px`;
      field.scrollTop = scrollTop;
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [input]);
  return <form className="companion-history__composer" onSubmit={event => { event.preventDefault(); void onSend(); }}>
    <textarea ref={composerRef} rows={1} value={input} onChange={event => onInputChange(event.currentTarget.value)}
      placeholder="想聊哪一句，或只是想说说话…" aria-label={`继续问 ${companionName}`}
      onKeyDown={event => {
        if (isCompanionComposition(event.nativeEvent)) return;
        if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); return; }
        if (shouldSendCompanionOnEnter(event)) { event.preventDefault(); void onSend(); }
      }} />
    <div className="companion-history__compose-tools">
      <button type="button" className="companion-history__tool" onClick={onPageActions} aria-label="当前页面快捷操作" title="当前页面快捷操作"><Plus size={21} /></button>
      {voiceEnabled ? <button type="button" className="companion-history__tool" onClick={onVoiceToggle}
        disabled={voice.phase === "transcribing" || sending} data-active={voice.phase !== "idle" || undefined}
        title={voice.supported ? "语音输入" : "当前设备没有可用的麦克风"}
        aria-label={voice.supported ? (sending ? "正在回复中——停止当前回复后可说话" : "语音输入") : "当前设备没有可用的麦克风"}>
        {voice.phase === "transcribing" ? <Loader2 className="companion-hud__spin" size={20} /> : <Mic size={21} />}
      </button> : null}
      <span>Enter 发送 · Shift + Enter 换行</span>
      {sending ? <button type="button" className="button companion-history__composer-stop" disabled={stopping} onClick={onStop} aria-label="停止这一轮">
        {stopping ? <Loader2 className="companion-hud__spin" size={16} /> : <Square size={14} />}停止
      </button> : null}
      <button className="button primary" type="submit" disabled={!input.trim() || voice.phase === "transcribing"} aria-label={sending ? "发送并接替当前回复" : "发送"}><span>发送</span><Send size={20} /></button>
    </div>
  </form>;
}
