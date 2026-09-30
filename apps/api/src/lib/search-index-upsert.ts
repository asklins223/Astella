import { searchDocuments } from "@ailearn/shared/db-schema";
import { logger } from "./logger.ts";
import type { ApiTransaction } from "../db/client.ts";

/**
 * 搜索投影的 upsert 语义（2026-09-29 抽出，P2-15 逐字副本收敛之一）。
 *
 * ## 为什么要抽，而且抽的是"这一层"而不是"整个函数"
 *
 * 审计记的是"2 份 21 行逐字"。实测是**三份**，各 29 行上下，28 行非空里 27 行逐字相同；
 * 冲突键（`workspaceId + objectType + objectId`）在三个文件里各写了一遍：
 *   · `modules/note/search-projection.ts`   请求路径，带 savepoint
 *   · `modules/source/service.ts`           请求路径，带 savepoint
 *   · `lib/search-index.ts`                  独立调用（导入器批量写），直接 insert
 *
 * **冲突键必须是唯一的一处。** 它决定了"同一篇笔记"这个身份：改了一处忘了另一处，
 * 症状是同一篇笔记在搜索结果里出现两条，或者改完正文搜到的还是旧内容——
 * 两种都**不报错**，只能靠 drift 检测端点事后发现。
 *
 * ## 但**执行模型**不该统一
 *
 * 前两份跑在调用方已经开好的事务里（要 savepoint 跟着业务一起回滚），
 * 第三份是独立调用（`markdown-import-service` 的批量写，没有外层事务，
 * 而且测试靠注入 mock database）。把这两种执行模型揉成一个函数，
 * 就得给 savepoint 加一个"没有就跳过"的分支——那才是真的引入耦合。
 *
 * 所以这里收敛的是**语义**（键 + set 段），执行模型各留各的。
 * 四处（`lib/search-index.ts` 那份多一列 `metadata`）都从下面这两样取。
 *
 * ## 为什么失败只记日志不抛
 *
 * 搜索索引是**投影**，不是真相来源。写失败不该让"保存笔记"整条链失败——
 * 那会把一次可后台补偿的索引滞后变成用户看得见的保存失败。
 * drift 检测端点与 `/search/reindex` 负责事后补偿（F-025）。
 */

/** 搜索文档的冲突键：同一篇文档的身份就是这三列。 */
export const SEARCH_DOCUMENT_CONFLICT_TARGET = [
  searchDocuments.workspaceId,
  searchDocuments.objectType,
  searchDocuments.objectId,
] as const;

/** 一条待写入的搜索投影。 */
export type SearchProjectionDocument = {
  workspaceId: string;
  objectType: string;
  objectId: string;
  title: string | null;
  body: string | null;
  /** 只有 `lib/search-index.ts` 那一路会带 metadata；另两路固定写空对象。 */
  metadata?: Record<string, unknown>;
};

/** upsert 命中冲突时要改的那几列。 */
export function searchProjectionSet(document: SearchProjectionDocument) {
  return {
    title: document.title,
    body: document.body,
    metadata: document.metadata ?? {},
    indexedAt: new Date(),
  };
}

/** 新插入时用的整行值（键 + 载荷 + 空 metadata + 写入时刻）。 */
export function searchProjectionValues(document: SearchProjectionDocument) {
  return { ...document, metadata: document.metadata ?? {}, indexedAt: new Date() };
}

/** 索引写失败时统一走这里记日志——三处的措辞必须一致，否则 grep 不到。 */
export function logSearchProjectionFailure(err: unknown, document: SearchProjectionDocument): void {
  logger.error(
    { err, ...document },
    "search index upsert failed — index may be stale, run reindex to compensate",
  );
}

/**
 * 请求路径的 upsert：在调用方**已经开好的事务**里用 savepoint 写一条投影。
 *
 * 返回 `true` 表示写成功；`false` 表示失败但**不抛**——理由见文件头。
 */
export async function upsertSearchProjection(
  executor: ApiTransaction,
  document: SearchProjectionDocument,
): Promise<boolean> {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .insert(searchDocuments)
        .values(searchProjectionValues(document))
        .onConflictDoUpdate({
          target: [...SEARCH_DOCUMENT_CONFLICT_TARGET],
          set: searchProjectionSet(document),
        });
    });
    return true;
  } catch (err) {
    logSearchProjectionFailure(err, document);
    return false;
  }
}
