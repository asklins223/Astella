/**
 * Procedural 手册（40 §4.6.10，验收 A69）。
 *
 * ## 这一层在合同里是什么
 *
 * §4.5.2 把记忆按用途分成 Core Profile / Semantic / Episodic / Working / **Procedural**
 * 五层。前四层此前都有落点，Procedural 是唯一一个**完全空白**的：
 * 「讲机制先反例后定义」这种可复用的表达/协作经验，只能躺在一条普通 preference 里，
 * 和「我叫小伴」混在一起。
 *
 * 差别是实质的：偏好说的是「**他**是什么样的人」，手册说的是「**遇到这类事先这么做**」。
 *
 * ## 两条读取路径，缺一不可
 *
 * | 路径 | 装什么 | 什么时候 |
 * | --- | --- | --- |
 * | `retrievePlaybookCatalog` | 只有标题 + 触发条件 | **默认**，每轮 |
 * | `readPlaybookById` | 步骤 + 例外 + 证据 | 条件匹配且与当前目标有关时 |
 *
 * 合同原话：「默认只注入**目录**，条件匹配且与用户目标有关时按需读取正文；
 * 优先复用追加召回或已有按 ID 读取服务，**不造无界文件浏览器**。」
 *
 * 所以这里没有"列出全部手册正文"的入口——那正是被点名要避免的形态。
 *
 * ## 手册不能做什么（§4.6.10 的三条禁令）
 *
 * 「手册不能保存未经核实的事实、扩大工具范围或自动启动复习；业务规则始终从领域服务取得。」
 *
 * 这三条**不是靠每个调用方自觉**的：表里根本没有 tool_scope / schedule 列，
 * 作者枚举里也没有 user，跨空间写入被 CHECK 与 RLS 挡住。
 * 换句话说，不合规的形状写不进去。
 */

import { sql } from "drizzle-orm";
import type {
  CompanionPlaybookAuthor,
  CompanionPlaybookEpistemicStatus,
} from "@ailearn/shared/db-schema/assistant-memory";

export interface PlaybookScope {
  workspaceId: string;
  userId: string;
}

/** 目录条目：只有标题与触发条件。**正文不在这条类型里**——这是刻意的。 */
export interface PlaybookCatalogEntry {
  playbookId: string;
  playbookKey: string;
  title: string;
  triggerCondition: string;
  version: number;
  epistemicStatus: CompanionPlaybookEpistemicStatus;
}

/** 展开后的完整手册：目录里没有的步骤/例外/证据只在这里出现。 */
export interface PlaybookBody extends PlaybookCatalogEntry {
  steps: string[];
  exceptions: string[];
  evidence: { memoryId?: string; eventId?: string; note?: string }[];
}

/** 目录最多几条。手册是"少数几条常用的"，不是数据库的全量导出。 */
export const PLAYBOOK_CATALOG_LIMIT = 32;

/**
 * 取目录（标题 + 触发条件）。
 *
 * 有界（{@link PLAYBOOK_CATALOG_LIMIT}）是硬要求：目录是要进 prompt 的，
 * 无界就等于把全量手册正文塞进上下文——那正是合同不想要的。
 */
export async function retrievePlaybookCatalog(
  tx: Executor,
  scope: PlaybookScope,
): Promise<PlaybookCatalogEntry[]> {
  const result = await tx.execute(sql`
    SELECT id, playbook_key, title, trigger_condition, version, epistemic_status
      FROM companion_procedural_playbooks
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
     ORDER BY updated_at DESC, id ASC
     LIMIT ${PLAYBOOK_CATALOG_LIMIT}
  `);
  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    playbookId: String(row.id),
    playbookKey: String(row.playbook_key),
    title: String(row.title),
    triggerCondition: String(row.trigger_condition),
    version: Number(row.version),
    epistemicStatus: String(row.epistemic_status) as CompanionPlaybookEpistemicStatus,
  }));
}

/**
 * 按稳定 ID + 版本展开一条手册。
 *
 * 版本必须显式给出且与当前一致：手册会随用户纠正而升版，模型拿着上一版的
 * `playbookId` 来读**不能**悄悄拿到新内容——那会让"她读的是哪一版"这个问题
 * 永远答不出来。这与记忆的 `expectedRevision` 是同一条纪律。
 */
export async function readPlaybookById(
  tx: Executor,
  scope: PlaybookScope,
  playbookId: string,
  expectedVersion: number,
): Promise<PlaybookBody | null> {
  const result = await tx.execute(sql`
    SELECT id, playbook_key, title, trigger_condition, steps, exceptions,
           evidence, version, epistemic_status
      FROM companion_procedural_playbooks
     WHERE id = ${playbookId}::uuid
       AND workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND version = ${expectedVersion}
     LIMIT 1
  `);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) return null;
  return {
    playbookId: String(row.id),
    playbookKey: String(row.playbook_key),
    title: String(row.title),
    triggerCondition: String(row.trigger_condition),
    steps: stringArray(row.steps),
    exceptions: stringArray(row.exceptions),
    evidence: evidenceArray(row.evidence),
    version: Number(row.version),
    epistemicStatus: String(row.epistemic_status) as CompanionPlaybookEpistemicStatus,
  };
}

/**
 * 写/升版一条手册。
 *
 * 命中同一 `playbookKey` 时**升版**而不是新增——§4.6.10 要「稳定 ID」。
 * 每次都新增的话，她会有五条几乎一样的"讲机制要举例"，而目录是有界的，
 * 结果是它们互相挤掉。
 */
export async function upsertPlaybook(
  tx: Executor,
  scope: PlaybookScope,
  input: {
    playbookKey: string;
    title: string;
    triggerCondition: string;
    steps: string[];
    exceptions: string[];
    evidence: { memoryId?: string; eventId?: string; note?: string }[];
    epistemicStatus: CompanionPlaybookEpistemicStatus;
    author: CompanionPlaybookAuthor;
  },
): Promise<{ playbookId: string; version: number; created: boolean }> {
  // 注意：`Executor.execute` 不是泛型的（本仓 worker 侧统一走 `rowsOf` 取行），
  // 所以这里不能写 `execute<{...}>(...)` —— 那是 apps/api 的 drizzle 事务才有的形状。
  const rows = rowsOf<{ id: string; version: number }>(await tx.execute(sql`
    INSERT INTO companion_procedural_playbooks
      (playbook_key, workspace_id, user_id, title, trigger_condition,
       steps, exceptions, evidence, version, epistemic_status, author, updated_at)
    VALUES
      (${input.playbookKey}, ${scope.workspaceId}, ${scope.userId}, ${input.title},
       ${input.triggerCondition},
       ${JSON.stringify(input.steps)}::jsonb, ${JSON.stringify(input.exceptions)}::jsonb,
       ${JSON.stringify(input.evidence)}::jsonb,
       1, ${input.epistemicStatus}, ${input.author}, now())
    ON CONFLICT (workspace_id, user_id, playbook_key) DO UPDATE
       SET title = EXCLUDED.title,
           trigger_condition = EXCLUDED.trigger_condition,
           steps = EXCLUDED.steps,
           exceptions = EXCLUDED.exceptions,
           evidence = EXCLUDED.evidence,
           version = companion_procedural_playbooks.version + 1,
           epistemic_status = EXCLUDED.epistemic_status,
           author = EXCLUDED.author,
           updated_at = now()
    RETURNING id, version
  `));
  const row = rows[0];
  if (!row) throw new Error("playbook upsert did not return a row");
  return {
    playbookId: String(row.id),
    version: Number(row.version),
    // 版本号是 1 就说明这次走的是纯 INSERT 分支（升版分支必然 ≥2）。
    // 不用 `xmax` 判：那是 ON CONFLICT 的实现细节，换个驱动就变了。
    created: Number(row.version) === 1,
  };
}

/**
 * 把目录渲染成给模型看的一段**纯文本**。
 *
 * 为什么是纯函数：这段文字进 prompt，而 prompt 的装配是整个系统里最容易
 * 悄悄失控的部分。它必须可单测——尤其要能证明「正文不会出现在目录里」。
 *
 * 形状上刻意模仿记忆目录（§4.6.6 的做法）：编号 + 标题 + 触发条件，
 * 让模型能说"第 2 条"，再用 `companion_read_playbook` 按 ID 展开。
 */
export function renderPlaybookCatalog(entries: readonly PlaybookCatalogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry, index) => {
    const disputed = entry.epistemicStatus === "disputed" ? "（依据已被用户纠正，待核对）" : "";
    return `${index + 1}. ${entry.title}｜触发：${entry.triggerCondition}${disputed}`;
  });
  return [
    "（表达与协作手册·目录，只有标题和触发条件；真正怎么做要按 id 展开）",
    ...lines,
    "条件匹配且与用户当前目标有关时，用 companion_read_playbook 读正文；不相关就别读。",
  ].join("\n");
}

// 用 worker 真实的 `WorkerTransaction` 而不是 `{ execute(query: unknown) }`：
// 后者因为参数逆变，drizzle 事务**传不进去**（`execute` 的形参收窄成
// `string | SQLWrapper`）。companion-memory-vector 里那个宽松写法之所以能用，
// 是因为它的调用方自己就把 `tx` 声明成了同一个宽类型——绕了一圈还是同一个形状。
import type { WorkerTransaction } from "../db.ts";

type Executor = WorkerTransaction;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function evidenceArray(value: unknown): PlaybookBody["evidence"] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PlaybookBody["evidence"][number] => typeof item === "object" && item !== null,
  );
}