import { useEffect, useRef, useState } from "react";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { useCompanionVoiceInput, type CompanionVoiceTranscript } from "./use-companion-voice-input";
import { useCompanionTransient } from "./use-companion-transient";

export function useCompanionInteraction(chat: CompanionChatSession, voiceEnabled: boolean, obscured = false) {
  const input = useRoomStore(state => state.companionComposerDraft);
  const setInput = useRoomStore(state => state.setCompanionComposerDraft);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState<CompanionVoiceTranscript | null>(null);
  const [voiceRevision, setVoiceRevision] = useState(0);
  const namespaceRef = useRef(chat.conversationId);
  const voice = useCompanionVoiceInput({
    disabled: chat.phase === "sending" || !voiceEnabled,
    onModelMissing: () => { setVoiceOpen(false); setVoiceDraft(null); },
    onTranscript: ({ text }) => {
      setVoiceDraft({ text });
      setVoiceRevision(value => value + 1);
      setVoiceOpen(true);
    },
  });
  useEffect(() => {
    if (namespaceRef.current === chat.conversationId) return;
    const wasBound = namespaceRef.current !== null;
    namespaceRef.current = chat.conversationId;
    if (!wasBound) return;
    setVoiceOpen(false);
    setVoiceDraft(null);
    voice.cancel();
  }, [chat.conversationId, voice.cancel]);
  const inputLife = useCompanionTransient(chat.mode === "conversation" ? `${chat.conversationId}:input` : null, 90_000, obscured);
  const menuLife = useCompanionTransient(chat.mode === "actions" ? `${chat.conversationId}:menu` : null, 90_000, obscured);
  const voiceLife = useCompanionTransient(voiceOpen ? `voice:${voiceRevision}` : null, 90_000, obscured || voice.phase !== "idle");
  useEffect(() => { if (chat.mode === "conversation" && !inputLife.visible) chat.setMode("closed"); }, [chat.mode, chat.setMode, inputLife.visible]);
  useEffect(() => { if (chat.mode === "actions" && !menuLife.visible) chat.setMode("closed"); }, [chat.mode, chat.setMode, menuLife.visible]);
  useEffect(() => { if (voiceOpen && !voiceLife.visible) setVoiceOpen(false); }, [voiceOpen, voiceLife.visible]);
  const errorKey = chat.interrupted ? `interrupted:${chat.conversationId}:${chat.interrupted.text}:${chat.interrupted.message}`
    : chat.phase === "error" && chat.failure ? `error:${chat.conversationId}:${chat.failure}` : null;
  const errorLife = useCompanionTransient(errorKey, 60_000, obscured);
  const toolKey = chat.nodes.some(node => node.kind === "tool")
    ? `${chat.conversationId}:${chat.nodes.map(node => `${node.key}:${node.state}`).join("|")}:${chat.phase === "sending" ? "running" : "done"}` : null;
  const toolLife = useCompanionTransient(toolKey, 8_000, obscured || chat.phase === "sending");
  return {
    input, setInput, voice, voiceOpen: voiceOpen && voiceLife.visible, voiceDraft,
    setVoiceDraftText: (text: string) => setVoiceDraft(draft => draft ? { ...draft, text } : draft),
    consumeVoiceDraft: (sentDraft: CompanionVoiceTranscript) => { setVoiceDraft(current => current === sentDraft ? null : current); },
    closeVoice: () => { voice.cancel(); setVoiceOpen(false); },
    /**
     * 「这次不发」= 连同上一句的识别结果一起丢掉。
     *
     * 以前它只关气泡：识别出来的字留在状态里，于是下一次点语音输入又把那一句原样
     * 摆出来（2026-10-06 窗口实测：用户连点两次都得不到一次新的录音）。一个按钮的
     * 字面意思就是"这句不算数"，留着它等于让用户没法把不想要的那句清掉。
     */
    discardVoice: () => { voice.cancel(); setVoiceOpen(false); setVoiceDraft(null); },
    /**
     * 麦克风按钮只有一种意思：**开始／停止录音**。
     *
     * 它以前在气泡开着时把气泡整个收走（`voice.cancel()` + 关面板）。2026-10-06
     * 窗口实测反馈正是这个形状：用户伸手去点气泡里的「结束录音」，路上点中旁边的
     * 麦克风——录音停了，气泡也没了，于是「点不到结束录音」。关气泡是**关闭语音气泡**
     * 与「这次不发」两件事，不该由麦克风按钮顺手做掉。
     *
     * `voice.toggle()` 自己分相位：`listening` → 收尾送去识别，`idle` → 开录，
     * `starting`/`transcribing` → 不动。
     */
    toggleVoice: () => {
      chat.setMode("closed");
      setVoiceOpen(true);
      setVoiceRevision(value => value + 1);
      /**
       * **有草稿也照样开录**（2026-10-06 修正）。
       *
       * 此前这里写着 `if (!voiceDraft) voice.toggle()`：一旦认出一句，之后每次点
       * 「语音输入」都只把旧字再摆一遍、不录音。按钮叫"语音输入"，按下去不录音，
       * 用户只会以为坏了——而且除了把那句发出去或换会话，没有别的路能开始新的一句。
       *
       * 旧草稿**先留在状态里**：新一句认出来才替换它，中途按「这次不发」则是明确
       * 丢掉（`discardVoice`）。录音期间面板只显示录音界面，不摆旧字
       * （CompanionHud 里按 phase 收），免得两次的话并排看着像同一句。
       */
      voice.toggle();
    },
    inputActivity: inputLife.activity,
    voiceActivity: voiceLife.activity,
    errorVisible: errorLife.visible,
    outputActivity: errorLife.activity,
    toolVisible: toolLife.visible,
    toolActivity: toolLife.activity,
    menuActivity: menuLife.activity,
  };
}
