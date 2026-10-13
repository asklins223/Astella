import type { CompanionVoicePreferenceV1 } from "@astella/shared";
import { TTS_VOICE_STYLE_PRESETS, type TtsEngineV1 } from "@astella/shared/tts-voice-catalog";
import { VOICE_STYLE_INSTRUCTION_MAX_UNITS, voiceStyleInstructionUnits } from "@astella/shared/voice-expression-tags";
import { useEffect, useId, useState } from "react";

type ChangeVoice = (engine: TtsEngineV1, voice: string, instruction?: string | null) => Promise<boolean>;

export function CompanionVoiceStyleControl(props: {
  readonly preference: CompanionVoicePreferenceV1;
  readonly saving: boolean;
  readonly error?: string | null;
  readonly onChange: ChangeVoice;
}) {
  const inputId = useId();
  const storedInstruction = props.preference.instruction?.trim() ?? "";
  const storedPreset = TTS_VOICE_STYLE_PRESETS.find((preset) => (preset.instruction ?? "") === storedInstruction);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(storedInstruction);
  const [customDirty, setCustomDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const customUnits = voiceStyleInstructionUnits(customDraft.trim());
  const customOverLimit = customUnits > VOICE_STYLE_INSTRUCTION_MAX_UNITS;
  const selectedId = customOpen || !storedPreset ? "custom" : storedPreset.id;
  const canUseInstruction = props.preference.engine === "qwen";

  useEffect(() => {
    if (!customDirty) setCustomDraft(props.preference.instruction ?? "");
  }, [customDirty, props.preference.instruction]);

  const choosePreset = async (preset: (typeof TTS_VOICE_STYLE_PRESETS)[number]) => {
    if (props.saving || !canUseInstruction) return;
    setSaved(false);
    const didSave = await props.onChange(props.preference.engine, props.preference.voice, preset.instruction);
    if (!didSave) return;
    setCustomOpen(false);
    setCustomDirty(false);
    setCustomDraft(preset.instruction ?? "");
    setSaved(true);
  };

  const chooseCustom = () => {
    setSaved(false);
    setCustomOpen(true);
    setCustomDraft(props.preference.instruction ?? "");
    setCustomDirty(false);
  };

  const saveCustom = async () => {
    if (props.saving || !canUseInstruction || !customDirty || customOverLimit) return;
    setSaved(false);
    const trimmed = customDraft.trim();
    const didSave = await props.onChange(
      props.preference.engine,
      props.preference.voice,
      trimmed === "" ? null : trimmed,
    );
    if (didSave) {
      setCustomDirty(false);
      setSaved(true);
    }
  };

  return <div className="companion-voice-style">
    <div className="companion-voice-style__choices" role="group" aria-label="语音说话风格">
      {TTS_VOICE_STYLE_PRESETS.map((preset) => <button
        key={preset.id}
        type="button"
        aria-pressed={selectedId === preset.id}
        disabled={props.saving || !canUseInstruction}
        onClick={() => void choosePreset(preset)}
      >
        <strong>{preset.label}</strong>
        <small>{preset.description}</small>
      </button>)}
      <button
        type="button"
        aria-pressed={selectedId === "custom"}
        disabled={props.saving || !canUseInstruction}
        onClick={chooseCustom}
      >
        <strong>自定义</strong>
        <small>自己写一句具体的声音描述。</small>
      </button>
    </div>

    {selectedId === "custom" ? <div className="companion-voice-style__custom">
      <label htmlFor={inputId}>自定义说话风格</label>
      <p className="companion-voice-style__message">可写音调、语速、情感、音色特点和使用场景；用具体客观的词，避免“好听”等模糊词或模仿真人。这里调整当前女声的表达，不会创建新音色。</p>
      <textarea
        id={inputId}
        value={customDraft}
        rows={2}
        maxLength={VOICE_STYLE_INSTRUCTION_MAX_UNITS}
        disabled={props.saving || !canUseInstruction}
        placeholder="例如：中音偏柔，音色圆润，语速稍慢，语气温柔平和，适合学习陪伴"
        onChange={(event) => {
          setCustomDraft(event.currentTarget.value);
          setCustomDirty(true);
          setSaved(false);
        }}
      />
      <button
        type="button"
        className="companion-voice-style__save"
        disabled={props.saving || !canUseInstruction || !customDirty || customOverLimit}
        onClick={() => void saveCustom()}
      >
        {props.saving ? "保存中…" : "保存自定义风格"}
      </button>
      {customOverLimit ? <p className="companion-voice-style__message" role="alert">风格描述超过 {VOICE_STYLE_INSTRUCTION_MAX_UNITS} 个字符单位，汉字算 2。</p> : null}
      {customDirty ? <p className="companion-voice-style__message" role="status">改动还没保存。</p> : null}
    </div> : null}

    {!canUseInstruction ? <p className="companion-voice-style__message">当前使用 Edge 音色引擎，不支持风格指令；切换到 Qwen 后才能使用。</p> : null}
    {props.error ? <p className="companion-voice-style__message is-error" role="alert">{props.error}</p> : null}
    {saved ? <p className="companion-voice-style__message" role="status">已保存，新合成的语音会使用这套风格。</p> : null}
  </div>;
}
