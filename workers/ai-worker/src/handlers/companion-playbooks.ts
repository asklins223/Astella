/**
 * Procedural 手册的 worker 适配层（40 §4.6.10，验收 A69）。
 *
 * ## 权威在 agent-host，这里只做投影
 *
 * 方法的生命周期、认识状态、来源核对与版本全部由 `agent-host` 从
 * `companion_procedural_playbooks` 的真实行投影出来（`projectAgentMethod`）。
 * 本文件**不重新发明**任何一条状态：目录条目的认识状态就是那一行的 `epistemic_status`，
 * 不是「默认有据」。写死 `supported` 会让依据已被用户纠正的手册在目录里装作没事——
 * 那正是 0348/0374 拆出 `method_state` 与 `epistemic_status` 两列要挡的退化。
 *
 * ## 两条读取路径，缺一不可
 *
 * | 路径 | 装什么 | 什么时候 |
 * | --- | --- | --- |
 * | `retrievePlaybookCatalog` | 只有编号 + 标题 + 触发条件 + ID/版本 | **默认**，每轮 |
 * | `readPlaybookById` | 步骤 + 例外 + 证据 | 条件匹配且与当前目标有关时 |
 *
 * 两条路径都经过 host 的「可采用」围栏：停用、依据失效、暂定的方法既不进目录，
 * 也读不出正文。
 */
import { listAgentMethods, readAgentMethod, upsertAgentMethodCandidate, type AgentSqlExecutor } from "@ailearn/agent-host";
import type { AgentMethodV1, AgentMethodEvidenceV1, AgentMethodEpistemicStatusV1 } from "@ailearn/shared/agent-growth-contracts";

export interface PlaybookScope { workspaceId: string; userId: string }
/** 目录条目：只有标题、触发条件、ID 与版本。**正文不在这条类型里**——这是刻意的。 */
export interface PlaybookCatalogEntry {
  playbookId: string; playbookKey: string; title: string; triggerCondition: string; version: number;
  epistemicStatus: AgentMethodEpistemicStatusV1;
}
/** 展开后的完整手册：目录里没有的步骤/例外/证据只在这里出现。 */
export interface PlaybookBody extends PlaybookCatalogEntry {
  steps: string[]; exceptions: string[]; evidence: AgentMethodEvidenceV1[];
}
/** 目录最多几条。手册是「少数几条常用的」，不是数据库的全量导出。 */
export const PLAYBOOK_CATALOG_LIMIT = 20;
/** 认识状态原样透传：它决定模型能不能把这条当成已确认的做法照做。 */
const catalogEntry = (method: AgentMethodV1): PlaybookCatalogEntry => ({
  playbookId: method.methodId, playbookKey: method.methodId, title: method.title,
  triggerCondition: method.appliesWhen, version: method.revision, epistemicStatus: method.epistemicStatus,
});
export async function retrievePlaybookCatalog(tx: AgentSqlExecutor, scope: PlaybookScope): Promise<PlaybookCatalogEntry[]> {
  return (await listAgentMethods(tx, scope, true)).map(catalogEntry);
}
export async function readPlaybookById(tx: AgentSqlExecutor, scope: PlaybookScope, playbookId: string, expectedVersion: number,
  consultation?: { kind: "agent_goal" | "conversation"; id: string; revision: number; sourceKey: string }): Promise<PlaybookBody | null> {
  const method = await readAgentMethod(tx, scope, playbookId, expectedVersion, consultation);
  return method ? { ...catalogEntry(method), steps: method.steps, exceptions: method.exceptions, evidence: method.evidence } : null;
}
export const upsertPlaybook = upsertAgentMethodCandidate;
/**
 * 把目录渲染成给模型看的一段**纯文本**：编号 + 标题 + 触发条件 + 稳定 ID + 版本。
 *
 * 为什么是纯函数：这段文字进 prompt，而 prompt 的装配最容易悄悄失控。
 * 它必须可单测——尤其要能证明两件事：正文不会出现，以及争议状态不会被抹掉。
 * 有争议的条目在目录里就标出来：目录是模型唯一默认看到的东西，
 * 等读到正文才发现「依据已被用户纠正」已经晚了一步。
 */
export function renderPlaybookCatalog(entries: readonly PlaybookCatalogEntry[]): string {
  if (!entries.length) return "";
  return [
    "（合作方法·目录，只有编号、标题、适用条件、稳定 ID 与版本；真正怎么做要按 id 展开）",
    ...entries.map((entry, index) => {
      const disputed = entry.epistemicStatus === "disputed" ? "（依据已被用户纠正，待核对）" : "";
      return `${index + 1}. ${entry.title}｜触发：${entry.triggerCondition}｜id=${entry.playbookId} v=${entry.version}${disputed}`;
    }),
    "条件匹配且与用户当前目标有关时，用 companion_read_playbook 读正文；不相关就别读。"
      + "当前要求与材料优先，不搬用旧产物或旧授权。",
  ].join("\n");
}
