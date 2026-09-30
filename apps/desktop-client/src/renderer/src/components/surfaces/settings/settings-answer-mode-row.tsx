/**
 * 「默认作答方式」那一行。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 23 行、3 个外部符号。它和声音那一行是**一对**——两样都是「账号级偏好、跨设备一致」，
 * 分组上挨着。但它们各自有自己的判据（一个三档、一个跟引擎走），合成一个组件反而要把
 * 两个不相干的 state 捆在一张 prop 表上。
 *
 * ⚠️ 那段注释是这一行的一部分：**读到之前不画选项**——把「跟随安排」画成已选，
 * 就是把一个服务端从没回答过的值当成答案给读者看。这是 §9 那一族「不制造用户没做过的
 * 选择」的规矩在这一处的落法。
 */
import type { ReactElement } from "react";
import type { CompanionAnswerModePreferenceV1 } from "@ailearn/shared";
import { SettingRow } from "./settings-primitives.tsx";
import { HudSegmented } from "../../hud/HudControls";
import { ANSWER_MODE_OPTIONS, pendingReadLine } from "./settings-data-tables.ts";

export function SettingsAnswerModeRow(props: {
  readonly answerMode: CompanionAnswerModePreferenceV1 | null;
  readonly answerModeRead: boolean;
  readonly answerModeSaving: boolean;
  /** 写回账号级偏好。页面持有它，因为它要串 save 那一发。 */
  readonly changeAnswerMode: (preference: CompanionAnswerModePreferenceV1["preference"]) => Promise<void>;
}): ReactElement {
  const { answerMode, answerModeRead, answerModeSaving, changeAnswerMode } = props;
  return (
<div className="settings-rows">
  {/* 读到之前不画选项：把「跟随安排」画成已选，就是把一个服务端从没
      回答过的值当成答案给读者看。 */}
  <SettingRow
    title="默认作答方式"
    detail={answerMode
      ? "账号级偏好，跨设备一致；「跟随安排」由系统按当时情况编排。"
      : "正在读取这个账号的作答偏好。"}
  >
    {answerMode ? (
      <HudSegmented
        label="默认作答方式"
        value={answerMode.preference}
        options={ANSWER_MODE_OPTIONS}
        compact
        disabled={answerModeSaving}
        onChange={(next) => void changeAnswerMode(next)}
      />
    ) : (
      <span className="tag">{pendingReadLine(answerModeRead)}</span>
    )}
  </SettingRow>
</div>
  );
}
