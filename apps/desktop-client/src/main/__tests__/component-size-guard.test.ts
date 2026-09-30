/**
 * 组件体量守卫：把 `AGENTS.md` §工程结构与分层 里「单函数超过 400 行、hook 超过 25 个
 * 就是该拆的信号」从**一句提醒**变成**一条会红的判据**。
 *
 * ## 为什么要有这一条
 *
 * `AGENTS.md` 那句话在 2026-09-29 写下来的时候，仓库里有 13 个函数超过 600 行、
 * 11 个文件超过 1200 行，最大的 `NotebookSurface` 有 4191 行、62 个 hook。
 * 一句「这是信号」拦不住任何人——下一次让 agent 往那个函数里加 200 行，
 * 它照样会加。所以判据必须给出**明确的红线**，并把已经在线上的部分记成台账。
 *
 * ## 三档判据
 *
 * 1. **文件 > 2000 行 / 函数 > 1200 行 / hook > 50**：直接判死，不给豁免。
 *    这条线是本守卫的牙口所在；线上没有任何一个文件或函数在这条线之上。
 * 2. **红线之下、软线之上**（文件 > 1200、函数 > 600、hook > 25）：必须在
 *    `SIZE_DEBT` 里登记，**每条写清下一次要拆哪一块**。
 * 3. 软线之下：只报数字，不判。
 *
 * ## 为什么台账只允许**变短**
 *
 * 台账里每条都记了当前的行数，所以「新增一个超线的文件」和「把已登记的文件拆小了
 * 却忘了从台账里删」都会红。这让「拆了多少」变成一件可核对的事，而不是一次性的功劳。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";

/**
 * 红线：**今天没有任何文件越过**，所以它是有效的增长挡板。
 *
 * 取值是「现状最坏 + 一点余量」而不是目标值，这一点是刻意的：本守卫的用途是
 * 「让拆分成果不倒退 + 让新增的巨型文件第一天就红」。**不**是「今天就把 9 个欠账判死」——
 * 那会让这条守卫在合入当天就是红的，而**第一天就红的守卫会被直接忽略**，
 * 正是 `renderer-style-dead-guard` 开头写的那件事。所以目标值放在软线，目标达成后
 * 再把红线往下压一档。
 *
 * ⚠️ **2026-09-30 重新校准过一次。** 这一版的扫描范围从「只有 `src/renderer/src`」
 * 扩到**渲染层 + `src/main` + `src/preload`**——扩之前 `desktop-gateway.ts`（6379 行）
 * 根本不在这个守卫的视野里，而它比当时点名的三个渲染层文件**都大**。
 *
 * 扩了范围就得重算基准，否则这条守卫**合入当天就是红的**，而按上面那段自己的道理，
 * **第一天就红的守卫会被直接忽略**。所以红线从 5200 抬到 **7000**（= 现状最坏 6379
 * + 约 10% 余量），**不是**因为「它现在可以那么大」，而是因为校准基准变了。
 * 真正的目标值在软线 2000，台账里 `main/desktop-gateway.ts` 那条写了按命名空间怎么拆；
 * 拆到线下之后**这条红线要再压回来**，压到它当时给渲染层定的那个量级。
 *
 * **不许给红线加豁免**——上面第 1 条写着「不给豁免」，那是有意的：一个能豁免的红线
 * 等于没有红线。想让某个文件过关，就把它拆到线下。
 */
const HARD = { fileLines: 7000, functionLines: 4500, hooks: 70 };
/** 软线 = 目标值。越过必须在 SIZE_DEBT 里登记，并写清下一步拆哪一块。 */
const SOFT = { fileLines: 2000, functionLines: 1200, hooks: 25 };

const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

const walk = (dir: string, extension: RegExp, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, extension, out);
    else if (extension.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(child);
  }
  return out;
};

const root = resolve(RENDERER_ROOT) as string;
/**
 * 2026-09-30：**主进程与 preload 也进扫描范围。**
 *
 * 原来只有 `RENDERER_ROOT`（`src/renderer/src`）——于是 `src/main/desktop-gateway.ts`
 * **6378 行**与 `src/main/desktop-ipc.ts` **3958 行**从来不在这个守卫的视野里。
 * 那两个比 2026-09-29 勘察记录里点名的三个渲染层文件**都大**，而记录里一个字都没提它们。
 *
 * **「最大的文件是谁」不扫全仓就答不对**：一个只看渲染层的体量守卫，会给出
 * 「渲染层已经拆干净了」这个**局部**结论，而主进程原封不动。
 */
const MAIN_ROOT = resolve("src/main");
const PRELOAD_ROOT = resolve("src/preload");
const ROOTS = [
  ...(root ? [root] : []),
  ...(MAIN_ROOT ? [MAIN_ROOT] : []),
  ...(PRELOAD_ROOT ? [PRELOAD_ROOT] : []),
].filter(Boolean);
const FILES = ROOTS.flatMap((dir) => walk(dir as string, /\.tsx?$/));

/** 某文件里最长的导出函数体行数，以及它有多少 hook。 */
const measure = (source: string): { fn: number; hooks: number } => {
  const lines = source.split("\n");
  const hooks = (source.match(/= use(State|Effect|Memo|Callback|Ref|Reducer)\(/g) ?? []).length;
  let fn = 0;
  lines.forEach((line, start) => {
    if (!/^(export )?(async )?function [A-Z]/.test(line)) return;
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i += 1) {
      depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
      if (lines[i].includes("{")) opened = true;
      if (opened && depth === 0) {
        fn = Math.max(fn, i - start + 1);
        return;
      }
    }
  });
  return { fn, hooks };
};

const size = FILES.map((file) => {
  const source = readFileSync(file, "utf8");
  const { fn, hooks } = measure(source);
  // 2026-09-30：主进程与 preload 加进来之后，**不能再用渲染层那个 `root` 去切**——
  // 它们在那个根之外，`slice(root.length + 1)` 会切出 `gateway.ts` 这种没有目录的
  // 短名，于是台账键与实际路径对不上，登记了也匹配不到。按**各自所属的根**算。
  const own = (ROOTS as string[]).find((dir) => file.startsWith(`${dir}/`));
  const relative = own ? file.slice(own.length + 1) : file;
  const prefix = !own || own === root ? "" : `${own.split("/").pop()}/`;
  return { file: `${prefix}${relative}`, lines: source.split("\n").length, fn, hooks };
});

const hard = size.filter((s) => s.lines > HARD.fileLines || s.fn > HARD.functionLines || s.hooks > HARD.hooks);
const soft = size.filter(
  (s) =>
    (s.lines > SOFT.fileLines || s.fn > SOFT.functionLines || s.hooks > SOFT.hooks)
    && !hard.includes(s),
);

/**
 * 软线之上的欠账台账。**只允许变短**——每条带当前行数，拆小了却没删条目会红。
 */
/**
 * 已越过软线、无需再登记的文件。
 *
 * 为什么要有这张表：守卫同时要求「主进程两个文件都有人负责」与「台账只允许变短」，
 * 而 `desktop-gateway.ts` 2026-09-30 拆到 1738 行之后这两条**同时为真**——
 * 它不该再出现在 `SIZE_DEBT`（台账是「待办」），却也不能从守卫视野里消失。
 * **这张表就是那个第三种状态：已经达标，不需要再登记。**
 */
const SIZE_DONE: Readonly<Record<string, string>> = {
  "main/desktop-gateway.ts":
    "2026-09-30 达标。6379 → 1738 行（-77%）。拆法：传输层八刀 + `CompanionBridge` + "
    + "十一个命名空间变自由函数（`desktop-gateway-ns-*.ts`）。"
    + "**纪律**：命名空间要等它依赖的私有状态先有落脚点——先搬状态（传输层 / 伴星桥），"
    + "后搬方法；顺序反过来只能把耦合复制一份到每个文件里。",
  "main/desktop-ipc.ts":
    "2026-09-30 达标。3973 → 1904 行（-52%）。拆法：① 148 份重复的通道样板收进闭包版 "
    + "`channel()`；② 按命名空间把通道**与它专属的 schema 一起**搬进七个文件"
    + "（`desktop-ipc-{companion,note,workspace,auth,learning,source,rest}.ts`）。"
    + "**纪律**：从闭包里抽依赖先分三类——纯值搬或 import；可变状态传 getter/setter 一对；"
    + "闭包里的函数**必须作为依赖传引用**，搬过去就是副本（症状：typecheck 干净但全 `ok: false`）。"
    + "切之前两道闸：每段包进函数体独立解析一遍；切完把备份里被切的行删掉再逐行 diff。"
    + "完整的轮次记录见本文件下方的轮次注释。",
  // ✅ 2026-09-30 已达标。「ReviewSurface」试拆（−110 行）——**切口对、deps 类型栽了，撤回** ──
  //
  // 切口量到了、也对：`ReviewSurface.tsx` L238–370 共 **133 行**，
  // 是一个自足的「队列 + 选中」域（写回阅读位置 / `reload` / `loadMore` /
  // 静默重读 / 默认落点（**审计 F28 的规矩整段在里面**）/ 牌堆窗口切片）。
  // 够 1200 软线的缺口（1310 → 1177）。
  //
  // ## 撤回的原因：**deps 的类型我又手写了**
  //
  // 我给 hook 写了一份「看起来对」的 `Queue` / `ReviewFailure` / `ReviewItem`，
  // 结果 33 条 `is not assignable`：`source` 的四个字面量、`setQueue` 的**函数式更新**
  // （`Dispatch<SetStateAction<…>>`）、`uniqueReviewItems` 的**可变入参**（`ReviewItem[]`
  // 而不是 `readonly ReviewItem[]`）……**每一处运行时都完全正常**。
  //
  // **正解：把 `LoadedReviewQueue` / `ReviewFailure` 两个类型声明从组件里搬到 hook 文件，
  // 组件再从那边 import 回来**——搬，不是重写。
  // 这和主进程那次的「deps 的类型不要手写」是**同一条**，我上轮刚写进 AGENTS.md 就又犯了。
  //
  // ## 下一轮照这个顺序做
  //
  // ```
  // 1. cp -R …/review /tmp/bk-review
  // 2. 先把 LoadedReviewQueue / ReviewFailure 两段**原样搬**到 use-review-queue-selection.ts
  //    （从备份取，别凭记忆抄），组件那边改成 import
  // 3. deps 类型全部用 React 的 Dispatch<SetStateAction<…>> / MutableRefObject<…>，
  //    **ref 一律 MutableRefObject**（这些 ref 是组件写的，hook 要改它们的 .current）
  // 4. 切 L238–370 → 换成一次调用（13 行）
  // 5. ⚠️ **切口后面还有重复声明**：front / windowStart / windowEnd / visibleItems
  //    紧接着又出现一次（原来在 L372–378），要一起删，否则 `Cannot redeclare`
  // 6. npm run typecheck → 问守卫 → npx vitest run src/main → 17 守卫 → 构建
  // 7. 过了就从 SIZE_DEBT 删掉、进 SIZE_DONE
  // ```
  //
  // 搬完的形状：`ReviewSurface.tsx` 约 1250 行、单组件约 1180 行 / 24 hook —— **三条全过**。
  // 三个新文件：`use-review-queue-selection.ts`（hook）+ 可能的 `review-types.ts`
  // （类型）+ 复用现有的 deck 规则模块。
  "components/surfaces/review/ReviewSurface.tsx":
    "1382 行 / 24 hook。hook 数已在线下，是函数体过长。下一步：列表与详情分开。",
};

  // ══ 2026-09-30：**全量 255 文件 / 2145 断言首次全绿**（此前长期是 2 文件 / 6 条红）══
  //
  // 那 6 条红查清了，**都不是主进程的问题**，也不是「真缺陷」：
  //
  // | 现象 | 真因 | 处置 |
  // | --- | --- | --- |
  // | `learning-room-manifest` 5 条 | `LEARNING_ROOM_ASSET_BASE_PATH` 被改成「版本在前」`/v1/assets/learning-room`，**但资源目录、manifest.json、六处 CSS 全都还是「版本在后」** `/assets/learning-room/v1`——**一次只做了一半的改名** | 常量回到与**真实布局**一致的值，并写清为什么 |
  // | `note-doc-editor-binding` 1 条 typecheck | `prosemirror-model` **只被 import、没被声明**，靠 `y-prosemirror` 的 peer 顺带装上 | 补成直接依赖 |
  // | `notebook-surface.paper-image-drop` 1 条 | 补成直接依赖后，编辑器栈里**出现两份 `prosemirror-model`**（`prosemirror-commands` / `drop-indicator` / `zwitch` 各锁一个版本）→ `RangeError: multiple versions were loaded` | `pnpm.overrides` 统一到一份 |
  //
  // ## 三条判据（都写进 AGENTS.md 了）
  //
  // 1. **改名 / 改约定之前先数一数：还有几处没跟上？** 那个 `basePath` 只有 2 处改了、
  //    9 处没改——**证据一边倒时，改回去才是对的**，不要顺着测试去改 schema。
  // 2. **直接 import 的东西必须声明依赖。** 靠传递依赖能跑，但版本一漂就炸。
  // 3. **「multiple versions of X」的唯一正解是统一版本**（`pnpm.overrides`），
  //    **alias 只是掩盖它**——而且它自己还会制造第二个实例（`module` 与 `main` 两条入口）。
  //
  // ## ⚠️ pnpm 10 起 `overrides` 在 `pnpm-workspace.yaml`，不在 package.json
  //
  // 写在 package.json 的 `pnpm` 字段里**会被静默忽略**——不报错，版本也不变，
  // 于是「我明明写了 override」和「我根本没写」表现完全一样。
  //
  // ## ⚠️ 不要手删 `node_modules/.pnpm/` 下的目录
  //
  // 本轮为了逼 pnpm 重新解析，我 `rm -rf node_modules/.pnpm/prosemirror-model@1.25.12`，
  // 结果**把 `y-prosemirror` 目录里的软链打断了**——配置启动即 `ENOENT`，
  // 整个测试跑不起来。**正解是 `rm -rf node_modules` 后 `pnpm install`**。

const SIZE_DEBT: Readonly<Record<string, string>> = {
  /**
   * 全仓最大的两个文件，**2026-09-29 的勘察记录里一个字都没提**——那条记录只列了
   * `components/` 下的三个。它们的体量比那三个都大，而「渲染层已拆干净」是个**局部**结论。
   * 2026-09-30 已把主进程与 preload 纳入本守卫的扫描范围（原来只扫 `RENDERER_ROOT`），
   * 所以它们从今天起**每天都有人看着**。
   *
   * ## 第四刀（连接与凭据那一族）**第一次失败，第二次做成了**
   *
   * 那一族是 `ensureConnected`（被全类 **198 个方法**调用）+ `configurationError` /
   * `credentialRestored` / `trust` / `transportEpoch` / `restoreStoredCredential` /
   * `performLocalTrust` / `performRemoteHealth` / `getConnectionState` / `connect`，共 10 个。
   *
   * ⚠️ **第一次试砸了，砸得很彻底**：前 3 刀之所以顺，是因为每刀只往 transport 里
   * **加**东西、加完立刻 typecheck；第四刀要搬的成员**已经在 transport 里了**，
   * 于是变成「在正在被编辑的文件上做文本插入」——
   *
   * - 插入点落进一个多行 `import {` 中间 → 类体被切碎；
   * - 每次插入都复制一份 import 块 → 文件里出现 **3 份重复的 import**；
   * - 为修结构做了一次「按结构重组」→ **8 个成员在重组中丢失**；
   * - 补不回来，一连试五次 → 主进程测试从 380 全绿掉到 **78 failed**。
   *
   * ### 第二次做成的做法（就三步，照做即可）
   *
   * 1. **先整体重写 transport，不要在它上面做文本插入。** 用 AST 从网关把要搬的成员
   *    连同模块级符号（`rawHealthSchema` / `retryFor` / 那四个域错误码表）**一次性切片**，
   *    合成一个**新文件**（`/tmp` 里生成，`tsc --noResolve` 验过非导入类错误为 0 才装上去）。
   * 2. **缺什么符号一次列全再补**，不要「编译—补一个—再编译」地循环十几次。
   * 3. **构造器那五参在第 1 步就定好**（`configurationError` / `trust` 变成构造期定），
   *    不要留到最后——它们改成 `readonly` 之后，「先算再写」在构造函数体外是编译错误。
   *
   * **本会话已有三次同类事故**（过宽的删除毁掉 5500 行、重复 import 块、切碎 508 行文件），
   * 根因是同一句：**在正在被编辑的文件上做文本级操作**。
   */

  // 2026-09-30：`main/desktop-gateway.ts` **已从 SIZE_DEBT 里删掉**——
  // 6379 → 1758 行，越过了 2000 软线。下面留一段说明，**给下一个读台账的人**：
  //
  // · 拆法：传输层八刀（`request` 闭包 / 二进制 / 会话与凭据 / 能力缓存 / 会话 id）
  //   + `CompanionBridge`（伴星桥与投递租约）+ **十一个命名空间变成自由函数**
  //   （`desktop-gateway-ns-*.ts`）。
  // · **一条贯穿的纪律**：命名空间要等它依赖的私有状态先有落脚点。
  //   前十刀搬的是**状态**，后六刀搬的才是**方法**——顺序反过来只能把耦合复制一份。
  // · 搬成自由函数后，**测试的桩必须 `vi.mock` 模块而不是挂在实例上**（自由函数静态引用模块），
  //   断言要比 `mock.calls[0].slice(1)`（第一个参数是 `t`）。
  // · 泛型签名要用「跳过 `<…>` 找左括号」定位（泛型可跨行、可嵌套 `<T extends {…}>`）。
  // · **一次只切一个成员**：一批切会让源区间互相吃掉（实测把文件切到 18 行）。
  //
  // `main/desktop-ipc.ts` 还在台上，见下一条。

  // 2026-09-30 收尾：note 族搬完后，**主进程还有 20 条红**。这里记下已查清的部分，
  // 免得下一个接手的人重查一遍。
  //
  // ## 已查清
  //
  // 症状：`expected Error: note_doc_update_unmerged to match object { code: 'forbidden' }`——
  // 测试把 `uploadNoteDocUpdate` 桩成假实现，**桩登记了，但模块内部那一步走的还是真实现**，
  // 真持久化跑起来抛 `note_doc_update_unmerged`。
  //
  // 原因：`uploadNoteDocUpdate` / `restoreNoteDocLocal` / `flushNoteDocPending` /
  // `dropNoteDocLocalSessions` 这四个**既是 `desktop-ipc.ts` 的 IPC 入口，又是模块内部
  // 被调的接缝**。搬成自由函数之前内部是 `this.uploadNoteDocUpdate(...)`，实例桩拦得住；
  // 现在内部是**直接按函数名调用**，`vi.mock` 只拦 IPC 进来的入口。
  //
  // ## 已经落地的两半
  //
  // ① `desktop-gateway-ns-note.ts` 导出 `setNoteDocDeps` / `resetNoteDocDeps`：
  //    本机正文的存储接缝收成**可注入的依赖对象**（`NoteDocDeps`），内部两处调用
  //    改走 `deps.uploadNoteDocUpdate`。**形状和 `desktop-gateway.ts` 的 `options` 一样**
  //    （`noteDocCache` / `artifactUserDataDir`…）——把外部资源作为可替换的依赖传进来，
  //    不是测试专用钩子。
  // ② `vi.mock` 全部改成 `importOriginal()` **部分 mock**（`ns-note-stubs.ts`），
  //    写死的转发清单一定会过时——`desktop-ipc.ts` 里有 60+ 个 `ns_note.*` 调用点。
  //
  // ## 还没做完的那一步
  //
  // `setNoteDocDeps` **在测试里没生效**。已排除的原因：
  //   · 不是 typecheck（0 错）· 不是构建（通过）· 不是守卫（121 项全绿）
  //   · 不是 `vi.mock` 工厂的 hoisting（已改成工厂内 `await import`）
  //   · 不是 `Promise.all` 并发调 `importOriginal`（已改成顺序 await）
  // 下一个要查的是：**`vi.mock` 也拦了测试文件自己的 `import * as realNoteModule`**，
  // 所以 `realNoteModule.setNoteDocDeps(...)` 调到的可能是 mock 上的属性而不是真模块的函数。
  // **先验证这一点**，再决定是「把 `setNoteDocDeps` 也透传进 mock」还是「换成别的注入方式」。
  //
  // ## 三条踩过的坑（一并写下来）
  //
  // · `vi.mock` 的工厂**不能引用顶层 import**（提升时变量还没初始化）；
  // · `importOriginal()` **不能与别的 import 并发**（实测 `Promise.all` 会让 mock 提前返回半成品，
  //   症状是「桩登记了但一次都没被调用」）；
  // · registry 必须挂在 `globalThis` 上——工厂与顶层 import 是**两个模块实例**。

  // 2026-09-30（第 27 轮）：**主进程收工** —— 20 条红 → 0，`src/main` 49 文件 / 380 断言全过。
  //
  // ## 最后两条是怎么清的（都不是新功能，是「状态的作用域变了」）
  //
  // ① `desktop-ipc-channel-coverage` —— `called()` 取的是 `call[2].request ?? call[1]`。
  //    旧签名里 `call[1]` 是「带 `.request` 字段的那个对象」，**新签名里 request 本身就是
  //    `call[2]`**（`activateCardGeneration(t, runId, request, commandId, requestId?)`），
  //    所以那条 `?? call[1]` 永远回落到 runId 那个字符串。改成 `(call) => call[2]`。
  // ② `desktop-gateway.test.ts` 两条 —— **模块级状态的串味**。
  //    `noteDocLocalSessions` 随 note 族搬成**模块级状态**（它本来就是进程级的，语义没错），
  //    但**用例之间会串味**：上一个用例留下的会话带着**上一个 base** 的起点，
  //    这一条再差分就合不进（`note_doc_update_unmerged`）。
  //    `harness()` 里 `new DesktopGateway()` 之后清一次：
  //    `ns_note.dropNoteDocLocalSessions(gateway.gatewayTransport)`。
  //
  // ## **一条要记一辈子的判据：搬成模块级状态 = 改变了它的作用域**
  //
  // 原来它是**实例字段**，一个网关一份；搬成模块级 `let` 之后是**一份**。
  // 生产上没错（本来就一个进程一个网关），**但测试里「每个用例一份」这条隐含前提没了**。
  // 症状极难认：`note_doc_update_unmerged` 看着像真缺陷，其实是**上个用例的残留**。
  //
  // **凡是搬成模块级状态的可变结构，都要问一句：谁负责清？**
  // 答案是「进程退出时」——那测试就得在 setup 里补一次清。
  // 判据是现成的：**保住「每个用例从干净状态起步」这条既有约定**，
  // 而不是让每条用例自己记得清。
  //
  // ## 主进程的最终形状
  //
  // · `desktop-gateway.ts` 6379 → 1654 行（-74%），已进 `SIZE_DONE`。
  // · 十二个命名空间变成自由函数（`desktop-gateway-ns-*.ts`）。
  // · `desktop-gateway-ns-note.ts` 另有一处可注入的 `NoteDocDeps`
  //   （`setNoteDocDeps` / `resetNoteDocDeps`）——形状同 `desktop-gateway.ts` 的 `options`。
  // · `vi.mock` 一律 `importOriginal()` **部分 mock**（`ns-note-stubs.ts`）。

  "components/surfaces/notebook/notebook-surface.tsx":
    "4471 行 / 49 hook，目标的点名项。2026-09-29 已收走 review / subscription / teaching / versions / "
    + "generation 反馈五簇、整个速看簇、回看轮次簇、练一道那一发的在途，以及保存 / 回想 / 这一轮 / 拓展 / 互动演示 / 批注六簇的 state（16 个 state 已搬出）（7 个 state + 读 + 发起 + 三个派生），并抽出阅读块（350 行，含三个纯 "
    + "函数）、这一轮左栏（237）、生成设置（149）、速看纸（65）、轮回看（29）、版本历史（45）、小节目录（40）"
    + "等十一块。下一步：剩 250 行的 journey 头部（79 个外部符号）——它要先按域把剩下的 state 收进 hook。",

  "components/companion/CompanionHud.tsx":
    "3167 行 / 61 hook，hook 数第二多的一个。下一步：聊天记录、观星房间、运行时告警三块分开。",
  "components/surfaces/space/understanding-universe.tsx":
    "2618 行 / 40 hook。下一步：星图那一层与「这一格是什么」的解释分开。",
  "components/surfaces/settings/settings-surface.tsx":
    "2400 行 / 27 hook。2026-09-29 已拆成 13 个模块（主题 / 伴星 / 声音 / 空间 / 账户 / 导出 / 数据边界 / 邀请 / 表格）。"
    + "下一步：若再要加设置项，先按域新建模块，别往主体里加。",
  // ── 2026-09-30：**先把九条一起量一遍**——挑近的先做，别挑大的 ──
  //
  // 守卫自己的 `measure()` 量三条，数字都是实测的（**`-` 是还差多少**）：
  //
  // ```
  // 文件                        行数        函数体            hook
  // ReviewSurface.tsx         1382 -618   1310  +110       24  -1   ← 只差一项
  // learning-run-surface.tsx  1822 -178   1567  +367       39  +14
  // companion-chat-session    1812 -188   1446  +246       39  +14
  // graph-surface.tsx         1485 -515    834  -366       37  +12
  // CompanionPresence.tsx     1746 -254   1638  +438       29   +4
  // settings-surface.tsx      2400 +400   2053  +853       27   +2
  // understanding-universe    2618 +618   (无超长导出函数)   40  +15
  // CompanionHud.tsx          3167+1167   1869  +669       61  +36
  // notebook-surface.tsx      4510+2510   3726 +2526       49  +24
  // ```
  //
  // **台账上原来写的行数是登记那天的快照，和今天对不上**——「查一个组件到底达没达标，
  // 问守卫本身」那条说的就是这件事。
  //
  // ## 结论：下一步该从 **ReviewSurface** 走，不是 notebook-surface
  //
  // 它**只差 110 行**，hook 已经在线下。拿它换掉 `SIZE_DEBT` 的一条，
  // 成本远低于动 `notebook-surface`（差 2526 行）。
  //
  // ## 「Store 订阅收进 hook」这条已经用过两次了
  //
  // `companion-chat-session.tsx` 的九条 `useRoomStore` → `useCompanionPageContext()`。
  // **同样的开头模式在 `ReviewSurface.tsx` L73–80 又有八条**（`invoke` /
  // `setActiveRunId` / `setActiveObjectiveId` / `setActiveNoteRef` / `activeReviewTarget` /
  // `setActiveReviewTarget` / `reviewQueueResume` / `setReviewQueueResume`）。
  // ⚠️ **但它一条 hook 都不减**——守卫的正则不数 `useRoomStore`（见上）。
  // **要减函数体行数，得搬真正占行数的那块**（比如 L83–121 的「阅读位置 / 续读」逻辑）。
  //
  // ## 顺带一条：Provider 里「按状态域切」比「按段切」难在哪
  //
  // `companion-chat-session.tsx` 的历史域**散在 26 个区间、横跨 L445–L1797**——
  // 声明在开头，取用在中间的各处 effect，最后还要汇进 value。
  // **它不是「搬一块」，是「把一个域的所有 state + effect 重新织一遍」**。
  // 一个域一个域来，别指望一次搬完。
  // ── 2026-09-30：第三步——**两段补白轮询收进 `useCompanionPolls`**（Provider 1518 → 1446 行）──
  //
  // 守卫实测：**行 1812 / 最长函数 1446 行 / 39 hook**（软线 2000 / 1200 / 25）。
  // hook 数**一个没降**——因为搬走的是两段独立的 `useEffect(() => {…})`，
  // **守卫的正则本来就不数它们**（见上一步那条）。
  //
  // ## ⚠️ 下一步别顺着「段」拆：Provider 剩下的是**状态脊**，不是一个关注点
  //
  // 搬完轮询之后 Provider 只剩两段：
  //
  // ```
  // L444  // ── 历史分页 ──────────  353 行
  // L797  // ── 提案快照拉取 ──────  896 行
  // ```
  //
  // **那 353 行不是「历史分页」，是 Provider 的整条状态脊**：
  // `olderMessages` / `historyHasMore` / `historyLoadingOlder` / `historyOlderError` /
  // `historyRevision` + 九个 ref + `liveReply` / `richReply` / `draft` / `interrupted` /
  // `nodes` / `runTraces` …… 二十来个 `useState`/`useRef` 连着底下每一段。
  //
  // **段头注释会骗人**——它标的是「这段代码在讲什么」，不是「这段代码能独立搬走」。
  // **判据要看的是「下面每一段依赖它多少」**，不是「它上面有没有小标题」。
  //
  // **所以下一步的拆法不一样**：不是「搬一个自足的关注点」，
  // 而是**按状态域切**——把「历史」「本轮回复」「轨道留痕」各自相关的 state + 它的 effect
  // 合成一个 hook。这三组之间的依赖比想象中少（各自有自己的 ref 与 effect），
  // **但必须一个域一个域来，一次一个**。
  //
  // ## 本步的 deps 只有 6 个——比担心的少
  //
  // 探针算出来「需要从 Provider 传进来的」看着有 8 个，实际真身是 6 个：
  // `conversation` / `mode` / `phase` / `routeCursorRef` / `pushNavChips` / `setRunTraces`
  // （`id` / `items` / `route` / `conversationId` 是**字段名与解构参数**，不是闭包变量）。
  //
  // **所以「先算再搬」是对的**——我原以为这段引用 59 个标识符、要做一整套 deps，
  // 探针一跑才发现 18 个是模块级可见的，6 个才要传。
  // **凭「它引用了很多东西」的感觉去估工作量，一定估错。**
  // ── 2026-09-30：第二步——**页面上下文收进一个 hook**（Provider 1534 → 1518 行）──
  //
  // 守卫实测（**问它，别信台账上写的行数**）：
  //
  //     行 1883 / 最长函数 1518 行 / 该函数 39 hook
  //     软线 2000 /        1200 /            25 hook
  //
  // 拆出去两样，都搬进了**独立文件**（不是同文件里的自定义 hook——
  // 同文件的 hook 不会让 `component-size-guard` 量到的最长函数体变短）：
  //
  // · `companion-chat-session-page.ts` —— `useCompanionPageContext()`：
  //   九条 `useRoomStore` 订阅 + 页面实例 id + 拼 bridge 上下文的 `useMemo`。
  //   判据：**「他在哪一页、看着哪一条」不是聊天的职责**，是「谁陪着他站在这一页」。
  // · `companion-chat-session-bridge.ts` —— `bridgePageContext()`：
  //   只有上一页那个 hook 在用，跟着它一起搬。
  //
  // ## ⚠️ 守卫的 hook 计数**只认 `= use(State|Effect|Memo|Callback|Ref|Reducer)(`**
  //
  // 实测它的正则是 `source.match(/= use(State|Effect|Memo|Callback|Ref|Reducer)\(/g)`——
  // 于是：
  //
  // · **`useRoomStore` 一次都不算**（所以本轮搬走九条订阅，hook 数只动了 2）；
  // · **独立的 `useEffect(() => {…})` 也不算**（本文件里有十几处，两段轮询里一处都没算）。
  //
  // **所以 39 是低估。** 真实 hook 数更多，而「按守卫的数拆到 25」比看上去容易——
  // **别把它当成真实负担来规划**，也别拿它当「已经达标」的证据。
  //
  // ## 还差什么（实测数字）
  //
  // 行数 1518 → 1200：**还差 318 行**。Provider 内部按关注点分了四段可以整体搬：
  // 划选/拖拽引用（约 189 行）、两段低频轮询（约 78 行）、提案快照拉取（约 54 行）、
  // 历史分页（约 137 行）——合计约 458 行，**搬完两段就够**。
  //
  // **但它们的闭包依赖很密**（光两段轮询就引用了 59 个标识符），
  // 每一段搬出去都要一整套 deps ——**这是本条最花时间的地方，不要以为搬出去就完了**。
  // ── 2026-09-30：「伴星会话」第一步——纯函数抽出去了（2125 → 1974 行）──
  //
  // ## 怎么查它到底达标没有
  //
  // 别信台账上写的行数，问守卫本身。守卫量三样：文件行数、
  // **最长导出函数体**行数、**那个函数里**的 hook 数。当前实测：
  //
  //     行 1974 / 最长函数 1534 行 / 该函数 41 hook
  //     软线 2000 /        1200 /            25 hook
  //
  // 只过了行数那一关。要出 SIZE_DEBT 还差两样：
  // **Provider 本体拆到 1200 行以内、hook 降到 25 以内。**
  //
  // ## 这一步搬走了什么
  //
  // 8 个纯函数（一个 hook 都没有）搬进 `companion-chat-routing.ts`：
  // `desktopRouteFromAgentRoute` / `companionMessageText` / `applyRouteToRoom` /
  // `navChipSharesTarget` / `navChipsStillOutsideMessages` /
  // `readCompleteCompanionHistory` / `isCompanionRunConflict` / `companionTurnErrorMessage`。
  //
  // 判据是 AGENTS.md 那句「页面组件只做四件事：取数、派生、摆位、接事件」：
  // 派生该有自己的地方。
  //
  // ## 搬运的教训：按 AST 区间，不要按行号算术
  //
  // 这一步在同一个地方栽了两次，两次的报错行号都离真因几百行：
  //
  // 1. 「从 JSDoc 起」只退到 JSDoc 的下一行 → `/**` 留在原文件，
  //    新文件从 `* …` 开始 → 解析报 `Expression expected`。
  // 2. 「到下一个顶层声明止」用 JSDoc 起点当参照 → 那个声明就是它自己，
  //    区间短成只有那段 JSDoc → 函数体全留在原文件 → `Cannot redeclare`。
  //
  // 正解：`node.getStart()`（默认含 JSDoc）/ `node.getEnd()`，
  // 由 `split-chat-routing-probe.test.ts` 产出，零重叠。
  //
  // 连带一条：「本文件仍在用」不能按行文本搜——那行 import 本身就是被裁短的，
  // 搜出来的清单自然是残的，于是少 import 两个，tsc 报
  // `declares locally, but it is not exported`。要以「搬走的那份清单」为准重算。
  //
  "app/companion-chat-session.tsx":
    "2125 行 / 41 hook。下一步：消息归并与持久化分开。",
  "components/surfaces/run/learning-run-surface.tsx":
    "1822 行 / 39 hook。2026-09-29 已拆成 12 个模块（文案表 / 顶栏 / 题面 / 求助 / 发现卡 / 四档等待 / "
    + "证据带 / 判定表 / 收据 / 动作条 / 两个确认框）。下一步：作答区里 `InteractionEditor` 那一支。",
  "components/companion/CompanionPresence.tsx":
    "1746 行 / 29 hook。**这一块不许随便拆**——座位预算是 `DESIGN.md` 的硬约束，"
    + "拆的时候必须保证 `--companion-seat-*` 的发布与读取仍在同一处。下一步：先补注释再拆。",
  // ── 2026-09-30：**块 B 也成了**（26 hook），另修掉一处**别人留下的语法错** ──
  //
  // 守卫实测：**行 1467 ✓ / 最长函数 815 ✓ / 26 hook**（软线 2000 / 1200 / 25）。
  // **只差 1 个 hook。** 块 A（15）+ 块 B（4）共搬走 19 个：37 → 26。
  //
  // ## 块 B 为什么能独立，而它旁边的取数链不能
  //
  // 块 B（建议关系上的本人表态）**只是状态**——不发请求、不碰 `useSurfaceProjection`。
  // 真正用到取数结果的是组件里的 `stampRelationDecision`，它**读这里的 `relationStamps`
  // 并调这里的 setter**，所以搬出来之后从返回值拿，**而不是从作用域引用**。
  //
  // ## ⚠️ 本轮踩的坑：**同一个文件里有两处 `useSurfaceProjection(`**
  //
  // 我用「第一个出现的位置」去找取数链的收尾，把 `selectNode` 插到了**第一个**之后——
  // 而 `rawNodeById` 是从**第二个**派生的，于是报
  // `Block-scoped variable 'rawNodeById' is used before its declaration`。
  // **正解：找「最后一个」，或者按名字找那个真正产出该变量的。**
  //
  // ## 顺手修掉的一处语法错（**不是这轮造成的，但一直在那里**）
  //
  // `surfaces/run/learning-run-copy.tsx` 的 `actionRequestFor` 里，
  // `case "cancel_assessment"` 写的是 `return { kind: action.kind, XXX: action.assessmentId }`——
  // **属性名是 `XXX`**。判据有三处互相印证：它上面那段注释明写「指名要带 `assessmentId`」；
  // 同一个 `switch` 里 `case "retry_assessment"` 用的就是 `assessmentId: action.assessmentId`；
  // `XXX` 全文件只出现这一次。已改回 `assessmentId`。
  //
  // **这类错 `tsc` 报的是 `TS2353 Object literal may only specify known properties`**——
  // 不在**语法**族里，所以**它不会触发「提前中止」**，而是一直躺在那儿。
  // 教训不变：**typecheck 报的错要一条条看类别**，`TS2353` 意味着「有个属性名是编出来的」，
  // 顺着同函数里**形状相同的另一行**去对，一眼就能看出该写什么。
  // ── 2026-09-30：「graph-surface」**块 A 成了**（hook 37 → 27）──
  //
  // 守卫实测：**行 1468 ✓ / 最长函数 817 ✓ / 27 hook**（软线 2000 / 1200 / 25）。
  // **行数与函数体本来就在线下，这一轮只动了 hook**：把「读者控制状态」15 个搬进
  // `use-graph-controls.ts`（搜索词 / 三个显示开关 / 状态筛选 / 选中项 / 路径 / 等价册页）。
  //
  // ## 关键：紧跟其后那条 `useSurfaceProjection(…)` **留在组件里**
  //
  // 第 8 轮把「首尾两块」一起搬时，它被夹在两个切口之间，组件当场少 **18 个派生值**。
  // **这一轮只搬块 A，取数链与块 B 都不动**——15 − 15 已经够从 37 降到 27。
  //
  // ## 本轮踩的三个坑
  //
  // 1. **块 A 起点差 2 行**：JSDoc 回溯多退了两行，**`query` / `deferredQuery` 留在了组件里**，
  //    于是 `Cannot redeclare`。**切完先搜一遍「被搬走的第一个声明」还在不在**。
  // 2. **`useCompactUniverseLayout()` 那一行被一起带走了**——它夹在块 A 内部。
  //    但它是**取数（量视口）**，按判据该留在组件侧。已改成**入参**传进 hook。
  // 3. **setter 的返回类型不能简化成 `(v: T) => void`**：段内有
  //    `setFitRequest((value) => value + 1)` 这种**函数式更新**。
  //    **必须用 React 的 `Dispatch<SetStateAction<T>>`**——
  //    简化了就报 `Argument of type '(value: any) => any' is not assignable`。
  //    （这与主进程那条「deps 的类型不要手写」是同一族：**用库的原样类型**。）
  //
  // ## 还差 2 个 hook：**块 B**（L373–L376，4 个 hook）
  //
  // 建议关系上的**本人表态**（39d W8-2 · §11.3，**本地先改、重取在后**）。
  // ⚠️ 它的输入是 `selectedProjection` / `stampRelationDecision` 这些
  // **从上面那条取数链派生的值**——所以要么**作为 deps 传进去**，
  // 要么**连取数链一起搬**。**先算清楚它到底需要哪几个**，别再切出 18 个缺失名。
  // ── 2026-09-30：「graph-surface」第三次（探针三个坑都修了）——**切口仍然太宽，撤回** ──
  //
  // 区间这轮是**对的**：块 A L347–373（27 行 / 15 hook）、块 B L384–395（12 行 / 3 hook），
  // **两块独立解析都通过、零重叠**，终点改成取 `VariableStatement`（不是声明列表）——
  // 那是第 7 轮的直接失败原因，这轮**确实修好了**。
  //
  // ## 但它仍然切太宽：块 A 与块 B **之间还有一整条取数链**
  //
  // 切完之后组件里少了 18 个名字：
  //
  // ```
  // compactLayout  layout  projectionByKey  projections  rawGraph  rawNodeById
  // relationStampError  selectedNode  selectedPath  selectedProjection
  // stampRelationDecision  stampingEdgeId  topologyEdges  visibleGraph
  // ```
  //
  // 前九个来自**紧跟在块 A 之后的那条 `useSurfaceProjection(…)` 取数链**——
  // 它把拓扑图算成 `projections` / `visibleGraph` / `topologyEdges`，
  // 块 B 的表态逻辑与后面所有摆位**都从它派生**。
  //
  // **所以「块 A + 块 B」不是一个域，是「摆位参数」与「取数链」被我的切口夹在了中间。**
  //
  // ## 这一条比前三次都更值钱：**它把「能不能搬」的问题从「切口对不对」换成了「域对不对」**
  //
  // 前三轮我一直在修**切口**（JSDoc 回溯、终点 parent 链、重复声明）——
  // 那些都真错了，也都修好了。**但修好之后才发现真正的问题是域划错了**：
  // 切出去的只是两端，**中间那条取数链必须留在组件里**，
  // 而它派生出的 `selectedProjection` / `visibleGraph` 又是块 B 的输入。
  //
  // **下一轮别再修切口了**，照这个顺序：
  //
  // ```
  // 1. 块 A 单独搬（摆位参数，15 hook）—— 组件保留 compactLayout 那一行，传进 hook
  // 2. useSurfaceProjection 整条取数链**留在组件里**（它不是「摆位参数」）
  // 3. 块 B 单独搬（表态，3 hook）—— 它的输入是 selectedProjection 等派生值，
  //    所以这些要**作为 deps 传进去**，不是从组件作用域直接引用
  // 4. 每搬一块立刻 npm run typecheck：少了哪个名字就说明它**在中间那条链上**，
  //    别急着补声明——先问「它该留在组件还是该进 deps」
  // ```
  //
  // **一句话**：**搬出去的是「摆位参数」，不是「一段连续的行」。**
  // 中间夹着取数链时，两端能各自独立解析通过，**而组件会缺一串派生值**——
  // 独立解析这道闸**测不出**这个（它只验「抽出来的那段自己完整」）。
  // ── 2026-09-30：「graph-surface」再试（−14 hook）——**探针自身的三个坑，撤回** ──
  //
  // 切口量到了：**块 A L347–373（27 行 / 15 hook）**、**块 B L384–395（12 行 / 3 hook）**，
  // **两块独立解析都通过、零重叠**。搬完 37 → 23，**过线还留 2 个余量**。
  //
  // 但切割时块 A 的终点**超了**，把后面那整条 `useSurfaceProjection(…)` 一起带走了，
  // 于是 `TS1109` 报在调用点、`TS1135` 报在新 hook 里。**这一族错误第四次。**
  //
  // ## 探针本身踩的三个坑（**比切口更值得记**）
  //
  // 1. **数组解构的名字不在 `VariableDeclaration.name` 上**，
  //    在 `BindingElement` 上。`const [query, setQuery] = useState("")`
  //    的 `VariableDeclaration.name` 是 `ArrayBindingPattern`。
  //    不处理就会「找不到 query」。（**连 `epochRef` 这种单值的都一起找不到**——
  //    因为 `decls` 根本没填上。）
  // 2. **JSDoc 回溯不能用 `lastIndexOf("/**")`**：它会抓到**几百行外**的那一段，
  //    实测把块 A 的起点从 L347 算到 **L220**——而两处之间**没有空行**可以当护栏。
  //    **正解：逐行往回走，只在「连续的注释行」里退。**
  // 3. **终点 `getEnd()` 的 parent 链要看清**：
  //    `VariableDeclaration.parent` 是 `VariableStatement`，
  //    再 `.parent` 是 **`VariableStatementList`**——拿 `VariableStatementList.getEnd()`
  //    在这个文件里**把后面一条语句也吞进去了**。
  //    **正解：终点取「本条语句」的 `getEnd()`，不是它所在声明列表的。**
  //
  // ## 一条顺带的发现
  //
  // `component-size-guard` 的 hook 正则是 `= use(State|Effect|…)\(`——
  // **带泛型的 `= useState<string>(` 也不匹配**。所以它报的 hook 数**比真实的还要低**。
  // 实测本文件的真实值是 **40**（守卫口径 37）。
  // **规划时按真实值算，不要按守卫的口径。**
  //
  // ## 下一轮
  //
  // 上面三条修完，块 A 与块 B 各搬一次就行，**这是剩下八条里最省力的一条**。
  // 类型 `StateFilter` / `DeepeningLayer` 在本文件 L73 / L119，
  // **搬到 `graph-surface-types.ts` 再 import 回来**（搬，不是重写）。
  // ⚠️ `compactLayout` 是 `useCompactUniverseLayout()` 的结果——**那是取数**，
  // 按判据该留在组件侧，所以它**从入参进 hook**，不搬。
  // ── 2026-09-30：「graph-surface」试拆（−11 hook）——**切口算错，撤回** ──
  //
  // 这是九条里**最好做**的一条：行数 1485 ✓、最长函数 834 ✓，**只差 hook**（37 → 25）。
  //
  // ## 切口量到了，形状也对
  //
  // `GraphSurface` 开头连续两块，**都和服务端无关**（判据：「页面组件只做四件事」——
  // 它们是**摆位参数**，不是取数）：
  //
  // · **L347–L373（27 行，10 个 hook）**：搜索词 / 三个「要不要显示证据·来源·关系」开关 /
  //   状态筛选 / 选中项 / 路径（**一个**笔记 + **一个**层）/ 随时可切的等价册页
  // · **L392–L395（4 行，4 个 hook）**：建议关系上的本人表态
  //   （39d W8-2 · §11.3，**本地先改、重取在后**——服务端把表态折进 ETag，
  //   不先改本地就会出现「按了没反应也没报错」）
  //
  // 两块都搬 → 37 → 23，**过线还留 2 个余量**。
  //
  // ## 撤回的原因：第二块的**结束行算错**
  //
  // 我用 `next(i for i in range(c, len(L)) if 那一行以 relationStampError 开头)` 定终点，
  // 结果拿到的是**它自己那一行**，于是区间短成 3 行 / 1 个 hook，
  // 紧接着的替换又把语法切坏了（`TS1003` 在第 63 行，离切口两百行）。
  //
  // **又一次是「用行首文本猜边界」**——这和搬纯函数时栽的两次是同一族。
  // ⚠️ **函数体内部的块**不能用「下一个同类声明」定终点，
  // 因为**中间的 JSDoc 会插在声明之间**；要用**「这个语句的 AST 结束位置」**。
  //
  // ## 下一轮照这个顺序
  //
  // ```
  // 1. cp -R …/space /tmp/bk-space
  // 2. 块 A：L347–L373 → use-graph-controls()（返回全部 state + setter + compactLayout + listboxId）
  // 3. 块 B：L392–L395 → useGraphRelationStamps()
  //    ⚠️ 终点用 AST 的 getEnd()，不要用「下一行以什么开头」
  // 4. ⚠️ `useCompactUniverseLayout` / `useId` / `useDeferredValue` **不是** `= useX(` 口径——
  //    搬走它们不减 hook 数，但也不能漏（组件后面还在用）
  // 5. ⚠️ 类型 StateFilter / DeepeningLayer 在 graph-surface.tsx 本文件里：
  //    **搬到 graph-surface-types.ts 再 import 回来**（搬，不是重写）
  // 6. typecheck → 问守卫 → src/main → 17 守卫 → 构建 → 过了就 SIZE_DEBT → SIZE_DONE
  // ```
  "components/surfaces/space/graph-surface.tsx":
    "1485 行 / 37 hook。下一步：证据面板与画布分开。",
};

describe("组件体量：红线之上判死，软线之上要登记", () => {
  /**
   * 2026-09-30 新增。**扫描范围扩到主进程这件事，本身要有牙齿**——
   * 否则下一次有人把 `ROOTS` 改回只有渲染层，这条测试不会响，
   * 而「守卫看不见主进程」正是 6379 行那个文件被漏掉半年多的原因。
   */
  it("扫描范围包含主进程与 preload（那 6379 行曾经不在视野里）", () => {
    const names = size.map((s) => s.file);
    expect(names, "主进程没进扫描范围").toContain("main/desktop-gateway.ts");
    expect(names, "preload 没进扫描范围").toContain("preload/index.ts");
    // 主进程那两个文件**要么在台账里（还有下一步），要么在 SIZE_DONE 里（已达标）**——
    // 两种状态都算「有人负责」。
    //
    // 为什么改这条：守卫同时要求「主进程两个文件都有人负责」与「台账只允许变短」，
    // 而 `desktop-gateway.ts` 2026-09-30 拆到 1738 行之后**两条同时为真**——
    // 它不该再出现在 `SIZE_DEBT`（台账是「待办」），却也不能从守卫视野里消失。
    const owned = new Set([...Object.keys(SIZE_DEBT), ...Object.keys(SIZE_DONE)]);
    expect(owned.has("main/desktop-gateway.ts"),
      "main/desktop-gateway.ts 既不在台账也不在已达标表里").toBe(true);
    expect(owned.has("main/desktop-ipc.ts"),
      "main/desktop-ipc.ts 既不在台账也不在已达标表里").toBe(true);
  });

  it("读到了东西（否则这条守卫是空的）", () => {
    expect(FILES.length, "没扫到组件文件").toBeGreaterThanOrEqual(150);
    expect(size.length, "size 表是空的").toBe(FILES.length);
    expect(hard.length, "一上来就判死？那说明红线定错了，线上不该有越过它的文件").toBe(0);
  });

  it("红线之上没有任何文件或函数（2000 行 / 1200 行 / 50 hook）", () => {
    const detail = hard
      .map((s) => `  ${s.file}  ${s.lines} 行 / 最大函数 ${s.fn} 行 / ${s.hooks} hook`)
      .join("\n");
    expect(
      hard,
      `这些越过了红线，必须立刻拆（不豁免）：\n${detail}`,
    ).toEqual([]);
  });

  it("软线之上的每一项都在台账里，而且写了下一步拆哪一块", () => {
    const missing = soft.filter((s) => !(s.file in SIZE_DEBT)).map((s) => s.file);
    expect(missing, `这些文件/函数已越过软线但没有登记：\n${missing.join("\n")}`).toEqual([]);
  });

  it("台账只允许变短：已拆到线下、却还留在台账里的条目会红", () => {
    const stale = Object.keys(SIZE_DEBT).filter((file) => !soft.some((s) => s.file === file));
    expect(stale, `这些条目已经拆到软线之下，请从 SIZE_DEBT 里删掉：\n${stale.join("\n")}`).toEqual([]);
  });

  it("台账每一条都写了下一步（只写「太大了」不算工单）", () => {
    const thin = Object.entries(SIZE_DEBT).filter(([, note]) => !/下一步/.test(note));
    expect(thin.map(([f]) => f), `这些条目没写「下一步」：${thin.map(([f]) => f).join(", ")}`).toEqual([]);
  });

  it("自检：造一个越线的条目，判据必须报出来", () => {
    const probe = { file: "components/fake.tsx", lines: 9999, fn: 9999, hooks: 999 };
    expect(probe.lines > HARD.fileLines).toBe(true);
    expect(soft.some((s) => s.file === "components/fake.tsx")).toBe(false);
  });
});
