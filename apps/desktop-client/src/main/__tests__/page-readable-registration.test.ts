/**
 * 「哪一屏没登记可读视图」的台账守卫（39d W2-7）。
 *
 * W2-7 的判据是"剩余页面逐屏登记"，而**漏登记不会红**：`usePageReadableView` 只在
 * 形状不合时喊，一次都没调用就是安静地少一屏（症状只是"她偶尔读不到这一页"）。
 * 所以这里从源码现读两件事——
 *  ① 每一屏的 `useHudPage(…)` 调用点在哪个文件：**字面量**（`useHudPage("today")`）与
 *     **变量**（`useHudPage(page)`，顺着那条 `const page: HudPageId = …` 声明取字面量）
 *     两种形状都要认——只认字面量会让一整份文件不在分母里（2026-09-25 实测漏了笔记页两屏）；
 *  ② 那个文件**发出了**几枚 pageId（`pageId: "…"`，含三元里的两个分支）。
 * 两者一比，"漏登记"就从"没人注意到"变成一条必须显式记账的差集。
 *
 * 两张清单的区别是这张表的全部意义：
 *  - `NOT_REGISTERED_WITH_REASON`＝**看了代码才下的判断**（永远不该登记，见里面那条理由）；
 *  - `PENDING_W2_7`＝**还没做**（W2-7 的欠账，只许变短：登记完还留着不删就红）。
 * 把欠账写成"理由"，是这张表最想防的那一种作弊。
 *
 * 判据形状照本仓库那条老规矩：匹配**调用形状** `usePageReadableView(`——只匹配 import 行
 * 会让"import 了但没调用"的文件蒙混过关。
 *
 * 放在 main 侧的理由与 `renderer-html-sink-guard.test.ts` 相同：读文件要 `node:fs`。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * 有意**不登记**可读视图的屏：每一条都得是能引用的代码事实，不是"还没做"。
 */
const NOT_REGISTERED_WITH_REASON: Readonly<Record<string, string>> = {
  /**
   * `space` 不是一屏业务页面：它是 `DesktopAccessGate` 在 `workspace_required`
   * 那一相画的一次性选空间模态（`hud/HudFirstSpace.tsx` 是 `role="dialog"
   * aria-modal="true"`；`DesktopAccessGate.tsx:1623-1626` 的注释写明"账号已登录
   * 但还没有绑定空间，此刻客户端对任何一个空间都读不到东西"）。
   * 伴星会话挂在门禁**之上**（`App.tsx:215-221`，那段注释还专门点名"工作区选择页
   * 也在门禁内部，同样由它覆盖"），所以这一刻她真的可能被问到——那就更不能把
   * "还没选空间、一个字节的学习数据都没读"当成一屏可读内容报给她。
   * 与 `credential_surface` 同族：那一档 W2-7 一开始就写明一律不登记。
   */
  space: "门禁内的一次性选空间模态（role=dialog）：此刻没有任何空间数据可读",
};

/**
 * W2-7 的欠账（只许变短）。登记完就把这一条删掉——留着不删会红。
 *
 * 2026-09-25 清空：最后一条 `settings` 已落（六张分区目录各自报自己那份事实）。
 * 这张表现在是空的，但**通道保留**——下一屏漏登记时，欠账要记在这里而不是记成"理由"；
 * 上面那条"留着不删就红"的判据也还在（`staleEntries`），自证用的是合成条目，不靠这张表里有东西。
 */
const PENDING_W2_7: Readonly<Record<string, string>> = {};

function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentFiles(path));
    else if (entry.name.endsWith(".tsx") && !TEST_FILE.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * 这一屏**挂在哪**：只认 `useHudPage("<字面量>"` 会漏掉一整类调用点。
 *
 * 2026-09-25 的真实漏法：笔记页写的是
 * `const page: HudPageId = mode === "edit" ? "note-edit" : "note-read"; useHudPage(page);`
 * ——参数是变量，字面量正则一条都匹配不到，于是 `note-read`／`note-edit` 两屏
 * **从来不在分母里**：漏登记不会红，"已经登记了"也不被认（双向失明），
 * 而它自己的正控制只看"扫到 >10 屏"，少两屏照样绿。
 *
 * 这里补第二条路：非字面量的 `useHudPage(x)` ⇒ 顺着 `const x: HudPageId = …` 那条声明
 * 取**它真正会取的那几个值**：三元的两个分支（`? "note-edit" : "note-read"`），
 * 或直接一个字符串字面量（`= "home"`）。
 * **不收初始化式里出现的所有字面量**——`mode === "edit" ? …` 里那个 `"edit"` 是**比较右侧的操作数**，
 * 收进来就会凭空多出一屏（第一版就是这么错的，红在真实文件上）。收不到就是零屏，
 * 与改前一致，宁可少判也不造假屏。
 */
function hostedPages(rawSource: string): string[] {
  const source = codeOnly(rawSource);
  const pages = new Set<string>();
  for (const match of source.matchAll(/useHudPage\("([a-z][a-z0-9_.-]*)"[,)]/g)) pages.add(match[1]);
  for (const match of source.matchAll(/useHudPage\((?!["'])\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g)) {
    // **取调用点之前最近的那一次同名声明**，不是"文件里第一次出现"：
    // 一个组件里可以有多个 `const page`（09-26 就真的撞上一次——翻页那发先声明了
    // `const page = unwrapGatewayResult(...)`，于是笔记页两屏整个从分母上消失，
    // 而"扫描器读到了东西"那条正控制照样绿，因为它数的是全仓总数）。
    const callAt = match.index ?? 0;
    const declarations = new RegExp(`(?:const|let)\\s+${match[1]}\\s*(?::[^=]+)?=([^;]+);`, "g");
    let initializer = "";
    for (const found of source.matchAll(declarations)) {
      if ((found.index ?? 0) >= callAt) break;
      initializer = found[1]?.trim() ?? "";
    }
    // ⚠️ 2026-09-30 改：原来只取**最外层** `? A : B` 那两个分支。
    // `notebook-surface.tsx` 是**嵌套**三元——`note-read` 藏在里层，于是它整个从分母上
    // 消失，报「note-edit 没进台账分母」。**一个初始化式里出现过的每一个页面名都是它挂的屏**，
    // 嵌套不改变这一点。与上面 `publishedPageIds` 同一个修法、同一个理由。
    // 字符类同时留点：页面名里有 `note.detailVersion` 这种带点的。
    // ⚠️ 只取**三元结果位**（`? "X"` / `: "X"`），**不是**初始化式里所有的字符串：
    // 条件那一半写着 `mode === "edit"`、`leaf === "learning"`，那些是**判据**不是页面名。
    // 第一次改成"全取"时 `edit` / `learning` / `expansion` 全被当成了屏——
    // 那个方向同样错。嵌套三元里每一层的 `?` 与 `:` 都被这条覆盖，所以不必数括号。
    for (const branch of initializer.matchAll(/[?:]\s*"([a-z][a-z0-9_.-]*)"/g)) {
      pages.add(branch[1]);
    }
    if (/^"[a-z-]+"$/.test(initializer)) pages.add(initializer.slice(1, -1));
  }
  return [...pages];
}

/**
 * 这个文件**真的发出了**哪几枚 pageId（`pageId: "x"` 字面量，含三元里那两个分支）。
 * 这是"发了几屏"的读数来源——比数 `usePageReadableView(` 的个数准，
 * 因为一个调用点可以按运行时分支发两枚（阅读／编辑就是同一份视图的两个 pageId）。
 */
function publishedPageIds(rawSource: string): string[] {
  const source = codeOnly(rawSource);
  const ids = new Set<string>();
  // ⚠️ 字符类**必须留点**（2026-09-30 修）：`notebook-surface.tsx` 那一枚是
  // `pageId: "note.detail"`，原来的 `[a-z_]+` 把点当成分隔符，于是**它数出来是 0 枚**——
  // 报「挂着 note-history/note-read 共 2 屏，却只发出 0 枚 pageId」。
  // 守卫读不到自己最该读的那一枚，报错还会指向「少登记」这个错误方向。
  for (const match of source.matchAll(/pageId:\s*"([a-z][a-z0-9_.]*)"/g)) ids.add(match[1]);
  // 2026-09-30 修：原来这里是 `? A : B` **只取最外层那两个分支**。
  // `notebook-surface.tsx` 那一条是**嵌套**三元——
  //   `mode === "edit" ? "note-edit" : (leaf === "learning" || ... ? "note-learning" : "note-read")`
  // ——于是 `note-read` 藏在里层，守卫数出来「1 枚」对上「2 屏」，报
  // 「挂着 note-history/note-read 共 2 屏，却只发出 0 枚 pageId」。
  //
  // **不改成把源码拍平来迁就守卫**：嵌套三元不是缺陷，它是这一屏真实的分支形状。
  // 该修的是读法——**一个 `pageId:` 表达式里出现过的每一个页面名都是它发出的一枚**。
  for (const match of source.matchAll(/pageId:\s*([^;\n]*)/g)) {
    // 与上面同一个坑：`? "note-edit" : "note-read"` 里那一半是**条件**
    // （`mode === "edit"`），它不是一枚 pageId。同一行后半段的 `label:` / `state:`
    // 也不是。所以只取 `?` / `:` 后面的那一枚，以及紧跟 `pageId:` 的字面量。
    for (const literal of match[1].matchAll(/[?:]\s*"([a-z][a-z0-9_.-]*)"/g)) ids.add(literal[1]);
    for (const literal of match[1].matchAll(/^\s*"([a-z][a-z0-9_.-]*)"/g)) ids.add(literal[1]);
  }
  return [...ids];
}

/**
 * 一个文件可以挂**好几屏**（`WorkspaceLibrarySurface.tsx` 就是列表与简报两半）。
 * 只看"这个文件里有没有 `usePageReadableView(`"会让其中一半替另一半交差，
 * 所以按文件比两个数：它**发出的 pageId 种数**必须**不少于**它挂的屏数。
 *
 * 比的是"种数"而不是"名字对得上"，因为发出去的那枚是**伴星词表里的页面名**，
 * 与 HUD 自己的屏名故意不同（`graph` 那屏发的是 `star_map`、`queue` 发 `review_queue`）；
 * 要求同名会把这层有意区分判成缺陷。
 */
function filesUnderRegistering(registration: Registration): string[] {
  const offenders: string[] = [];
  for (const [page, info] of registration) {
    if (!info.own) continue;
    const pagesInFile = [...registration.entries()]
      .filter(([name, other]) => other.file === info.file && !(name in PUBLISHED_BY_PANEL))
      .map(([name]) => name);
    const published = publishedPageIds(readFileSync(info.file, "utf8"));
    if (published.length < pagesInFile.length) {
      offenders.push(`${info.file.split("/").pop()}：挂着 ${pagesInFile.join("/")} 共 ${pagesInFile.length} 屏，却只发出 ${published.length} 枚 pageId（${published.join("/")}）`);
    }
  }
  return [...new Set(offenders)];
}

/**
 * 有的屏由子面板发布可读视图。伴星中心的七个页面，以及记忆页的星图和
 * 整理与回收页，分别计算实际可见内容；导航壳不再重复取数或发布清单。
 * Activity 隐藏页面时解除其登记，只留下当前页。登记跟随实现文件和真实
 * import 图，不以旧的六页 barrel 或文件位置推定所有权。
 *
 * 记在这里的每一屏都还要过两道核对：面板文件里真有 `usePageReadableView(`，
 * 且壳层文件真的 import 了它（不然就是一个把登记算给自己的空壳）。
 */
const PUBLISHED_BY_PANEL: Readonly<Record<string, string | readonly string[]>> = {
  companion: ["companion-center-overview", "companion-dialogue-panel", "companion-diary-panel", "companion-memory-panel", "companion-memory-map", "companion-memory-maintenance", "companion-discovery-panel", "companion-activity-panel", "companion-persona-panel"].map(file => `src/renderer/src/components/surfaces/companion/${file}.tsx`),
  candidate: "src/renderer/src/components/surfaces/review/use-card-generation-readable-view.ts",
  generating: "src/renderer/src/components/surfaces/review/use-card-generation-readable-view.ts",
};

function callsPublish(source: string): boolean {
  return /usePageReadableView\(/.test(codeOnly(source));
}

/**
 * 只留"像是代码"的那几行再交给判据。
 *
 * 这条不是洁癖，是量出来的洞（2026-09-25）：把 `usePageReadableView(readableView);`
 * **注释掉**之后守卫仍然绿——判据是纯正则，`//` 后面那句照样算"发了"。
 * 注释掉一处的写法在真实改动里太常见（"先停一下这一屏"），所以三处判据
 * （挂哪屏、发了几枚 pageId、有没有登记）统一读**去注释**后的源码。
 *
 * 只去掉**整行注释**（`// …` 与块注释里的 ` * …`），不做逐字符的字符串扫描：
 * 那会把 `https://…` 与 JSX 文本里的 `//` 也当注释吃掉，判据会反过来少看真代码。
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join("\n");
}

/**
 * 面板能不能替壳层交这份登记：**面板真发了**，且**壳层真 import 了那个文件**。
 * 纯函数，喂字符串就自证——不依赖任何一份真实文件现在的状态（那些文件以后会改，
 * 拿它们当自证的一条腿，明天就变成一条说不清的红）。
 */
function registeredViaPanel(shellSource: string, panelSource: string, panelFile: string, shellFile = panelFile): boolean {
  if (!callsPublish(panelSource)) return false;
  const path = relative(dirname(shellFile), panelFile).replace(/\.tsx?$/, "");
  const specifier = path.startsWith(".") ? path : `./${path}`;
  return shellSource.includes(`from "${specifier}"`) || shellSource.includes(`from '${specifier}'`);
}

/** Follow local imports and re-exports after page containers were split from panels. */
function registeredViaPanels(shellSource: string, shellFile: string, panelFiles: readonly string[]): boolean {
  const reached = new Set<string>();
  const walk = (source: string, file: string) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const match of codeOnly(source).matchAll(/(?:import|export)[^;]*?from\s+["'](\.[^"']+)["']/g)) {
      const base = join(dirname(file), match[1]);
      const child = [base, `${base}.tsx`, `${base}.ts`].find(path => existsSync(path) && /\.[jt]sx?$/.test(path));
      if (child && !reached.has(child)) walk(readFileSync(child, "utf8"), child);
    }
  };
  walk(shellSource, shellFile);
  return panelFiles.every(file => reached.has(file) && callsPublish(readFileSync(file, "utf8")));
}

/** 页面身份 → 它自己的组件文件，以及登记落在哪里（自己或它的面板文件）。 */
function pageRegistration(): Map<string, { file: string; registered: boolean; own: boolean }> {
  const map = new Map<string, { file: string; registered: boolean; own: boolean }>();
  for (const file of componentFiles(RENDERER_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const page of hostedPages(source)) {
      const panel = PUBLISHED_BY_PANEL[page];
      const viaPanel = panel !== undefined && (typeof panel === "string"
        ? registeredViaPanel(source, readFileSync(panel, "utf8"), panel, file)
        : registeredViaPanels(source, file, panel));
      const own = callsPublish(source);
      map.set(page, { file, registered: own || viaPanel, own });
    }
  }
  return map;
}

/** 面板代登记的屏必须指名道姓：列了却用不上，就是拿它当免登记通道。 */
function unusedPanelClaims(): string[] {
  const registration = pageRegistration();
  return Object.entries(PUBLISHED_BY_PANEL)
    .filter(([page]) => !registration.get(page)?.registered)
    .map(([page, panel]) => `${page} 声称由 ${panel} 代登记，但那道核对没过`);
}

type Registration = ReturnType<typeof pageRegistration>;

function unaccountedPages(
  registration: Registration,
  reasons: Record<string, string>,
  pending: Record<string, string>,
): string[] {
  return [...registration.entries()]
    .filter(([page, info]) => !info.registered && !(page in reasons) && !(page in pending))
    .map(([page, info]) => `${page}（${info.file.split("/").pop()}）`);
}

function staleEntries(
  registration: Registration,
  reasons: Record<string, string>,
  pending: Record<string, string>,
): string[] {
  return [...Object.keys(reasons), ...Object.keys(pending)]
    .filter((page) => registration.get(page)?.registered)
    .map((page) => `${page}：已经登记了，台账里的条目该删`);
}

function phantomEntries(registration: Registration, reasons: Record<string, string>, pending: Record<string, string>): string[] {
  return [...Object.keys(reasons), ...Object.keys(pending)]
    .filter((page) => !registration.has(page))
    .map((page) => `${page}：根本没有 useHudPage 调用点，不该出现在台账里`);
}

describe("可读视图登记台账（W2-7）", () => {
  it("每一屏要么登记了可读视图，要么在「理由」或「欠账」两张表里", () => {
    const registration = pageRegistration();
    // 正控制：扫描器必须真的读到了东西（读不到时"差集为空"就是假绿）。
    expect(registration.size, "一个 useHudPage 调用点都没找到——扫描路径或判据形状错了").toBeGreaterThan(10);

    const both = Object.keys(NOT_REGISTERED_WITH_REASON).filter((page) => page in PENDING_W2_7);
    expect(both, "同一屏不能既是「有意不登记」又是「还没做」").toEqual([]);

    expect(
      unaccountedPages(registration, NOT_REGISTERED_WITH_REASON, PENDING_W2_7),
      "这些屏挂了页面身份，既没登记也没记账",
    ).toEqual([]);
    expect(filesUnderRegistering(registration), "同一文件挂着好几屏时，一半不许替另一半交差").toEqual([]);
    // 一个文件挂几屏，就要有几处登记（不许一半替另一半交差）。
    expect(filesUnderRegistering(registration), "登记调用点少于这一屏数").toEqual([]);
  });

  it("两条发现路都单独自证：字面量调用点与变量调用点，以及三元发出的两枚 pageId", () => {
    // 合成输入，不依赖任何一份真实文件以后长什么样（拿真文件当这条自证的一条腿，明天就说不清了）。
    const literalForm = `useHudPage("today");`;
    expect(hostedPages(literalForm)).toEqual(["today"]);
    // ① 变量式调用点：屏名在声明的初始化式里（笔记页就是这个形状）。
    expect(hostedPages(
      `const page: HudPageId = mode === "edit" ? "note-edit" : "note-read";\nuseHudPage(page);`,
    )).toEqual(["note-edit", "note-read"]);
    // ①-b 同名声明出现多次：认**调用点前面最近那一条**，不认文件里第一条。
    expect(hostedPages(
      `const page = readSomething();\nconst page: HudPageId = mode === "edit" ? "note-edit" : "note-read";\nuseHudPage(page);`,
    )).toEqual(["note-edit", "note-read"]);
    // ② 变量式但顺着不到字面量 ⇒ 零屏（宁可少判，不许凭空造出一屏）。
    expect(hostedPages(`useHudPage(someOtherThing);`)).toEqual([]);
    // ③ 一个调用点按分支发两枚 pageId ⇒ 种数算 2（这正是笔记页合法的那条形状）。
    expect(publishedPageIds(`const v = { pageId: page === "note-edit" ? "note_edit" : "note_read" };`))
      .toEqual(["note_edit", "note_read"]);
    // ④ 多条分支各发一枚 ⇒ 也按种数算，且重复的不重复计。
    expect(publishedPageIds(`if (a) { pageId: "companion" } if (b) { pageId: "companion" }`))
      .toEqual(["companion"]);

    // 现状核对：这两屏确实进了分母（**这条断言在 2026-09-25 之前是红的**，
    // 因为发现只认字面量调用点，笔记页整个不在名单上）。
    const registration = pageRegistration();
    for (const page of ["note-read", "note-edit"]) {
      expect(registration.get(page)?.file, `${page} 没进台账分母`).toContain("notebook-surface");
      expect(registration.get(page)!.registered, `${page} 进了分母却没登记`).toBe(true);
    }
  });

  it("两张表都不许留下已经不需要它的屏", () => {
    const registration = pageRegistration();
    expect(staleEntries(registration, NOT_REGISTERED_WITH_REASON, PENDING_W2_7)).toEqual([]);
    expect(phantomEntries(registration, NOT_REGISTERED_WITH_REASON, PENDING_W2_7)).toEqual([]);
    // 「面板替某屏代登记」这条通道不许变成免登记通道。
    expect(unusedPanelClaims()).toEqual([]);
  });

  it("会红自证：漏登记、忘删欠账、把欠账写成理由三种形状都逮得住", () => {
    const registration = pageRegistration();
    const todayFile = registration.get("today");
    expect(todayFile, "扫描器没找到 today 这一屏").toBeDefined();

    // ① 把一屏改成"没登记" ⇒ 差集必须点名它。
    const leaked = new Map(registration);
    leaked.set("today", { file: todayFile!.file, registered: false, own: false });
    expect(unaccountedPages(leaked, NOT_REGISTERED_WITH_REASON, PENDING_W2_7).join(" ")).toContain("today");

    // ② 登记完却留着欠账条目 ⇒ stale 必须点名它。（用**合成**的欠账表：真表现在已清空，
    // 拿它当这条自证的一条腿，明天它就自证不了了。）
    const forgotten = new Map(registration);
    forgotten.set("settings", { file: registration.get("settings")!.file, registered: true, own: true });
    expect(staleEntries(forgotten, NOT_REGISTERED_WITH_REASON, { settings: "合成欠账" }).join(" ")).toContain("settings");

    // ③ 把"还没做"伪装成"不登记的理由" ⇒ 现状就该红（today 已经登记了）。
    expect(
      staleEntries(registration, { ...NOT_REGISTERED_WITH_REASON, today: "伪装成理由" }, PENDING_W2_7).join(" "),
    ).toContain("today");

    // ④ 「面板代登记」那道核对真的在核：三种形状各判一次。
    const panels = "src/renderer/src/components/surfaces/companion/companion-center-panels.tsx";
    const publishing = "usePageReadableView(view);";
    const shellImport = 'import { MemoryPanel } from "./companion-center-panels";';
    // 正控制：面板发了、壳层也真 import 了 ⇒ 认。
    expect(registeredViaPanel(shellImport, publishing, panels)).toBe(true);
    // a) 面板没发 ⇒ 不认（这条通道不是免登记通道）。
    expect(registeredViaPanel(shellImport, "", panels)).toBe(false);
    // b) 壳层根本没引那个面板 ⇒ 不认（防止把登记算给不相干的文件）。
    expect(registeredViaPanel('import { MemoryPanel } from "./elsewhere";', publishing, panels)).toBe(false);
    // c) 只看 import 行不算数：判据仍是调用形状 usePageReadableView(。
    expect(registeredViaPanel(shellImport, "import { usePageReadableView } from \"../hud/use-page-readable-view\";", panels)).toBe(false);

    // ⑤ 负控制：现状两句话都是空的（否则上面四条红得没有意义）。
    expect(unaccountedPages(registration, NOT_REGISTERED_WITH_REASON, PENDING_W2_7)).toEqual([]);
    expect(staleEntries(registration, NOT_REGISTERED_WITH_REASON, PENDING_W2_7)).toEqual([]);
  });
});
