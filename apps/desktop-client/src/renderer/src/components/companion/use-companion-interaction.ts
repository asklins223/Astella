import { useEffect, useRef, useState } from "react";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { useCompanionVoiceInput } from "./use-companion-voice-input";
import { useCompanionTransient } from "./use-companion-transient";

/**
 * 伴星这一面的临时状态：输入框、菜单、出错条，以及**语音对话会话**。
 *
 * 语音从 2026-10-07 起不再是"认一句、摆进气泡等你点发送"，而是按住一次麦克风
 * 就一直开着、说完一轮直接进对话。所以这里没有 `voiceDraft` 这种东西了：
 * 会话交出来的文本是一轮**已经说出口的话**，界面没有编辑它的位置，只有把它发出去。
 */
export function useCompanionInteraction(chat: CompanionChatSession, voiceEnabled: boolean, obscured = false) {
  const input = useRoomStore(state => state.companionComposerDraft);
  const setInput = useRoomStore(state => state.setCompanionComposerDraft);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceSession, setVoiceSession] = useState(0);
  const [voiceTurn, setVoiceTurn] = useState<{ readonly text: string; readonly revision: number } | null>(null);
  const turnRevisionRef = useRef(0);
  const namespaceRef = useRef(chat.conversationId);
  const voice = useCompanionVoiceInput({
    // 「她正在回答」不该挡住开口：打断一句正在说的回复、接着问下一句，正是对话要的样子。
    // 发送这条路上服务端会用新的 generation 接替旧轮（见 CompanionHud 的 sendText 注释）。
    disabled: !voiceEnabled,
    onModelMissing: () => { setVoiceOpen(false); },
    onTurn: (text) => {
      turnRevisionRef.current += 1;
      setVoiceTurn({ text, revision: turnRevisionRef.current });
    },
    onSessionEnd: () => { setVoiceOpen(false); },
  });
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
  const toolLife = useCompanionTransient(toolKey, 8_000, obscured || chat.phase === "sending");
  return {
    input, setInput, voice,
    voiceOpen: voiceOpen && (voiceLife.visible || voice.phase !== "idle"),
    /** 一轮说完的话；HUD 按 `revision` 一次一发进对话，发过不再发。 */
    voiceTurn,
    consumeVoiceTurn: (turn: { readonly text: string; readonly revision: number }) => {
      setVoiceTurn(current => current?.revision === turn.revision ? null : current);
    },
    closeVoice: () => { voice.cancel(); setVoiceOpen(false); },
    /**
     * 麦克风按钮的意思变成**进入／退出对话**。
     *
     * 退出时那一句仍然算数（`voice.toggle` 会把已识别的这轮发出去再收麦克风）——
     * 用户按下的是"我说完了"，不是"把我刚才说的丢掉"。真的想丢掉是 X 那件事
     * （`closeVoice`：不收麦克风也不发）。
     */
    toggleVoice: () => {
      chat.setMode("closed");
      if (voice.phase === "idle") {
        setVoiceSession(value => value + 1);
        setVoiceOpen(true);
      }
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
