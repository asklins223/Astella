import { join } from "node:path";
import { extname } from "node:path";
import { createHash } from "node:crypto";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { markdownImageSources, rewriteNoteImagePaths } from "./note-writing-files";
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
  /**
   * 取一张站内图片的字节。取不回来（没权限、已删除、服务不在了）返回 null——
   * 那一处引用就原样留在正文里，导出的那份文件仍然完整可读。
   */
  readonly fetchImage: (objectKey: string) => Promise<{ readonly bytes: Buffer; readonly mime: string } | null>;
  /** 往 `assets/` 里落一个文件；同名已存在时不覆盖（内容寻址的名字意味着那份字节本来就一样）。 */
  readonly writeAsset: (filePath: string, bytes: Buffer) => Promise<boolean>;
}

export interface NotesMarkdownExportOutcome {
  readonly version: 1;
  readonly canceled: boolean;
  readonly directory: string | null;
  readonly total: number;
  readonly exported: number;
  readonly failed: number;
  /** 真的落到 `assets/` 里的图片文件数（跨笔记去重之后的数）。 */
  readonly images: number;
  /** 没能落下来的图片引用数：正文照旧收了，那一处仍是站内地址。 */
  readonly imageFailures: number;
}

/**
 * 导出的主流程。
 *
 * 单篇失败只记数、不中断整批：导出 200 篇时第 137 篇的网络抖动，不该让前 136 篇白导。
 * 回执里 `exported + failed === total` 恒成立，界面上据此说「导出了 X 篇，Y 篇没写成」——
 * 只报成功数会让人以为整个空间都存下来了。
 *
 * 图片落在**一个共享的 `assets/`** 里而不是每篇旁边一个：同一个来源被十几篇引用时，
 * 每篇复制一份只是把那次导出变成几十 MB 的重复字节。名字按内容哈希取，
 * 于是「同一张图」在物理上就只有一份，谁也不用再去认哪两份是一样的。
 */
export async function exportNotesAsMarkdown(
  deps: NotesMarkdownExportDeps,
): Promise<NotesMarkdownExportOutcome> {
  const directory = await deps.pickDirectory();
  if (!directory) {
    return { version: 1, canceled: true, directory: null, total: 0, exported: 0, failed: 0, images: 0, imageFailures: 0 };
  }
  // 先问目录再取清单：读者取消的时候一次网络往返都不该发生。
  const notes = await deps.listNotes();
  const taken = await deps.existingNames(directory);
  const assets = new AssetSink(deps);
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
        taken.add(name.toLowerCase());
        await deps.writeNote(join(directory, name), await assets.localize(markdown, directory));
        exported += 1;
      } catch {
        failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(EXPORT_CONCURRENCY, notes.length) }, worker));
  return {
    version: 1, canceled: false, directory, total: notes.length, exported, failed,
    images: assets.written, imageFailures: assets.failures,
  };
}

/** 导出的那一个目录里，图片共用的落点名字。 */
const ASSETS_DIR_NAME = "assets";

/**
 * 把正文里的站内图片地址换成 `assets/…` 的相对地址。
 *
 * 三件事按同一条判据办：同一张图只取一次、只落一份、几篇引用它都指到那一个文件。
 * 取不回来的那一张**不改正文**——留着原来的地址，那份 .md 依旧完整，读者知道那里少了一张图，
 * 而不是看到一段什么都没有的文字。
 */
class AssetSink {
  /** objectKey → 那个文件的名字（null = 这一张没落地）。正在取的那次共享同一个 promise，
   *  几百篇同时引用同一张图也只发一次网络。 */
  private readonly located = new Map<string, Promise<string | null>>();
  private readonly writtenNames = new Set<string>();
  written = 0;
  failures = 0;

  constructor(private readonly deps: NotesMarkdownExportDeps) {}

  async localize(markdown: string, directory: string): Promise<string> {
    const sources = markdownImageSources(markdown);
    if (sources.length === 0) return markdown;
    const replacements = new Map<string, string>();
    for (const src of sources) {
      const objectKey = sourceImageObjectKeyFromUrl(src);
      if (!objectKey) continue;
      const name = await this.ensure(objectKey, directory);
      // 导出的每一篇 .md 都直接落在这个目录里，所以相对地址就是 `assets/名字`。
      if (name) replacements.set(src, `${ASSETS_DIR_NAME}/${name}`);
    }
    return replacements.size > 0 ? rewriteNoteImagePaths(markdown, replacements) : markdown;
  }

  /** 一张图从取回到落盘的整个过程；失败如实记一笔并返回 null。 */
  private async ensure(objectKey: string, directory: string): Promise<string | null> {
    const pending = this.located.get(objectKey);
    if (pending) return pending;
    const attempt = (async () => {
      const fetched = await this.deps.fetchImage(objectKey).catch(() => null);
      if (!fetched || fetched.bytes.byteLength === 0) return null;
      const name = `${createHash("sha256").update(fetched.bytes).digest("hex").slice(0, 20)}${extname(objectKey).toLowerCase()}`;
      // 写不下去（磁盘满、目录被读者删了）也算这一张没落地：正文那处原样留着，
      // 别让读者以为文件已经在 assets 里了。
      if (!await this.deps.writeAsset(join(directory, ASSETS_DIR_NAME, name), fetched.bytes)) return null;
      return name;
    })().then((name) => {
      if (name && !this.writtenNames.has(name)) { this.writtenNames.add(name); this.written += 1; }
      else if (!name) this.failures += 1;
      return name;
    });
    this.located.set(objectKey, attempt);
    return attempt;
  }
}