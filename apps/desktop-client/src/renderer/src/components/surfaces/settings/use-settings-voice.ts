/**
 * 设置页「声音」那一簇：音色偏好、试听播放器、以及它们的读写。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件 3139 行、`SettingsSurface` 单个函数 2603 行，29 个 state 按前缀聚成
 * voice / invite / inventory / audit / ai / profile / dissolve 等簇。这是第一簇（voice），
 * 也是唯一一簇**不读任何页面级数据**的：它只要 `epochRef` 与一句 `setFailureNotice`。
 *
 * 拆分的判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 *
 * ## 刻意留在页面里的那一半
 *
 * 读取那一个 effect 和 invites / members / inventory 的读取写在**同一个 effect** 里
 * （`settings-surface.tsx` 的 `setVoicePreference` 那处），所以它跟着留下了——
 * 它只用本 hook 返回的 setter，边界是干净的。要拆它得先把那个 effect 按域分开，
 * 那是另一步的事。
 *
 * ⚠️ 搬过来时逐字保留了实现：`wireVoiceAudio` 的事件解绑、`previewVoice` 里
 * `preload="none"` 那段录音的 src 清理，都是踩过坑写下来的，不要"顺手简化"。
 */
import { useEffect, useRef, useState } from "react";
import type { CompanionVoicePreferenceV1, TtsEngineV1, TtsVoiceOptionV1 } from "@ailearn/shared";
import { createRequestMeta, unwrapGatewayResult, gatewayErrorMessage } from "../../../app/desktop-client";

export function useSettingsVoice(input: {
  readonly epochRef: { current: number | undefined };
  /** 页面级的那一句失败说明。声音这一簇不自己另开一块错误区。 */
  readonly setFailureNotice: (message: string | null) => void;
}) {
  const { epochRef, setFailureNotice } = input;

  // 声音：引擎 + 音色（账号级）。与作答方式同样"读到才画选项"，没读到不能把默认值演成用户的选择。
  const [voicePreference, setVoicePreference] = useState<CompanionVoicePreferenceV1 | null>(null);
  const [voicePreferenceRead, setVoicePreferenceRead] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  /** 录音放不出来时的读数（例如资产没打进包）：控件在响但没声音，比没控件更难查。 */
  const [voicePreviewError, setVoicePreviewError] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 播放器读数：只有真合成回来才有值，没试听过时界面讲的是"将要念的那句"。 */
  const [voicePlayer, setVoicePlayer] = useState<{
    readonly name: string;
    readonly voice: string;
    readonly at: number;
    readonly total: number;
    readonly playing: boolean;
  } | null>(null);

  /**
   * 保存"这一身"。引擎与音色成对写：切到 edge 时把 edge 那条固定音色一起写下去，
   * 库里不留"引擎=edge + 音色是千问的"的半套状态（服务端读到不配对会整条回默认，
   * 但那是兜底，不该由界面产生）。
   */
  const changeVoice = async (engine: TtsEngineV1, voice: string) => {
    if (voiceSaving) return;
    setVoiceSaving(true);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.companion.voicePreference.patch({
        meta: createRequestMeta(epochRef.current),
        engine,
        voice,
      });
      setVoicePreference(unwrapGatewayResult(response));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setVoiceSaving(false);
    }
  };

  /**
   * 播放器读数：换掉原生 <audio controls> 之后，进度、时长和"在放哪一身"全由这几个事件供。
   *
   * 不能挂在一次性 mount effect 上：<audio> 渲染在「语音与伴星」这一屏里，effect 跑的
   * 那一刻它还不存在（真窗口实测：音频在放，读数却永远停在 0:00 / 0:00、进度条一动不动）。
   * 所以改成第一次要用它之前接线，按元素身份去重。
   */
  const wiredAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioHandlersRef = useRef<Record<string, EventListener> | null>(null);
  const wireVoiceAudio = () => {
    const element = voiceAudioRef.current;
    if (!element || wiredAudioRef.current === element) return;
    const patch = (next: Partial<{ at: number; total: number; playing: boolean }>) =>
      setVoicePlayer((prev) => (prev ? { ...prev, ...next } : prev));
    const handlers: Record<string, EventListener> = {
      loadedmetadata: () => patch({ total: Number.isFinite(element.duration) ? element.duration : 0 }),
      timeupdate: () => patch({ at: element.currentTime }),
      play: () => patch({ playing: true }),
      pause: () => patch({ playing: false }),
      ended: () => patch({ playing: false }),
      error: () => setVoicePreviewError("这段试听录音没能放出来。"),
    };
    for (const [event, handler] of Object.entries(handlers)) element.addEventListener(event, handler);
    wiredAudioRef.current = element;
    voiceAudioHandlersRef.current = handlers;
  };

  /**
   * 试听：直接放渲染进程里的那段录音。
   *
   * 这里刻意不再调服务端。挑声音天然要把同一句话反复听好几遍，每听一遍就合成一次
   * 是白花钱；录音按当前 model + voice + instruction 生成，改那三样要重新生成资产
   * （见 public/assets/companion/voice-preview-v1/PROVENANCE.md）。
   */
  const previewVoice = (option: TtsVoiceOptionV1) => {
    setVoicePreviewError(null);
    setVoicePlayer({ name: option.name, voice: option.voice, at: 0, total: 0, playing: false });
    const element = voiceAudioRef.current;
    if (!element) return;
    wireVoiceAudio();
    element.src = option.previewAsset;
    element.load();
    // 用户点的就是"放给我听"，不再要求二次点击；被自动播放策略拦下时播放器仍可手动按。
    void element.play().catch(() => undefined);
  };

  useEffect(() => () => {
    const element = wiredAudioRef.current;
    const handlers = voiceAudioHandlersRef.current;
    if (element) {
      // 卸载要**先停下来**再摘监听：以前这里只摘监听，于是切走这一屏之后录音还在放，
      // 而读数、进度条、那颗「暂停试听」按钮全跟着界面一起没了（方案 35 F9）。
      element.pause();
      if (handlers) {
        for (const [event, handler] of Object.entries(handlers)) element.removeEventListener(event, handler);
      }
      // 源也要放开：`preload="none"` 的那段录音留在一个已脱离文档的元素上，
      // 下次进这一屏时它会先播上一次的音色。
      element.removeAttribute("src");
      element.load();
    }
  }, []);

  const toggleVoicePlayer = () => {
    const element = voiceAudioRef.current;
    if (!element || !voicePlayer) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  return {
    voicePreference,
    setVoicePreference,
    voicePreferenceRead,
    setVoicePreferenceRead,
    voiceSaving,
    voicePreviewError,
    voicePlayer,
    voiceAudioRef,
    changeVoice,
    previewVoice,
    toggleVoicePlayer,
  };
}
