/**
 * 笔记正文里的库内链接 → 星图上的 `references` 边（note → note）。
 *
 * 「什么算一个库内链接」只有这一个口径：解析走 `noteMarkdownTree` + `noteLinkTarget`，
 * 那正是阅读视图（`note-library-links.tsx`）与伴星写入门（`companion-note-authoring.ts`）
 * 用的同一份语法。在这里另写一条正则，就会出现「阅读里点得动、星图上没有那条线」
 * 或者反过来，而两边都没错。
 *
 * 边是**现算的，不落库**：正文改了链接，下一份拓扑的内容指纹（`topologyEdgeIdentity`
 * 掺了这条边的两端与 kind）自然就变，ETag 随之失效。加一张关系表等于加第二个事实源，
 * 而正文的写入口子不止一个（自动保存、伴星改文、版本还原、跨空间迁移），漏掉任何一个
 * 就是永久漂移的边。
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  noteLinkTarget,
  noteMarkdownTree,
  type NoteMarkdownNode,
  type NoteMarkdownTree,
} from "@astella/shared/note-markdown";
import type { UnderstandingEdgeProjectionV3 } from "@astella/shared/note-deepening-contracts";
import { relationEdgeIsDecidableV2 } from "./personal-relation-decision-service.ts";

/** 一块当前版本的正文；`blockType` 用来跳过代码块（代码里的 `[[…]]` 不是链接）。 */
export interface NoteLinkBlockRowV3 {
  noteId: string;
  blockType: string;
  content: string;
}

type NoteLinkTargetV3 = NonNullable<ReturnType<typeof noteLinkTarget>>;

/**
 * 原文里链接可能长成的三副样子（`astella-note:`／`astella-note-title:` 由
 * `noteLinkHref` 与 `noteWikiLinks` 写出，`[[…]]` 是还没展开的 wiki 写法，`.md`
 * 是相对路径写法）。
 *
 * SQL 侧的粗筛必须覆盖这里的每一样，漏一样就是星图上少一条线；多留一块正文只多一次
 * 解析。判定仍然交给 AST——本文件不靠这些字符串下结论。
 */
export const NOTE_LINK_RAW_HINTS = ["astella-note", "[[", ".md"] as const;

/**
 * 把正文搬进内存之前先在库里筛掉一大片。拓扑那条链的 P0-2 审计要的就是这个：
 * 单次请求读的字节数不能随整个空间的正文量增长（见 `topology-repository.ts` 头部）。
 */
export function noteLinkBlockContentConditionV3(content: SQLWrapper): SQL {
  return sql.join(
    NOTE_LINK_RAW_HINTS.map(hint => sql`${content} LIKE ${`%${hint}%`}`),
    sql` OR `,
  );
}

function noteLinkTargetsInContentV3(content: string): NoteLinkTargetV3[] {
  const targets: NoteLinkTargetV3[] = [];
  const walk = (node: NoteMarkdownTree | NoteMarkdownNode) => {
    if (node.type === "element" && node.tagName === "a") {
      const target = noteLinkTarget(String(node.properties?.href ?? ""));
      if (target) targets.push(target);
    }
    if ("children" in node) node.children.forEach(child => walk(child));
  };
  walk(noteMarkdownTree(content));
  return targets;
}

const withoutMarkdownSuffix = (title: string) => title.replace(/\.md$/i, "");

/**
 * 标题链接的落点：与阅读视图的跳转同一条规则（`openLibraryNoteLink`）——同名多篇就不
 * 认定，认不出来就不画。**宁可少一条线，不画一条点不开的线**。
 */
function resolveTitleTargetV3(value: string, idsByTitle: Map<string, string[]>): string | null {
  const matches = idsByTitle.get(value) ?? idsByTitle.get(withoutMarkdownSuffix(value));
  return matches?.length === 1 ? matches[0]! : null;
}

export function buildNoteReferenceEdgesV3(input: {
  blocks: readonly NoteLinkBlockRowV3[];
  notes: readonly { id: string; title: string }[];
}): UnderstandingEdgeProjectionV3[] {
  const readableIds = new Set(input.notes.map(note => note.id));
  const idsByTitle = new Map<string, string[]>();
  for (const note of input.notes) {
    idsByTitle.set(note.title, [...(idsByTitle.get(note.title) ?? []), note.id]);
  }

  const edges: UnderstandingEdgeProjectionV3[] = [];
  const linked = new Set<string>();
  for (const block of input.blocks) {
    if (block.blockType === "code") continue;
    for (const target of noteLinkTargetsInContentV3(block.content)) {
      const toNoteId = target.kind === "id"
        ? (readableIds.has(target.value) ? target.value : null)
        : resolveTitleTargetV3(target.value, idsByTitle);
      if (!toNoteId || toNoteId === block.noteId) continue;
      const pair = `${block.noteId}|${toNoteId}`;
      if (linked.has(pair)) continue;
      linked.add(pair);
      edges.push({
        // 两端用完整 id（这一族边别的用的是截断 8 位）：这条 id 会进详情列表与
        // 表态入口，撞了就连错笔记，而这里没有任何外键会替我发现撞了。
        edgeId: `ref-${block.noteId}-${toNoteId}`,
        kind: "references",
        decidable: relationEdgeIsDecidableV2("references"),
        from: { kind: "note", id: block.noteId },
        to: { kind: "note", id: toNoteId },
        reasonCodes: [target.kind === "id" ? "link_id" : "link_title"],
      });
    }
  }
  return edges;
}
