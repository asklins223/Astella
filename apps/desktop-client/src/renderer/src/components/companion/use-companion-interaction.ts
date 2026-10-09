import { useEffect, useRef, useState } from "react";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { useCompanionVoiceInput } from "./use-companion-voice-input";
import { useCompanionTransient } from "./use-companion-transient";
import { stopCompanionSpeech } from "../../app/companion-voice-playback";

/** 输入草稿与语音会话各有状态；真实发送回执通过 HUD 绑定，等待和失败不会静默丢掉。 */
export function useCompanionInteraction(chat: CompanionChatSession, voiceEnabled: boolean, obscured = false, processReading = false) {
  const input = useRoomStore(state => state.companionComposerDraft);
  const setInput = useRoomStore(state => state.setCompanionComposerDraft);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceSession, setVoiceSession] = useState(0);
  const sendVoiceRef = useRef<(text: string) => Promise<boolean | void>>(async () => false);
  const interruptVoiceRef = useRef<() => void>(() => undefined);
  const namespaceRef = useRef(chat.conversationId);
  const voice = useCompanionVoiceInput({
    disabled: !voiceEnabled,
    replyPending: chat.phase === "sending",
    onModelMissing: () => { setVoiceOpen(false); },
    onTurn: text => sendVoiceRef.current(text),
    onInterrupt: () => interruptVoiceRef.current(),
    onSessionEnd: () => { setVoiceOpen(false); },
  });
  useEffect(() => {
    if (obscured && (voice.phase === "open" || voice.phase === "starting" || voice.phase === "closing")) voice.pause();
  }, [obscured, voice.phase, voice.pause]);
  useEffect(() => {
    if (!voiceOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      stopCompanionSpeech(); voice.cancel(); setVoiceOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [voiceOpen, voice.cancel]);
  useEffect(() => {
    if (namespaceRef.current === chat.conversationId) return;
    const wasBound = namespaceRef.current !== null;
    namespaceRef.current = chat.conversationId;
    if (!wasBound) return;
    setVoiceOpen(false);
    voice.cancel();
  }, [chat.conversationId, voice.cancel]);
  const inputLife = useCompanionTransient(chat.mode === "conversation" ? `${chat.conversationId}:input` : null, 90_000, obscured);
  const menuLife = useCompanionTransient(chat.mode === "actions" ? `${chat.conversationId}:menu` : null, 90_000, obscured);
  // 会话开着的时候不按"闲置 90 秒"收：人在说话，气泡不该自己走掉。
  const voiceLife = useCompanionTransient(voiceOpen && voiceSession > 0 ? `voice:${voiceSession}` : null, 90_000, obscured || voice.phase !== "idle");
  useEffect(() => { if (chat.mode === "conversation" && !inputLife.visible) chat.setMode("closed"); }, [chat.mode, chat.setMode, inputLife.visible]);
  useEffect(() => { if (chat.mode === "actions" && !menuLife.visible) chat.setMode("closed"); }, [chat.mode, chat.setMode, menuLife.visible]);
  useEffect(() => { if (voiceOpen && !voiceLife.visible) setVoiceOpen(false); }, [voiceOpen, voiceLife.visible]);
  const errorKey = chat.interrupted ? `interrupted:${chat.conversationId}:${chat.interrupted.text}:${chat.interrupted.message}`
    : chat.phase === "error" && chat.failure ? `error:${chat.conversationId}:${chat.failure}` : null;
  const errorLife = useCompanionTransient(errorKey, 60_000, obscured);
  const toolKey = chat.nodes.some(node => node.kind === "tool")
    ? `${chat.conversationId}:${chat.nodes.map(node => `${node.key}:${node.state}`).join("|")}:${chat.phase === "sending" ? "running" : "done"}` : null;
  const toolNeedsAttention = chat.nodes.some(node => node.kind === "tool" && ["waiting_confirmation", "outcome_unknown", "failed", "not_executed", "unavailable"].includes(node.state));
  const toolLife = useCompanionTransient(toolKey, 8_000, obscured || chat.phase === "sending" || Boolean(chat.liveReply || chat.richReply) || processReading || toolNeedsAttention);
  return {
    input, setInput, voice,
    voiceOpen: voiceOpen && (voiceLife.visible || voice.phase !== "idle"),
    sendVoiceRef, interruptVoiceRef,
    closeVoice: () => { if (voice.phase !== "idle") stopCompanionSpeech(); voice.cancel(); setVoiceOpen(false); },
    // 结束和 X 都立即交还麦克风，不以退出操作代替发送。
    toggleVoice: () => {
      chat.setMode("closed");
      if (voice.phase === "idle") {
        setVoiceSession(value => value + 1);
        setVoiceOpen(true);
      }
      else stopCompanionSpeech();
      voice.toggle();
    },
    inputActivity: inputLife.activity,
    voiceActivity: voiceLife.activity,
    errorVisible: errorLife.visible,
    outputActivity: errorLife.activity,
    toolVisible: toolLife.visible,
    toolActivity: toolLife.activity,
    dismissTool: toolLife.dismiss,
    menuActivity: menuLife.activity,
  };
}
