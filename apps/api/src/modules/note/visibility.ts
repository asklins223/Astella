// 判据文本的唯一来源。API 与 Worker 两个包共用同一段 SQL——伴星读正文那条路
// 在 worker 里，此前它按 workspace 直接查 notes，把同空间别人的私有笔记一起读了
// 出来（`companion_read_note` / here-and-now 快照）。
import {
  isNoteVisibleToViewer as isNoteVisibleToViewerShared,
  noteVisibleSqlText as noteVisibleSqlTextShared,
  NOTE_SHARE_SCOPES,
  isNoteShareScope,
  type NoteShareScope,
} from "@astella/shared/note-visibility";
// 判据的 drizzle 版本。2026-10-04：这一支从本文件搬到
// `packages/shared/src/note/note-visibility-condition.ts`（制卡领域服务要在自己的创建
// 事务里用同一句判据，它不能反向 import API 的模块）。本文件继续 import 并转出
// 它，所以 API 侧三十余处 `../note/visibility.ts` 的调用点一行都不用改，
// 而判据在全仓仍然只有一份。
import { visibleNotesCondition } from "@astella/shared/note-visibility-condition";

export { NOTE_SHARE_SCOPES, isNoteShareScope, visibleNotesCondition };
export type { NoteShareScope };

/**
 * 笔记归属的唯一判据（批次 4.5）。
 *
 * 规则：**新建的笔记默认「仅自己可见」**，共享是一次显式动作（界面上的
 * 「共享给空间」），并且作者随时可以撤回。产品口径是"共享学习空间只共享学习资料"，
 * 而一篇没拿出去的笔记还不是资料，是作者自己的东西。
 *
 * 这一列不能从空间类型推（协作空间里同样有只给自己的笔记），也不能从 `created_by`
 * 推（作者写的同样可以共享出去），所以它必须是一个独立的、由人决定的值。
 *
 * 为什么要专门一个文件：`notes` 的 RLS 本轮没重开（`note_blocks` / `note_versions`
 * 的策略还只按 workspace_id 判），这条边界目前**完全靠应用层每个读点带上同一个谓词**。
 * 判据散开写就会出现"列表挡住了、搜索没挡"那一类分裂——这正是审查里反复出现的那件事。
 * 所以：drizzle 读点用 `visibleNotesCondition`，手写 SQL 用 `noteVisibleSqlText`，
 * 已经握在手里的那一行用 `isNoteVisibleToViewer`。三个入口，一个规则。
 *
 * 三个入口的**文本**现在都来自 `@astella/shared/note-visibility`：worker 侧
 * （伴星工具）也读同一份，跨包不会漂移。drizzle 那一条的**实现**在
 * `@astella/shared/note-visibility-condition`（见上面那行 import 的说明），
 * 本文件转出它，`visibleCardsCondition` / `visibleObjectivesCondition` 用的
 * 仍是同一句。
 */

/** 同一句话的行内版本：给"行已经读出来了，要不要算他看得见"这种判断。 */
export function isNoteVisibleToViewer(
  row: { shareScope: string; createdBy: string },
  userId: string,
): boolean {
  return isNoteVisibleToViewerShared(row, userId);
}

/**
 * 同一句话的手写 SQL 版本（转发到 shared 的唯一实现）。
 *
 * 与上面 drizzle 那条是同一规则的两种写法，这是本仓少有的重复。**故意留一份测试**
 * 去执行它们并比对结果集（`note-share-scope-postgres.integration.ts`），而不是比字符串——
 * 字符串相等证明不了两条路在同一份数据上给同样的答案。
 */
export function noteVisibleSqlText(alias: string, viewerExpr: string): string {
  return noteVisibleSqlTextShared(alias, viewerExpr);
}

/**
 * 搜索索引那张表专用：`search_documents` 没有用户列，判可见性必须回连 `notes`。
 *
 * 为什么在查询侧判而不是在**建索引**时判：索引是整个空间共用的一份。建索引时按某个人
 * 可见的范围裁剪，等于把"他的视角"烧进大家共用的那份数据——下一次换成 owner 触发重
 * 索引，私有笔记就谁也都搜不到了（连作者自己）。所以索引照旧收全量，发不发出去由
 * 这一次 join 决定。
 *
 * 返回的片段假设外层已经把查看者放进了一个 `v(viewer)` 的 CROSS JOIN。
 */
export function searchDocumentsVisibleSql(): string {
  return `(search_document.object_type <> 'note'
    OR EXISTS (
      SELECT 1 FROM public.notes visible_note
      WHERE visible_note.id = search_document.object_id
        AND visible_note.workspace_id = search_document.workspace_id
        AND visible_note.deleted_at IS NULL
        AND ${noteVisibleSqlText("visible_note", "v.viewer")}
    ))`;
}
