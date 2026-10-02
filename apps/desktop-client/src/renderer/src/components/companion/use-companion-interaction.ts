import { useEffect, useRef, useState } from "react";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { useCompanionVoiceInput, type CompanionVoiceTranscript } from "./use-companion-voice-input";
import { useCompanionTransient } from "./use-companion-transient";

export function useCompanionInteraction(chat: CompanionChatSession, voiceEnabled: boolean, obscured = false) {
  const [input, setInput] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState<CompanionVoiceTranscript | null>(null);
  const [voiceRevision, setVoiceRevision] = useState(0);
  const namespaceRef = useRef(chat.conversationId);
  const voice = useCompanionVoiceInput({
    disabled: chat.phase === "sending" || !voiceEnabled,
    onTranscript: ({ text, voiceArtifactId }) => {
      setVoiceDraft({ text, voiceArtifactId });
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
    setInput("");
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
    toggleVoice: () => {
      if (voiceOpen) { voice.cancel(); setVoiceOpen(false); return; }
      chat.setMode("closed");
      setVoiceOpen(true);
      setVoiceRevision(value => value + 1);
      if (!voiceDraft) voice.toggle();
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
