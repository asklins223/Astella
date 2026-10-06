import { join } from "node:path";
import type { DesktopNoteListItem } from "@astella/shared/desktop-surface-contracts";

/**
 * 笔记导出为 Markdown 目录：**一个目录、一篇一个 `.md`**。
 *
 * ## 为什么是「目录」而不是一个文件
 *
 * 整库导出那份是一个 JSON（`workspaceExport`），它是给「留档/自己分析」用的；
 * 而这一条服务的是另一件事——把笔记拿回别的工具里读、编、搜。所以形态必须是人能直接
 * 打开的东西：一堆 `.md` 文件，扔进任何编辑器都能用，而不是一个要写脚本才看得懂的容器。
 *
 * ## 谁可以导
 *
 * 任何成员。判断在服务端：`GET /notes` 与 `GET /export/notes/:id` 都没有 owner 门，
 * 可见性由 `visibleNotesCondition(userId)` 判。所以导出的就是**这个人已经看得见的那批**，
 * 协作空间里的成员不需要额外授权，也不会因为导了别人共享的笔记而越界——
 * 他导出的每一篇，界面上本来就读得到。owner 门只留在整库导出那条路上。
 *
 * ## 为什么不导别的
 *
 * 一篇笔记的「全貌」还包括来源、版本历史、学习卡与复习排程，那些不是 Markdown 能表达
 * 的东西，硬塞进 .md 只会造出一份看着像正文、实际掺了别的东西的文件。要那些走整库导出。
 */

/** 一次同时取几篇。6 是「别把连接池占满」与「别让一个人干等」之间取的数。 */
const EXPORT_CONCURRENCY = 6;

/** 文件名里最长留多少字符给标题本身：后面还要接 ` (12)` 和 `.md`。 */
const TITLE_FILE_NAME_MAX = 120;

/**
 * 文件名里不能出现的字符。
 *
 * 跨平台取并集：macOS/Windows 禁 `\ / : * ? " < > |`，控制字符（U+0000–U+001F）
 * 任何平台都不该进文件名。逐个平台判等于给三个平台各写一套规则，而「读者导出来是为了
 * 拿去别处用」这件事要求这份文件在哪儿都能打开——所以按最严的那份来。
 *
 * **空格不在其中**：标题里的空格是内容的一部分，替读者删掉会让「学习方法 / 学习方法论」
 * 两条笔记撞成同一个名字。
 */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Windows 的保留设备名：CON.md 之类在 Windows 上写不出来。 */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 标题 → 文件名主干（不含 `.md`）。
 *
 * 判据是**可移植**，不是好看：这份文件要被拿去别的机器上打开，所以平台差异一律按最严的
 * 那份处理。三个必须处理的坑：
 *  - 路径分隔符与保留字符（否则 `a/b` 会写到目录外面去，或者干脆写不出来）；
 *  - 结尾的点和空格（Windows 会自己吃掉，于是「A.」和「A」撞成同一个文件）；
 *  - 清洗完变空（标题全是非法字符时），这时退回笔记 id 而不是留一个 `.md`。
 */
export function markdownFileStem(title: string, noteId: string): string {
  const cleaned = title
    .replace(ILLEGAL_FILE_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .trim();
  const base = cleaned.length > 0 ? cleaned.slice(0, TITLE_FILE_NAME_MAX).replace(/[. ]+$/, "") : "";
  if (base.length > 0 && !RESERVED_DEVICE_NAMES.test(base)) return base;
  // 撞上保留设备名，或者标题整个被清洗掉了：用 id 尾巴区分，仍然是一眼认得出的名字。
  return `笔记 ${noteId.slice(0, 8)}`;
}

/**
 * 在 `taken` 里给这个主干找一个没被占用的文件名。
 *
 * **只增不改**：读者挑的目录里可能已经有他手写的同名文件，静默覆盖别人的东西是不可接受的。
 * 所以第二个同名的是 `标题 (2).md`，第三个 `(3)`，直到不撞为止（文件系统大小写不敏感，
 * 所以比较一律按小写去撞——macOS 上 `笔记.md` 和 `笔记.MD` 是同一个文件）。
 */
export function allocateMarkdownFileName(stem: string, taken: ReadonlySet<string>): string {
  const key = (name: string) => name.toLowerCase();
  if (!taken.has(key(`${stem}.md`))) return `${stem}.md`;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} (${index}).md`;
    if (!taken.has(key(candidate))) return candidate;
  }
  // 撞满一万个同名才可能走到这里：这时用 id 尾巴让开，而不是覆盖或者抛错。
  return `${stem}-${Math.random().toString(36).slice(2, 8)}.md`;
}

export interface NotesMarkdownExportDeps {
  /** 列出这个调用者看得见的全部笔记（不含回收站）。 */
  readonly listNotes: () => Promise<DesktopNoteListItem[]>;
  /** 取单篇的 Markdown 正文。 */
  readonly fetchMarkdown: (noteId: string) => Promise<string>;
  /** 读者选目录；返回 null = 取消了。 */
  readonly pickDirectory: () => Promise<string | null>;
  /** 目录里已经有的文件名（小写），用来避开读者自己的文件。 */
  readonly existingNames: (directory: string) => Promise<Set<string>>;
  /** 写一个文件。 */
  readonly writeNote: (filePath: string, text: string) => Promise<void>;
}

export interface NotesMarkdownExportOutcome {
  readonly version: 1;
  readonly canceled: boolean;
  readonly directory: string | null;
  readonly total: number;
  readonly exported: number;
  readonly failed: number;
}

/**
 * 导出的主流程。
 *
 * 单篇失败只记数、不中断整批：导出 200 篇时第 137 篇的网络抖动，不该让前 136 篇白导。
 * 回执里 `exported + failed === total` 恒成立，界面上据此说「导出了 X 篇，Y 篇没写成」——
 * 只报成功数会让人以为整个空间都存下来了。
 */
export async function exportNotesAsMarkdown(
  deps: NotesMarkdownExportDeps,
): Promise<NotesMarkdownExportOutcome> {
  const directory = await deps.pickDirectory();
  if (!directory) {
    return { version: 1, canceled: true, directory: null, total: 0, exported: 0, failed: 0 };
  }
  // 先问目录再取清单：读者取消的时候一次网络往返都不该发生。
  const notes = await deps.listNotes();
  const taken = await deps.existingNames(directory);
  let cursor = 0;
  let exported = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const note = notes[index];
      if (!note) return;
      try {
        const markdown = await deps.fetchMarkdown(note.id);
        const name = allocateMarkdownFileName(markdownFileStem(note.title, note.id), taken);
        await deps.writeNote(join(directory, name), markdown);
        taken.add(name.toLowerCase());
        exported += 1;
      } catch {
        failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(EXPORT_CONCURRENCY, notes.length) }, worker));
  return { version: 1, canceled: false, directory, total: notes.length, exported, failed };
}