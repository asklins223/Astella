import { useLayoutEffect, useRef } from "react";
import { Loader2, Mic, MousePointerClick, Plus, Send, Square } from "lucide-react";
import type { CompanionVoiceInput } from "./use-companion-voice-input";
import { isCompanionComposition, shouldSendCompanionOnEnter } from "./companion-composer-key";
import { NOTE_IMAGE_UPLOAD_MIME_TYPES } from "@astella/shared/note-image-upload-contracts";
import {
  CompanionComposerImageChip,
  CompanionComposerImageStatus,
  type CompanionComposerImage,
} from "./companion-composer-image";
import { CompanionAgentPermissionMenu } from "./companion-agent-permission";

/**
 * The Demo's two-row paper composer, connected to the shared production draft.
 *
 * 2026-10-06 输入框传图：「＋」现在就是"传一张图给她"（隐藏的 file input 触发），
 * 页面快捷操作换到它右边的独立图标——原来那个 ＋ 是快捷操作的占位符，
 * 而用户对输入框上 ＋ 的心智模型一直是"加附件"。
 */
export function CompanionHistoryComposer({ input, onInputChange, onSend, voice, voiceEnabled, companionName, sending, stopping, onStop, onVoiceToggle, onPageActions, image, imageUploading, imageError, onPickImage, onRemoveImage }: {
  input: string; onInputChange: (value: string) => void; onSend: () => Promise<void>;
  voice: CompanionVoiceInput; voiceEnabled: boolean; companionName: string; sending: boolean; stopping: boolean;
  onStop: () => void; onVoiceToggle: () => void; onPageActions: () => void;
  image: CompanionComposerImage | null; imageUploading: boolean; imageError: string | null;
  onPickImage: (file: File) => void; onRemoveImage: () => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const voiceStatus = voice.phase === "starting" ? "正在开启麦克风…"
    : voice.phase === "closing" ? "正在识别语音…"
      : voice.phase === "paused" ? "收音已暂停"
        : voice.activity === "waiting" ? "正在等待伴星回复…"
          : voice.activity === "speaking" ? "伴星正在说话"
            : "正在听你说话，停顿后自动发送";
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
    {image ? <CompanionComposerImageChip image={image} onRemove={onRemoveImage} /> : null}
    <textarea ref={composerRef} rows={1} value={input} onChange={event => onInputChange(event.currentTarget.value)}
      placeholder="想聊哪一句，或只是想说说话…" aria-label={`继续问 ${companionName}`}
      onKeyDown={event => {
        if (isCompanionComposition(event.nativeEvent)) return;
        if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); return; }
        if (shouldSendCompanionOnEnter(event)) { event.preventDefault(); void onSend(); }
      }} />
    <CompanionComposerImageStatus uploading={imageUploading} error={imageError} />
    {/**
     * 手记里说话时，这一行就是"我刚才说到哪儿了"。
     *
     * 抽屉开着的时候 HUD 那层的语音气泡是被遮住的，所以字幕必须在这一面自己长出来——
     * 不然用户在完整的一面里对着麦克风说话，看见的只有一个转圈的图标。
     */}
    {voiceEnabled && voice.phase !== "idle" ? <p className="companion-history__voice-live" role="status" aria-live="polite">
      {voice.caption?.text || voiceStatus}
    </p> : null}
    <div className="companion-history__compose-tools">
      <input ref={imageInputRef} type="file" accept={NOTE_IMAGE_UPLOAD_MIME_TYPES.join(",")} className="companion-compose-image__input"
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onPickImage(file); }} />
      <button type="button" className="companion-history__tool" disabled={imageUploading}
        onClick={() => imageInputRef.current?.click()} aria-label="传一张图给伴星" title="传一张图给她">
        {imageUploading ? <Loader2 className="companion-hud__spin" size={20} /> : <Plus size={21} />}
      </button>
      <button type="button" className="companion-history__tool" onClick={onPageActions} aria-label="当前页面快捷操作" title="当前页面快捷操作"><MousePointerClick size={19} /></button>
      <CompanionAgentPermissionMenu buttonClassName="companion-history__tool" />
      {voiceEnabled ? <button type="button" className="companion-history__tool" onClick={onVoiceToggle}
        disabled={voice.phase === "starting" || !voice.supported} data-active={voice.phase !== "idle" || undefined}
        title={voice.supported ? (voice.phase === "idle" ? "开始语音对话" : "结束语音对话") : "当前设备没有可用的麦克风"}
        aria-label={voice.supported ? (voice.phase === "idle" ? "开始语音对话" : "结束语音对话") : "当前设备没有可用的麦克风"}>
        {voice.phase === "closing" ? <Loader2 className="companion-hud__spin" size={20} /> : <Mic size={21} />}
      </button> : null}
      <span>Enter 发送 · Shift + Enter 换行</span>
      {sending ? <button type="button" className="button companion-history__composer-stop" disabled={stopping} onClick={onStop} aria-label="停止这一轮">
        {stopping ? <Loader2 className="companion-hud__spin" size={16} /> : <Square size={14} />}停止
      </button> : null}
      <button className="button primary" type="submit" disabled={!input.trim() || voice.phase === "closing" || imageUploading} aria-label={sending ? "发送并接替当前回复" : "发送"}><span>发送</span><Send size={20} /></button>
    </div>
  </form>;
}
