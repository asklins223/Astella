import { CompanionSelect } from "./companion-select";

export type CooperationScope = "workspace" | "global";

export interface MemoryRuleDraftFields {
  disabled?: boolean;
  appliesWhen: string;
  onAppliesWhen: (value: string) => void;
  scope?: { value: CooperationScope; onChange: (value: CooperationScope) => void; allowGlobal: boolean };
}

export function MemoryRuleFields({ fields, editing = false }: { fields: MemoryRuleDraftFields; editing?: boolean }) {
  return <>
    {fields.scope ? <label>适用书房<CompanionSelect paper disabled={fields.disabled} ariaLabel="新记忆适用书房"
      value={fields.scope.allowGlobal ? fields.scope.value : "workspace"}
      options={fields.scope.allowGlobal ? [{ value: "workspace", label: "这个书房" }, { value: "global", label: "所有书房" }]
        : [{ value: "workspace", label: "这个书房" }]} onChange={fields.scope.onChange} /></label> : null}
    <label className="cc-rule-conditions">适用条件与例外<textarea disabled={fields.disabled} value={fields.appliesWhen} maxLength={200}
      onChange={event => fields.onAppliesWhen(event.currentTarget.value)}
      aria-label={editing ? "修订后的适用条件" : "新记忆适用条件"}
      placeholder="例如：讲解机制时先举例；正式作答时不要主动提示。可留空。" /></label>
    {fields.scope?.allowGlobal && fields.scope.value === "global" ? <p className="cc-rule-form-note">只有一般的学习与相处偏好会跟随你。涉及具体材料、科目或任务的内容，请留在这个书房。</p> : null}
  </>;
}
