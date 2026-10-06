/**
 * 笔记可见性的 **drizzle 读点判据**（唯一实现，与 `note-visibility.ts` 的文本版同一条规则）。
 *
 * ─── 为什么要从 `apps/api/src/modules/note/visibility.ts` 搬出来 ───
 * 这一段 `or(share_scope = 'shared', created_by = viewer)` 原先只住在 API 的
 * note 模块里，而制卡领域服务（`@astella/card-generation`）要在自己的创建事务里
 * 按人判"这篇笔记你看得见吗"——它不能反向 import API 的模块（那是宿主层的方向）。
 * 于是判据按**承载它的东西**搬到这里：它本来就是纯 SQL builder，零 IO、零宿主依赖，
 * 而 `@astella/shared` 正是"两个包都要用的纯东西"该住的地方。
 *
 * `apps/api/src/modules/note/visibility.ts` 现在 import 并 re-export 这一份，
 * 所以 API 侧其余三十多处读点（`../note/visibility.ts`）一行都不用改；
 * note 模块也**没有**因此反向依赖制卡包。
 *
 * 函数体原样搬过来：规则文本、列、一个字都没改——改它等于改全仓库的笔记可见性。
 * 与 `noteVisibleSqlText` 的关系见那个文件的说明（故意保留两份写法并用真实数据
 * 比对结果集，而不是比字符串）。
 */
import { eq, or, type SQL } from "drizzle-orm";
import { notes } from "./db-schema/note.ts";

/** 判据那一句话。改动它等于改动全仓库的笔记可见性，所以只写一次。 */
export function visibleNotesCondition(userId: string): SQL {
  return or(eq(notes.shareScope, "shared"), eq(notes.createdBy, userId)) as SQL;
}