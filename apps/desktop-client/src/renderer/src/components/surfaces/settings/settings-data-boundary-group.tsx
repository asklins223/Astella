/**
 * 设置页「数据外发策略」与「外发台账」那两块。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 67 行、12 个外部符号。其中 `DATA_POLICY_FIELDS` 与 `HudSwitch` 都已经是可 import 的
 * 东西；`policy` / `busy` / `aiSaving` 是这一组的三个值；台账那半只需要页数与读数。
 *
 * ⚠️ 这一块有个**不能拆的语义**：「数据外发策略」跟着**账号**走、不是跟着空间走
 * （正文第一句就写着），而「外发台账」是**逐条已发生的记录**。两者同在一个分组里，
 * 所以搬的时候要一起搬——拆开会让「策略」看起来像空间级设置。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement } from "react";
import { SettingRow } from "./settings-primitives.tsx";
import { HudSwitch } from "../../hud/HudControls";
import { AUDIT_CATEGORY_LABELS, AUDIT_STATUS_LABELS, DATA_POLICY_FIELDS } from "./settings-data-tables.ts";
import type { DesktopAiAuditItemV1, DesktopAiAuditPageV1 } from "@ailearn/shared/desktop-surface-contracts";
import type { AiDataPolicyV1 } from "@ailearn/shared/desktop-ipc-contracts";

export function SettingsDataBoundaryGroup(props: {
  /** 策略本体来自共享合同；组件按 `DATA_POLICY_FIELDS` 的键读它，不自己另定一套。 */
  readonly policy: AiDataPolicyV1 | null;
  readonly busy: boolean;
  readonly aiSaving: string | null;
  readonly isOwner: boolean;
  readonly audit: {
    readonly auditPage: DesktopAiAuditPageV1 | null;
    readonly auditOffset: number;
    readonly auditBusy: boolean;
    readonly auditFailure: string | null;
    readonly auditPagingLine: string | null;
  };
  readonly onSavePolicy: (patch: Partial<AiDataPolicyV1>, field: string) => Promise<void>;
  readonly loadAuditPage: (offset: number) => void;
  readonly formatWhen: (value: string) => string;
}): ReactElement {
  const {
    policy, busy, aiSaving, isOwner,
    audit: {
      auditPage, auditOffset, auditBusy, auditFailure, auditPagingLine,
    },
    onSavePolicy: saveDataPolicy,
    loadAuditPage,
    formatWhen: formatObjectiveDateTime,
  } = props;
  return (
<section className="settings-group">
  <h3 className="settings-group__title">数据外发策略</h3>
  <p className="settings-group__note">跟着你的账号走，不跟空间走：在这个部署里签一次、调一次，去哪个空间都沿用同一份设置。</p>
  <div className="settings-rows">
    {DATA_POLICY_FIELDS.map(([field, title, detail]) => (
      <SettingRow key={field} title={title} detail={detail}>
        {aiSaving === field ? <span className="tag">保存中…</span> : null}
        <HudSwitch
          checked={policy?.[field] ?? false}
          disabled={!policy || busy}
          onChange={(next) => void saveDataPolicy({ [field]: next }, field)}
          label={title}
        />
      </SettingRow>
    ))}
    {/* 上面那行"供你回看"以前没有落点：写侧一直在记，桌面没有任何地方读它
        （doc 34 L3）。这一行就是那个落点，读的是服务端那份审计。 */}
    <SettingRow
      title="外发记录"
      detail={isOwner
        ? "哪一天、把哪类内容发给了哪家模型、成没成。"
        : "记录一直在写；这份清单由这个空间的所有者回看。"}
    >
      {isOwner ? (
        <button type="button" className="button" disabled={auditBusy} onClick={() => void loadAuditPage(0)}>
          {auditBusy ? "正在读取…" : auditPage ? "重新读取" : "查看"}
        </button>
      ) : null}
    </SettingRow>
    {isOwner && auditFailure ? (
      <SettingRow title="外发记录暂时读不到" detail={auditFailure}>
        <button type="button" className="button" disabled={auditBusy} onClick={() => void loadAuditPage(auditOffset)}>重试</button>
      </SettingRow>
    ) : null}
    {isOwner && !auditFailure && auditPage && auditPage.items.length === 0 ? (
      <SettingRow title="还没有外发记录" detail="这个空间还没有记下任何一次外发。" />
    ) : null}
    {isOwner && auditPage && auditPage.items.length > 0 ? (
      <>
        {auditPage.items.map((item) => (
          <SettingRow
            key={item.id}
            title={`${item.provider} · ${item.modelId}`}
            detail={`${formatObjectiveDateTime(item.createdAt)} · 带出去的内容：${item.dataCategories.map((category) => AUDIT_CATEGORY_LABELS[category] ?? category).join("、")}`}
          >
            <span className={item.status === "success" ? "tag green" : "tag"}>{AUDIT_STATUS_LABELS[item.status]}</span>
          </SettingRow>
        ))}
        <SettingRow
          title={auditPagingLine}
          detail="更早的记录按时间往前列。"
        >
          {auditOffset + auditPage.items.length < auditPage.total ? (
            <button
              type="button"
              className="button"
              disabled={auditBusy}
              onClick={() => void loadAuditPage(auditOffset + auditPage.items.length)}
            >
              更早的记录
            </button>
          ) : null}
        </SettingRow>
      </>
    ) : null}
  </div>
</section>
  );
}
