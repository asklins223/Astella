import { mkdtemp, readFile, rm, stat as statFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  FileNoteDocCacheStore,
  MemoryNoteDocCacheStore, NOTE_DOC_CACHE_ENTRY_MAX_BYTES,
  NOTE_DOC_PENDING_LIMIT,
  type NoteDocCacheEntryV1,
  type NoteDocCacheKey,
  type NoteDocDraftV1,
} from "../note-doc/note-doc-cache-store.ts";

const SUBJECT = randomUUID();
const WORKSPACE = randomUUID();
const NOTE = randomUUID();
const OTHER_SUBJECT = randomUUID();
const OTHER_WORKSPACE = randomUUID();

const key = (over: Partial<NoteDocCacheKey> = {}): NoteDocCacheKey => ({
  subjectId: SUBJECT,
  workspaceId: WORKSPACE,
  noteId: NOTE,
  ...over,
});

const entry = (over: Partial<NoteDocCacheEntryV1> = {}): NoteDocCacheEntryV1 => ({
  docState: "GIVERAIAggISAEugEIggEiuAQ=",
  pending: ["kQQBoAEKYAAAAAAAAAAAAAA="],
  revision: 4,
  savedAt: "2026-09-21T00:00:00.000Z",
  shareScope: "private",
  epochAtRest: 2,
  updatedAt: "2026-09-21T00:00:00.000Z",
  ...over,
});

const draft = (over: Partial<NoteDocDraftV1> = {}): NoteDocDraftV1 => ({
  update: "kQQBoAEKYAAAAAAAAAAAAAA=",
  savedAt: "2026-09-21T00:10:00.000Z",
  ...over,
});

describe("本机笔记文档缓存", () => {
  let dir = "";
  let filePath = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "note-doc-cache-"));
    filePath = join(dir, "note-doc-cache.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("跨重启回得来：写进去的那一份，换个实例读得到同一份", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    expect(await store.set(key(), entry({ revision: 9 }))).toBe(true);

    const reopened = new FileNoteDocCacheStore(filePath);
    expect(await reopened.get(key())).toMatchObject({ revision: 9, pending: entry().pending });
  });

  it("内容是敏感的那一类：落盘文件必须是本人可读", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry());
    const stat = await statFile(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("同一台机器上的另一个人拿不到别人的那一份", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry({ savedAt: "A 的那一份" }));
    // 这条不是"设计上应该如此"的推演，是判据本身：subjectId 少一段，
    // 另一个账号就能把别人的私有笔记正文接回编辑器。
    expect(await store.get(key({ subjectId: OTHER_SUBJECT }))).toBeNull();
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE }))).toBeNull();
    expect((await store.get(key()))?.savedAt).toBe("A 的那一份");
  });

  it("坏文件阻止覆盖，并保留原件供恢复", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, entries: [{ ...key(), ...entry(), docState: "不是 base64 !!!" }] }),
    );
    const store = new FileNoteDocCacheStore(filePath);
    const original = await readFile(filePath, "utf8");
    await expect(store.get(key())).rejects.toThrow("original file was preserved");
    await expect(store.set(key(), entry())).rejects.toThrow("original file was preserved");
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("上一版（数组形状）的那一份整机不接回来，哪怕它自己完全合法", async () => {
    // 这条管的是换形状留下的一次性风险：数组形状的 `docState` 是新内核眼里的**空正文**，
    // 接回编辑器 → 用户接着打字 → 服务端按 fragment 投影 → 那一版的 `note_blocks` 行被清空。
    // 所以判据必须是版本，不能是"能不能解"——下面这份是合法 base64、字段齐全的一份旧数据。
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, entries: [{ ...key(), ...entry({ savedAt: "数组形状那一份" }) }] }),
    );
    const store = new FileNoteDocCacheStore(filePath);
    const original = await readFile(filePath, "utf8");
    await expect(store.get(key())).rejects.toThrow("original file was preserved");
    await expect(store.set(key(), entry({ savedAt: "新形状那一份" }))).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("一份大到不该占缓存时明说不收，而不是截断正文", async () => {
    // 生产的单条上限现在是 100 MB（与传输同一个数）：按那个数测一次"不收"要在测试里现造
    // 100 MB 字符串，所以这里把上限收窄来钉**这条支路的形状**——拒绝、不留半份，
    // 而不是截断正文。默认值本身由下面那条用例钉住。
    const store = new MemoryNoteDocCacheStore(64);
    const huge = "A".repeat(2_100_000);
    expect(await store.set(key(), entry({ docState: huge }))).toBe(false);
    expect(await store.get(key())).toBeNull();
  });

  it("一篇大笔记不再被本机缓存悄悄拒收（默认上限 = 传输上限）", async () => {
    // 判据改成"能存下来的那一篇也能离线留在本机"。以前是 2 MB：过了一格的症状不是报错，
    // 是这一份**不收**——"断网可编辑"对大笔记静默失效，合盖再打开那一段就没了。
    const store = new MemoryNoteDocCacheStore();
    const big = "A".repeat(2_100_000);
    expect(await store.set(key(), entry({ docState: big }))).toBe(true);
    expect((await store.get(key()))?.docState).toBe(big);
    expect(NOTE_DOC_CACHE_ENTRY_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it("超出条数先放下最旧的那一篇，常用的留在原地", async () => {
    const store = new MemoryNoteDocCacheStore();
    for (let i = 0; i <= 48; i += 1) {
      await store.set(key({ noteId: randomUUID() }), entry({
        pending: [],
        updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        savedAt: `#${i}`,
      }));
    }
    const snapshot = store.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(48);
    expect(snapshot.some((row) => row.savedAt === "#48")).toBe(true);
    expect(snapshot.some((row) => row.savedAt === "#0")).toBe(false);
  });

  it("缓存满时不淘汰待同步更新或草稿，无法安全容纳时拒绝新写入", async () => {
    const store = new MemoryNoteDocCacheStore();
    const dirtyKeys = Array.from({ length: 48 }, () => key({ noteId: randomUUID() }));
    for (const dirtyKey of dirtyKeys) expect(await store.set(dirtyKey, entry())).toBe(true);
    const extra = key({ noteId: randomUUID() });
    expect(await store.set(extra, entry())).toBe(false);
    expect(await store.get(extra)).toBeNull();
    for (const dirtyKey of dirtyKeys) expect((await store.get(dirtyKey))?.pending).toEqual(entry().pending);
  });

  it("容量不足不覆盖磁盘中待同步的内容，重启后依然能恢复", async () => {
    const store = new FileNoteDocCacheStore(filePath, { maxFileBytes: 700 });
    expect(await store.set(key(), entry())).toBe(true);
    const other = key({ noteId: randomUUID() });
    expect(await store.set(other, entry({ docState: "A".repeat(500) }))).toBe(false);
    const reopened = new FileNoteDocCacheStore(filePath, { maxFileBytes: 700 });
    expect((await reopened.get(key()))?.pending).toEqual(entry().pending);
    expect(await reopened.get(other)).toBeNull();
  });

  it("旧版写出的超限文件仍可读取，拒绝覆盖它直到空间足够", async () => {
    const payload = JSON.stringify({ version: 2, entries: [{ ...key(), ...entry() }] });
    await writeFile(filePath, payload);
    const store = new FileNoteDocCacheStore(filePath, { maxFileBytes: 100 });
    expect((await store.get(key()))?.pending).toEqual(entry().pending);
    expect(await store.set(key({ noteId: randomUUID() }), entry())).toBe(false);
    const reopened = new FileNoteDocCacheStore(filePath, { maxFileBytes: 100 });
    expect((await reopened.get(key()))?.pending).toEqual(entry().pending);
  });

  it("超出安全恢复内存预算时不读取或覆盖原文件", async () => {
    const original = JSON.stringify({ version: 2, entries: [{ ...key(), ...entry() }] });
    await writeFile(filePath, original);
    const store = new FileNoteDocCacheStore(filePath, { maxFileBytes: 80, maxRecoveryBytes: 100 });
    await expect(store.get(key())).rejects.toThrow("original file was preserved");
    await expect(store.set(key(), entry())).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("退出这个空间 / 换账号时那一段一起清掉", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    const otherNote = randomUUID();
    await store.set(key(), entry());
    await store.set(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }), entry());
    await store.clearWorkspace(SUBJECT, WORKSPACE);
    expect(await store.get(key())).toBeNull();
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }))).not.toBeNull();

    await store.clearSubject(SUBJECT);
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }))).toBeNull();
  });

  it("待发改量的上限与主进程那道同一个数", async () => {
    const store = new MemoryNoteDocCacheStore();
    expect(await store.set(key(), entry({ pending: Array.from({ length: NOTE_DOC_PENDING_LIMIT }, () => "kQBo") }))).toBe(true);
    await expect(store.set(key(), entry({
      pending: Array.from({ length: NOTE_DOC_PENDING_LIMIT + 1 }, () => "kQBo"),
    }))).rejects.toThrow();
  });

  it("草稿跨重启回得来：刷新/崩溃前没交出去的那一条还在", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry());
    expect(await store.setDraft(key(), draft({ update: "kQQBoAEKYAAAAAAAAAAAAAB=" }))).toBe(true);

    const reopened = new FileNoteDocCacheStore(filePath);
    expect(await reopened.getDraft(key())).toMatchObject({ update: "kQQBoAEKYAAAAAAAAAAAAAB=" });
    // 与本机那份文档同住一格：读草稿不会把文档那一半挤掉。
    expect((await reopened.get(key()))?.docState).toBe(entry().docState);
  });

  it("另一个空间 / 另一个账号读不到这一份草稿", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry());
    await store.setDraft(key(), draft());
    // 这一条不是"设计上应该如此"的推演，是判据本身：草稿与正文同一条边界
    // `(subjectId, workspaceId, noteId)`。少了 workspaceId，另一个空间里同名的那一篇
    // 就能把这里的字复活过去（跨空间正文缝合）；少了 subjectId，同一台机器上的另一个
    // 账号就能读到别人的私有笔记草稿。
    expect(await store.getDraft(key({ workspaceId: OTHER_WORKSPACE }))).toBeNull();
    expect(await store.getDraft(key({ subjectId: OTHER_SUBJECT }))).toBeNull();
    expect(await store.getDraft(key({ noteId: randomUUID() }))).toBeNull();
    expect(await store.getDraft(key())).not.toBeNull();
  });

  it("确认交出去之后草稿清掉，本机那份文档不动", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry({ revision: 7 }));
    await store.setDraft(key(), draft());
    expect(await store.clearDraft(key())).toBe(true);
    // 本来就没有的那一次要如实回答 false：确认提交之后每次都会问一次，落盘那一层
    // 据此跳过整份重写。
    expect(await store.clearDraft(key())).toBe(false);

    expect(await store.getDraft(key())).toBeNull();
    expect((await store.get(key()))?.revision).toBe(7);
    // 清掉这件事也要落到盘上，不能只活在内存里——否则重启之后那份草稿又回来了。
    const reopened = new FileNoteDocCacheStore(filePath);
    expect(await reopened.getDraft(key())).toBeNull();
  });

  it("落盘本机文档那一次不顺手抹掉草稿（打开笔记时两次 IPC 谁先到不确定）", async () => {
    const store = new MemoryNoteDocCacheStore();
    await store.set(key(), entry());
    await store.setDraft(key(), draft());
    // `noteDocState` 那条路会再落一次文档（`persistNoteDocLocal`）。它若把草稿一起换掉，
    // 抢在 `draftGet` 之前到的那一次就把要恢复的东西删了。
    await store.set(key(), entry({ revision: 8, updatedAt: "2026-09-21T00:11:00.000Z" }));
    expect(await store.getDraft(key())).not.toBeNull();
  });

  it("本机还没有这一篇的文档时不凭空造一条草稿", async () => {
    const store = new MemoryNoteDocCacheStore();
    // 草稿是"本机那一份文档里还没交出去的部分"，那一份必须有服务端的祖先；
    // 没有祖先的一份接回编辑器，一改就是复制块。
    expect(await store.setDraft(key(), draft())).toBe(false);
    expect(await store.get(key())).toBeNull();
    expect(await store.getDraft(key())).toBeNull();
  });
});
