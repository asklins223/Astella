/**
 * Agent 采用的「已确认合作规则」的纯映射层（方案 42 阶段 1B）。
 *
 * SQL 判据在 `learning-context.ts`（索引、时窗、隔离只能问库）；这里只回答
 * 「读出来的那一行本身可不可信」。两层不是两份规则：白名单是同一份常量。
 */
import { AGENT_PROMPT_DIRECTORY_LIMIT } from "@astella/agent-host";

/** 认识状态词表，与迁移 0360 的 `assistant_memory_items_epistemic_status_check` 同源。 */
export const ADOPTABLE_EPISTEMIC_STATUSES = ["supported", "tentative"] as const;

/**
 * 采用的空间档。`task` 是「这一轮的临时状态」，把它当偏好就是把旧任务带进下一次。
 *
 * `global` 能出现在这里，靠的是 0267 的铺开与 0268 的副本同步，不是这里跨空间读。
 */
export const ADOPTABLE_PREFERENCE_SCOPES = ["global", "workspace"] as const;

/**
 * 采用条数与「相关做法目录」共用同一份声明源（agent-host，2026-10-12 收口：
 * 进提示词的目录不再两处各写一个 4）。单条正文**整条给出**：旧的「单条 ≤200 字」
 * 是逐条砍字，正属本轮裁决取消的那一类，所以这里不再有字数常量。
 */
export const AGENT_PREFERENCE_LIMIT = AGENT_PROMPT_DIRECTORY_LIMIT;

export type AgentPreferenceScope = (typeof ADOPTABLE_PREFERENCE_SCOPES)[number];
export type AgentPreferenceEpistemicStatus = (typeof ADOPTABLE_EPISTEMIC_STATUSES)[number];

export interface AgentPreferenceRow {
  id: string;
  revision: number | string;
  scope: string;
  content: string;
  applies_when: string | null;
  epistemic_status: string;
}

/**
 * `memoryId` / `revision` 是「这条偏好从哪来、还是不是最新那一版」的凭据：
 * 没有 id 无法在纠正后对照是哪一条，没有 revision 分不出「读到的」和「现在的」。
 * `kind` 与 `content` 是既有调用接口，不动。
 */
export interface AdoptedAgentPreference {
  memoryId: string;
  revision: number;
  scope: AgentPreferenceScope;
  kind: "preference";
  content: string;
  appliesWhen: string | null;
  epistemicStatus: AgentPreferenceEpistemicStatus;
}

/** id 形状不对说明查错了列或连错了库——这种行无法追溯，也就无法被撤销。 */
const MEMORY_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveRevision(value: number | string): number | null {
  const revision = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

/**
 * 入参顺序即优先级（SQL 已按 pinned/importance/updated_at 排过），预算只砍尾部，
 * 固定过的高优先级偏好不会被后面一条挤掉。
 */
export function adoptAgentPreferences(
  rows: readonly AgentPreferenceRow[],
  limit: number = AGENT_PREFERENCE_LIMIT,
): AdoptedAgentPreference[] {
  const adopted: AdoptedAgentPreference[] = [];
  for (const row of rows) {
    if (adopted.length >= Math.max(0, limit)) break;
    if (!ADOPTABLE_PREFERENCE_SCOPES.includes(row.scope as AgentPreferenceScope)) continue;
    if (!ADOPTABLE_EPISTEMIC_STATUSES.includes(row.epistemic_status as AgentPreferenceEpistemicStatus)) continue;
    const memoryId = String(row.id ?? "").trim().toLowerCase();
    if (!MEMORY_ID_SHAPE.test(memoryId)) continue;
    const revision = positiveRevision(row.revision);
    if (revision === null) continue;
    // 正文整条采用：曾经在这里 `.slice(0, 200)`，把用户定过的合作规则砍成半句，
    // 是「喂给模型的输入按字数静默裁」的禁止形状（2026-10-12 裁决）。
    const content = String(row.content ?? "").trim();
    // 空的没有可采用的内容，也不能占掉上限里的一个位置。
    if (!content) continue;
    const appliesWhen = String(row.applies_when ?? "").trim();
    adopted.push({
      memoryId,
      revision,
      scope: row.scope as AgentPreferenceScope,
      kind: "preference",
      content,
      appliesWhen: appliesWhen ? appliesWhen : null,
      epistemicStatus: row.epistemic_status as AgentPreferenceEpistemicStatus,
    });
  }
  return adopted;
}