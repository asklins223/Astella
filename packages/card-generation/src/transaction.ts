/**
 * 窄事务端口：制卡领域服务在**事务里**真正用到的那几个执行器方法。
 *
 * ─── 为什么不写 `ApiTransaction` ───
 * `apps/api/src/db/client.ts` 的 `ApiTransaction` 是 `Parameters<db.transaction>` 的
 * 提取类型——它属于 API 这个宿主。一旦制卡服务开始 import 它，依赖方向就倒过来了：
 * 领域服务 → 宿主模块。所以这里改为**从真实 driver 类型上 Pick 出实际用到的那几个
 * 方法**，API 的 `withWorkspaceTransaction` 回调里的 `tx` 与 worker 的 drizzle 事务
 * 都能**结构赋值**给它们（两者都是 `drizzle(postgres, { schema })` 出来的
 * `PgTransaction<PostgresJsQueryResultHKT, typeof schema, …>`，而
 * `PostgresJsDatabase` 的 `select/insert/update/execute/query` 就定义在同一个
 * `PgDatabase` 基类上）。
 *
 * ─── 为什么这个类型**不**声称自己有事务能力 ───
 * 这里只有 select/insert/update/execute/query。**没有** `transaction`、
 * **没有** `rollback`、**没有** `commit`——领域服务拿到的就是调用方那一段事务里
 * 的执行器，它不许开嵌套事务、不许 commit、不许 rollback。用 `any` 或
 * `as unknown as` 把整个事务对象假装成"我有全部能力"会让这些调用在编译期消失，
 * 而那正是这类抽取最常见的真实故障（有人顺手在里面 commit 掉外层事务）。
 *
 * `query` 进一步缩到**创建事务真正用到的那三张笔记表**（`noteVersions` / `notes` /
 * `noteBlocks`）：领域服务不该因为"类型上拿到了"就能读别的域的表。
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** 真实 driver 用的那份 shared schema（与 API / worker 建库时传入的同一个模块）。 */
type SharedSchema = typeof import("@ailearn/shared/db-schema");

type WorkspaceDb = PostgresJsDatabase<SharedSchema>;

/** 关系查询（`tx.query.*`）的窄口：只有创建事务真正读的那三张笔记表。 */
export type CardGenerationNoteQuery = Pick<
  WorkspaceDb["query"],
  "noteVersions" | "notes" | "noteBlocks"
>;

/** 写 run 事件的执行面：一次 MAX + 一次 INSERT（见 `events.ts`）。 */
export interface CardGenerationEventTx {
  select: WorkspaceDb["select"];
  insert: WorkspaceDb["insert"];
}

/** seal 的执行面：三批幂等 INSERT（见 `evidence-seal.ts`）。 */
export interface CardGenerationEvidenceSealTx {
  insert: WorkspaceDb["insert"];
}

/** 创建事务的执行面：事件 + 状态推进 + advisory lock/计数 + 三张笔记表的关系查询。 */
export interface CardGenerationRunCreationTx extends CardGenerationEventTx {
  update: WorkspaceDb["update"];
  execute: WorkspaceDb["execute"];
  query: CardGenerationNoteQuery;
}