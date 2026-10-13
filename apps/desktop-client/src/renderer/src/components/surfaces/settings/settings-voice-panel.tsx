/**
 * 「用哪套声音合成」那两行：引擎/音色的选择，以及下面那颗试听播放器。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 两块共 52 行、5 个外部符号。播放器那颗**必须和选择器住在一起**——它们说的是同一件事
 * （你选了哪套声音、听起来是什么样），拆开就会出现「选了但没法试听」的空档。
 *
 * `pendingReadLine` / `voicePlayerLine` / `formatVoiceTime` / `percentLine` 四个
 * 「还没读到 / 读到了多少」的小句子与作答方式共用，已放进 `settings-data-tables.ts`。
 *
 * ⚠️ 那句注释是这一块的一部分：**读到之前不画选项**——把「跟随安排」画成已选，
 * 就是把一个服务端从没回答过的值当成答案给读者看。
 *
 * 硬约束（`AGENTS.md`）：声音设置**跟着账号走**，不跟空间走。别把它搬进空间设置那一组。
 */
import type { ReactElement } from "react";
import { SettingRow } from "./settings-primitives.tsx";
import {
  TTS_ENGINE_OPTIONS,
  formatVoiceTime,
  pendingReadLine,
  ttsDefaultVoiceFor,
  voicesForEngine,
  voicePlayerLine,
  VOICE_IN_USE_TAG,
} from "./settings-data-tables.ts";
import { HudSegmented } from "../../hud/HudControls";
import { Pause, Play } from "lucide-react";
import { TTS_PREVIEW_TEXT, type TtsEngineV1, type TtsVoiceOptionV1 } from "@astella/shared/tts-voice-catalog";
import type { CompanionVoicePreferenceV1 } from "@astella/shared";
import type { useSettingsVoice } from "./use-settings-voice.ts";

  export function SettingsVoicePanel(props: {
  readonly voicePreference: CompanionVoicePreferenceV1 | null;
  readonly voicePreferenceRead: boolean;
  readonly voiceSaving: boolean;
  /** 这一对来自 `useSettingsVoice`——面板只负责摆位，状态与网络都在那个 hook 里。 */
  readonly changeVoice: ReturnType<typeof useSettingsVoice>["changeVoice"];
  readonly previewVoice: ReturnType<typeof useSettingsVoice>["previewVoice"];
  readonly voicePlayer: { readonly name: string; readonly voice: string; readonly at: number; readonly total: number; readonly playing: boolean } | null;
  readonly onTogglePlayer: () => void;
}): ReactElement {
  const {
    voicePreference, voicePreferenceRead, voiceSaving, voicePlayer, changeVoice, previewVoice,
    onTogglePlayer: toggleVoicePlayer,
  } = props;

  const voiceRow = (option: TtsVoiceOptionV1, inUse: boolean) => (
    <SettingRow
      key={option.voice}
      title={option.name}
      detail={option.note || "官方没有给这一条额外的说明，听上面的试听。"}
      selected={inUse}
    >
      <span className="settings-voice__actions">
        {inUse ? <span className="tag green">{VOICE_IN_USE_TAG}</span> : null}
        {inUse ? null : (
          <button
            type="button"
            className="button ghost"
            disabled={voiceSaving}
            onClick={() => void changeVoice(option.engine, option.voice)}
          >
            用这个声音
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => previewVoice(option)}
        >
          试听
        </button>
      </span>
    </SettingRow>
  );
  return (
    <>
  <div className="settings-rows">
    <SettingRow
      title="用哪套声音合成"
      detail={voicePreference
        ? "换的是她说话用的合成引擎；跟着账号走，换设备也在。"
        : "正在读取这个账号的声音设置。"}
    >
      {voicePreference ? (
        <HudSegmented
          label="合成引擎"
          value={voicePreference.engine}
          options={TTS_ENGINE_OPTIONS}
          compact
          disabled={voiceSaving}
          onChange={(next) => void changeVoice(next, ttsDefaultVoiceFor(next))}
        />
      ) : (
        <span className="tag">{pendingReadLine(voicePreferenceRead)}</span>
      )}
    </SettingRow>
  
    {/* 只画当前引擎下的那一份名单：两套引擎的音色名不通用，混在一张列表里
        会让人以为"龙安灵希"和"晓晓"是可以互换了再听的同一批。 */}
    {voicePreference
      ? voicesForEngine(voicePreference.engine).map(
          (option) => voiceRow(option, voicePreference.voice === option.voice),
        )
      : null}
  </div>
  <div className="settings-voice__player" data-empty={voicePlayer ? undefined : "true"}>
    <button
      type="button"
      className="settings-voice__toggle"
      disabled={!voicePlayer}
      aria-label={voicePlayer?.playing ? "暂停试听" : "播放试听"}
      onClick={toggleVoicePlayer}
    >
      {voicePlayer?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
    </button>
    <span className="settings-voice__reading">
      <b>{voicePlayerLine(voicePlayer)}</b>
      <small>{voicePlayer ? TTS_PREVIEW_TEXT : "点某一行的「试听」，她会用同一句话念给你听：" + TTS_PREVIEW_TEXT}</small>
    </span>
    <span className="settings-voice__track" aria-hidden="true">
      <i style={{ transform: `scaleX(${voicePlayer && voicePlayer.total > 0 ? voicePlayer.at / voicePlayer.total : 0})` }} />
    </span>
    <span className="settings-voice__time">
      {voicePlayer
        ? `${formatVoiceTime(voicePlayer.at)} / ${formatVoiceTime(voicePlayer.total)}`
        : "尚未开始"}
    </span>
  </div>
    </>

  );
}
