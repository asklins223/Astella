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
 * 两条路径都经过 host 的「可采用」围栏：停用、依据失效或有争议的方法既不进目录，
 * 也读不出正文。
 */
import {
  listAgentMethodBuckets, readAgentMethod, upsertAgentMethodCandidate,
  type AgentSqlExecutor,
} from "@astella/agent-host";
import type { AgentMethodV1, AgentMethodEvidenceV1, AgentMethodEpistemicStatusV1 } from "@astella/shared/agent-growth-contracts";

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
/**
 * 旧候选（待迁移或由历史流程留下）另开一条有界通道。
 *
 * 上限单独一个源：候选和目录是两个集合，共用一个数会让"目录被候选挤掉"这种
 * 退化没法解释（§4.6.10 那条纪律讲的是两条独立通道）。
 */
export const PLAYBOOK_CANDIDATE_LIMIT = 5;
/** 认识状态原样透传：它决定模型能不能把这条当成已确认的做法照做。 */
const catalogEntry = (method: AgentMethodV1): PlaybookCatalogEntry => ({
  playbookId: method.methodId, playbookKey: method.methodId, title: method.title,
  triggerCondition: method.appliesWhen, version: method.revision, epistemicStatus: method.epistemicStatus,
});
/**
 * 候选条目：与目录同样的身份，多带「什么时候别用」那几行。
 *
 * 例外要紧：一条刚从相处里提炼出来的做法最容易过度套用（"打招呼别盘点笔记"被
 * 引申成"永远不接学习笔记"），而那几行例外本来就是反思时从同一批素材里读出来的。
 */
export interface PlaybookCandidateEntry extends PlaybookCatalogEntry { exceptions: string[] }

/**
 * 目录与候选**一次取回**（2026-10-10 审计：同一张表、同一个事务，分两条 SQL 只让每轮装配
 * 多一次往返）。两条通道的判据都留在 agent-host 那条查询里（`listAgentMethodBuckets` 的
 * bucket：目录 active 且非 disputed、候选 candidate 且非 disputed），这里只做投影——
 * 目录给 id/标题/触发条件，候选还要「什么时候别用」那几行。
 *
 * 候选这一边就是成长闭环的**读回**边（方案 50 §16 第 6 步）：反思产出若永远进不了下一次
 * 相处，「用户改过之后下一轮不再照旧的来」就没有可观察的落点。候选不进那 20 条目录
 * （那是「可以照做」的集合），上限也各算各的。
 */
export async function retrievePlaybookViews(tx: AgentSqlExecutor, scope: PlaybookScope): Promise<{
  catalog: PlaybookCatalogEntry[]; candidates: PlaybookCandidateEntry[];
}> {
  const buckets = await listAgentMethodBuckets(tx, scope, {
    catalogLimit: PLAYBOOK_CATALOG_LIMIT, candidateLimit: PLAYBOOK_CANDIDATE_LIMIT,
  });
  return {
    catalog: buckets.catalog.map(catalogEntry),
    candidates: buckets.candidates.map((method) => ({ ...catalogEntry(method), exceptions: method.exceptions })),
  };
}
export async function readPlaybookById(tx: AgentSqlExecutor, scope: PlaybookScope, playbookId: string, expectedVersion: number,
  consultation?: { kind: "agent_goal" | "conversation"; id: string; revision: number; sourceKey: string }): Promise<PlaybookBody | null> {
  const method = await readAgentMethod(tx, scope, playbookId, expectedVersion, consultation);
  return method ? { ...catalogEntry(method), steps: method.steps, exceptions: method.exceptions, evidence: method.evidence } : null;
}
/**
 * 候选渲染成给模型看的一段纯文本，与目录同一口径：**正文不在这里出现**。
 *
 * 「还没核对」这个状态必须写在文字里：这一条与目录那条的差别不是排版，而是
 * 她能不能把眼前这条当既成约定。同时也不给她台阶去向用户复述这条内部账目
 * （「我有一条待核对的做法」不是对用户说的话，撤换在方法页里做）。
 */
export function renderPlaybookCandidates(entries: readonly PlaybookCandidateEntry[]): string {
  if (!entries.length) return "";
  return [
    "（合作方法·她自己从最近相处里提炼的候选，暂定做法；只有标题、触发条件与别用的情形）",
    ...entries.map((entry, index) => {
      const avoid = entry.exceptions.length > 0 ? `｜别用的情形：${entry.exceptions.join("；")}` : "";
      return `${index + 1}. ${entry.title}｜触发：${entry.triggerCondition}${avoid}`;
    }),
    "这些是她自己记下的尝试，不是用户定过的约定：这一轮确实合触发条件才参考，"
      + "用户现在说的与手头材料优先，合不上就当没有。不要把这条清单念给用户听，"
      + "也不要说「我还在等你核对」；用户可以事后在「方法」页查看、纠正或停用。",
  ].join("\n");
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
      const disputed = entry.epistemicStatus === "disputed" ? "（依据已被用户纠正，待核对）"
        : entry.epistemicStatus === "tentative" ? "（暂定做法，仍在尝试）" : "";
      return `${index + 1}. ${entry.title}｜触发：${entry.triggerCondition}｜id=${entry.playbookId} v=${entry.version}${disputed}`;
    }),
    "条件匹配且与用户当前目标有关时，用 companion_read_playbook 读正文；不相关就别读。"
      + "做法由你判断采用、修订或放弃，无需用户批准；暂定不等于已证实。当前要求与材料优先，不搬用旧产物或旧授权。",
  ].join("\n");
}
