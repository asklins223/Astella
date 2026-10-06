import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { searchDocuments } from "@astella/shared/db-schema/search";
import { logger } from "../../lib/logger.ts";
import {
  SEARCH_DOCUMENT_CONFLICT_TARGET,
  logSearchProjectionFailure,
  searchProjectionSet,
  searchProjectionValues,
} from "../../lib/search-index-upsert.ts";

/**
 * 数据库接口类型——仅选取 upsert/delete 所需的方法。
 * 测试时可注入 mock 实现以验证真实函数逻辑。
 */
type SearchDatabase = Pick<typeof db, "insert" | "delete">;

/**
 * 搜索索引同步统一入口。
 * 各模块只调用此函数，不内联写 upsert SQL。
 *
 * 2026-09-29（P2-15）：冲突键与 set 段改为从 `lib/search-index-upsert.ts` 取——
 * 它们此前在这三个文件里各写了一遍（这里 + note/search-projection + source/service），
 * 而"同一篇文档的身份"必须只有一处。执行模型**不统一**：这里没有外层事务，
 * 另外两处有（要用 savepoint 跟着业务一起回滚），所以只共享语义。
 *
 * V0.3 用同步写入，不引入 domain event。
 * 后续如需改为异步（domain event 驱动），只需修改此函数内部实现。
 *
 * F-025: 索引写入失败不中断主流程，记录日志供补偿。
 * 搜索索引是派生投影，业务事务成功后索引写入失败不应回滚业务操作。
 * 调用方可通过 GET /search/drift 检测漂移，并通过 POST /search/reindex 补偿。
 */
export async function upsertSearchDocument(
  params: {
    workspaceId: string;
    objectType: "note" | "source";
    objectId: string;
    title: string | null;
    body: string | null;
    metadata?: Record<string, unknown>;
  },
  database: SearchDatabase = db,
): Promise<boolean> {
  try {
    await database
      .insert(searchDocuments)
      .values(searchProjectionValues(params))
      .onConflictDoUpdate({
        target: [...SEARCH_DOCUMENT_CONFLICT_TARGET],
        set: searchProjectionSet(params),
      });
    return true;
  } catch (err) {
    // F-025：索引写入失败不中断主流程，记录日志供补偿。
    logSearchProjectionFailure(err, params);
    return false;
  }
}

/**
 * 删除搜索索引。
 *
 * F-025: 同上，删除失败也只记录日志，不中断主流程。
 */
export async function deleteSearchDocument(
  workspaceId: string,
  objectType: "note" | "source",
  objectId: string,
  database: SearchDatabase = db,
): Promise<void> {
  try {
    await database
      .delete(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, workspaceId),
          eq(searchDocuments.objectType, objectType),
          eq(searchDocuments.objectId, objectId),
        ),
      );
  } catch (err) {
    // F-025: 索引删除失败不中断主流程，记录日志供补偿
    logger.error(
      {
        err,
        workspaceId,
        objectType,
        objectId,
      },
      "search index delete failed — index may have ghost document, run reindex to compensate",
    );
  }
}
